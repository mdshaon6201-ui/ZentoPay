-- ZentoPay Coordinated Fix Migration 002b (Standalone & Non-Destructive)
-- Target: Supabase PostgreSQL 15+ (to be executed manually ONLY after Stage 0 inspection approval)
-- Scope:
--   1. Collision-safe, permanent, immutable 67XXXXXX Agent ID (profiles.agent_code)
--   2. Field-level protection trigger on public.profiles (prevents self-escalation & agent_code tampering)
--   3. Automatic 'agent' role assignment & BDT-only wallet provisioning on signup (handle_new_auth_user)
--   4. BDT-only defaults and legacy-safe BDT enforcement triggers (without stranding open legacy USD rows)
--   5. Hardened SECURITY DEFINER RPCs (execute_wallet_transfer with balanced fee ledger + activate_agent_gateway), service_role-only
--   6. Missing public.platform_config table creation, full policy reset, Admin-only RLS, BDT seed & PostgREST reload

-- ============================================================================
-- 1. PROFILES: Agent ID (agent_code) Column, Unique Constraint, Format & Backfill
-- ============================================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS agent_code TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.conrelid = 'public.profiles'::regclass
      AND c.contype = 'u'
      AND array_length(c.conkey, 1) = 1
      AND a.attname = 'agent_code'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM pg_class
      WHERE relname = 'idx_profiles_agent_code_unique'
        AND relnamespace = 'public'::regnamespace
    ) THEN
      DROP INDEX IF EXISTS public.idx_profiles_agent_code_unique;
    END IF;
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_agent_code_key UNIQUE (agent_code);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_profiles_agent_code_format'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT chk_profiles_agent_code_format
      CHECK (agent_code IS NULL OR agent_code ~ '^67[0-9]{6}$') NOT VALID;
  END IF;
END $$;

-- Collision-safe backfill for any existing profiles where agent_code IS NULL
DO $$
DECLARE
  rec RECORD;
  candidate TEXT;
  attempts INTEGER;
  assigned BOOLEAN;
  v_constraint TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('zentopay_backfill_agent_code'));

  FOR rec IN
    SELECT id FROM public.profiles WHERE agent_code IS NULL ORDER BY created_at ASC, id ASC
  LOOP
    attempts := 0;
    assigned := FALSE;
    WHILE NOT assigned LOOP
      attempts := attempts + 1;
      IF attempts > 25 THEN
        RAISE EXCEPTION 'Unable to allocate unique 67XXXXXX agent_code after 25 attempts for profile %', rec.id;
      END IF;

      candidate := '67' || LPAD(
        (
          (('x' || substr(replace(gen_random_uuid()::TEXT, '-', ''), 1, 8))::bit(32) & x'7fffffff'::bit(32))::bigint
          % 1000000
        )::TEXT,
        6,
        '0'
      );

      BEGIN
        UPDATE public.profiles
        SET agent_code = candidate,
            updated_at = NOW()
        WHERE id = rec.id
          AND agent_code IS NULL;
        assigned := TRUE;
      EXCEPTION
        WHEN unique_violation THEN
          GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
          IF v_constraint IS NOT NULL AND v_constraint LIKE '%agent_code%' THEN
            assigned := FALSE;
          ELSE
            RAISE;
          END IF;
      END;
    END LOOP;
  END LOOP;
END $$;

-- ============================================================================
-- 2. PROFILES SECURITY: Protect Immutable agent_code & Privileged Fields
-- ============================================================================
CREATE OR REPLACE FUNCTION public.protect_profile_immutable_and_privileged_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_is_super_admin BOOLEAN := FALSE;
BEGIN
  -- 1. agent_code is permanently immutable once assigned for ALL callers (including service_role)
  IF OLD.agent_code IS NOT NULL AND NEW.agent_code IS DISTINCT FROM OLD.agent_code THEN
    RAISE EXCEPTION 'agent_code is permanent and cannot be modified once assigned';
  END IF;

  -- 2. Guard privileged columns against ordinary authenticated / anon PostgREST updates
  IF v_jwt_role IN ('authenticated', 'anon') THEN
    v_is_super_admin := public.is_admin_role(ARRAY['super_admin']::zentopay_role[]);
    IF NOT v_is_super_admin THEN
      IF NEW.role IS DISTINCT FROM OLD.role
         OR NEW.kyc_status IS DISTINCT FROM OLD.kyc_status
         OR NEW.is_frozen IS DISTINCT FROM OLD.is_frozen
         OR NEW.parent_agent_id IS DISTINCT FROM OLD.parent_agent_id
         OR NEW.email IS DISTINCT FROM OLD.email
         OR NEW.agent_code IS DISTINCT FROM OLD.agent_code THEN
        RAISE EXCEPTION 'Insufficient privileges to modify protected profile fields';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_protect_fields ON public.profiles;
