-- ZentoPay Core PostgreSQL Schema, Double-Entry Ledger & Row Level Security
-- Target: Supabase PostgreSQL 15+

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Domain Enums
DO $$ BEGIN
  CREATE TYPE zentopay_role AS ENUM (
    'user',
    'agent',
    'sub_agent',
    'super_admin',
    'finance_admin',
    'support_admin'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE kyc_status_type AS ENUM ('unverified', 'pending', 'verified', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE wallet_type_enum AS ENUM ('main', 'float', 'commission', 'settlement');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tx_type_enum AS ENUM (
    'deposit',
    'transfer',
    'withdrawal',
    'cash_in',
    'cash_out',
    'gateway_payment',
    'commission',
    'settlement',
    'adjustment'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tx_status_enum AS ENUM ('pending', 'completed', 'failed', 'reversed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Profiles (1-to-1 with auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  phone TEXT,
  country TEXT NOT NULL DEFAULT 'US',
  business_name TEXT,
  role zentopay_role NOT NULL DEFAULT 'user',
  kyc_status kyc_status_type NOT NULL DEFAULT 'unverified',
  parent_agent_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  is_frozen BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Wallets (Double-entry constrained balances)
CREATE TABLE IF NOT EXISTS public.wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  wallet_type wallet_type_enum NOT NULL DEFAULT 'main',
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  balance NUMERIC(18, 2) NOT NULL DEFAULT 0.00 CHECK (balance >= 0),
  available_balance NUMERIC(18, 2) NOT NULL DEFAULT 0.00 CHECK (available_balance >= 0),
  daily_limit NUMERIC(18, 2) NOT NULL DEFAULT 5000.00,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, wallet_type, currency)
);

-- 4. Financial Transactions
CREATE TABLE IF NOT EXISTS public.transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_code TEXT NOT NULL UNIQUE,
  sender_wallet_id UUID REFERENCES public.wallets(id),
  receiver_wallet_id UUID REFERENCES public.wallets(id),
  initiator_user_id UUID NOT NULL REFERENCES public.profiles(id),
  tx_type tx_type_enum NOT NULL,
  amount NUMERIC(18, 2) NOT NULL CHECK (amount > 0),
  fee_amount NUMERIC(18, 2) NOT NULL DEFAULT 0.00 CHECK (fee_amount >= 0),
  commission_amount NUMERIC(18, 2) NOT NULL DEFAULT 0.00 CHECK (commission_amount >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  status tx_status_enum NOT NULL DEFAULT 'pending',
  description TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Immutable Double-Entry Ledger Lines
CREATE TABLE IF NOT EXISTS public.ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
  wallet_id UUID NOT NULL REFERENCES public.wallets(id) ON DELETE RESTRICT,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('debit', 'credit')),
  amount NUMERIC(18, 2) NOT NULL CHECK (amount > 0),
  balance_after NUMERIC(18, 2) NOT NULL CHECK (balance_after >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Agent & Sub-Agent Hierarchy
CREATE TABLE IF NOT EXISTS public.agent_hierarchy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  sub_agent_id UUID NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  commission_rate NUMERIC(5, 4) NOT NULL DEFAULT 0.0125,
  float_cap NUMERIC(18, 2) NOT NULL DEFAULT 10000.00,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Settlement & Payout Requests
CREATE TABLE IF NOT EXISTS public.settlement_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES public.profiles(id),
  wallet_id UUID NOT NULL REFERENCES public.wallets(id),
  amount NUMERIC(18, 2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  destination_bank TEXT NOT NULL,
  account_last4 CHAR(4) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'disbursed')),
  reviewed_by UUID REFERENCES public.profiles(id),
  reviewed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. KYC Document Submissions (files stored in private Supabase Storage bucket)
CREATE TABLE IF NOT EXISTS public.kyc_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('passport', 'national_id', 'business_license', 'proof_of_address')),
  storage_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewer_id UUID REFERENCES public.profiles(id),
  review_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. Support Tickets
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assigned_to UUID REFERENCES public.profiles(id),
  category TEXT NOT NULL CHECK (category IN ('wallet', 'transfer', 'kyc', 'agent_float', 'gateway', 'dispute')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10. Payment Gateway Merchant Configurations
CREATE TABLE IF NOT EXISTS public.gateway_merchants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  merchant_name TEXT NOT NULL,
  webhook_url TEXT,
  public_key TEXT NOT NULL UNIQUE,
  secret_key_hash TEXT NOT NULL,
  fee_bps INTEGER NOT NULL DEFAULT 150,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. Immutable Audit Logs
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES public.profiles(id),
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  target_table TEXT NOT NULL,
  target_id UUID,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 12. Helper Functions for RLS
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS zentopay_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_admin_role(allowed zentopay_role[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT role = ANY(allowed) FROM public.profiles WHERE id = auth.uid()), FALSE);
$$;

-- 13. Auto-provision Profile & Default Main Wallet on Auth Signup
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  assigned_role zentopay_role := 'user';
  requested_role TEXT := COALESCE(NEW.raw_user_meta_data->>'requested_role', 'user');
BEGIN
  -- Restrict self-registration strictly to non-privileged roles
  IF requested_role IN ('user', 'agent', 'sub_agent') THEN
    assigned_role := requested_role::zentopay_role;
  END IF;

  INSERT INTO public.profiles (id, email, full_name, phone, country, business_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    NEW.raw_user_meta_data->>'phone',
    COALESCE(NEW.raw_user_meta_data->>'country', 'US'),
    NEW.raw_user_meta_data->>'business_name',
    assigned_role
  );

  INSERT INTO public.wallets (user_id, wallet_type, currency, balance, available_balance)
  VALUES (NEW.id, 'main', 'USD', 0.00, 0.00);

  IF assigned_role IN ('agent', 'sub_agent') THEN
    INSERT INTO public.wallets (user_id, wallet_type, currency, balance, available_balance)
    VALUES
      (NEW.id, 'float', 'USD', 0.00, 0.00),
      (NEW.id, 'commission', 'USD', 0.00, 0.00);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- 14. Atomic Wallet Transfer RPC (Executed server-side / Edge Function)
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
  v_sender_bal NUMERIC(18, 2);
  v_receiver_bal NUMERIC(18, 2);
  v_total_debit NUMERIC(18, 2);
  v_tx_id UUID;
  v_ref TEXT;
BEGIN
  IF p_amount <= 0 OR p_fee_amount < 0 THEN
    RAISE EXCEPTION 'Invalid transfer amounts';
  END IF;
  IF p_sender_wallet_id = p_receiver_wallet_id THEN
    RAISE EXCEPTION 'Sender and receiver wallets must differ';
  END IF;

  v_total_debit := p_amount + p_fee_amount;

  -- Lock wallets in deterministic UUID order to avoid deadlocks
  IF p_sender_wallet_id < p_receiver_wallet_id THEN
    SELECT available_balance INTO v_sender_bal FROM public.wallets WHERE id = p_sender_wallet_id AND status = 'active' FOR UPDATE;
    SELECT available_balance INTO v_receiver_bal FROM public.wallets WHERE id = p_receiver_wallet_id AND status = 'active' FOR UPDATE;
  ELSE
    SELECT available_balance INTO v_receiver_bal FROM public.wallets WHERE id = p_receiver_wallet_id AND status = 'active' FOR UPDATE;
    SELECT available_balance INTO v_sender_bal FROM public.wallets WHERE id = p_sender_wallet_id AND status = 'active' FOR UPDATE;
  END IF;

  IF v_sender_bal IS NULL OR v_receiver_bal IS NULL THEN
    RAISE EXCEPTION 'One or both wallets are inactive or unavailable';
  END IF;

  IF v_sender_bal < v_total_debit THEN
    RAISE EXCEPTION 'Insufficient available balance';
  END IF;

  UPDATE public.wallets
    SET balance = balance - v_total_debit,
        available_balance = available_balance - v_total_debit,
        updated_at = NOW()
    WHERE id = p_sender_wallet_id
    RETURNING balance INTO v_sender_bal;

  UPDATE public.wallets
    SET balance = balance + p_amount,
        available_balance = available_balance + p_amount,
        updated_at = NOW()
    WHERE id = p_receiver_wallet_id
    RETURNING balance INTO v_receiver_bal;

  v_ref := 'ZP-' || UPPER(SUBSTRING(gen_random_uuid()::TEXT FROM 1 FOR 10));

  INSERT INTO public.transactions (
    reference_code, sender_wallet_id, receiver_wallet_id, initiator_user_id,
    tx_type, amount, fee_amount, currency, status, description
  ) VALUES (
    v_ref, p_sender_wallet_id, p_receiver_wallet_id, p_initiator_user_id,
    'transfer', p_amount, p_fee_amount, 'USD', 'completed', p_description
  ) RETURNING id INTO v_tx_id;

  INSERT INTO public.ledger_entries (transaction_id, wallet_id, entry_type, amount, balance_after)
  VALUES
    (v_tx_id, p_sender_wallet_id, 'debit', v_total_debit, v_sender_bal),
    (v_tx_id, p_receiver_wallet_id, 'credit', p_amount, v_receiver_bal);

  RETURN v_tx_id;
END;
$$;

-- 15. Enable Row Level Security Across All Tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_hierarchy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlement_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kyc_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gateway_merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Profiles RLS
CREATE POLICY "profiles_select_self_or_staff" ON public.profiles
  FOR SELECT USING (
    id = auth.uid()
    OR parent_agent_id = auth.uid()
    OR public.is_admin_role(ARRAY['super_admin', 'finance_admin', 'support_admin']::zentopay_role[])
  );

CREATE POLICY "profiles_update_self_safe" ON public.profiles
  FOR UPDATE USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY "profiles_admin_manage" ON public.profiles
  FOR ALL USING (public.is_admin_role(ARRAY['super_admin']::zentopay_role[]));

-- Wallets RLS (Direct client balance mutation is strictly blocked; reads scoped to owner/finance/super_admin)
CREATE POLICY "wallets_select_owner_or_finance" ON public.wallets
  FOR SELECT USING (
    user_id = auth.uid()
    OR public.is_admin_role(ARRAY['super_admin', 'finance_admin']::zentopay_role[])
  );

-- Transactions RLS
CREATE POLICY "transactions_select_party_or_admins" ON public.transactions
  FOR SELECT USING (
    initiator_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.wallets w
      WHERE (w.id = sender_wallet_id OR w.id = receiver_wallet_id)
        AND w.user_id = auth.uid()
    )
    OR public.is_admin_role(ARRAY['super_admin', 'finance_admin', 'support_admin']::zentopay_role[])
  );

-- Ledger Entries RLS
CREATE POLICY "ledger_select_wallet_owner_or_finance" ON public.ledger_entries
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.wallets w
      WHERE w.id = wallet_id AND w.user_id = auth.uid()
    )
    OR public.is_admin_role(ARRAY['super_admin', 'finance_admin']::zentopay_role[])
  );

