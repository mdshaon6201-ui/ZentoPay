# ZentoPay — Project Status & eWalletUp 1:1 Parity Log

**Reference Architecture:** `https://ewalletup.com/` (`eWallet Up - MFS Agent`) & `https://ewalletup.com/policy`  
**Language & Branding:** 100% Bengali (`bn`) UI with ZentoPay Branding  
**Backend Stack:** Express (`server.ts`), Vite + React + TypeScript + Tailwind CSS, Supabase PostgreSQL (RLS + Double-Entry Ledger + Auth)

---

## 1. Verified Implemented Features

### A. Mobile App Shell & Authentication (`/`, `/login`, `/register`, `/policy`)
- **Exact `430px` Centered Mobile App Frame** (`.ew-mobile-viewport > .app-container`) with `#043824` backdrop and forest-green color palette (`#075B3A`, `#0B7A4A`, `#16A66A`, `#E9F7F0`, `#F4F7F5`).
- **Splash Screen**: Brand emblem, tagline, animated loading bar, automatic 1.35s transition to Login (or auto-redirect to role portal when session active).
- **Login Screen**: Email + Password authentication, Remember Me (`localStorage`), Forgot Password email reset modal (`supabase.auth.resetPasswordForEmail`), visual Google/Apple quick buttons, Help link, Agent Policy link.
- **Register Screen**: Full Name, Email, Bangladeshi Phone Number, Password (min 6 chars), Confirm Password, optional Affiliate Referral Agent ID (`67XXXXXX`, auto-read from `?ref=` query param), Policy & Terms checkbox.
- **Agent Policy & Onboarding Guide (`/policy`)**: Full-width responsive Bengali guide covering stats (`500+ Agent`, `70+ Partners`, `bKash 5%`, `Nagad/Rocket 4%`), ZentoPay overview, Agent responsibilities, requirements, `Trial Plan` (`৳৫,০০০`) vs `Premium Plan` (`৳১৫,০০০`), Commission/Withdraw/KYC/Refund rules, 9-item interactive FAQ accordion, and CTA buttons.

### B. Unified Agent Portal (`/dashboard/agent`)
- **Header & Slide-in Left Drawer**: Menu trigger, `ZentoPay` emblem, Notification Bell (unread count badge) + modal (Global + Personal alerts), Support shortcut, and 9-link Slide Drawer (`হোম`, `লেনদেন`, `সার্ভিস প্ল্যান`, `MFS গেটওয়ে`, `হেল্প ও সাপোর্ট`, `আমাদের পার্টনার`, `সোশ্যাল নেটওয়ার্ক`, `অ্যাফিলিয়েট প্রোগ্রাম`, `সেটিংস`) + `লগআউট`.
- **Fixed 4-Tab Bottom Navigation**: `হোম`, `লেনদেন`, `সার্ভিস`, `সেটিংস`.
- **Home Tab (`dashboard`)**:
  - Forest-green balance card (`মোট ব্যালেন্স` in `৳`, active plan/ID tag, `+` quick add funds button).
  - 4 Balance Card Actions (`Withdraw`, `Gateway`, `Bet Payout` with live red pending badge, `Bet Deposit` with live red pending badge).
  - Quick Actions Row (`Add Balance`, `Withdraw`).
  - `আজকের সারসংক্ষেপ` 2×2 real-data overview (`আজকের কমিশন`, `আজকের ডিপোজিট`, `আজকের পেআউট`, `আজকের লেনদেন`).
  - `সাম্প্রতিক লেনদেন` real ledger + settlement feed with `সব দেখুন` link.
- **Transactions Tab (`transactions`)**: Full chronological feed merging wallet transactions and withdrawal requests with Bengali status pills (`অনুমোদিত`, `অপেক্ষমাণ`, `প্রত্যাখ্যাত`).
- **Service Tab (`service`)**: Exact 2 plan cards — `Trial Plan` (`৳৫,০০০`, 30 দিন) and `Premium Plan` (`৳১৫,০০০`, লাইফটাইম) with locked plan deposit handoff to Add Funds.
- **Settings Tab (`settings`)**: Profile card (avatar upload modal, Verified badge, `Agent ID: 67XXXXXX` + Copy), Personal Information card (`এজেন্ট আইডি` + Copy), KYC Verification modal (`NID` name, DOB, NID number, private Supabase Storage front photo upload), Personal Info edit modal, Change Password modal, Withdraw PIN setup/change modal (scrypt hashed server-side), Social & Support shortcuts, Logout confirmation modal.
- **11 Verified Sub-Screens (`AgentSubScreens.tsx`)**:
  1. `MFS Gateway`: `bKash`, `Nagad`, `Rocket` × (`Personal`, `Agent`, `Merchant`), enforces min `৳১,০০০` BDT balance & `01XXXXXXXXX` regex, `৳০` fee.
  2. `Add Balance` (`add-funds`) & `Deposit Details` (`payment-detail`): Renders Admin-configured BDT methods (`bKash`, `Nagad`, `Rocket`, and custom BDT channels), copyable payment number/ID, min `৳১,০০০` (or locked `৳৫,০০০`/`৳১৫,০০০` for plans), sender account, TrxID, optional screenshot.
  3. `Bet Deposit` (`payment-collection`) & `Bet Payout` (`payment-payout`) (bKash `5%`, Nagad `4%`, Rocket `4%` DB-authoritative rates): Approve with TrxID / balance check (idempotency-protected) or Decline pending requests.
  4. `Withdraw` & `Withdraw Funds`: `bKash`, `Nagad`, `Rocket`, `Bank Transfer`, min `৳৫০০`, server-verified Withdraw PIN.
  5. `Help & Support`: Admin-configured Telegram & WhatsApp support links.
  6. `Our Partners`: Admin-configured partner cards (honest empty state when unconfigured).
  7. `Social Networks`: Facebook, YouTube, Telegram links from Platform Config.
  8. `Affiliate Program`: Live 30-day account age + Premium Plan eligibility status, permanent `এজেন্ট আইডি`, `১%` Deposit & `১%` Payout commission metrics, copyable `?ref=67XXXXXX` link & referral count.