CREATE TRIGGER trg_profiles_protect_fields
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_immutable_and_privileged_fields();

-- ============================================================================
-- 3. BDT-ONLY DEFAULTS & LEGACY-SAFE BDT ENFORCEMENT TRIGGERS
--    Note: Hard CHECK (currency = 'BDT') NOT VALID is intentionally deferred
--    until Stage 0/Stage 3 confirms zero open non-BDT deposits, settlements,
--    or unsettled non-BDT wallets remain, so pending legacy rows can be closed.
-- ============================================================================
ALTER TABLE public.wallets ALTER COLUMN currency SET DEFAULT 'BDT';
ALTER TABLE public.transactions ALTER COLUMN currency SET DEFAULT 'BDT';
ALTER TABLE public.settlement_requests ALTER COLUMN currency SET DEFAULT 'BDT';

CREATE OR REPLACE FUNCTION public.enforce_wallet_bdt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.currency IS DISTINCT FROM 'BDT' THEN
      RAISE EXCEPTION 'Only BDT currency wallets are allowed (received: %)', COALESCE(NEW.currency, 'NULL');
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.currency IS DISTINCT FROM OLD.currency THEN
      RAISE EXCEPTION 'Wallet currency cannot be changed after creation';
    END IF;
    IF OLD.currency = 'BDT' AND NEW.currency IS DISTINCT FROM 'BDT' THEN
      RAISE EXCEPTION 'Only BDT currency wallets are allowed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wallets_enforce_bdt ON public.wallets;
CREATE TRIGGER trg_wallets_enforce_bdt
  BEFORE INSERT OR UPDATE ON public.wallets
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_wallet_bdt();

CREATE OR REPLACE FUNCTION public.enforce_transaction_bdt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.currency IS DISTINCT FROM 'BDT' THEN
      RAISE EXCEPTION 'Only BDT transactions are permitted (received: %)', COALESCE(NEW.currency, 'NULL');
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.currency IS DISTINCT FROM OLD.currency THEN
      RAISE EXCEPTION 'Transaction currency cannot be modified';
    END IF;
    IF OLD.currency <> 'BDT' THEN
      IF OLD.status <> 'pending' OR NEW.status NOT IN ('completed', 'failed', 'reversed') THEN
        RAISE EXCEPTION 'Historical non-BDT transactions are immutable except finalizing open pending rows';
      END IF;
      IF NEW.amount IS DISTINCT FROM OLD.amount THEN
        RAISE EXCEPTION 'Legacy non-BDT transaction amount cannot be modified';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_transactions_enforce_bdt ON public.transactions;
CREATE TRIGGER trg_transactions_enforce_bdt
  BEFORE INSERT OR UPDATE ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_transaction_bdt();

CREATE OR REPLACE FUNCTION public.enforce_settlement_bdt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.currency IS DISTINCT FROM 'BDT' THEN
      RAISE EXCEPTION 'Only BDT settlement requests are permitted (received: %)', COALESCE(NEW.currency, 'NULL');
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.currency IS DISTINCT FROM OLD.currency THEN
      RAISE EXCEPTION 'Settlement currency cannot be modified';
    END IF;
    IF OLD.currency <> 'BDT' THEN
      IF OLD.status NOT IN ('pending', 'approved') OR NEW.status NOT IN ('approved', 'rejected', 'disbursed') THEN
        RAISE EXCEPTION 'Finalized non-BDT settlement requests are immutable';
      END IF;
      IF NEW.amount IS DISTINCT FROM OLD.amount THEN
        RAISE EXCEPTION 'Legacy non-BDT settlement amount cannot be modified';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_settlements_enforce_bdt ON public.settlement_requests;