-- Agent Hierarchy RLS
CREATE POLICY "agent_hierarchy_select" ON public.agent_hierarchy
  FOR SELECT USING (
    agent_id = auth.uid()
    OR sub_agent_id = auth.uid()
    OR public.is_admin_role(ARRAY['super_admin', 'finance_admin']::zentopay_role[])
  );

-- Settlement Requests RLS
CREATE POLICY "settlements_select" ON public.settlement_requests
  FOR SELECT USING (
    requester_id = auth.uid()
    OR public.is_admin_role(ARRAY['super_admin', 'finance_admin']::zentopay_role[])
  );

CREATE POLICY "settlements_insert_self" ON public.settlement_requests
  FOR INSERT WITH CHECK (requester_id = auth.uid());

-- KYC Submissions RLS
CREATE POLICY "kyc_select_owner_or_support" ON public.kyc_submissions
  FOR SELECT USING (
    user_id = auth.uid()
    OR public.is_admin_role(ARRAY['super_admin', 'support_admin']::zentopay_role[])
  );

CREATE POLICY "kyc_insert_owner" ON public.kyc_submissions
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- Support Tickets RLS
CREATE POLICY "tickets_select_owner_or_support" ON public.support_tickets
  FOR SELECT USING (
    user_id = auth.uid()
    OR public.is_admin_role(ARRAY['super_admin', 'support_admin']::zentopay_role[])
  );

