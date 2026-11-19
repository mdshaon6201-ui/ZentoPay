-- ZentoPay Coordinated Migration 004 (Idempotent & Non-Destructive)
-- Target: Supabase PostgreSQL 15+ (Manual execution in Supabase SQL Editor)
-- Purpose:
--   Restore missing 003 objects required for Bet Deposit (payment_collection),
--   Bet Payout (payment_payout), and Agent notifications without altering any
--   existing data, balances, or historical records.

-- ============================================================================
-- 1. ENUM EXTENSIONS (PostgreSQL requires ADD VALUE outside explicit TX block)
-- ============================================================================
ALTER TYPE public.tx_type_enum ADD VALUE IF NOT EXISTS 'payment_collection';
ALTER TYPE public.tx_type_enum ADD VALUE IF NOT EXISTS 'payment_payout';
ALTER TYPE public.tx_type_enum ADD VALUE IF NOT EXISTS 'affiliate_commission';

-- ============================================================================
-- 2. PROFILES: Additional Columns Used by Agent Portal & Plan/Pin/Referral
-- ============================================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS agent_code TEXT,
  ADD COLUMN IF NOT EXISTS withdraw_pin_hash TEXT,
  ADD COLUMN IF NOT EXISTS active_plan TEXT,
  ADD COLUMN IF NOT EXISTS plan_activated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS referred_by_agent_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_profiles_active_plan'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT chk_profiles_active_plan
      CHECK (active_plan IS NULL OR active_plan IN ('trial', 'premium')) NOT VALID;
  END IF;
END $$;

-- ============================================================================
-- 3. MFS PAYMENT REQUESTS TABLE (Bet Deposit & Bet Payout Routing)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.mfs_payment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_code TEXT NOT NULL UNIQUE,
  idempotency_key TEXT UNIQUE,
  agent_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  request_type TEXT NOT NULL CHECK (request_type IN ('payment_collection', 'payment_payout')),
  method TEXT NOT NULL CHECK (method IN ('bkash', 'nagad', 'rocket')),
  account_mode TEXT NOT NULL CHECK (account_mode IN ('personal', 'merchant', 'agent')),
  agent_account_number TEXT NOT NULL,
  customer_account TEXT,
  amount NUMERIC(18, 2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'BDT' CHECK (currency = 'BDT'),
  commission_rate NUMERIC(5, 4) NOT NULL DEFAULT 0.0400 CHECK (commission_rate >= 0 AND commission_rate <= 0.2500),
  commission_amount NUMERIC(18, 2) NOT NULL DEFAULT 0.00 CHECK (commission_amount >= 0),
  trx_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mfs_payment_requests_agent_status_created
  ON public.mfs_payment_requests (agent_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mfs_payment_requests_created
  ON public.mfs_payment_requests (created_at DESC);

ALTER TABLE public.mfs_payment_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mfs_requests_select_agent_or_admin" ON public.mfs_payment_requests;
CREATE POLICY "mfs_requests_select_agent_or_admin" ON public.mfs_payment_requests
  FOR SELECT TO authenticated
  USING (
    agent_id = auth.uid()
    OR public.is_admin_role(ARRAY['super_admin', 'finance_admin']::zentopay_role[])
  );

DROP POLICY IF EXISTS "mfs_requests_insert_admins" ON public.mfs_payment_requests;
CREATE POLICY "mfs_requests_insert_admins" ON public.mfs_payment_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin_role(ARRAY['super_admin', 'finance_admin']::zentopay_role[])
    AND (created_by IS NULL OR created_by = auth.uid())
  );

DROP POLICY IF EXISTS "mfs_requests_update_admins" ON public.mfs_payment_requests;
CREATE POLICY "mfs_requests_update_admins" ON public.mfs_payment_requests
  FOR UPDATE TO authenticated
  USING (public.is_admin_role(ARRAY['super_admin', 'finance_admin']::zentopay_role[]))
  WITH CHECK (public.is_admin_role(ARRAY['super_admin', 'finance_admin']::zentopay_role[]));

-- ============================================================================
-- 4. USER NOTIFICATIONS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.user_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_user_read_created
  ON public.user_notifications (user_id, is_read, created_at DESC);

ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_notifications_select_owner_or_admin" ON public.user_notifications;
CREATE POLICY "user_notifications_select_owner_or_admin" ON public.user_notifications
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_admin_role(ARRAY['super_admin', 'finance_admin', 'support_admin']::zentopay_role[])
  );

