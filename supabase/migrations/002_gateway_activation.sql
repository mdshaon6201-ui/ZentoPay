-- ZentoPay Free Gateway Activation Schema & Zero-Deduction RPC
-- Business Rule: Gateway activation is FREE. Agents must have sufficient wallet balance,
-- and activation MUST NOT deduct any money.

CREATE TABLE IF NOT EXISTS public.agent_gateways (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('bkash', 'nagad', 'rocket', 'binance')),
  account_mode TEXT NOT NULL CHECK (account_mode IN ('personal', 'merchant', 'agent')),
  account_number TEXT NOT NULL,
  min_required_balance NUMERIC(18, 2) NOT NULL DEFAULT 50.00,
  activation_fee NUMERIC(18, 2) NOT NULL DEFAULT 0.00 CHECK (activation_fee = 0.00),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider, account_number)
);

ALTER TABLE public.agent_gateways ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_gateways_select_owner_or_admin" ON public.agent_gateways
  FOR SELECT USING (
    user_id = auth.uid()
    OR public.is_admin_role(ARRAY['super_admin', 'finance_admin', 'support_admin']::zentopay_role[])
  );

-- Atomic Free Gateway Activation RPC (verifies balance without deducting funds)
CREATE OR REPLACE FUNCTION public.activate_agent_gateway(
  p_user_id UUID,
  p_provider TEXT,
  p_account_mode TEXT,
  p_account_number TEXT,
  p_min_required_balance NUMERIC DEFAULT 50.00
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet_balance NUMERIC(18, 2);
  v_gateway_id UUID;
BEGIN
  SELECT COALESCE(MAX(available_balance), 0.00)
  INTO v_wallet_balance
  FROM public.wallets
  WHERE user_id = p_user_id
    AND status = 'active'
    AND wallet_type IN ('float', 'main');

  IF v_wallet_balance < p_min_required_balance THEN
    RAISE EXCEPTION 'Insufficient wallet balance for gateway activation. Minimum required balance is % USD (activation is FREE and deducts $0.00).', p_min_required_balance;
  END IF;

  INSERT INTO public.agent_gateways (
    user_id, provider, account_mode, account_number, min_required_balance, activation_fee, is_active
  )
  VALUES (
    p_user_id, p_provider, p_account_mode, p_account_number, p_min_required_balance, 0.00, TRUE
  )
  ON CONFLICT (user_id, provider, account_number)
  DO UPDATE SET
    account_mode = EXCLUDED.account_mode,
    is_active = TRUE,
    activated_at = NOW()
  RETURNING id INTO v_gateway_id;

  INSERT INTO public.audit_logs (actor_id, actor_role, action, target_table, target_id, payload)
  VALUES (
    p_user_id,
    COALESCE((SELECT role::TEXT FROM public.profiles WHERE id = p_user_id), 'agent'),
    'gateway_activated_free',
    'agent_gateways',
    v_gateway_id,
    jsonb_build_object(
      'provider', p_provider,
      'account_mode', p_account_mode,
      'verified_balance', v_wallet_balance,
      'fee_deducted', 0.00
    )
  );

  RETURN v_gateway_id;
END;
$$;
