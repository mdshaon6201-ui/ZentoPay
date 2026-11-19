-- ZentoPay Migration 007 (Idempotent & Non-Destructive)
-- Target: Supabase PostgreSQL 15+ (Manual execution in Supabase SQL Editor)
-- Purpose:
--   1. Ensure public.profiles includes withdraw_pin_hash (and companion Agent Portal
--      columns from migration 004) without modifying existing rows, roles, wallets,
--      or balances.
--   2. Preserve all existing Row Level Security (RLS) policies on public.profiles.
--   3. Reload PostgREST schema cache immediately so /api/agent/withdraw-pin and
--      /api/settlements recognize profiles.withdraw_pin_hash.

-- ============================================================================
-- 1. ADD MISSING PROFILE COLUMNS SAFELY (NO-OP IF ALREADY PRESENT)
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
-- 2. VERIFY RLS REMAINS ENABLED ON public.profiles
-- ============================================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Reload PostgREST schema cache immediately
NOTIFY pgrst, 'reload schema';
