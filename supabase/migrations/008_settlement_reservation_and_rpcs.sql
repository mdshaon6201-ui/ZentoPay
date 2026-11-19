-- ZentoPay Migration 008 (Idempotent & Non-Destructive)
-- Target: Supabase PostgreSQL 15+ (Run in Supabase SQL Editor)
-- Purpose:
--   1. Add explicit reserved_balance tracking to public.wallets and backfill any open
--      pending settlement reservations without altering historical settled rows.
--   2. Add reference_code, destination_account, idempotency_key, transaction_id,
--      approved_at, and rejected_at columns to public.settlement_requests.
--   3. Install atomic, row-locked (SELECT ... FOR UPDATE), idempotent service_role-only
--      RPCs for Withdrawal Submission, Admin Approval, and Admin Rejection.

-- ============================================================================
-- 1. WALLETS: Explicit reserved_balance column + safe backfill for pending rows
-- ============================================================================
ALTER TABLE public.wallets
  ADD COLUMN IF NOT EXISTS reserved_balance NUMERIC(18, 2) NOT NULL DEFAULT 0.00;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_wallets_reserved_balance_nonneg'
      AND conrelid = 'public.wallets'::regclass
  ) THEN
    ALTER TABLE public.wallets
      ADD CONSTRAINT chk_wallets_reserved_balance_nonneg
      CHECK (reserved_balance >= 0) NOT VALID;
  END IF;
END $$;

-- Backfill reserved_balance strictly for wallets that currently have pending settlement_requests
UPDATE public.wallets w
SET reserved_balance = LEAST(
  w.balance,
  GREATEST(
    0.00,
    COALESCE((
      SELECT SUM(sr.amount)
      FROM public.settlement_requests sr
      WHERE sr.wallet_id = w.id
        AND sr.status = 'pending'
    ), 0.00)
  )
)
WHERE w.reserved_balance = 0.00
  AND EXISTS (
    SELECT 1
    FROM public.settlement_requests sr2
    WHERE sr2.wallet_id = w.id
      AND sr2.status = 'pending'
  );

-- ============================================================================
-- 2. SETTLEMENT REQUESTS: Traceability, Idempotency & Full Destination Details
-- ============================================================================
ALTER TABLE public.settlement_requests
  ADD COLUMN IF NOT EXISTS reference_code TEXT,
  ADD COLUMN IF NOT EXISTS destination_account TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS transaction_id UUID REFERENCES public.transactions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;