CREATE POLICY "tickets_insert_owner" ON public.support_tickets
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "tickets_update_support" ON public.support_tickets
  FOR UPDATE USING (public.is_admin_role(ARRAY['super_admin', 'support_admin']::zentopay_role[]));

-- Gateway Merchants RLS
CREATE POLICY "gateway_select_owner_or_super" ON public.gateway_merchants
  FOR SELECT USING (
    owner_id = auth.uid()
    OR public.is_admin_role(ARRAY['super_admin', 'finance_admin']::zentopay_role[])
  );

-- Audit Logs RLS (Read-only for Super Admin & Finance Admin)
CREATE POLICY "audit_select_admins" ON public.audit_logs
  FOR SELECT USING (
    public.is_admin_role(ARRAY['super_admin', 'finance_admin']::zentopay_role[])
  );

-- 16. Supabase Storage Bucket for Private KYC Documents
INSERT INTO storage.buckets (id, name, public)
VALUES ('kyc-documents', 'kyc-documents', FALSE)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "kyc_storage_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'kyc-documents'
    AND (storage.foldername(name))[1] = auth.uid()::TEXT
  );

CREATE POLICY "kyc_storage_read_own_or_support" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'kyc-documents'
    AND (
      (storage.foldername(name))[1] = auth.uid()::TEXT
      OR public.is_admin_role(ARRAY['super_admin', 'support_admin']::zentopay_role[])
    )
  );