CREATE TRIGGER trg_settlements_enforce_bdt
  BEFORE INSERT OR UPDATE ON public.settlement_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_settlement_bdt();

-- ============================================================================
-- 4. SIGNUP TRIGGER: Force 'agent' Role, Collision-Safe Agent ID & 3 BDT Wallets
-- ============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  assigned_role zentopay_role := 'agent';
  generated_agent_code TEXT;
  attempts INTEGER := 0;
  inserted BOOLEAN := FALSE;
  v_constraint TEXT;
BEGIN
  -- Client-provided requested_role is strictly ignored; every new signup receives 'agent'.
  WHILE NOT inserted LOOP
    attempts := attempts + 1;
    IF attempts > 25 THEN
      RAISE EXCEPTION 'Failed to allocate unique 67XXXXXX agent_code during signup';
    END IF;

    generated_agent_code := '67' || LPAD(
      (
        (('x' || substr(replace(gen_random_uuid()::TEXT, '-', ''), 1, 8))::bit(32) & x'7fffffff'::bit(32))::bigint
        % 1000000
      )::TEXT,
      6,
      '0'
    );

    BEGIN
      INSERT INTO public.profiles (
        id, email, full_name, phone, country, business_name, role, agent_code
      )
      VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
        NEW.raw_user_meta_data->>'phone',
        COALESCE(NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'country', '')), ''), 'BD'),
        NEW.raw_user_meta_data->>'business_name',
        assigned_role,
        generated_agent_code
      );
      inserted := TRUE;
    EXCEPTION
      WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint IS NOT NULL AND v_constraint LIKE '%agent_code%' THEN
          inserted := FALSE;
        ELSE
          RAISE;
        END IF;
    END;
  END LOOP;

  -- Provision all 3 Agent wallets strictly in BDT
  INSERT INTO public.wallets (user_id, wallet_type, currency, balance, available_balance)
  VALUES
    (NEW.id, 'main', 'BDT', 0.00, 0.00),
    (NEW.id, 'float', 'BDT', 0.00, 0.00),
    (NEW.id, 'commission', 'BDT', 0.00, 0.00)
  ON CONFLICT (user_id, wallet_type, currency) DO NOTHING;

  RETURN NEW;
END;
$$;