DROP POLICY IF EXISTS "user_notifications_insert_admins" ON public.user_notifications;
CREATE POLICY "user_notifications_insert_admins" ON public.user_notifications
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin_role(ARRAY['super_admin', 'finance_admin', 'support_admin']::zentopay_role[])
  );

DROP POLICY IF EXISTS "user_notifications_update_owner_or_admin" ON public.user_notifications;
CREATE POLICY "user_notifications_update_owner_or_admin" ON public.user_notifications
  FOR UPDATE TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_admin_role(ARRAY['super_admin', 'finance_admin', 'support_admin']::zentopay_role[])
  )
  WITH CHECK (
    user_id = auth.uid()
    OR public.is_admin_role(ARRAY['super_admin', 'finance_admin', 'support_admin']::zentopay_role[])
  );

-- ============================================================================
-- 5. ATOMIC MFS REQUEST APPROVAL RPC (service_role only, idempotent)
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
  v_req RECORD;
  v_clean_trx TEXT := NULLIF(TRIM(COALESCE(p_trx_id, '')), '');
  v_rate NUMERIC(5, 4);
  v_default_rate NUMERIC(5, 4);
  v_raw_rate TEXT;
  v_commission NUMERIC(18, 2);
  v_payout_wallet RECORD;
  v_comm_wallet RECORD;
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

  -- Idempotent replay guard: never double-credit on retry
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
  END IF;

  UPDATE public.wallets
  SET balance = ROUND((balance + v_commission)::NUMERIC, 2),
      available_balance = ROUND((available_balance + v_commission)::NUMERIC, 2),
      updated_at = NOW()
  WHERE id = v_comm_wallet.id
  RETURNING balance, available_balance INTO v_new_comm_bal, v_new_comm_avail;

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
    CASE WHEN v_req.request_type = 'payment_payout' THEN v_payout_wallet.id ELSE NULL END,
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

