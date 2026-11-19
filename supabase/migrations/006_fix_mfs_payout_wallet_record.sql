-- ZentoPay Migration 006 (Idempotent & Non-Destructive)
-- Target: Supabase PostgreSQL 15+ (Manual execution in Supabase SQL Editor)
-- Purpose:
--   1. Fix PL/pgSQL runtime error: `record "v_payout_wallet" is not assigned yet`
--      when approving payment_collection (Bet Deposit) requests.
--   2. Replace untyped RECORD declarations with explicit table %ROWTYPE
--      (`v_payout_wallet public.wallets%ROWTYPE`, `v_comm_wallet public.wallets%ROWTYPE`,
--      `v_req public.mfs_payment_requests%ROWTYPE`) and an explicit nullable
--      `v_sender_wallet_id UUID := NULL` so `payment_collection` inserts NULL
--      for `sender_wallet_id` without ever accessing `v_payout_wallet`.
--   3. Preserve exact function signature, SECURITY DEFINER, SET search_path = public,
--      SELECT ... FOR UPDATE payout wallet lock, commission rates (bKash 5%, Nagad 4%,
--      Rocket 4%), ledger entries, audit logs, idempotency, and service_role-only grants.
--   4. Does NOT approve any pending request or modify any wallet balance.

-- ============================================================================
-- 1. REPLACE public.approve_mfs_payment_request(UUID, UUID, TEXT) SAFELY
-- ============================================================================
CREATE OR REPLACE FUNCTION public.approve_mfs_payment_request(
  p_request_id UUID,
  p_agent_id UUID,
  p_trx_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.mfs_payment_requests%ROWTYPE;
  v_clean_trx TEXT := NULLIF(TRIM(COALESCE(p_trx_id, '')), '');
  v_rate NUMERIC(5, 4);
  v_default_rate NUMERIC(5, 4);
  v_raw_rate TEXT;
  v_commission NUMERIC(18, 2);
  v_payout_wallet public.wallets%ROWTYPE;
  v_comm_wallet public.wallets%ROWTYPE;
  v_sender_wallet_id UUID := NULL;
  v_new_payout_bal NUMERIC(18, 2);
  v_new_payout_avail NUMERIC(18, 2);
  v_new_comm_bal NUMERIC(18, 2);
  v_new_comm_avail NUMERIC(18, 2);
  v_tx_id UUID;
BEGIN
  IF p_request_id IS NULL OR p_agent_id IS NULL THEN
    RAISE EXCEPTION 'MFS_REQUEST_NOT_FOUND';
  END IF;

  SELECT *
  INTO v_req
  FROM public.mfs_payment_requests
  WHERE id = p_request_id
    AND agent_id = p_agent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MFS_REQUEST_NOT_FOUND';
  END IF;

  IF v_req.status = 'declined' THEN
    RAISE EXCEPTION 'MFS_REQUEST_ALREADY_DECLINED';
  END IF;

  -- Idempotent replay guard: never double-credit or double-debit on retry
  IF v_req.status = 'approved' THEN
    RETURN jsonb_build_object(
      'idempotentReplay', TRUE,
      'requestId', v_req.id,
      'referenceCode', v_req.reference_code,
      'commissionAmount', v_req.commission_amount,
      'commissionRate', v_req.commission_rate,
      'status', v_req.status
    );
  END IF;

  IF v_req.request_type = 'payment_collection' THEN
    IF v_clean_trx IS NULL OR LENGTH(v_clean_trx) < 4 THEN
      RAISE EXCEPTION 'INVALID_TRX_ID';
    END IF;
  END IF;

  -- Authoritative provider commission rate (bKash 5%, Nagad 4%, Rocket 4%)
  IF v_req.method = 'bkash' THEN
    v_default_rate := 0.0500;
  ELSIF v_req.method = 'nagad' THEN
    v_default_rate := 0.0400;
  ELSIF v_req.method = 'rocket' THEN
    v_default_rate := 0.0400;
  ELSE
    RAISE EXCEPTION 'Unsupported MFS method: %', v_req.method;
  END IF;

  SELECT config_value->'commissionRates'->>v_req.method
  INTO v_raw_rate
  FROM public.platform_config
  WHERE config_key = 'ewallet_config'
  LIMIT 1;

  IF v_raw_rate IS NOT NULL AND v_raw_rate ~ '^[0-9]+(\.[0-9]+)?$' THEN
    v_rate := ROUND(v_raw_rate::NUMERIC, 4);
    IF v_rate < 0 OR v_rate > 0.2500 THEN
      v_rate := v_default_rate;
    END IF;
  ELSE
    v_rate := v_default_rate;
  END IF;

  v_commission := ROUND((v_req.amount * v_rate)::NUMERIC, 2);

  -- Ensure agent BDT commission wallet exists
  INSERT INTO public.wallets (user_id, wallet_type, currency, balance, available_balance, status)
  VALUES (p_agent_id, 'commission', 'BDT', 0.00, 0.00, 'active')
  ON CONFLICT (user_id, wallet_type, currency) DO NOTHING;

  SELECT *
  INTO v_comm_wallet
  FROM public.wallets
  WHERE user_id = p_agent_id
    AND wallet_type = 'commission'
    AND currency = 'BDT'
    AND status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACTIVE_WALLET_NOT_FOUND';
  END IF;

  -- Lock & debit active BDT main/float wallet strictly for payment_payout (Bet Payout)
  IF v_req.request_type = 'payment_payout' THEN
    SELECT *
    INTO v_payout_wallet
    FROM public.wallets
    WHERE user_id = p_agent_id
      AND currency = 'BDT'
      AND status = 'active'
      AND wallet_type IN ('main', 'float')
    ORDER BY CASE WHEN wallet_type = 'main' THEN 0 ELSE 1 END
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ACTIVE_WALLET_NOT_FOUND';
    END IF;

    IF v_payout_wallet.available_balance < v_req.amount THEN
      RAISE EXCEPTION 'INSUFFICIENT_PAYOUT_BALANCE';
    END IF;

    UPDATE public.wallets
    SET balance = ROUND((balance - v_req.amount)::NUMERIC, 2),
        available_balance = ROUND((available_balance - v_req.amount)::NUMERIC, 2),
        updated_at = NOW()
    WHERE id = v_payout_wallet.id
    RETURNING balance, available_balance INTO v_new_payout_bal, v_new_payout_avail;

    v_sender_wallet_id := v_payout_wallet.id;
  END IF;

  -- Credit agent commission wallet
  UPDATE public.wallets
  SET balance = ROUND((balance + v_commission)::NUMERIC, 2),
      available_balance = ROUND((available_balance + v_commission)::NUMERIC, 2),
      updated_at = NOW()
  WHERE id = v_comm_wallet.id
  RETURNING balance, available_balance INTO v_new_comm_bal, v_new_comm_avail;

  -- Record transaction; v_sender_wallet_id is NULL for payment_collection and v_payout_wallet.id for payment_payout
  INSERT INTO public.transactions (
    reference_code,
    sender_wallet_id,
    receiver_wallet_id,
    initiator_user_id,
    tx_type,
    amount,
    fee_amount,
    commission_amount,
    currency,
    status,
    description,
    metadata
  ) VALUES (
    v_req.reference_code,
    v_sender_wallet_id,
    v_comm_wallet.id,
    p_agent_id,
    v_req.request_type::tx_type_enum,
    v_req.amount,
    0.00,
    v_commission,
    'BDT',
    'completed',
    UPPER(v_req.method) || ' ' || CASE WHEN v_req.request_type = 'payment_collection' THEN 'Bet Deposit' ELSE 'Bet Payout' END,
    jsonb_build_object(
      'mfsRequestId', v_req.id,
      'method', v_req.method,
      'accountMode', v_req.account_mode,
      'agentAccountNumber', v_req.agent_account_number,
      'customerAccount', v_req.customer_account,
      'trxId', COALESCE(v_clean_trx, v_req.trx_id),
      'commissionRate', v_rate,
      'commissionAmount', v_commission
    )
  ) RETURNING id INTO v_tx_id;

  IF v_req.request_type = 'payment_payout' THEN
    INSERT INTO public.ledger_entries (transaction_id, wallet_id, entry_type, amount, balance_after)
    VALUES (v_tx_id, v_payout_wallet.id, 'debit', v_req.amount, v_new_payout_bal);
  END IF;

  IF v_commission > 0 THEN
    INSERT INTO public.ledger_entries (transaction_id, wallet_id, entry_type, amount, balance_after)
    VALUES (v_tx_id, v_comm_wallet.id, 'credit', v_commission, v_new_comm_bal);
  END IF;

  UPDATE public.mfs_payment_requests
  SET status = 'approved',
      trx_id = COALESCE(v_clean_trx, trx_id),
      commission_rate = v_rate,
      commission_amount = v_commission,
      processed_at = NOW()
  WHERE id = v_req.id;

  INSERT INTO public.audit_logs (actor_id, actor_role, action, target_table, target_id, payload)
  VALUES (
    p_agent_id,
    COALESCE((SELECT role::TEXT FROM public.profiles WHERE id = p_agent_id), 'agent'),
    'mfs_request_approved',
    'mfs_payment_requests',
    v_req.id,
    jsonb_build_object(
      'referenceCode', v_req.reference_code,
      'requestType', v_req.request_type,
      'method', v_req.method,
      'amount', v_req.amount,
      'commissionRate', v_rate,
      'commissionAmount', v_commission,
      'transactionId', v_tx_id
    )
  );

  RETURN jsonb_build_object(
    'idempotentReplay', FALSE,
    'requestId', v_req.id,
    'referenceCode', v_req.reference_code,
    'transactionId', v_tx_id,
    'commissionRate', v_rate,
    'commissionAmount', v_commission,
    'status', 'approved'
  );
END;
$$;

-- Restrict RPC execution strictly to service_role (never anon or authenticated)
REVOKE ALL ON FUNCTION public.approve_mfs_payment_request(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_mfs_payment_request(UUID, UUID, TEXT) TO service_role;

-- Reload PostgREST schema cache immediately
NOTIFY pgrst, 'reload schema';