-- ============================================================================
-- 5. HARDENED SECURITY DEFINER RPCs (service_role only, BDT-only, Balanced Ledger)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.execute_wallet_transfer(
  p_sender_wallet_id UUID,
  p_receiver_wallet_id UUID,
  p_initiator_user_id UUID,
  p_amount NUMERIC,
  p_fee_amount NUMERIC,
  p_description TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_amount NUMERIC(18, 2);
  v_fee_amount NUMERIC(18, 2);
  v_total_debit NUMERIC(18, 2);
  v_initiator_role zentopay_role;
  v_initiator_frozen BOOLEAN;
  v_sender_wallet RECORD;
  v_receiver_wallet RECORD;
  v_fee_wallet_id UUID;
  v_super_admin_id UUID;
  v_sender_bal NUMERIC(18, 2);
  v_receiver_bal NUMERIC(18, 2);
  v_fee_bal NUMERIC(18, 2);
  v_tx_id UUID;
  v_ref TEXT;
  v_lock_ids UUID[];
BEGIN
  IF p_sender_wallet_id IS NULL OR p_receiver_wallet_id IS NULL OR p_initiator_user_id IS NULL THEN
    RAISE EXCEPTION 'Missing required transfer identifiers';
  END IF;

  v_amount := ROUND(p_amount::NUMERIC, 2);
  v_fee_amount := ROUND(COALESCE(p_fee_amount, 0.00)::NUMERIC, 2);

  IF v_amount IS NULL OR v_amount <= 0 OR v_fee_amount < 0 THEN
    RAISE EXCEPTION 'Invalid transfer amounts';
  END IF;

  IF p_sender_wallet_id = p_receiver_wallet_id THEN
    RAISE EXCEPTION 'Sender and receiver wallets must differ';
  END IF;

  -- Validate initiator profile & account status
  SELECT role, is_frozen
  INTO v_initiator_role, v_initiator_frozen
  FROM public.profiles
  WHERE id = p_initiator_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Initiator account not found';
  END IF;

  IF COALESCE(v_initiator_frozen, FALSE) THEN
    RAISE EXCEPTION 'Initiator account is frozen';
  END IF;

  -- Resolve Platform Fee Revenue Wallet (BDT settlement wallet owned by active super_admin)
  -- Never deduct a fee without a verified destination wallet & double-entry ledger credit.
  IF v_fee_amount > 0 THEN
    SELECT w.id
    INTO v_fee_wallet_id
    FROM public.wallets w
    JOIN public.profiles p ON p.id = w.user_id
    WHERE w.wallet_type = 'settlement'
      AND w.currency = 'BDT'
      AND w.status = 'active'
      AND p.role = 'super_admin'
      AND p.is_frozen = FALSE
    ORDER BY p.created_at ASC, w.created_at ASC
    LIMIT 1;

    IF v_fee_wallet_id IS NULL THEN
      SELECT id INTO v_super_admin_id
      FROM public.profiles
      WHERE role = 'super_admin' AND is_frozen = FALSE
      ORDER BY created_at ASC
      LIMIT 1;

      IF v_super_admin_id IS NULL THEN
        RAISE EXCEPTION 'Platform fee revenue wallet unavailable';
      END IF;

      INSERT INTO public.wallets (user_id, wallet_type, currency, balance, available_balance, status)
      VALUES (v_super_admin_id, 'settlement', 'BDT', 0.00, 0.00, 'active')
      ON CONFLICT (user_id, wallet_type, currency) DO NOTHING;

      SELECT id INTO v_fee_wallet_id
      FROM public.wallets
      WHERE user_id = v_super_admin_id
        AND wallet_type = 'settlement'
        AND currency = 'BDT'
        AND status = 'active'
      LIMIT 1;

      IF v_fee_wallet_id IS NULL THEN
        RAISE EXCEPTION 'Platform fee revenue wallet unavailable';
      END IF;
    END IF;
  END IF;

  -- Lock all involved wallets in deterministic UUID order to prevent deadlocks
  v_lock_ids := ARRAY[p_sender_wallet_id, p_receiver_wallet_id];
  IF v_fee_wallet_id IS NOT NULL THEN
    v_lock_ids := v_lock_ids || v_fee_wallet_id;
  END IF;

  PERFORM 1
  FROM public.wallets
  WHERE id = ANY(v_lock_ids)
  ORDER BY id ASC
  FOR UPDATE;

  SELECT * INTO v_sender_wallet
  FROM public.wallets
  WHERE id = p_sender_wallet_id AND status = 'active';

  SELECT * INTO v_receiver_wallet
  FROM public.wallets
  WHERE id = p_receiver_wallet_id AND status = 'active';

  IF v_sender_wallet.id IS NULL OR v_receiver_wallet.id IS NULL THEN
    RAISE EXCEPTION 'One or both wallets are inactive or unavailable';
  END IF;

  -- Ownership authorization: initiator must own sender wallet (unless super_admin)
  IF v_sender_wallet.user_id <> p_initiator_user_id AND v_initiator_role <> 'super_admin' THEN
    RAISE EXCEPTION 'Sender wallet not owned by initiator';
  END IF;

  -- Strict BDT-only enforcement
  IF v_sender_wallet.currency <> 'BDT' OR v_receiver_wallet.currency <> 'BDT' THEN
    RAISE EXCEPTION 'Only BDT wallets are allowed for transfers';
  END IF;

  v_total_debit := ROUND((v_amount + v_fee_amount)::NUMERIC, 2);

  IF v_sender_wallet.available_balance < v_total_debit THEN
    RAISE EXCEPTION 'Insufficient available balance';
  END IF;

  UPDATE public.wallets
  SET balance = ROUND((balance - v_total_debit)::NUMERIC, 2),
      available_balance = ROUND((available_balance - v_total_debit)::NUMERIC, 2),
      updated_at = NOW()
  WHERE id = p_sender_wallet_id
  RETURNING balance INTO v_sender_bal;

  UPDATE public.wallets
  SET balance = ROUND((balance + v_amount)::NUMERIC, 2),
      available_balance = ROUND((available_balance + v_amount)::NUMERIC, 2),
      updated_at = NOW()
  WHERE id = p_receiver_wallet_id
  RETURNING balance INTO v_receiver_bal;

  IF v_fee_amount > 0 THEN
    UPDATE public.wallets
    SET balance = ROUND((balance + v_fee_amount)::NUMERIC, 2),
        available_balance = ROUND((available_balance + v_fee_amount)::NUMERIC, 2),
        updated_at = NOW()
    WHERE id = v_fee_wallet_id
    RETURNING balance INTO v_fee_bal;
  END IF;

  v_ref := 'ZP-' || UPPER(SUBSTRING(gen_random_uuid()::TEXT FROM 1 FOR 10));

  INSERT INTO public.transactions (
    reference_code,
    sender_wallet_id,
    receiver_wallet_id,
    initiator_user_id,
    tx_type,
    amount,
    fee_amount,
    currency,
    status,
    description,
    metadata
  ) VALUES (
    v_ref,
    p_sender_wallet_id,
    p_receiver_wallet_id,
    p_initiator_user_id,
    'transfer',
    v_amount,
    v_fee_amount,
    'BDT',
    'completed',
    p_description,
    jsonb_build_object(
      'currency', 'BDT',
      'totalDebit', v_total_debit,
      'feeCredited', v_fee_amount,
      'feeWalletId', v_fee_wallet_id
    )
  ) RETURNING id INTO v_tx_id;

  INSERT INTO public.ledger_entries (transaction_id, wallet_id, entry_type, amount, balance_after)
  VALUES
    (v_tx_id, p_sender_wallet_id, 'debit', v_total_debit, v_sender_bal),
    (v_tx_id, p_receiver_wallet_id, 'credit', v_amount, v_receiver_bal);

  IF v_fee_amount > 0 THEN
    INSERT INTO public.ledger_entries (transaction_id, wallet_id, entry_type, amount, balance_after)
    VALUES (v_tx_id, v_fee_wallet_id, 'credit', v_fee_amount, v_fee_bal);
  END IF;

  INSERT INTO public.audit_logs (
    actor_id, actor_role, action, target_table, target_id, payload
  ) VALUES (
    p_initiator_user_id,
    v_initiator_role::TEXT,
    'wallet_transfer_executed',
    'transactions',
    v_tx_id,
    jsonb_build_object(
      'referenceCode', v_ref,
      'senderWalletId', p_sender_wallet_id,
      'receiverWalletId', p_receiver_wallet_id,
      'feeWalletId', v_fee_wallet_id,
      'amount', v_amount,
      'feeAmount', v_fee_amount,
      'currency', 'BDT'
    )
  );

  RETURN v_tx_id;
END;
$$;

REVOKE ALL ON FUNCTION public.execute_wallet_transfer(UUID, UUID, UUID, NUMERIC, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.execute_wallet_transfer(UUID, UUID, UUID, NUMERIC, NUMERIC, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.activate_agent_gateway(
  p_user_id UUID,
  p_provider TEXT,
  p_account_mode TEXT,
  p_account_number TEXT,
  p_min_required_balance NUMERIC DEFAULT 1000.00
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role zentopay_role;
  v_frozen BOOLEAN;
  v_clean_number TEXT := TRIM(COALESCE(p_account_number, ''));
  v_required_min NUMERIC(18, 2);
  v_wallet_balance NUMERIC(18, 2);
  v_gateway_id UUID;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Missing user ID';
  END IF;

  SELECT role, is_frozen
  INTO v_role, v_frozen
  FROM public.profiles
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent profile not found';
  END IF;

  IF COALESCE(v_frozen, FALSE) THEN
    RAISE EXCEPTION 'Account is frozen and cannot activate gateways';
  END IF;

  IF v_role NOT IN ('agent', 'sub_agent', 'user', 'super_admin') THEN
    RAISE EXCEPTION 'Account role (%) is not permitted to activate agent gateways', v_role;
  END IF;

  IF p_provider NOT IN ('bkash', 'nagad', 'rocket') THEN
    RAISE EXCEPTION 'Unsupported MFS provider for BDT gateway: %', COALESCE(p_provider, 'NULL');
  END IF;

  IF p_account_mode NOT IN ('personal', 'merchant', 'agent') THEN
    RAISE EXCEPTION 'Invalid account mode: %', COALESCE(p_account_mode, 'NULL');
  END IF;

  IF v_clean_number !~ '^01[0-9]{9}$' THEN
    RAISE EXCEPTION 'Invalid Bangladeshi mobile account number (expected 01XXXXXXXXX)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.agent_gateways
    WHERE provider = p_provider
      AND account_number = v_clean_number
      AND user_id <> p_user_id
  ) THEN
    RAISE EXCEPTION 'This gateway account number is already registered to another agent';
  END IF;

  v_required_min := GREATEST(ROUND(COALESCE(p_min_required_balance, 1000.00)::NUMERIC, 2), 1000.00);

  SELECT COALESCE(MAX(available_balance), 0.00)
  INTO v_wallet_balance
  FROM public.wallets
  WHERE user_id = p_user_id
    AND status = 'active'
    AND currency = 'BDT'
    AND wallet_type IN ('main', 'float');

  IF v_wallet_balance < v_required_min THEN
    RAISE EXCEPTION 'Insufficient BDT wallet balance for gateway activation. Minimum required balance is % BDT (activation is FREE and deducts 0 BDT).', v_required_min;
  END IF;

  INSERT INTO public.agent_gateways (
    user_id, provider, account_mode, account_number, min_required_balance, activation_fee, is_active
  )
  VALUES (
    p_user_id, p_provider, p_account_mode, v_clean_number, v_required_min, 0.00, TRUE
  )
  ON CONFLICT (user_id, provider, account_number)
  DO UPDATE SET
    account_mode = EXCLUDED.account_mode,
    min_required_balance = EXCLUDED.min_required_balance,
    is_active = TRUE,
    activated_at = NOW()
  RETURNING id INTO v_gateway_id;

  INSERT INTO public.audit_logs (actor_id, actor_role, action, target_table, target_id, payload)
  VALUES (
    p_user_id,
    v_role::TEXT,
    'gateway_activated_free',
    'agent_gateways',
    v_gateway_id,
    jsonb_build_object(
      'provider', p_provider,
      'account_mode', p_account_mode,
      'account_number', v_clean_number,
      'verified_balance', v_wallet_balance,
      'currency', 'BDT',
      'fee_deducted', 0.00
    )
  );

  RETURN v_gateway_id;
END;
$$;

REVOKE ALL ON FUNCTION public.activate_agent_gateway(UUID, TEXT, TEXT, TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_agent_gateway(UUID, TEXT, TEXT, TEXT, NUMERIC) TO service_role;

-- ============================================================================
-- 6. PLATFORM CONFIG TABLE: Create Safely, Reset All Policies, Admin-Only RLS
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.platform_config (
  config_key TEXT PRIMARY KEY,
  config_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.platform_config ENABLE ROW LEVEL SECURITY;

-- Drop EVERY existing policy on public.platform_config (even unexpected names)
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'platform_config'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.platform_config', pol.policyname);
  END LOOP;
END $$;

REVOKE ALL ON TABLE public.platform_config FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_config TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_config TO authenticated;

CREATE POLICY "platform_config_select_admins" ON public.platform_config
  FOR SELECT TO authenticated
  USING (public.is_admin_role(ARRAY['super_admin', 'finance_admin']::zentopay_role[]));

CREATE POLICY "platform_config_insert_super_admin" ON public.platform_config
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin_role(ARRAY['super_admin']::zentopay_role[]));

CREATE POLICY "platform_config_update_super_admin" ON public.platform_config
  FOR UPDATE TO authenticated
  USING (public.is_admin_role(ARRAY['super_admin']::zentopay_role[]))
  WITH CHECK (public.is_admin_role(ARRAY['super_admin']::zentopay_role[]));

CREATE POLICY "platform_config_delete_super_admin" ON public.platform_config
  FOR DELETE TO authenticated
  USING (public.is_admin_role(ARRAY['super_admin']::zentopay_role[]));

-- Seed default ewallet_config strictly once (ON CONFLICT DO NOTHING preserves existing config)
INSERT INTO public.platform_config (config_key, config_value)
VALUES (
  'ewallet_config',
  '{
    "depositMethods": [
      { "id": "bkash", "name": "bKash", "accountNumber": "", "accountLabel": "bKash Personal/Agent", "enabled": false },
      { "id": "nagad", "name": "Nagad", "accountNumber": "", "accountLabel": "Nagad Personal/Agent", "enabled": false },
      { "id": "rocket", "name": "Rocket", "accountNumber": "", "accountLabel": "Rocket Personal/Agent", "enabled": false }
    ],
    "commissionRates": {
      "bkash": 0.05,
      "nagad": 0.04,
      "rocket": 0.04
    },
    "supportLinks": {
      "telegram": "",
      "whatsapp": "",
      "affiliateManagerTelegram": ""
    },
    "socialNetworks": [
      { "id": "facebook", "name": "Facebook", "url": "" },
      { "id": "youtube", "name": "YouTube", "url": "" },
      { "id": "telegram", "name": "Telegram", "url": "" }
    ],
    "partners": [],
    "globalNotifications": []
  }'::jsonb
)
ON CONFLICT (config_key) DO NOTHING;

-- Backfill commissionRates key safely if an existing ewallet_config row lacks it (preserves depositMethods & custom settings)
UPDATE public.platform_config
SET config_value = jsonb_set(
      config_value,
      '{commissionRates}',
      '{"bkash": 0.05, "nagad": 0.04, "rocket": 0.04}'::jsonb,
      TRUE
    ),
    updated_at = NOW()
WHERE config_key = 'ewallet_config'
  AND NOT (config_value ? 'commissionRates');

-- Authoritative DB helper to resolve MFS provider payment commission rates (Single Source of Truth)
-- Authoritative defaults: bKash = 5% (0.05), Nagad = 4% (0.04), Rocket = 4% (0.04)
CREATE OR REPLACE FUNCTION public.get_provider_commission_rate(p_provider TEXT)
RETURNS NUMERIC(5, 4)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_provider TEXT := LOWER(TRIM(COALESCE(p_provider, '')));
  v_default NUMERIC(5, 4);
  v_raw TEXT;
  v_parsed NUMERIC(5, 4);
BEGIN
  IF v_provider = 'bkash' THEN
    v_default := 0.0500;
  ELSIF v_provider = 'nagad' THEN
    v_default := 0.0400;
  ELSIF v_provider = 'rocket' THEN
    v_default := 0.0400;
  ELSE
    RAISE EXCEPTION 'Unsupported MFS provider for commission rate: %', COALESCE(p_provider, 'NULL');
  END IF;

  SELECT config_value->'commissionRates'->>v_provider
  INTO v_raw
  FROM public.platform_config
  WHERE config_key = 'ewallet_config'
  LIMIT 1;

  IF v_raw IS NOT NULL AND v_raw ~ '^[0-9]+(\.[0-9]+)?$' THEN
    v_parsed := ROUND(v_raw::NUMERIC, 4);
    IF v_parsed >= 0 AND v_parsed <= 0.2500 THEN
      RETURN v_parsed;
    END IF;
  END IF;

  RETURN v_default;
END;
$$;

REVOKE ALL ON FUNCTION public.get_provider_commission_rate(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_provider_commission_rate(TEXT) TO service_role;

-- Notify PostgREST to reload schema cache immediately
NOTIFY pgrst, 'reload schema';