UPDATE public.settlement_requests
SET reference_code = 'WD-' || UPPER(SUBSTRING(REPLACE(id::TEXT, '-', ''), 1, 8))
WHERE reference_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_requests_reference_code
  ON public.settlement_requests (reference_code)
  WHERE reference_code IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_requests_requester_idempotency
  ON public.settlement_requests (requester_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_settlement_requests_status_created
  ON public.settlement_requests (status, created_at DESC);

-- ============================================================================
-- 3. ATOMIC RPC: CREATE WITHDRAWAL REQUEST (Reserves available_balance safely)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_withdrawal_request(
  p_agent_id UUID,
  p_wallet_id UUID,
  p_amount NUMERIC,
  p_destination_bank TEXT,
  p_account_last4 TEXT,
  p_destination_account TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_amount NUMERIC(18, 2) := ROUND(COALESCE(p_amount, 0)::NUMERIC, 2);
  v_clean_key TEXT := NULLIF(TRIM(COALESCE(p_idempotency_key, '')), '');
  v_clean_dest TEXT := TRIM(COALESCE(p_destination_bank, ''));
  v_clean_acc TEXT := NULLIF(TRIM(COALESCE(p_destination_account, '')), '');
  v_last4 TEXT := LPAD(RIGHT(REGEXP_REPLACE(COALESCE(p_account_last4, ''), '[^0-9]', '', 'g'), 4), 4, '0');
  v_existing public.settlement_requests%ROWTYPE;
  v_wallet public.wallets%ROWTYPE;
  v_new_avail NUMERIC(18, 2);
  v_new_reserved NUMERIC(18, 2);
  v_ref_code TEXT;
  v_tx_id UUID;
  v_settlement public.settlement_requests%ROWTYPE;
BEGIN
  IF p_agent_id IS NULL OR p_wallet_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST_PARAMS';
  END IF;

  IF v_amount IS NULL OR v_amount < 500.00 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  IF LENGTH(v_clean_dest) < 2 THEN
    RAISE EXCEPTION 'INVALID_DESTINATION';
  END IF;

  -- Idempotency check (prevents duplicate submission on double-click/retry)
  IF v_clean_key IS NOT NULL THEN
    SELECT *
    INTO v_existing
    FROM public.settlement_requests
    WHERE requester_id = p_agent_id
      AND idempotency_key = v_clean_key
    LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'idempotentReplay', TRUE,
        'settlement', to_jsonb(v_existing)
      );
    END IF;
  END IF;

  -- Lock the agent's active wallet row to serialize concurrent withdrawals
  SELECT *
  INTO v_wallet
  FROM public.wallets
  WHERE id = p_wallet_id
    AND user_id = p_agent_id
    AND status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;

  IF v_wallet.currency <> 'BDT' THEN
    RAISE EXCEPTION 'INVALID_CURRENCY';
  END IF;

  IF v_wallet.available_balance < v_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_AVAILABLE_BALANCE';
  END IF;

  -- Reserve funds: deduct available_balance and add to reserved_balance; keep total balance intact until approval
  UPDATE public.wallets
  SET available_balance = ROUND((available_balance - v_amount)::NUMERIC, 2),
      reserved_balance = ROUND((reserved_balance + v_amount)::NUMERIC, 2),
      updated_at = NOW()
  WHERE id = v_wallet.id
  RETURNING available_balance, reserved_balance INTO v_new_avail, v_new_reserved;

  v_ref_code := 'WD-' || TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYMMDD') || '-' ||
                UPPER(SUBSTRING(REPLACE(gen_random_uuid()::TEXT, '-', ''), 1, 6));

  -- Create a pending withdrawal transaction record for complete traceability
  INSERT INTO public.transactions (
    reference_code,
    sender_wallet_id,
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
    v_ref_code,
    v_wallet.id,
    p_agent_id,
    'withdrawal',
    v_amount,
    0.00,
    0.00,
    'BDT',
    'pending',
    'উইথড্র রিকোয়েস্ট (' || v_clean_dest || ')',
    jsonb_build_object(
      'destinationBank', v_clean_dest,
      'destinationAccount', v_clean_acc,
      'accountLast4', v_last4,
      'idempotencyKey', v_clean_key
    )
  ) RETURNING id INTO v_tx_id;

  INSERT INTO public.settlement_requests (
    requester_id,
    wallet_id,
    amount,
    currency,
    destination_bank,
    destination_account,
    account_last4,
    reference_code,
    idempotency_key,
    transaction_id,
    status
  ) VALUES (
    p_agent_id,
    v_wallet.id,
    v_amount,
    'BDT',
    v_clean_dest,
    v_clean_acc,
    v_last4,
    v_ref_code,
    v_clean_key,
    v_tx_id,
    'pending'
  ) RETURNING * INTO v_settlement;

  INSERT INTO public.audit_logs (actor_id, actor_role, action, target_table, target_id, payload)
  VALUES (
    p_agent_id,
    COALESCE((SELECT role::TEXT FROM public.profiles WHERE id = p_agent_id), 'agent'),
    'withdrawal_requested',
    'settlement_requests',
    v_settlement.id,
    jsonb_build_object(
      'referenceCode', v_ref_code,
      'walletId', v_wallet.id,
      'amount', v_amount,
      'availableBalanceAfter', v_new_avail,
      'reservedBalanceAfter', v_new_reserved
    )
  );

  RETURN jsonb_build_object(
    'idempotentReplay', FALSE,
    'settlement', to_jsonb(v_settlement),
    'wallet', jsonb_build_object(
      'id', v_wallet.id,
      'balance', v_wallet.balance,
      'available_balance', v_new_avail,
      'reserved_balance', v_new_reserved
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_withdrawal_request(UUID, UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_withdrawal_request(UUID, UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- ============================================================================
-- 4. ATOMIC RPC: APPROVE WITHDRAWAL REQUEST (Finalizes reserved debit once)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.approve_withdrawal_request(
  p_request_id UUID,
  p_admin_id UUID,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.settlement_requests%ROWTYPE;
  v_wallet public.wallets%ROWTYPE;
  v_clean_notes TEXT := NULLIF(TRIM(COALESCE(p_notes, '')), '');
  v_amount NUMERIC(18, 2);
  v_new_bal NUMERIC(18, 2);
  v_new_avail NUMERIC(18, 2);
  v_new_reserved NUMERIC(18, 2);
  v_tx_id UUID;
  v_tx_ref TEXT;
  v_updated_req public.settlement_requests%ROWTYPE;
BEGIN
  IF p_request_id IS NULL OR p_admin_id IS NULL THEN
    RAISE EXCEPTION 'SETTLEMENT_NOT_FOUND';
  END IF;

  SELECT *
  INTO v_req
  FROM public.settlement_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SETTLEMENT_NOT_FOUND';
  END IF;

  -- Idempotent replay guard: never debit balance a second time
  IF v_req.status IN ('approved', 'disbursed') THEN
    RETURN jsonb_build_object(
      'idempotentReplay', TRUE,
      'settlement', to_jsonb(v_req)
    );
  END IF;

  IF v_req.status = 'rejected' THEN
    RAISE EXCEPTION 'SETTLEMENT_ALREADY_FINALIZED';
  END IF;

  v_amount := ROUND(v_req.amount::NUMERIC, 2);

  SELECT *
  INTO v_wallet
  FROM public.wallets
  WHERE id = v_req.wallet_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;

  IF v_wallet.balance < v_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_LEDGER_BALANCE';
  END IF;

  -- Finalize reserved balance as permanent ledger debit WITHOUT subtracting available_balance again
  v_new_bal := ROUND((v_wallet.balance - v_amount)::NUMERIC, 2);
  v_new_reserved := GREATEST(0.00, ROUND((v_wallet.reserved_balance - v_amount)::NUMERIC, 2));
  v_new_avail := LEAST(v_new_bal, v_wallet.available_balance);

  UPDATE public.wallets
  SET balance = v_new_bal,
      available_balance = v_new_avail,
      reserved_balance = v_new_reserved,
      updated_at = NOW()
  WHERE id = v_wallet.id;

  IF COALESCE(v_req.currency, v_wallet.currency, 'BDT') = 'BDT' THEN
    IF v_req.transaction_id IS NOT NULL THEN
      UPDATE public.transactions
      SET tx_type = 'settlement',
          status = 'completed',
          description = 'উইথড্র অনুমোদিত (' || v_req.destination_bank || ' ·••• ' || v_req.account_last4 || ')',
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'settlementRequestId', v_req.id,
            'approvedBy', p_admin_id,
            'adminNotes', v_clean_notes
          )
      WHERE id = v_req.transaction_id
      RETURNING id INTO v_tx_id;
    END IF;

    IF v_tx_id IS NULL THEN
      v_tx_ref := COALESCE(
        NULLIF(v_req.reference_code, ''),
        'STL-' || UPPER(TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYMMDD')) || '-' ||
          UPPER(SUBSTRING(REPLACE(gen_random_uuid()::TEXT, '-', ''), 1, 6))
      );
      -- Avoid reference_code collision if fallback runs
      IF EXISTS (SELECT 1 FROM public.transactions WHERE reference_code = v_tx_ref) THEN
        v_tx_ref := 'STL-' || v_tx_ref || '-' || UPPER(SUBSTRING(REPLACE(gen_random_uuid()::TEXT, '-', ''), 1, 4));
      END IF;

      INSERT INTO public.transactions (
        reference_code,
        sender_wallet_id,
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
        v_tx_ref,
        v_wallet.id,
        v_req.requester_id,
        'settlement',
        v_amount,
        0.00,
        0.00,
        'BDT',
        'completed',
        'উইথড্র অনুমোদিত (' || v_req.destination_bank || ' ·••• ' || v_req.account_last4 || ')',
        jsonb_build_object(
          'settlementRequestId', v_req.id,
          'approvedBy', p_admin_id,
          'adminNotes', v_clean_notes
        )
      ) RETURNING id INTO v_tx_id;
    END IF;

    INSERT INTO public.ledger_entries (transaction_id, wallet_id, entry_type, amount, balance_after)
    VALUES (v_tx_id, v_wallet.id, 'debit', v_amount, v_new_bal);
  END IF;

  UPDATE public.settlement_requests
  SET status = 'approved',
      notes = COALESCE(v_clean_notes, notes),
      reviewed_by = p_admin_id,
      reviewed_at = NOW(),
      approved_at = NOW(),
      transaction_id = COALESCE(v_tx_id, transaction_id)
  WHERE id = v_req.id
  RETURNING * INTO v_updated_req;

  INSERT INTO public.audit_logs (actor_id, actor_role, action, target_table, target_id, payload)
  VALUES (
    p_admin_id,
    COALESCE((SELECT role::TEXT FROM public.profiles WHERE id = p_admin_id), 'finance_admin'),
    'settlement_approved',
    'settlement_requests',
    v_req.id,
    jsonb_build_object(
      'referenceCode', v_updated_req.reference_code,
      'amount', v_amount,
      'balanceAfter', v_new_bal,
      'availableBalanceAfter', v_new_avail,
      'reservedBalanceAfter', v_new_reserved,
      'transactionId', v_tx_id,
      'notes', v_clean_notes
    )
  );

  INSERT INTO public.user_notifications (user_id, title, message, created_by)
  VALUES (
    v_req.requester_id,
    'উইথড্র রিকোয়েস্ট অনুমোদিত (' || COALESCE(v_updated_req.reference_code, LEFT(v_req.id::TEXT, 8)) || ')',
    'আপনার ৳' || TO_CHAR(v_amount, 'FM999,999,990.00') || ' উইথড্র রিকোয়েস্ট (' || v_req.destination_bank || ') অনুমোদিত হয়েছে।' ||
      CASE WHEN v_clean_notes IS NOT NULL THEN ' নোট: ' || v_clean_notes ELSE '' END,
    p_admin_id
  );

  RETURN jsonb_build_object(
    'idempotentReplay', FALSE,
    'settlement', to_jsonb(v_updated_req),
    'wallet', jsonb_build_object(
      'id', v_wallet.id,
      'balance', v_new_bal,
      'available_balance', v_new_avail,
      'reserved_balance', v_new_reserved
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.approve_withdrawal_request(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_withdrawal_request(UUID, UUID, TEXT) TO service_role;

-- ============================================================================
-- 5. ATOMIC RPC: REJECT WITHDRAWAL REQUEST (Releases reserved balance safely once)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reject_withdrawal_request(
  p_request_id UUID,
  p_admin_id UUID,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.settlement_requests%ROWTYPE;
  v_wallet public.wallets%ROWTYPE;
  v_clean_notes TEXT := NULLIF(TRIM(COALESCE(p_notes, '')), '');
  v_amount NUMERIC(18, 2);
  v_new_avail NUMERIC(18, 2);
  v_new_reserved NUMERIC(18, 2);
  v_updated_req public.settlement_requests%ROWTYPE;
BEGIN
  IF p_request_id IS NULL OR p_admin_id IS NULL THEN
    RAISE EXCEPTION 'SETTLEMENT_NOT_FOUND';
  END IF;

  SELECT *
  INTO v_req
  FROM public.settlement_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SETTLEMENT_NOT_FOUND';
  END IF;

  -- Idempotent replay guard: never release the same reserved amount twice
  IF v_req.status = 'rejected' THEN
    RETURN jsonb_build_object(
      'idempotentReplay', TRUE,
      'settlement', to_jsonb(v_req)
    );
  END IF;

  IF v_req.status IN ('approved', 'disbursed') THEN
    RAISE EXCEPTION 'SETTLEMENT_ALREADY_FINALIZED';
  END IF;

  v_amount := ROUND(v_req.amount::NUMERIC, 2);

  SELECT *
  INTO v_wallet
  FROM public.wallets
  WHERE id = v_req.wallet_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;

  -- Release reserved funds safely back to available_balance (never exceeding ledger balance)
  v_new_avail := LEAST(v_wallet.balance, ROUND((v_wallet.available_balance + v_amount)::NUMERIC, 2));
  v_new_reserved := GREATEST(0.00, ROUND((v_wallet.reserved_balance - v_amount)::NUMERIC, 2));

  UPDATE public.wallets
  SET available_balance = v_new_avail,
      reserved_balance = v_new_reserved,
      updated_at = NOW()
  WHERE id = v_wallet.id;

  IF v_req.transaction_id IS NOT NULL THEN
    UPDATE public.transactions
    SET status = 'reversed',
        description = 'উইথড্র প্রত্যাখ্যাত (' || v_req.destination_bank || ')',
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'settlementRequestId', v_req.id,
          'rejectedBy', p_admin_id,
          'adminNotes', v_clean_notes
        )
    WHERE id = v_req.transaction_id;
  END IF;

  UPDATE public.settlement_requests
  SET status = 'rejected',
      notes = v_clean_notes,
      reviewed_by = p_admin_id,
      reviewed_at = NOW(),
      rejected_at = NOW()
  WHERE id = v_req.id
  RETURNING * INTO v_updated_req;

  INSERT INTO public.audit_logs (actor_id, actor_role, action, target_table, target_id, payload)
  VALUES (
    p_admin_id,
    COALESCE((SELECT role::TEXT FROM public.profiles WHERE id = p_admin_id), 'finance_admin'),
    'settlement_rejected',
    'settlement_requests',
    v_req.id,
    jsonb_build_object(
      'referenceCode', v_updated_req.reference_code,
      'amount', v_amount,
      'releasedToAvailable', v_amount,
      'availableBalanceAfter', v_new_avail,
      'reservedBalanceAfter', v_new_reserved,
      'notes', v_clean_notes
    )
  );

  INSERT INTO public.user_notifications (user_id, title, message, created_by)
  VALUES (
    v_req.requester_id,
    'উইথড্র রিকোয়েস্ট প্রত্যাখ্যাত (' || COALESCE(v_updated_req.reference_code, LEFT(v_req.id::TEXT, 8)) || ')',
    'আপনার ৳' || TO_CHAR(v_amount, 'FM999,999,990.00') || ' উইথড্র রিকোয়েস্ট প্রত্যাখ্যান করা হয়েছে এবং অর্থ আপনার ব্যবহারযোগ্য ব্যালেন্সে ফেরত পাঠানো হয়েছে।' ||
      CASE WHEN v_clean_notes IS NOT NULL THEN ' কারণ: ' || v_clean_notes ELSE '' END,
    p_admin_id
  );

  RETURN jsonb_build_object(
    'idempotentReplay', FALSE,
    'settlement', to_jsonb(v_updated_req),
    'wallet', jsonb_build_object(
      'id', v_wallet.id,
      'balance', v_wallet.balance,
      'available_balance', v_new_avail,
      'reserved_balance', v_new_reserved
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reject_withdrawal_request(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_withdrawal_request(UUID, UUID, TEXT) TO service_role;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