REVOKE ALL ON FUNCTION public.approve_mfs_payment_request(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_mfs_payment_request(UUID, UUID, TEXT) TO service_role;

-- ============================================================================
-- 6. AFFILIATE COMMISSION RPC (Idempotent, 1% Level-1 + 1% Level-2 Premium 30d+)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.credit_affiliate_commission(
  p_source_user_id UUID,
  p_base_amount NUMERIC,
  p_source_label TEXT,
  p_source_ref TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lvl1_id UUID;
  v_lvl2_id UUID;
  v_bonus NUMERIC(18, 2);
  v_ref TEXT;
  v_wallet RECORD;
  v_new_bal NUMERIC(18, 2);
  v_tx_id UUID;
  v_credited INTEGER := 0;
BEGIN
  IF p_source_user_id IS NULL OR p_base_amount IS NULL OR p_base_amount <= 0 THEN
    RETURN jsonb_build_object('credited', 0);
  END IF;

  v_bonus := ROUND((p_base_amount * 0.01)::NUMERIC, 2);
  IF v_bonus <= 0 THEN
    RETURN jsonb_build_object('credited', 0);
  END IF;

  SELECT referred_by_agent_id INTO v_lvl1_id
  FROM public.profiles
  WHERE id = p_source_user_id;

  IF v_lvl1_id IS NOT NULL AND v_lvl1_id <> p_source_user_id THEN
    IF EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = v_lvl1_id
        AND is_frozen = FALSE
        AND active_plan = 'premium'
        AND plan_activated_at IS NOT NULL
        AND plan_activated_at <= NOW() - INTERVAL '30 days'
    ) THEN
      v_ref := 'AFF1-' || UPPER(COALESCE(p_source_label, 'TX')) || '-' || COALESCE(p_source_ref, gen_random_uuid()::TEXT);
      IF NOT EXISTS (SELECT 1 FROM public.transactions WHERE reference_code = v_ref) THEN
        INSERT INTO public.wallets (user_id, wallet_type, currency, balance, available_balance, status)
        VALUES (v_lvl1_id, 'commission', 'BDT', 0.00, 0.00, 'active')
        ON CONFLICT (user_id, wallet_type, currency) DO NOTHING;

        SELECT * INTO v_wallet FROM public.wallets
        WHERE user_id = v_lvl1_id AND wallet_type = 'commission' AND currency = 'BDT' AND status = 'active'
        FOR UPDATE;

        IF FOUND THEN
          UPDATE public.wallets
          SET balance = ROUND((balance + v_bonus)::NUMERIC, 2),
              available_balance = ROUND((available_balance + v_bonus)::NUMERIC, 2),
              updated_at = NOW()
          WHERE id = v_wallet.id
          RETURNING balance INTO v_new_bal;

          INSERT INTO public.transactions (
            reference_code, receiver_wallet_id, initiator_user_id, tx_type, amount, currency, status, description
          ) VALUES (
            v_ref, v_wallet.id, v_lvl1_id, 'affiliate_commission', v_bonus, 'BDT', 'completed',
            'Level-1 Affiliate Commission (' || COALESCE(p_source_ref, '') || ')'
          ) RETURNING id INTO v_tx_id;

          INSERT INTO public.ledger_entries (transaction_id, wallet_id, entry_type, amount, balance_after)
          VALUES (v_tx_id, v_wallet.id, 'credit', v_bonus, v_new_bal);

          v_credited := v_credited + 1;
        END IF;
      END IF;
    END IF;

    SELECT referred_by_agent_id INTO v_lvl2_id
    FROM public.profiles
    WHERE id = v_lvl1_id;

    IF v_lvl2_id IS NOT NULL AND v_lvl2_id <> p_source_user_id AND v_lvl2_id <> v_lvl1_id THEN
      IF EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = v_lvl2_id
          AND is_frozen = FALSE
          AND active_plan = 'premium'
          AND plan_activated_at IS NOT NULL
          AND plan_activated_at <= NOW() - INTERVAL '30 days'
      ) THEN
        v_ref := 'AFF2-' || UPPER(COALESCE(p_source_label, 'TX')) || '-' || COALESCE(p_source_ref, gen_random_uuid()::TEXT);
        IF NOT EXISTS (SELECT 1 FROM public.transactions WHERE reference_code = v_ref) THEN
          INSERT INTO public.wallets (user_id, wallet_type, currency, balance, available_balance, status)
          VALUES (v_lvl2_id, 'commission', 'BDT', 0.00, 0.00, 'active')
          ON CONFLICT (user_id, wallet_type, currency) DO NOTHING;

          SELECT * INTO v_wallet FROM public.wallets
          WHERE user_id = v_lvl2_id AND wallet_type = 'commission' AND currency = 'BDT' AND status = 'active'
          FOR UPDATE;

          IF FOUND THEN
            UPDATE public.wallets
            SET balance = ROUND((balance + v_bonus)::NUMERIC, 2),
                available_balance = ROUND((available_balance + v_bonus)::NUMERIC, 2),
                updated_at = NOW()
            WHERE id = v_wallet.id
            RETURNING balance INTO v_new_bal;

            INSERT INTO public.transactions (
              reference_code, receiver_wallet_id, initiator_user_id, tx_type, amount, currency, status, description
            ) VALUES (
              v_ref, v_wallet.id, v_lvl2_id, 'affiliate_commission', v_bonus, 'BDT', 'completed',
              'Level-2 Affiliate Commission (' || COALESCE(p_source_ref, '') || ')'
            ) RETURNING id INTO v_tx_id;

            INSERT INTO public.ledger_entries (transaction_id, wallet_id, entry_type, amount, balance_after)
            VALUES (v_tx_id, v_wallet.id, 'credit', v_bonus, v_new_bal);

            v_credited := v_credited + 1;
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('credited', v_credited);
END;
$$;

REVOKE ALL ON FUNCTION public.credit_affiliate_commission(UUID, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_affiliate_commission(UUID, NUMERIC, TEXT, TEXT) TO service_role;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