### C. Preserved & Extended Admin Dashboards
- **Finance Admin Dashboard (`/dashboard/finance-admin`)**: Preserves Deposit Verification (`planActivation` badge + auto-activation on approval + 1% affiliate deposit commission), Settlement/Withdraw Review, Ledger Reconciliation + CSV Export, AND adds **Bet Deposit / Payout** dispatch (`POST /api/admin/mfs-requests`, server-authoritative provider commission rates + `user_notifications` delivery) & tracking queue.
- **Super Admin Dashboard (`/dashboard/super-admin`)**: Preserves User/Role/Freeze Management (`Agent ID` & `active_plan` visible), Fee Matrix, Immutable Audit Logs, AND adds **প্ল্যাটফর্ম কনফিগারেশন** (`PUT /api/admin/commission-rates`, `PUT /api/admin/platform-config`, `POST/PATCH/DELETE /api/admin/payment-methods` for BDT deposit methods, provider commission rates, support links, social URLs, partners, global notifications) + **ব্যক্তিগত নোটিফিকেশন** sender (`POST /api/admin/notifications`).
- **Support Admin Dashboard (`/dashboard/support-admin`)**: Preserves Support Ticket resolution, Account Freeze/Unfreeze, and KYC Review Drawer (now also displaying submitted NID metadata: Name, DOB, NID number).

---

## 2. Additive Database Migrations (`002b`, `004`, `005`, `006`)
All changes are **strictly non-destructive** — existing historical financial records, wallets, ledger entries, and privileged admin roles remain intact:
1. **`002b_agent_bdt_config_fix.sql` (Core Security, Agent ID, BDT-Only & `platform_config` Fix)**:
   - Adds collision-safe, permanent, immutable `agent_code` (`^67[0-9]{6}$`) on `public.profiles` with advisory-locked `23505`-retry backfill and field protection trigger (`trg_profiles_protect_fields`).
   - Forces `'agent'` role on public signup (`handle_new_auth_user()`) and creates `'main'`, `'float'`, `'commission'` wallets in `'BDT'`.
   - Enforces BDT-only on new wallets, transactions, and settlements via defaults + legacy-safe triggers.
   - Hardens `execute_wallet_transfer()` and `activate_agent_gateway()`, both restricted to `service_role`.
   - Creates `public.platform_config`, seeds BDT defaults + authoritative `commissionRates` (`bkash: 0.05`, `nagad: 0.04`, `rocket: 0.04`), provides `public.get_provider_commission_rate()`, and reloads PostgREST schema cache.
2. **`004_mfs_requests_and_notifications.sql` (MFS Routing, Notifications & Affiliate RPCs)**:
   - Extends `tx_type_enum` (`payment_collection`, `payment_payout`, `affiliate_commission`) and adds profile columns (`withdraw_pin_hash`, `active_plan`, `plan_activated_at`, `referred_by_agent_id`, `avatar_url`).
   - Creates `public.mfs_payment_requests` and `public.user_notifications` with strict RLS (`agent_id = auth.uid()` / `user_id = auth.uid()` or authorized Admins).
   - Defines `approve_mfs_payment_request()` and `credit_affiliate_commission()` (`service_role` only).
3. **`005_install_approve_mfs_rpc.sql` (Standalone Idempotent RPC Install & Preflight Check)**:
   - Ensures `tx_type_enum` values (`payment_collection`, `payment_payout`, `affiliate_commission`) exist.
   - Runs a preflight verification block across `mfs_payment_requests`, `wallets`, `transactions`, `ledger_entries`, `audit_logs`, `profiles`, and `platform_config`.
   - Installs `public.approve_mfs_payment_request(p_request_id UUID, p_agent_id UUID, p_trx_id TEXT DEFAULT NULL)` as `SECURITY DEFINER` with `SET search_path = public`, restricted strictly to `service_role`.
4. **`006_fix_mfs_payout_wallet_record.sql` (Fix `v_payout_wallet` `%ROWTYPE` & `payment_collection` `NULL` `sender_wallet_id`)**:
   - Fixes `record "v_payout_wallet" is not assigned yet` during `payment_collection` (`Bet Deposit`) approval by replacing `RECORD` declarations with `public.wallets%ROWTYPE` / `public.mfs_payment_requests%ROWTYPE` and explicit `v_sender_wallet_id UUID := NULL`.
   - Preserves `SELECT ... FOR UPDATE` payout wallet locking/debiting for `payment_payout`, commission calculation (`bKash 5%`, `Nagad 4%`, `Rocket 4%`), ledger entries, audit logs, idempotency, and `service_role`-only permissions.

---

## 3. Live Database Status & Pending Manual Deployment Step
- **Tables Verified Present in Live Supabase (`/api/health`)**: All 14 required tables including `public.mfs_payment_requests`, `public.user_notifications`, and `public.platform_config` exist.
- **Pending Production RPC Hotfix**: `005` installed `public.approve_mfs_payment_request` in production, hitting `record "v_payout_wallet" is not assigned yet` on `payment_collection`.
- **Action Required**: Execute `supabase/migrations/006_fix_mfs_payout_wallet_record.sql` manually in Supabase Dashboard → **SQL Editor**, then verify both `payment_collection` (`Bet Deposit`) and `payment_payout` (`Bet Payout`) approvals safely.

