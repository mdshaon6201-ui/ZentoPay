import express, { type Request, type Response, type NextFunction } from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  AUTHORITATIVE_COMMISSION_RATES,
  MAX_PROVIDER_COMMISSION_RATE,
  computeCommissionAmount,
  sanitizeCommissionRates,
} from './src/lib/commissions.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.NODE_ENV === 'production' ? Number(process.env.PORT || 3000) : 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

const isServerConfigured = Boolean(
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && SUPABASE_ANON_KEY
);

const supabaseAdmin: SupabaseClient | null = isServerConfigured
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

const supabaseAnon: SupabaseClient | null =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

// Sliding-window rate limiters for /api/auth/register (does not weaken or bypass Supabase limits)
const REGISTER_IP_WINDOW_MS = 15 * 60 * 1000;
const REGISTER_IP_MAX_ATTEMPTS = 8;
const REGISTER_EMAIL_COOLDOWN_MS = 60 * 1000;

const registerIpHits = new Map<string, number[]>();
const registerEmailLastSent = new Map<string, number>();

const LOGIN_IP_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_IP_MAX_ATTEMPTS = 15;
const loginIpHits = new Map<string, number[]>();

function normalizeBdPhone(raw: string): string | null {
  const cleaned = raw.replace(/[\s\-().]/g, '');
  if (/^01[3-9]\d{8}$/.test(cleaned)) {
    return cleaned;
  }
  if (/^\+8801[3-9]\d{8}$/.test(cleaned)) {
    return `0${cleaned.slice(4)}`;
  }
  if (/^8801[3-9]\d{8}$/.test(cleaned)) {
    return `0${cleaned.slice(3)}`;
  }
  return null;
}

function getBdPhoneVariants(canonical: string): string[] {
  return Array.from(new Set([canonical, `+88${canonical}`, `88${canonical}`]));
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || 'unknown';
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}

function checkIpRateLimit(ip: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const cutoff = now - REGISTER_IP_WINDOW_MS;
  const recent = (registerIpHits.get(ip) ?? []).filter((ts) => ts > cutoff);
  if (recent.length >= REGISTER_IP_MAX_ATTEMPTS) {
    const oldest = recent[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + REGISTER_IP_WINDOW_MS - now) / 1000));
    registerIpHits.set(ip, recent);
    return { allowed: false, retryAfterSec };
  }
  recent.push(now);
  registerIpHits.set(ip, recent);
  return { allowed: true, retryAfterSec: 0 };
}

function checkLoginIpRateLimit(ip: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const cutoff = now - LOGIN_IP_WINDOW_MS;
  const recent = (loginIpHits.get(ip) ?? []).filter((ts) => ts > cutoff);
  if (recent.length >= LOGIN_IP_MAX_ATTEMPTS) {
    const oldest = recent[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + LOGIN_IP_WINDOW_MS - now) / 1000));
    loginIpHits.set(ip, recent);
    return { allowed: false, retryAfterSec };
  }
  recent.push(now);
  loginIpHits.set(ip, recent);
  return { allowed: true, retryAfterSec: 0 };
}

function checkEmailCooldown(email: string): { allowed: boolean; retryAfterSec: number } {
  const last = registerEmailLastSent.get(email);
  if (!last) return { allowed: true, retryAfterSec: 0 };
  const elapsed = Date.now() - last;
  if (elapsed < REGISTER_EMAIL_COOLDOWN_MS) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((REGISTER_EMAIL_COOLDOWN_MS - elapsed) / 1000)),
    };
  }
  return { allowed: true, retryAfterSec: 0 };
}

async function findExistingAuthUserByEmail(email: string) {
  if (!supabaseAdmin) return null;
  let page = 1;
  const perPage = 200;
  while (page <= 10) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error || !data?.users?.length) break;
    const match = data.users.find((u) => u.email?.toLowerCase() === email);
    if (match) return match;
    if (data.users.length < perPage) break;
    page += 1;
  }
  return null;
}

function hashWithdrawPin(pin: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyWithdrawPin(pin: string, stored: string | null | undefined): boolean {
  if (!stored || !stored.includes(':')) return false;
  const [salt, expectedHex] = stored.split(':');
  if (!salt || !expectedHex) return false;
  try {
    const actual = crypto.scryptSync(pin, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function sanitizeProfile(profile: Record<string, unknown> | null) {
  if (!profile) return null;
  const { withdraw_pin_hash, ...rest } = profile;
  return {
    ...rest,
    has_withdraw_pin: Boolean(withdraw_pin_hash),
  };
}

const DEFAULT_PLATFORM_CONFIG = {
  depositMethods: [
    { id: 'bkash', name: 'bKash', accountNumber: '', accountLabel: 'bKash Personal/Agent', enabled: false },
    { id: 'nagad', name: 'Nagad', accountNumber: '', accountLabel: 'Nagad Personal/Agent', enabled: false },
    { id: 'rocket', name: 'Rocket', accountNumber: '', accountLabel: 'Rocket Personal/Agent', enabled: false },
  ],
  commissionRates: { ...AUTHORITATIVE_COMMISSION_RATES },
  supportLinks: {
    telegram: '',
    whatsapp: '',
    affiliateManagerTelegram: '',
  },
  socialNetworks: [
    { id: 'facebook', name: 'Facebook', url: '' },
    { id: 'youtube', name: 'YouTube', url: '' },
    { id: 'telegram', name: 'Telegram', url: '' },
  ],
  partners: [] as Array<{ id: string; name: string; logoUrl?: string; description?: string; url?: string }>,
  globalNotifications: [] as Array<{ id: string; title: string; message: string; createdAt: string }>,
};

const DISALLOWED_PAYMENT_IDS = new Set(['binance', 'usdt', 'btc', 'eth', 'trx', 'usd']);

function isMissingSchemaError(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false;
  const code = (err.code || '').toUpperCase();
  const msg = (err.message || '').toLowerCase();
  return (
    code === 'PGRST205' ||
    code === 'PGRST204' ||
    code === '42P01' ||
    code === '42703' ||
    msg.includes('schema cache') ||
    msg.includes('does not exist')
  );
}

interface SanitizedDepositMethod {
  id: string;
  name: string;
  accountNumber: string;
  accountLabel: string;
  enabled: boolean;
}

interface SanitizedPartnerItem {
  id: string;
  name: string;
  logoUrl?: string;
  description?: string;
  url?: string;
}

function sanitizeDepositMethod(raw: unknown): SanitizedDepositMethod | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const rawId = typeof obj.id === 'string' ? obj.id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') : '';
  const name = typeof obj.name === 'string' ? obj.name.trim().slice(0, 60) : '';
  if (!rawId || rawId.length < 2 || rawId.length > 40 || !name) return null;
  if (DISALLOWED_PAYMENT_IDS.has(rawId)) return null;
  const accountNumber = typeof obj.accountNumber === 'string' ? obj.accountNumber.trim().slice(0, 80) : '';
  const accountLabel = typeof obj.accountLabel === 'string' ? obj.accountLabel.trim().slice(0, 80) : '';
  return {
    id: rawId,
    name,
    accountNumber,
    accountLabel,
    enabled: Boolean(obj.enabled),
  };
}

function sanitizePlatformConfig(raw: unknown) {
  const val = (raw && typeof raw === 'object' ? raw : {}) as Partial<typeof DEFAULT_PLATFORM_CONFIG> & {
    depositMethods?: unknown;
    commissionRates?: unknown;
  };
  const hasExplicitMethods = Array.isArray(val.depositMethods);
  const depositMethods = hasExplicitMethods
    ? (val.depositMethods as unknown[])
        .map(sanitizeDepositMethod)
        .filter((m): m is SanitizedDepositMethod => m !== null)
    : DEFAULT_PLATFORM_CONFIG.depositMethods;

  const commissionRates = sanitizeCommissionRates(val.commissionRates);

  const rawSupport = (val.supportLinks && typeof val.supportLinks === 'object' ? val.supportLinks : {}) as Record<string, unknown>;
  const supportLinks = {
    telegram: typeof rawSupport.telegram === 'string' ? rawSupport.telegram.trim().slice(0, 300) : '',
    whatsapp: typeof rawSupport.whatsapp === 'string' ? rawSupport.whatsapp.trim().slice(0, 300) : '',
    affiliateManagerTelegram:
      typeof rawSupport.affiliateManagerTelegram === 'string'
        ? rawSupport.affiliateManagerTelegram.trim().slice(0, 300)
        : '',
  };

  const socialNetworks = Array.isArray(val.socialNetworks) && val.socialNetworks.length > 0
    ? val.socialNetworks
        .filter((s): s is { id: 'facebook' | 'youtube' | 'telegram'; name: string; url: string } =>
          Boolean(s && typeof s === 'object' && typeof s.id === 'string' && typeof s.name === 'string')
        )
        .map((s) => ({
          id: s.id,
          name: s.name.trim().slice(0, 40),
          url: typeof s.url === 'string' ? s.url.trim().slice(0, 300) : '',
        }))
    : DEFAULT_PLATFORM_CONFIG.socialNetworks;

  const partners: SanitizedPartnerItem[] = Array.isArray(val.partners)
    ? val.partners
        .filter((p): p is SanitizedPartnerItem =>
          Boolean(p && typeof p === 'object' && typeof p.id === 'string' && typeof p.name === 'string' && p.name.trim())
        )
        .map((p) => ({
          id: p.id.trim().slice(0, 60),
          name: p.name.trim().slice(0, 80),
          logoUrl: typeof p.logoUrl === 'string' && p.logoUrl.trim() ? p.logoUrl.trim().slice(0, 400) : undefined,
          description:
            typeof p.description === 'string' && p.description.trim() ? p.description.trim().slice(0, 200) : undefined,
          url: typeof p.url === 'string' && p.url.trim() ? p.url.trim().slice(0, 300) : undefined,
        }))
    : [];

  const globalNotifications = Array.isArray(val.globalNotifications)
    ? val.globalNotifications
        .filter((g): g is { id: string; title: string; message: string; createdAt: string } =>
          Boolean(g && typeof g === 'object' && typeof g.id === 'string' && typeof g.title === 'string' && typeof g.message === 'string')
        )
        .map((g) => ({
          id: g.id.trim().slice(0, 60),
          title: g.title.trim().slice(0, 120),
          message: g.message.trim().slice(0, 1000),
          createdAt: typeof g.createdAt === 'string' && g.createdAt ? g.createdAt : new Date().toISOString(),
        }))
    : [];

  return {
    depositMethods,
    commissionRates,
    supportLinks,
    socialNetworks,
    partners,
    globalNotifications,
  };
}

async function readPlatformConfig(): Promise<{
  config: ReturnType<typeof sanitizePlatformConfig>;
  schemaPending: boolean;
  fromDb: boolean;
}> {
  if (!supabaseAdmin) {
    return { config: DEFAULT_PLATFORM_CONFIG, schemaPending: false, fromDb: false };
  }
  const { data, error } = await supabaseAdmin
    .from('platform_config')
    .select('config_value')
    .eq('config_key', 'ewallet_config')
    .maybeSingle();

  if (error) {
    if (isMissingSchemaError(error)) {
      return { config: DEFAULT_PLATFORM_CONFIG, schemaPending: true, fromDb: false };
    }
    return { config: DEFAULT_PLATFORM_CONFIG, schemaPending: false, fromDb: false };
  }

  return {
    config: sanitizePlatformConfig(data?.config_value),
    schemaPending: false,
    fromDb: Boolean(data),
  };
}

async function ensureProfileAgentCode<T extends Record<string, unknown>>(profile: T): Promise<T> {
  if (!supabaseAdmin || !profile || typeof profile.id !== 'string') return profile;
  if (typeof profile.agent_code === 'string' && /^67\d{6}$/.test(profile.agent_code)) {
    return profile;
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = `67${String(crypto.randomInt(0, 1000000)).padStart(6, '0')}`;
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update({ agent_code: candidate, updated_at: new Date().toISOString() })
      .eq('id', profile.id)
      .is('agent_code', null)
      .select('*')
      .maybeSingle();

    if (!error) {
      if (data) {
        return data as T;
      }
      const { data: latest } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .eq('id', profile.id)
        .maybeSingle();
      return (latest as T) || profile;
    }

    // If agent_code column isn't migrated yet (pre-002b DB), fail silently and preserve flow
    if (isMissingSchemaError(error)) {
      return profile;
    }
    // Retry on unique_violation (23505)
    if (error.code === '23505') {
      continue;
    }
    return profile;
  }

  return profile;
}

async function ensureAgentBdtWallets(userId: string, role: string | null | undefined): Promise<void> {
  if (!supabaseAdmin || !userId) return;
  const walletTypesToEnsure: Array<'main' | 'float' | 'commission'> =
    role === 'agent' || role === 'sub_agent' || role === 'user'
      ? ['main', 'float', 'commission']
      : role === 'super_admin'
        ? ['main']
        : [];
  if (walletTypesToEnsure.length === 0) return;

  const { data: existingBdt, error: checkErr } = await supabaseAdmin
    .from('wallets')
    .select('wallet_type')
    .eq('user_id', userId)
    .eq('currency', 'BDT');

  if (checkErr) {
    console.warn(`[wallets/ensureBdt] lookup failed userId=${userId}: ${checkErr.message}`);
    return;
  }

  const existingTypes = new Set((existingBdt ?? []).map((w) => w.wallet_type));
  const missingRows = walletTypesToEnsure
    .filter((wt) => !existingTypes.has(wt))
    .map((wt) => ({
      user_id: userId,
      wallet_type: wt,
      currency: 'BDT',
      balance: 0,
      available_balance: 0,
      status: 'active',
    }));

  if (missingRows.length === 0) return;

  const { error: upsertErr } = await supabaseAdmin
    .from('wallets')
    .upsert(missingRows, { onConflict: 'user_id,wallet_type,currency', ignoreDuplicates: true });

  if (upsertErr) {
    console.warn(`[wallets/ensureBdt] provision failed userId=${userId}: ${upsertErr.message}`);
  } else {
    console.info(
      `[wallets/ensureBdt] provisioned missing BDT wallets userId=${userId} types=${missingRows.map((r) => r.wallet_type).join(',')}`
    );
  }
}

async function ensureProfileForAuthenticatedUser(userId: string): Promise<{
  profile?: Record<string, unknown>;
  created?: boolean;
  status?: number;
  schemaPending?: boolean;
  error?: string;
}> {
  if (!supabaseAdmin || !userId) {
    return { status: 404, error: 'প্রোফাইল পাওয়া যায়নি।' };
  }

  const { data: existing, error: existingErr } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (existingErr) {
    if (isMissingSchemaError(existingErr)) {
      return {
        status: 503,
        schemaPending: true,
        error: 'ডাটাবেজ স্কিমা (profiles টেবিল) এখনো সম্পূর্ণভাবে আপডেট করা হয়নি।',
      };
    }
    return { status: 500, error: existingErr.message };
  }

  if (existing) {
    return { profile: existing as Record<string, unknown>, created: false };
  }

  // Profile is genuinely missing for this verified Auth UUID; inspect Auth record
  const { data: authRes, error: authErr } = await supabaseAdmin.auth.admin.getUserById(userId);
  const authUser = authRes?.user;
  const authEmail = authUser?.email?.trim().toLowerCase() || '';
  if (authErr || !authUser || !authEmail) {
    return { status: 404, error: 'প্রোফাইল পাওয়া যায়নি।' };
  }

  // Never create duplicate profiles if the email already belongs to another profile row
  const { data: emailConflict, error: conflictErr } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .ilike('email', authEmail)
    .limit(1)
    .maybeSingle();

  if (conflictErr) {
    return { status: 500, error: conflictErr.message };
  }
  if (emailConflict && emailConflict.id !== userId) {
    console.warn(`[auth/profile-heal] email conflict userId=${userId} existingProfileId=${emailConflict.id}`);
    return {
      status: 409,
      error: 'এই ইমেইলে ইতিমধ্যে একটি ভিন্ন প্রোফাইল রয়েছে। অনুগ্রহ করে সাপোর্টে যোগাযোগ করুন।',
    };
  }

  const meta = (authUser.user_metadata ?? {}) as Record<string, unknown>;
  const rawFullName = typeof meta.full_name === 'string' && meta.full_name.trim()
    ? meta.full_name.trim()
    : authEmail.split('@')[0];
  const rawPhone = typeof meta.phone === 'string' && meta.phone.trim() ? meta.phone.trim() : null;
  const rawCountry = typeof meta.country === 'string' && meta.country.trim().length >= 2
    ? meta.country.trim().slice(0, 8).toUpperCase()
    : 'BD';
  const rawBusiness = typeof meta.business_name === 'string' && meta.business_name.trim()
    ? meta.business_name.trim()
    : null;

  const { error: insertErr } = await supabaseAdmin
    .from('profiles')
    .upsert(
      {
        id: userId,
        email: authEmail,
        full_name: rawFullName,
        phone: rawPhone,
        country: rawCountry,
        business_name: rawBusiness,
        role: 'agent',
      },
      { onConflict: 'id', ignoreDuplicates: true }
    );

  if (insertErr) {
    console.warn(`[auth/profile-heal] safe upsert failed userId=${userId}: ${insertErr.code || ''} ${insertErr.message}`);
    return { status: 500, error: insertErr.message };
  }

  const { data: createdProf, error: refetchErr } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (refetchErr || !createdProf) {
    return { status: 404, error: 'প্রোফাইল পাওয়া যায়নি।' };
  }

  const withCode = await ensureProfileAgentCode(createdProf as Record<string, unknown>);
  await ensureAgentBdtWallets(userId, String(withCode.role || 'agent'));
  console.info(`[auth/profile-heal] provisioned missing profile userId=${userId} role=${String(withCode.role || 'agent')}`);

  return { profile: withCode, created: true };
}

async function resolvePlatformFeeWallet() {
  if (!supabaseAdmin) return null;
  const { data: superAdmins } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('role', 'super_admin')
    .eq('is_frozen', false)
    .order('created_at', { ascending: true })
    .limit(5);

  const adminIds = (superAdmins ?? []).map((a) => a.id);
  if (adminIds.length === 0) return null;

  const { data: existingFeeWallet } = await supabaseAdmin
    .from('wallets')
    .select('*')
    .in('user_id', adminIds)
    .eq('wallet_type', 'settlement')
    .eq('currency', 'BDT')
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  if (existingFeeWallet) return existingFeeWallet;

  const primaryAdminId = adminIds[0];
  await supabaseAdmin
    .from('wallets')
    .upsert(
      {
        user_id: primaryAdminId,
        wallet_type: 'settlement',
        currency: 'BDT',
        balance: 0,
        available_balance: 0,
        status: 'active',
      },
      { onConflict: 'user_id,wallet_type,currency', ignoreDuplicates: true }
    );

  const { data: provisioned } = await supabaseAdmin
    .from('wallets')
    .select('*')
    .eq('user_id', primaryAdminId)
    .eq('wallet_type', 'settlement')
    .eq('currency', 'BDT')
    .eq('status', 'active')
    .maybeSingle();

  return provisioned ?? null;
}

async function creditEligibleAffiliateCommission(params: {
  sourceUserId: string;
  baseAmount: number;
  sourceLabel: 'deposit' | 'payout';
  sourceRef: string;
}) {
  if (!supabaseAdmin || params.baseAmount <= 0) return;
  await supabaseAdmin.rpc('credit_affiliate_commission', {
    p_source_user_id: params.sourceUserId,
    p_base_amount: Number(params.baseAmount.toFixed(2)),
    p_source_label: params.sourceLabel,
    p_source_ref: params.sourceRef,
  });
}

interface AuthenticatedRequest extends Request {
  userId?: string;
  userRole?: string;
  accessToken?: string;
}

function createUserScopedRlsClient(accessToken: string): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !accessToken) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}

async function resolveProfileByIdentifier(
  rawIdentifier: string,
  options?: {
    allowedRoles?: string[];
    requireAuthUser?: boolean;
    rlsClient?: SupabaseClient | null;
  }
): Promise<{
  profile?: Record<string, unknown> & {
    id: string;
    email: string;
    full_name: string;
    phone?: string | null;
    role: string;
    is_frozen?: boolean;
    agent_code?: string | null;
    active_plan?: string | null;
  };
  status?: number;
  code?: string;
  error?: string;
}> {
  const cleanIdent = rawIdentifier.trim();
  if (!cleanIdent || !supabaseAdmin) {
    return { status: 400, code: 'INVALID_IDENTIFIER', error: 'সঠিক এজেন্ট আইডি, ইমেইল, ফোন নম্বর অথবা UUID দিন।' };
  }

  // Prefer RLS-scoped client when provided so Finance/Super Admin RLS permissions are honored directly
  const reader = options?.rlsClient ?? supabaseAdmin;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanIdent);
  const normalizedPhone = normalizeBdPhone(cleanIdent);

  let matched: Record<string, unknown> | null = null;

  if (isUuid) {
    const { data, error } = await reader
      .from('profiles')
      .select('*')
      .eq('id', cleanIdent)
      .maybeSingle();
    if (error) {
      return { status: 403, code: error.code || 'RLS_ERROR', error: `প্রোফাইল যাচাই ত্রুটি: ${error.message}` };
    }
    matched = data as Record<string, unknown> | null;
  } else if (cleanIdent.includes('@')) {
    const { data, error } = await reader
      .from('profiles')
      .select('*')
      .ilike('email', cleanIdent.toLowerCase())
      .limit(2);
    if (error) {
      return { status: 403, code: error.code || 'RLS_ERROR', error: `প্রোফাইল যাচাই ত্রুটি: ${error.message}` };
    }
    if (data && data.length > 1) {
      return {
        status: 409,
        code: 'AMBIGUOUS_AGENT',
        error: 'একাধিক এজেন্ট অ্যাকাউন্ট মিলেছে। অনুগ্রহ করে ড্রপডাউন তালিকা থেকে নির্দিষ্ট এজেন্ট বাছাই করুন।',
      };
    }
    matched = (data?.[0] as Record<string, unknown> | undefined) ?? null;
  } else {
    // 1. Try agent_code (accepting both 67XXXXXX and #67XXXXXX)
    const cleanAgentCode = cleanIdent.replace(/^#+/, '').trim();
    if (cleanAgentCode) {
      const { data: codeData, error: codeErr } = await reader
        .from('profiles')
        .select('*')
        .eq('agent_code', cleanAgentCode)
        .limit(1)
        .maybeSingle();
      if (!codeErr && codeData) {
        matched = codeData as Record<string, unknown>;
      }
    }

    // 2. Try normalized BD phone variants
    if (!matched && normalizedPhone) {
      const variants = getBdPhoneVariants(normalizedPhone);
      const { data: phoneData, error: phoneErr } = await reader
        .from('profiles')
        .select('*')
        .in('phone', variants)
        .limit(2);
      if (phoneErr) {
        return { status: 403, code: phoneErr.code || 'RLS_ERROR', error: `প্রোফাইল যাচাই ত্রুটি: ${phoneErr.message}` };
      }
      if (phoneData && phoneData.length > 1) {
        return {
          status: 409,
          code: 'AMBIGUOUS_AGENT',
          error: 'এই ফোন নম্বরে একাধিক অ্যাকাউন্ট পাওয়া গেছে। অনুগ্রহ করে তালিকা থেকে নির্দিষ্ট এজেন্ট বাছাই করুন।',
        };
      }
      matched = (phoneData?.[0] as Record<string, unknown> | undefined) ?? null;
    }

    // 3. Try exact full_name match (scoped to allowedRoles if provided)
    if (!matched) {
      let nameQuery = reader.from('profiles').select('*').ilike('full_name', cleanIdent);
      if (options?.allowedRoles?.length) {
        nameQuery = nameQuery.in('role', options.allowedRoles);
      }
      const { data: nameData } = await nameQuery.limit(2);
      if (nameData && nameData.length > 1) {
        return {
          status: 409,
          code: 'AMBIGUOUS_AGENT',
          error: `"${cleanIdent}" নামে একাধিক এজেন্ট রয়েছেন। অনুগ্রহ করে ড্রপডাউন তালিকা থেকে ইমেইল বা UUID-সহ নির্দিষ্ট এজেন্ট নির্বাচন করুন।`,
        };
      }
      matched = (nameData?.[0] as Record<string, unknown> | undefined) ?? null;
    }
  }

  if (!matched || typeof matched.id !== 'string') {
    return {
      status: 404,
      code: 'AGENT_NOT_FOUND',
      error: 'নির্বাচিত এজেন্ট খুঁজে পাওয়া যায়নি। অনুগ্রহ করে ড্রপডাউন তালিকা থেকে এজেন্ট নির্বাচন করুন অথবা সঠিক ইমেইল/ফোন নম্বর দিন।',
    };
  }

  const typedProfile = matched as Record<string, unknown> & {
    id: string;
    email: string;
    full_name: string;
    phone?: string | null;
    role: string;
    is_frozen?: boolean;
    agent_code?: string | null;
    active_plan?: string | null;
  };

  if (options?.requireAuthUser) {
    const { data: authCheck, error: authErr } = await supabaseAdmin.auth.admin.getUserById(typedProfile.id);
    if (authErr || !authCheck?.user) {
      return {
        status: 404,
        code: 'AUTH_USER_MISSING',
        error: 'নির্বাচিত এজেন্টের Supabase Auth অ্যাকাউন্ট পাওয়া যায়নি।',
      };
    }
  }

  if (typedProfile.is_frozen) {
    return {
      status: 400,
      code: 'AGENT_FROZEN',
      error: 'নির্বাচিত এজেন্টের অ্যাকাউন্টটি সাময়িকভাবে ফ্রিজ করা আছে।',
    };
  }

  if (options?.allowedRoles && !options.allowedRoles.includes(typedProfile.role)) {
    return {
      status: 400,
      code: 'INVALID_AGENT_ROLE',
      error: `নির্বাচিত অ্যাকাউন্টটি এজেন্ট রোল নয় (বর্তমান রোল: ${typedProfile.role})। অনুগ্রহ করে তালিকা থেকে একজন এজেন্ট নির্বাচন করুন।`,
    };
  }

  return { profile: typedProfile };
}

async function requireSupabaseAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  if (!supabaseAdmin) {
    return res.status(503).json({
      configured: false,
      error: 'Supabase সার্ভার ক্রেডেনশিয়াল কনফিগার করা হয়নি। অনুগ্রহ করে SUPABASE_URL, SUPABASE_ANON_KEY এবং SUPABASE_SERVICE_ROLE_KEY সেট করুন।',
    });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn(`[auth] 401 missing_bearer path=${req.originalUrl}`);
    return res.status(401).json({ configured: true, code: 'MISSING_BEARER', error: 'অথেনটিকেশন Bearer টোকেন পাওয়া যায়নি।' });
  }

  const token = authHeader.slice(7).trim();
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    console.warn(`[auth] 401 invalid_token path=${req.originalUrl} msg="${error?.message || 'no user'}"`);
    return res.status(401).json({ configured: true, code: 'INVALID_TOKEN', error: 'সেশন টোকেন অবৈধ অথবা মেয়াদ উত্তীর্ণ হয়েছে।' });
  }

  const { data: profile, error: profErr } = await supabaseAdmin
    .from('profiles')
    .select('role, is_frozen')
    .eq('id', data.user.id)
    .maybeSingle();

  if (profErr && !isMissingSchemaError(profErr)) {
    console.warn(`[auth] profile_lookup_error userId=${data.user.id} path=${req.originalUrl}: ${profErr.message}`);
  }

  if (profile?.is_frozen) {
    console.warn(`[auth] 403 account_frozen userId=${data.user.id} path=${req.originalUrl}`);
    return res.status(403).json({ configured: true, code: 'ACCOUNT_FROZEN', error: 'পর্যালোচনার জন্য আপনার অ্যাকাউন্টটি সাময়িকভাবে ফ্রিজ করা হয়েছে।' });
  }

  req.userId = data.user.id;
  req.userRole = profile?.role || '';
  req.accessToken = token;
  next();
}

function requireRoles(...allowedRoles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.userRole || !allowedRoles.includes(req.userRole)) {
      console.warn(
        `[auth/requireRoles] 403 role_forbidden userId=${req.userId || 'unknown'} role=${req.userRole || 'none'} allowed=${allowedRoles.join(',')} path=${req.originalUrl}`
      );
      return res.status(403).json({
        configured: true,
        code: 'ROLE_FORBIDDEN',
        error: !req.userRole
          ? 'ব্যবহারকারীর প্রোফাইল বা রোল ডাটাবেজে পাওয়া যায়নি।'
          : 'এই কাজের জন্য আপনার পর্যাপ্ত রোল অনুমতি নেই।',
      });
    }
    next();
  };
}

const REQUIRED_TABLES = [
  'profiles',
  'wallets',
  'transactions',
  'ledger_entries',
  'agent_hierarchy',
  'settlement_requests',
  'kyc_submissions',
  'support_tickets',
  'gateway_merchants',
  'audit_logs',
  'agent_gateways',
  'mfs_payment_requests',
  'platform_config',
  'user_notifications',
] as const;

export async function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Live Supabase health check endpoint (never exposes secrets or fakes success)
  app.get('/api/health', async (_req, res) => {
    if (!isServerConfigured || !supabaseAdmin) {
      return res.status(503).json({
        service: 'ZentoPay API',
        configured: false,
        authAdminConnected: false,
        schemaReady: false,
        storageBucketReady: false,
        missingTables: [...REQUIRED_TABLES],
        status: 'unconfigured',
      });
    }

    let authAdminConnected = false;
    let authAdminError: string | null = null;
    try {
      const { error: authErr } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 });
      if (authErr) {
        authAdminError = authErr.message;
      } else {
        authAdminConnected = true;
      }
    } catch (err) {
      authAdminError = err instanceof Error ? err.message : 'Auth admin connection failed';
    }

    const existingTables: string[] = [];
    const missingTables: string[] = [];
    const tableErrors: Record<string, string> = {};

    await Promise.all(
      REQUIRED_TABLES.map(async (tableName) => {
        const { error: tblErr } = await supabaseAdmin!
          .from(tableName)
          .select('*')
          .limit(0);
        if (!tblErr) {
          existingTables.push(tableName);
        } else {
          missingTables.push(tableName);
          tableErrors[tableName] = `${tblErr.code || 'ERR'}: ${tblErr.message}`;
        }
      })
    );

    let storageBucketReady = false;
    let storageError: string | null = null;
    try {
      const { data: buckets, error: bErr } = await supabaseAdmin.storage.listBuckets();
      if (bErr) {
        storageError = bErr.message;
      } else {
        storageBucketReady = Boolean(buckets?.some((b) => b.id === 'kyc-documents' || b.name === 'kyc-documents'));
      }
    } catch (err) {
      storageError = err instanceof Error ? err.message : 'Storage bucket check failed';
    }

    const schemaReady = missingTables.length === 0;

    let anonSchemaError: string | null = null;
    try {
      const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error: aErr } = await anonClient.from('profiles').select('id').limit(1);
      if (aErr) {
        anonSchemaError = `${aErr.code || 'ERR'}: ${aErr.message}`;
      }
    } catch (err) {
      anonSchemaError = err instanceof Error ? err.message : 'Anon check failed';
    }

    const viteUrl = process.env.VITE_SUPABASE_URL || '';
    const viteAnon = process.env.VITE_SUPABASE_ANON_KEY || '';
    let clientKeySchemaError: string | null = null;
    if (viteUrl && viteAnon) {
      try {
        const clientSb = createClient(viteUrl, viteAnon, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const { error: cErr } = await clientSb.from('profiles').select('id').limit(1);
        if (cErr) {
          clientKeySchemaError = `${cErr.code || 'ERR'}: ${cErr.message}`;
        }
      } catch (err) {
        clientKeySchemaError = err instanceof Error ? err.message : 'Client key check failed';
      }
    }

    const { count: profilesCount } = existingTables.includes('profiles')
      ? await supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true })
      : { count: 0 };
    const { count: walletsCount } = existingTables.includes('wallets')
      ? await supabaseAdmin.from('wallets').select('id', { count: 'exact', head: true })
      : { count: 0 };

    let withdrawPinColumnReady = false;
    let withdrawPinColumnError: string | null = null;
    if (existingTables.includes('profiles')) {
      const { error: pinColErr } = await supabaseAdmin
        .from('profiles')
        .select('id, withdraw_pin_hash')
        .limit(0);
      if (!pinColErr) {
        withdrawPinColumnReady = true;
      } else {
        withdrawPinColumnError = `${pinColErr.code || 'ERR'}: ${pinColErr.message}`;
      }
    }

    let settlementReservationReady = false;
    if (existingTables.includes('wallets')) {
      const { error: resColErr } = await supabaseAdmin
        .from('wallets')
        .select('id, reserved_balance')
        .limit(0);
      if (!resColErr) {
        settlementReservationReady = true;
      }
    }

    const overallStatus =
      authAdminConnected && schemaReady && !anonSchemaError && !clientKeySchemaError && storageBucketReady
        ? 'ok'
        : !schemaReady
          ? 'schema_pending'
          : 'degraded';

    return res.json({
      service: 'ZentoPay API',
      configured: true,
      serverUrlHost: SUPABASE_URL ? new URL(SUPABASE_URL).hostname : null,
      clientEnvHost: viteUrl ? new URL(viteUrl).hostname : null,
      anonKeysMatch: Boolean(SUPABASE_ANON_KEY && viteAnon && SUPABASE_ANON_KEY === viteAnon),
      hasDatabaseUrl: Boolean(process.env.SUPABASE_DB_URL || process.env.DATABASE_URL),
      authAdminConnected,
      authAdminError,
      schemaReady,
      withdrawPinColumnReady,
      withdrawPinColumnError,
      settlementReservationReady,
      existingTables,
      missingTables,
      tableErrors,
      anonSchemaError,
      clientKeySchemaError,
      profilesCount: profilesCount ?? 0,
      walletsCount: walletsCount ?? 0,
      storageBucketReady,
      storageError,
      status: overallStatus,
    });
  });

  // Public contact / merchant inquiry endpoint
  app.post('/api/public/inquiry', (req, res) => {
    const { fullName, email, accountType, message } = req.body ?? {};
    if (!fullName || !email || !message) {
      return res.status(400).json({ error: 'পূর্ণ নাম, ইমেইল এবং অনুসন্ধানের বিস্তারিত তথ্য প্রয়োজন।' });
    }
    return res.status(200).json({
      ok: true,
      receivedAt: new Date().toISOString(),
      accountType: accountType || 'user',
    });
  });

  // Public read-only platform configuration (NEVER exposes depositMethods receiving accounts or secrets)
  app.get('/api/public/platform-config', async (_req, res) => {
    const { config, schemaPending } = await readPlatformConfig();
    return res.json({
      configured: isServerConfigured,
      schemaPending,
      data: {
        depositMethods: [],
        commissionRates: config.commissionRates,
        supportLinks: config.supportLinks,
        socialNetworks: config.socialNetworks,
        partners: config.partners,
        globalNotifications: config.globalNotifications,
      },
    });
  });

  // Public registration endpoint: validates input, prevents duplicate accounts before hitting Supabase SMTP,
  // enforces server-side IP/email cooldown, logs exact upstream HTTP/error codes, and returns clear Bangla errors.
  app.post('/api/auth/register', async (req, res) => {
    if (!isServerConfigured || !supabaseAdmin || !supabaseAnon) {
      return res.status(503).json({
        configured: false,
        code: 'SUPABASE_UNCONFIGURED',
        error: 'Supabase অথেনটিকেশন এখনো কনফিগার করা হয়নি। অনুগ্রহ করে সার্ভার এনভায়রনমেন্ট ভ্যারিয়েবল সেট করুন।',
      });
    }

    const clientIp = getClientIp(req);
    const {
      email,
      password,
      fullName,
      phone,
      country,
      businessName,
      username,
      requestedRole,
      referralCode,
    } = req.body ?? {};

    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const cleanFullName = typeof fullName === 'string' ? fullName.trim() : '';
    const cleanPhone = typeof phone === 'string' ? phone.trim() : '';
    const cleanReferralCode = typeof referralCode === 'string' ? referralCode.trim() : '';
    const cleanBusinessName =
      typeof businessName === 'string' && businessName.trim()
        ? businessName.trim()
        : typeof username === 'string' && username.trim()
          ? username.trim()
          : '';
    const cleanCountry =
      typeof country === 'string' && country.trim().length >= 2
        ? country.trim().slice(0, 8).toUpperCase()
        : 'BD';
    const rawPassword = typeof password === 'string' ? password : '';

    if (!cleanFullName || cleanFullName.length < 2) {
      return res.status(400).json({
        configured: true,
        code: 'INVALID_FULL_NAME',
        error: 'অনুগ্রহ করে কমপক্ষে ২ অক্ষরের পূর্ণ নাম লিখুন।',
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
      return res.status(400).json({
        configured: true,
        code: 'INVALID_EMAIL',
        error: 'অনুগ্রহ করে একটি সঠিক ইমেইল ঠিকানা লিখুন।',
      });
    }

    const phoneDigits = cleanPhone.replace(/[^0-9]/g, '');
    if (phoneDigits.length < 6 || phoneDigits.length > 20) {
      return res.status(400).json({
        configured: true,
        code: 'INVALID_PHONE',
        error: 'অনুগ্রহ করে একটি সঠিক ফোন নম্বর লিখুন।',
      });
    }
    const normalizedPhone = normalizeBdPhone(cleanPhone) || cleanPhone;

    if (rawPassword.length < 6 || rawPassword.length > 128) {
      return res.status(400).json({
        configured: true,
        code: 'WEAK_PASSWORD',
        error: 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।',
      });
    }

    // Per-IP sliding-window protection
    const ipLimit = checkIpRateLimit(clientIp);
    if (!ipLimit.allowed) {
      console.warn(
        `[auth/register] 429 APP_IP_RATE_LIMIT ip=${clientIp} email=${maskEmail(cleanEmail)} retryAfter=${ipLimit.retryAfterSec}s`
      );
      res.setHeader('Retry-After', String(ipLimit.retryAfterSec));
      return res.status(429).json({
        configured: true,
        code: 'APP_IP_RATE_LIMIT',
        error: `এই নেটওয়ার্ক থেকে অল্প সময়ে অতিরিক্ত রেজিস্ট্রেশন চেষ্টা করা হয়েছে। অনুগ্রহ করে ${Math.ceil(ipLimit.retryAfterSec / 60)} মিনিট পর আবার চেষ্টা করুন।`,
      });
    }

    // Duplicate account check BEFORE creating user (email + phone uniqueness)
    const phoneLookupVariants = normalizeBdPhone(cleanPhone)
      ? getBdPhoneVariants(normalizedPhone)
      : [cleanPhone];

    const [{ data: existingProfile }, { data: existingPhoneProfile }, existingAuthUser] = await Promise.all([
      supabaseAdmin.from('profiles').select('id, email').eq('email', cleanEmail).maybeSingle(),
      supabaseAdmin.from('profiles').select('id').in('phone', phoneLookupVariants).limit(1).maybeSingle(),
      findExistingAuthUserByEmail(cleanEmail),
    ]);

    if (existingProfile || existingAuthUser) {
      console.info(
        `[auth/register] 409 ACCOUNT_EXISTS ip=${clientIp} email=${maskEmail(cleanEmail)}`
      );
      return res.status(409).json({
        configured: true,
        code: 'ACCOUNT_EXISTS',
        error: 'এই ইমেইল দিয়ে ইতিমধ্যে একটি অ্যাকাউন্ট নিবন্ধিত রয়েছে। অনুগ্রহ করে লগইন করুন।',
      });
    }

    if (existingPhoneProfile) {
      console.info(
        `[auth/register] 409 PHONE_EXISTS ip=${clientIp} email=${maskEmail(cleanEmail)}`
      );
      return res.status(409).json({
        configured: true,
        code: 'ACCOUNT_EXISTS',
        error: 'এই ফোন নম্বর দিয়ে ইতিমধ্যে একটি অ্যাকাউন্ট নিবন্ধিত রয়েছে। অনুগ্রহ করে লগইন করুন।',
      });
    }

    // Per-email cooldown before hitting upstream auth
    const emailCooldown = checkEmailCooldown(cleanEmail);
    if (!emailCooldown.allowed) {
      console.warn(
        `[auth/register] 429 APP_EMAIL_COOLDOWN ip=${clientIp} email=${maskEmail(cleanEmail)} retryAfter=${emailCooldown.retryAfterSec}s`
      );
      res.setHeader('Retry-After', String(emailCooldown.retryAfterSec));
      return res.status(429).json({
        configured: true,
        code: 'APP_EMAIL_COOLDOWN',
        error: `এই ইমেইলে সবেমাত্র একটি রেজিস্ট্রেশন অনুরোধ পাঠানো হয়েছে। অনুগ্রহ করে ${emailCooldown.retryAfterSec} সেকেন্ড পর আবার চেষ্টা করুন।`,
      });
    }

    // Strictly enforce 'agent' role for every public registration regardless of client payload
    const assignedRole = 'agent' as const;

    // Create user with email confirmed immediately so registration works without email verification or Custom SMTP
    const { data: createdData, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: cleanEmail,
      password: rawPassword,
      email_confirm: true,
      user_metadata: {
        full_name: cleanFullName,
        phone: normalizedPhone,
        country: cleanCountry,
        business_name: cleanBusinessName || null,
        referral_agent_code: cleanReferralCode || null,
      },
    });

    if (createError) {
      const errCode = (createError as { code?: string }).code || '';
      const errStatus = (createError as { status?: number }).status || 400;
      const errLower = (createError.message || '').toLowerCase();

      console.warn(
        `[auth/register] upstream_error status=${errStatus} supabaseCode=${errCode || 'none'} ip=${clientIp} email=${maskEmail(cleanEmail)} msg="${createError.message}"`
      );

      if (
        errCode === 'over_request_rate_limit' ||
        errStatus === 429 ||
        errLower.includes('rate limit') ||
        errLower.includes('security purposes')
      ) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({
          configured: true,
          code: 'SUPABASE_AUTH_RATE_LIMIT',
          upstreamCode: errCode || 'over_request_rate_limit',
          error:
            'অথেনটিকেশন সার্ভারে অতিরিক্ত অনুরোধের কারণে সাময়িক বিরতি রয়েছে। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।',
        });
      }

      if (
        errCode === 'user_already_exists' ||
        errCode === 'email_exists' ||
        errLower.includes('already registered') ||
        errLower.includes('already been registered') ||
        errLower.includes('already exists')
      ) {
        return res.status(409).json({
          configured: true,
          code: 'ACCOUNT_EXISTS',
          upstreamCode: errCode || 'user_already_exists',
          error: 'এই ইমেইল দিয়ে ইতিমধ্যে একটি অ্যাকাউন্ট নিবন্ধিত রয়েছে। অনুগ্রহ করে লগইন করুন।',
        });
      }

      if (errCode === 'weak_password' || errLower.includes('password should be at least')) {
        return res.status(400).json({
          configured: true,
          code: 'WEAK_PASSWORD',
          error: 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের এবং নিরাপদ হতে হবে।',
        });
      }

      if (
        errCode === 'email_address_invalid' ||
        errLower.includes('unable to validate email') ||
        errLower.includes('invalid email')
      ) {
        return res.status(400).json({
          configured: true,
          code: 'INVALID_EMAIL',
          error: 'অনুগ্রহ করে একটি সঠিক ইমেইল ঠিকানা লিখুন।',
        });
      }

      if (errLower.includes('database error saving new user') || errLower.includes('database error')) {
        return res.status(500).json({
          configured: true,
          code: 'DATABASE_TRIGGER_ERROR',
          error: 'ডাটাবেজে ব্যবহারকারীর প্রোফাইল সংরক্ষণে ত্রুটি হয়েছে। অনুগ্রহ করে সাপোর্টে যোগাযোগ করুন।',
        });
      }

      return res.status(errStatus >= 400 && errStatus < 600 ? errStatus : 400).json({
        configured: true,
        code: errCode || 'SUPABASE_SIGNUP_ERROR',
        error: `রেজিস্ট্রেশন সম্পন্ন করা যায়নি: ${createError.message}`,
      });
    }

    const userId = createdData.user?.id;
    registerEmailLastSent.set(cleanEmail, Date.now());

    // Pre-002b defense-in-depth: if trigger created profile with role='user' or missing agent_code, normalize cleanly
    if (userId) {
      const { data: initialProf } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (initialProf) {
        if (initialProf.role === 'user') {
          await supabaseAdmin
            .from('profiles')
            .update({ role: assignedRole, updated_at: new Date().toISOString() })
            .eq('id', userId);
        }
        await ensureProfileAgentCode(initialProf as Record<string, unknown>);
      }
    }

    // Immediately establish an authenticated session for the newly created user
    const { data: signInData, error: signInError } = await supabaseAnon.auth.signInWithPassword({
      email: cleanEmail,
      password: rawPassword,
    });

    if (signInError || !signInData.session) {
      const signInCode = (signInError as { code?: string } | null)?.code || '';
      const signInLower = (signInError?.message || '').toLowerCase();

      console.warn(
        `[auth/register] user created (${userId}) but immediate sign-in failed: code=${signInCode || 'none'} msg="${signInError?.message || 'no session'}"`
      );

      if (signInCode === 'email_provider_disabled' || signInLower.includes('email logins are disabled')) {
        if (userId) {
          await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => {});
        }
        registerEmailLastSent.delete(cleanEmail);
        return res.status(503).json({
          configured: true,
          code: 'EMAIL_PROVIDER_DISABLED',
          upstreamCode: signInCode || 'email_provider_disabled',
          error:
            'Supabase-এ Email লগইন প্রোভাইডার বন্ধ রয়েছে। অনুগ্রহ করে Supabase Dashboard → Authentication → Providers → Email চালু রাখুন এবং শুধু "Confirm email" অপশনটি বন্ধ করুন।',
        });
      }

      return res.status(201).json({
        configured: true,
        data: {
          user: createdData.user ? { id: createdData.user.id, email: createdData.user.email } : null,
          role: assignedRole,
          session: null,
        },
      });
    }

    const { data: createdProfile } = userId
      ? await supabaseAdmin.from('profiles').select('role').eq('id', userId).maybeSingle()
      : { data: null };

    const resolvedRole = createdProfile?.role || assignedRole;

    console.info(
      `[auth/register] 201 CREATED_AUTHENTICATED ip=${clientIp} email=${maskEmail(cleanEmail)} userId=${userId || 'none'} role=${resolvedRole}`
    );

    return res.status(201).json({
      configured: true,
      data: {
        user: createdData.user ? { id: createdData.user.id, email: createdData.user.email } : null,
        role: resolvedRole,
        session: {
          access_token: signInData.session.access_token,
          refresh_token: signInData.session.refresh_token,
        },
      },
    });
  });

  // Public login endpoint: supports Bangladeshi phone number (primary) or email + password via real Supabase Auth
  app.post('/api/auth/login', async (req, res) => {
    if (!isServerConfigured || !supabaseAdmin || !supabaseAnon) {
      return res.status(503).json({
        configured: false,
        code: 'SUPABASE_UNCONFIGURED',
        error: 'Supabase অথেনটিকেশন এখনো কনফিগার করা হয়নি। অনুগ্রহ করে সার্ভার এনভায়রনমেন্ট ভ্যারিয়েবল সেট করুন।',
      });
    }

    const clientIp = getClientIp(req);
    const loginLimit = checkLoginIpRateLimit(clientIp);
    if (!loginLimit.allowed) {
      res.setHeader('Retry-After', String(loginLimit.retryAfterSec));
      return res.status(429).json({
        configured: true,
        code: 'LOGIN_RATE_LIMIT',
        error: `অতিরিক্ত লগইন প্রচেষ্টার কারণে সাময়িকভাবে বিরতি দেওয়া হয়েছে। অনুগ্রহ করে ${Math.ceil(loginLimit.retryAfterSec / 60)} মিনিট পর আবার চেষ্টা করুন।`,
      });
    }

    const { identifier, email, phone, password } = req.body ?? {};
    const rawIdentifier =
      typeof identifier === 'string' && identifier.trim()
        ? identifier.trim()
        : typeof phone === 'string' && phone.trim()
          ? phone.trim()
          : typeof email === 'string' && email.trim()
            ? email.trim()
            : '';
    const rawPassword = typeof password === 'string' ? password : '';

    if (!rawIdentifier || !rawPassword) {
      return res.status(400).json({
        configured: true,
        code: 'MISSING_CREDENTIALS',
        error: 'অনুগ্রহ করে আপনার ফোন নম্বর অথবা ইমেইল এবং পাসওয়ার্ড দিন।',
      });
    }

    const genericInvalidMsg = 'ফোন নম্বর/ইমেইল অথবা পাসওয়ার্ড সঠিক নয়।';
    let targetEmail = '';
    let matchedProfile: { id: string; email: string; role: string; is_frozen: boolean } | null = null;

    if (rawIdentifier.includes('@')) {
      const cleanEmail = rawIdentifier.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
        return res.status(400).json({
          configured: true,
          code: 'INVALID_IDENTIFIER',
          error: 'অনুগ্রহ করে সঠিক বাংলাদেশি ফোন নম্বর (01XXXXXXXXX) অথবা ইমেইল দিন।',
        });
      }
      targetEmail = cleanEmail;
      const { data: prof } = await supabaseAdmin
        .from('profiles')
        .select('id, email, role, is_frozen')
        .eq('email', cleanEmail)
        .maybeSingle();
      matchedProfile = prof ?? null;
    } else {
      const canonicalPhone = normalizeBdPhone(rawIdentifier);
      if (!canonicalPhone) {
        return res.status(400).json({
          configured: true,
          code: 'INVALID_IDENTIFIER',
          error: 'অনুগ্রহ করে সঠিক বাংলাদেশি ফোন নম্বর (01XXXXXXXXX) অথবা ইমেইল দিন।',
        });
      }

      const variants = getBdPhoneVariants(canonicalPhone);
      const { data: phoneMatches, error: lookupErr } = await supabaseAdmin
        .from('profiles')
        .select('id, email, role, is_frozen')
        .in('phone', variants)
        .limit(2);

      if (lookupErr || !phoneMatches || phoneMatches.length !== 1 || !phoneMatches[0].email) {
        return res.status(401).json({
          configured: true,
          code: 'INVALID_CREDENTIALS',
          error: genericInvalidMsg,
        });
      }

      matchedProfile = phoneMatches[0];
      targetEmail = matchedProfile.email;
    }

    const { data: signInData, error: signInErr } = await supabaseAnon.auth.signInWithPassword({
      email: targetEmail,
      password: rawPassword,
    });

    if (signInErr || !signInData.session) {
      const signInCode = (signInErr as { code?: string } | null)?.code || '';
      const signInStatus = (signInErr as { status?: number } | null)?.status || 401;
      if (signInStatus === 429 || signInCode === 'over_request_rate_limit') {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({
          configured: true,
          code: 'SUPABASE_AUTH_RATE_LIMIT',
          error: 'অতিরিক্ত অনুরোধের কারণে সাময়িক বিরতি রয়েছে। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।',
        });
      }
      return res.status(401).json({
        configured: true,
        code: 'INVALID_CREDENTIALS',
        error: genericInvalidMsg,
      });
    }

    if (matchedProfile?.is_frozen) {
      return res.status(403).json({
        configured: true,
        code: 'ACCOUNT_FROZEN',
        error: 'পর্যালোচনার জন্য আপনার অ্যাকাউন্টটি সাময়িকভাবে ফ্রিজ করা হয়েছে।',
      });
    }

    return res.status(200).json({
      configured: true,
      data: {
        session: {
          access_token: signInData.session.access_token,
          refresh_token: signInData.session.refresh_token,
        },
        role: matchedProfile?.role || 'agent',
      },
    });
  });

  // Authenticated profile, wallets, transactions, settlements, KYC, tickets & gateways overview
  app.get('/api/auth/me', requireSupabaseAuth, async (req: AuthenticatedRequest, res) => {
    let { data: profile, error: profErr } = await supabaseAdmin!
      .from('profiles')
      .select('*')
      .eq('id', req.userId!)
      .maybeSingle();

    if (!profile && !profErr) {
      const healed = await ensureProfileForAuthenticatedUser(req.userId!);
      if (healed.profile) {
        profile = healed.profile;
      } else {
        return res.status(healed.status || 404).json({
          configured: true,
          schemaReady: !healed.schemaPending,
          error: healed.error || 'ব্যবহারকারীর প্রোফাইল ডাটাবেজে পাওয়া যায়নি।',
        });
      }
    }

    if (profErr) {
      const isMissingTable = profErr.code === 'PGRST205';
      const localizedErr = isMissingTable
        ? 'ডাটাবেজ স্কিমা (profiles টেবিল) এখনো Supabase-এ তৈরি করা হয়নি। অনুগ্রহ করে SQL মাইগ্রেশন প্রয়োগ করুন।'
        : profErr.message;
      return res.status(isMissingTable ? 503 : 404).json({
        configured: true,
        schemaReady: !isMissingTable,
        error: localizedErr,
      });
    }

    const ensuredProfile = await ensureProfileAgentCode(profile as Record<string, unknown>);
    await ensureAgentBdtWallets(req.userId!, String(ensuredProfile.role || ''));

    const { data: wallets } = await supabaseAdmin!
      .from('wallets')
      .select('*')
      .eq('user_id', req.userId!)
      .order('created_at', { ascending: true });

    const walletIds = (wallets ?? []).map((w) => w.id);
    const txFilter =
      walletIds.length > 0
        ? `initiator_user_id.eq.${req.userId!},sender_wallet_id.in.(${walletIds.join(',')}),receiver_wallet_id.in.(${walletIds.join(',')})`
        : `initiator_user_id.eq.${req.userId!}`;

    const [txRes, settleRes, kycRes, ticketRes, gwRes, mfsRes, notifRes, refCountRes, platformConfigResult] = await Promise.all([
      supabaseAdmin!
        .from('transactions')
        .select('*')
        .or(txFilter)
        .order('created_at', { ascending: false })
        .limit(80),
      supabaseAdmin!
        .from('settlement_requests')
        .select('*')
        .eq('requester_id', req.userId!)
        .order('created_at', { ascending: false })
        .limit(30),
      supabaseAdmin!
        .from('kyc_submissions')
        .select('*')
        .eq('user_id', req.userId!)
        .order('created_at', { ascending: false })
        .limit(20),
      supabaseAdmin!
        .from('support_tickets')
        .select('*')
        .eq('user_id', req.userId!)
        .order('created_at', { ascending: false })
        .limit(30),
      supabaseAdmin!
        .from('agent_gateways')
        .select('*')
        .eq('user_id', req.userId!)
        .order('activated_at', { ascending: false }),
      supabaseAdmin!
        .from('mfs_payment_requests')
        .select('*')
        .eq('agent_id', req.userId!)
        .order('created_at', { ascending: false })
        .limit(50),
      supabaseAdmin!
        .from('user_notifications')
        .select('*')
        .eq('user_id', req.userId!)
        .order('created_at', { ascending: false })
        .limit(40),
      supabaseAdmin!
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('referred_by_agent_id', req.userId!),
      readPlatformConfig(),
    ]);

    if (mfsRes.error && !isMissingSchemaError(mfsRes.error)) {
      console.warn(`[auth/me] mfs_payment_requests query error userId=${req.userId}: ${mfsRes.error.code || ''} ${mfsRes.error.message}`);
    }
    if (notifRes.error && !isMissingSchemaError(notifRes.error)) {
      console.warn(`[auth/me] user_notifications query error userId=${req.userId}: ${notifRes.error.code || ''} ${notifRes.error.message}`);
    }

    const agentVisiblePlatformConfig = {
      ...platformConfigResult.config,
      depositMethods: platformConfigResult.config.depositMethods.filter(
        (m) => m.enabled && m.accountNumber.trim().length > 0
      ),
    };

    return res.json({
      configured: true,
      data: {
        profile: sanitizeProfile(ensuredProfile),
        wallets: wallets ?? [],
        transactions: txRes.data ?? [],
        settlements: settleRes.data ?? [],
        kycSubmissions: kycRes.data ?? [],
        tickets: ticketRes.data ?? [],
        gateways: gwRes.data ?? [],
        mfsRequests: mfsRes.data ?? [],
        notifications: notifRes.data ?? [],
        mfsSchemaPending: isMissingSchemaError(mfsRes.error) || isMissingSchemaError(notifRes.error),
        referralCount: refCountRes.count ?? 0,
        platformConfig: agentVisiblePlatformConfig,
      },
    });
  });

  // Dedicated Agent-scoped Bet Deposit & Bet Payout request + notification refresh endpoint
  app.get(
    '/api/agent/mfs-requests',
    requireSupabaseAuth,
    requireRoles('user', 'agent', 'sub_agent', 'super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const [mfsRes, notifRes] = await Promise.all([
        supabaseAdmin!
          .from('mfs_payment_requests')
          .select('*')
          .eq('agent_id', req.userId!)
          .order('created_at', { ascending: false })
          .limit(50),
        supabaseAdmin!
          .from('user_notifications')
          .select('*')
          .eq('user_id', req.userId!)
          .order('created_at', { ascending: false })
          .limit(40),
      ]);

      if (mfsRes.error && !isMissingSchemaError(mfsRes.error)) {
        console.warn(`[agent/mfs-requests] query error userId=${req.userId}: ${mfsRes.error.code || ''} ${mfsRes.error.message}`);
      }
      if (notifRes.error && !isMissingSchemaError(notifRes.error)) {
        console.warn(`[agent/mfs-requests] notifications query error userId=${req.userId}: ${notifRes.error.code || ''} ${notifRes.error.message}`);
      }

      const schemaPending = isMissingSchemaError(mfsRes.error) || isMissingSchemaError(notifRes.error);
      return res.json({
        configured: true,
        data: {
          mfsRequests: mfsRes.data ?? [],
          notifications: notifRes.data ?? [],
          schemaPending,
          error: mfsRes.error && !isMissingSchemaError(mfsRes.error) ? mfsRes.error.message : null,
        },
      });
    }
  );

  // Agent Profile Avatar Update
  app.patch('/api/agent/avatar', requireSupabaseAuth, async (req: AuthenticatedRequest, res) => {
    const { avatarUrl } = req.body ?? {};
    const cleanUrl = typeof avatarUrl === 'string' ? avatarUrl.trim() : '';
    if (!cleanUrl || cleanUrl.length > 450000) {
      return res.status(400).json({ configured: true, error: 'অনুগ্রহ করে সঠিক এবং ৪০০ কেবি-র কম আকারের প্রোফাইল ছবি দিন।' });
    }
    const { data, error } = await supabaseAdmin!
      .from('profiles')
      .update({ avatar_url: cleanUrl, updated_at: new Date().toISOString() })
      .eq('id', req.userId!)
      .select('*')
      .single();
    if (error) return res.status(400).json({ configured: true, error: error.message });
    return res.json({ configured: true, data: sanitizeProfile(data as Record<string, unknown>) });
  });

  // Agent Withdraw PIN Setup / Change (4-6 numeric digits, salted scrypt hash)
  app.post('/api/agent/withdraw-pin', requireSupabaseAuth, async (req: AuthenticatedRequest, res) => {
    const { currentPin, newPin, confirmPin } = req.body ?? {};
    const cleanNew = String(newPin ?? '').trim();
    const cleanConfirm = typeof confirmPin === 'string' ? confirmPin.trim() : '';

    if (!/^\d{4,6}$/.test(cleanNew)) {
      return res.status(400).json({ configured: true, error: 'উইথড্র পিন অবশ্যই ৪ থেকে ৬ সংখ্যার হতে হবে।' });
    }
    if (cleanConfirm !== cleanNew) {
      return res.status(400).json({ configured: true, error: 'নতুন পিন ও নিশ্চিত পিন মিলছে না।' });
    }

    let { data: prof, error: profErr } = await supabaseAdmin!
      .from('profiles')
      .select('id, role, withdraw_pin_hash')
      .eq('id', req.userId!)
      .maybeSingle();

    if (profErr) {
      if (isMissingSchemaError(profErr)) {
        console.warn(
          `[agent/withdraw-pin] schema_pending userId=${req.userId} code=${profErr.code || ''} msg="${profErr.message}"`
        );
        return res.status(503).json({
          configured: true,
          code: 'SCHEMA_PENDING',
          schemaPending: true,
          error:
            'ডাটাবেজের profiles টেবিলে withdraw_pin_hash কলাম এখনো যোগ করা হয়নি। অনুগ্রহ করে supabase/migrations/007_fix_withdraw_pin_profile.sql মাইগ্রেশনটি চালান।',
        });
      }
      console.error(
        `[agent/withdraw-pin] profile_lookup_error userId=${req.userId} code=${profErr.code || ''} msg="${profErr.message}"`
      );
      return res.status(500).json({ configured: true, error: 'প্রোফাইল যাচাই করতে ডাটাবেজ ত্রুটি হয়েছে।' });
    }

    if (!prof) {
      const healed = await ensureProfileForAuthenticatedUser(req.userId!);
      if (healed.error) {
        return res.status(healed.status || 404).json({
          configured: true,
          schemaPending: Boolean(healed.schemaPending),
          error: healed.error,
        });
      }
      const { data: retryProf, error: retryErr } = await supabaseAdmin!
        .from('profiles')
        .select('id, role, withdraw_pin_hash')
        .eq('id', req.userId!)
        .maybeSingle();

      if (retryErr) {
        if (isMissingSchemaError(retryErr)) {
          return res.status(503).json({
            configured: true,
            code: 'SCHEMA_PENDING',
            schemaPending: true,
            error:
              'ডাটাবেজের profiles টেবিলে withdraw_pin_hash কলাম এখনো যোগ করা হয়নি। অনুগ্রহ করে supabase/migrations/007_fix_withdraw_pin_profile.sql মাইগ্রেশনটি চালান।',
          });
        }
        return res.status(500).json({ configured: true, error: retryErr.message });
      }
      prof = retryProf;
    }

    if (!prof) {
      return res.status(404).json({ configured: true, error: 'প্রোফাইল পাওয়া যায়নি।' });
    }

    if (prof.withdraw_pin_hash) {
      const cleanCurr = String(currentPin ?? '').trim();
      if (!cleanCurr) {
        return res.status(409).json({
          configured: true,
          code: 'PIN_ALREADY_SET',
          data: { has_withdraw_pin: true },
          error: 'উইথড্র পিন ইতিমধ্যে সেট করা আছে।',
        });
      }
      if (!verifyWithdrawPin(cleanCurr, prof.withdraw_pin_hash)) {
        return res.status(400).json({
          configured: true,
          code: 'INVALID_CURRENT_PIN',
          error: 'বর্তমান উইথড্র পিন সঠিক নয়।',
        });
      }
    }

    const pinHash = hashWithdrawPin(cleanNew);
    const { error: updateErr } = await supabaseAdmin!
      .from('profiles')
      .update({ withdraw_pin_hash: pinHash, updated_at: new Date().toISOString() })
      .eq('id', req.userId!);

    if (updateErr) {
      if (isMissingSchemaError(updateErr)) {
        return res.status(503).json({
          configured: true,
          code: 'SCHEMA_PENDING',
          schemaPending: true,
          error:
            'ডাটাবেজের profiles টেবিলে withdraw_pin_hash কলাম এখনো যোগ করা হয়নি। অনুগ্রহ করে supabase/migrations/007_fix_withdraw_pin_profile.sql মাইগ্রেশনটি চালান।',
        });
      }
      return res.status(400).json({ configured: true, error: updateErr.message });
    }

    await supabaseAdmin!.from('audit_logs').insert({
      actor_id: req.userId!,
      actor_role: String(prof.role || req.userRole || 'agent'),
      action: prof.withdraw_pin_hash ? 'withdraw_pin_changed' : 'withdraw_pin_created',
      target_table: 'profiles',
      target_id: req.userId!,
      payload: {},
    });

    return res.json({ configured: true, data: { has_withdraw_pin: true } });
  });

  // Agent Password Change (verifies current password first)
  app.post('/api/agent/change-password', requireSupabaseAuth, async (req: AuthenticatedRequest, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!currentPassword || !newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ configured: true, error: 'বর্তমান পাসওয়ার্ড এবং কমপক্ষে ৬ অক্ষরের নতুন পাসওয়ার্ড দিন।' });
    }
    const { data: prof } = await supabaseAdmin!
      .from('profiles')
      .select('email')
      .eq('id', req.userId!)
      .single();
    if (!prof?.email) return res.status(404).json({ configured: true, error: 'অ্যাকাউন্ট খুঁজে পাওয়া যায়নি।' });

    const { error: checkErr } = await supabaseAnon!.auth.signInWithPassword({
      email: prof.email,
      password: String(currentPassword),
    });
    if (checkErr) {
      return res.status(400).json({ configured: true, error: 'বর্তমান পাসওয়ার্ড সঠিক নয়।' });
    }

    const { error: updateErr } = await supabaseAdmin!.auth.admin.updateUserById(req.userId!, {
      password: String(newPassword),
    });
    if (updateErr) {
      return res.status(400).json({ configured: true, error: updateErr.message });
    }

    await supabaseAdmin!.from('audit_logs').insert({
      actor_id: req.userId!,
      actor_role: req.userRole!,
      action: 'password_changed',
      target_table: 'profiles',
      target_id: req.userId!,
      payload: {},
    });

    return res.json({ configured: true, data: { updated: true } });
  });

  // Mark agent notifications as read
  app.post('/api/notifications/read', requireSupabaseAuth, async (req: AuthenticatedRequest, res) => {
    await supabaseAdmin!
      .from('user_notifications')
      .update({ is_read: true })
      .eq('user_id', req.userId!)
      .eq('is_read', false);
    return res.json({ configured: true, data: { read: true } });
  });

  // Safe self-profile update (never permits changing role, kyc_status, or is_frozen)
  app.patch('/api/auth/profile', requireSupabaseAuth, async (req: AuthenticatedRequest, res) => {
    const { fullName, phone, country, businessName } = req.body ?? {};
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (typeof fullName === 'string' && fullName.trim().length >= 2) {
      updates.full_name = fullName.trim();
    }
    if (typeof phone === 'string') {
      updates.phone = phone.trim() || null;
    }
    if (typeof country === 'string' && country.trim().length >= 2) {
      updates.country = country.trim().slice(0, 8);
    }
    if (typeof businessName === 'string') {
      updates.business_name = businessName.trim() || null;
    }

    const { data, error } = await supabaseAdmin!
      .from('profiles')
      .update(updates)
      .eq('id', req.userId!)
      .select('*')
      .single();

    if (error) {
      return res.status(400).json({ configured: true, error: error.message });
    }

    await supabaseAdmin!.from('audit_logs').insert({
      actor_id: req.userId!,
      actor_role: req.userRole!,
      action: 'profile_updated',
      target_table: 'profiles',
      target_id: req.userId!,
      payload: updates,
    });

    return res.json({ configured: true, data: sanitizeProfile(data as Record<string, unknown>) });
  });

  // Atomic wallet transfer via PostgreSQL RPC (BDT only)
  app.post('/api/wallets/transfer', requireSupabaseAuth, async (req: AuthenticatedRequest, res) => {
    const { senderWalletId, recipientEmail, amount, description, currency } = req.body ?? {};
    if (currency !== undefined && String(currency).trim().toUpperCase() !== 'BDT') {
      return res.status(400).json({ configured: true, error: 'শুধুমাত্র BDT (৳) কারেন্সিতে ট্রান্সফার করা যাবে।' });
    }

    const numericAmount = Number(amount);

    if (!senderWalletId || !recipientEmail || !Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ configured: true, error: 'সঠিক প্রেরক ওয়ালেট, প্রাপকের ইমেইল এবং ধনাত্মক পরিমাণ প্রদান করুন।' });
    }

    const { data: senderWallet } = await supabaseAdmin!
      .from('wallets')
      .select('id, user_id, currency, status')
      .eq('id', senderWalletId)
      .eq('user_id', req.userId!)
      .eq('currency', 'BDT')
      .eq('status', 'active')
      .single();

    if (!senderWallet) {
      return res.status(403).json({ configured: true, error: 'প্রেরক BDT ওয়ালেটের মালিকানা বা সক্রিয় অবস্থা যাচাই ব্যর্থ হয়েছে।' });
    }

    const { data: recipient } = await supabaseAdmin!
      .from('profiles')
      .select('id')
      .eq('email', String(recipientEmail).trim().toLowerCase())
      .single();

    if (!recipient) {
      return res.status(404).json({ configured: true, error: 'প্রাপকের ZentoPay অ্যাকাউন্ট খুঁজে পাওয়া যায়নি।' });
    }

    const { data: receiverWallet } = await supabaseAdmin!
      .from('wallets')
      .select('id, currency, status')
      .eq('user_id', recipient.id)
      .eq('wallet_type', 'main')
      .eq('currency', 'BDT')
      .eq('status', 'active')
      .single();

    if (!receiverWallet) {
      return res.status(404).json({ configured: true, error: 'প্রাপকের সক্রিয় BDT মূল ওয়ালেট পাওয়া যায়নি।' });
    }

    if (senderWallet.id === receiverWallet.id) {
      return res.status(400).json({ configured: true, error: 'নিজের একই ওয়ালেটে ট্রান্সফার করা যাবে না।' });
    }

    const feeAmount = Number((numericAmount * 0.005).toFixed(2));
    const { data: txId, error: rpcErr } = await supabaseAdmin!.rpc('execute_wallet_transfer', {
      p_sender_wallet_id: senderWallet.id,
      p_receiver_wallet_id: receiverWallet.id,
      p_initiator_user_id: req.userId!,
      p_amount: numericAmount,
      p_fee_amount: feeAmount,
      p_description: description || `Transfer to ${recipientEmail}`,
    });

    if (rpcErr) {
      const msgLower = rpcErr.message.toLowerCase();
      const localized = msgLower.includes('insufficient')
        ? 'ওয়ালেটে পর্যাপ্ত ব্যবহারযোগ্য ব্যালেন্স নেই।'
        : msgLower.includes('inactive')
          ? 'প্রেরক বা প্রাপকের ওয়ালেট সক্রিয় নয়।'
          : rpcErr.message;
      return res.status(400).json({ configured: true, error: localized });
    }

    return res.json({ configured: true, data: { transactionId: txId, feeAmount, currency: 'BDT', status: 'completed' } });
  });

  // Deposit request submission (creates pending BDT deposit transaction awaiting Finance Admin approval)
  app.post(
    '/api/deposits',
    requireSupabaseAuth,
    requireRoles('user', 'agent', 'sub_agent', 'super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const {
        walletId,
        channel,
        senderAccount,
        externalTrxId,
        amount,
        planActivation,
        screenshotData,
        currency,
        userId: bodyUserId,
        initiatorUserId: bodyInitiatorUserId,
        initiator_user_id: bodyInitiatorUserIdSnake,
      } = req.body ?? {};

      // Strictly reject any attempt to submit a deposit on behalf of another user
      const suppliedActorId = [bodyUserId, bodyInitiatorUserId, bodyInitiatorUserIdSnake].find(
        (v) => v !== undefined && v !== null && String(v).trim() !== ''
      );
      if (suppliedActorId && String(suppliedActorId).trim() !== req.userId!) {
        console.warn(
          `[deposits] 403 IMPERSONATION_FORBIDDEN authUser=${req.userId} suppliedActor=${String(suppliedActorId).trim()}`
        );
        return res.status(403).json({
          configured: true,
          code: 'IMPERSONATION_FORBIDDEN',
          error: 'অন্য ব্যবহারকারীর নামে ডিপোজিট অনুরোধ জমা দেওয়া যাবে না।',
        });
      }

      if (currency !== undefined && String(currency).trim().toUpperCase() !== 'BDT') {
        return res.status(400).json({
          configured: true,
          code: 'INVALID_CURRENCY',
          error: 'শুধুমাত্র BDT (৳) কারেন্সিতে ডিপোজিট গ্রহণ করা হয়।',
        });
      }

      const cleanChannel = typeof channel === 'string' ? channel.trim().toLowerCase() : '';
      if (!cleanChannel || !/^[a-z0-9_-]{2,40}$/.test(cleanChannel) || DISALLOWED_PAYMENT_IDS.has(cleanChannel)) {
        return res.status(400).json({
          configured: true,
          code: 'INVALID_PAYMENT_METHOD',
          error: 'শুধুমাত্র অনুমোদিত BDT পেমেন্ট মাধ্যম গ্রহণযোগ্য।',
        });
      }

      const { config: platformCfg } = await readPlatformConfig();
      const matchedMethod = platformCfg.depositMethods.find(
        (m) => m.id === cleanChannel && m.enabled && m.accountNumber.trim().length > 0
      );

      if (!matchedMethod) {
        console.warn(`[deposits] 400 METHOD_UNAVAILABLE userId=${req.userId} channel=${cleanChannel}`);
        return res.status(400).json({
          configured: true,
          code: 'METHOD_UNAVAILABLE',
          error: 'নির্বাচিত পেমেন্ট মাধ্যমটি বর্তমানে সক্রিয় বা কনফিগার করা নেই।',
        });
      }

      if (planActivation !== undefined && planActivation !== null && planActivation !== 'trial' && planActivation !== 'premium') {
        return res.status(400).json({
          configured: true,
          code: 'INVALID_PLAN',
          error: 'অবৈধ প্ল্যান অ্যাক্টিভেশন অনুরোধ।',
        });
      }

      const validPlan = planActivation === 'trial' || planActivation === 'premium' ? planActivation : null;
      const requiredExact = validPlan === 'trial' ? 5000 : validPlan === 'premium' ? 15000 : null;
      const rawAmount = Number(amount);
      const numericAmount = Number(rawAmount.toFixed(2));

      if (
        !Number.isFinite(rawAmount) ||
        !Number.isFinite(numericAmount) ||
        numericAmount < 1000 ||
        numericAmount > 10000000 ||
        (requiredExact !== null && numericAmount !== requiredExact)
      ) {
        return res.status(400).json({
          configured: true,
          code: 'INVALID_AMOUNT',
          error: requiredExact
            ? `এই প্ল্যান সক্রিয় করতে ঠিক ৳${requiredExact} প্রদান করুন।`
            : 'ডিপোজিট পরিমাণ ন্যূনতম ৳১,০০০ এবং সর্বোচ্চ ৳১,০০,০০,০০০ হতে হবে।',
        });
      }

      const cleanSender = typeof senderAccount === 'string' ? senderAccount.trim() : '';
      if (
        cleanSender.length < 5 ||
        cleanSender.length > 60 ||
        !/^[a-zA-Z0-9+\-\s()_.@]{5,60}$/.test(cleanSender) ||
        cleanSender.replace(/[^a-zA-Z0-9]/g, '').length < 4
      ) {
        return res.status(400).json({
          configured: true,
          code: 'INVALID_SENDER_ACCOUNT',
          error: 'সঠিক প্রেরক নম্বর বা অ্যাকাউন্ট আইডি (কমপক্ষে ৫ অক্ষর) প্রদান করুন।',
        });
      }

      const cleanTrxId = typeof externalTrxId === 'string' ? externalTrxId.trim() : '';
      if (!/^[a-zA-Z0-9_-]{4,64}$/.test(cleanTrxId)) {
        return res.status(400).json({
          configured: true,
          code: 'INVALID_TRX_ID',
          error: 'সঠিক ট্রানজেকশন আইডি (TrxID: ৪–৬৪ অক্ষরের অক্ষর/সংখ্যা) প্রদান করুন।',
        });
      }

      if (screenshotData !== undefined && screenshotData !== null && screenshotData !== '') {
        if (
          typeof screenshotData !== 'string' ||
          screenshotData.length > 700000 ||
          (!screenshotData.startsWith('data:image/') && !screenshotData.startsWith('https://'))
        ) {
          return res.status(400).json({
            configured: true,
            code: 'INVALID_SCREENSHOT',
            error: 'অবৈধ পেমেন্ট স্ক্রিনশট ফরম্যাট বা আকার।',
          });
        }
      }

      const cleanWalletId = typeof walletId === 'string' ? walletId.trim() : '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanWalletId)) {
        return res.status(400).json({
          configured: true,
          code: 'INVALID_WALLET_ID',
          error: 'সঠিক লক্ষ্য BDT ওয়ালেট নির্বাচন করুন।',
        });
      }

      const { data: targetWallet, error: walletErr } = await supabaseAdmin!
        .from('wallets')
        .select('id, user_id, wallet_type, currency, status')
        .eq('id', cleanWalletId)
        .maybeSingle();

      if (walletErr) {
        console.error(`[deposits] 500 WALLET_LOOKUP_FAILED userId=${req.userId} walletId=${cleanWalletId}: ${walletErr.message}`);
        return res.status(500).json({
          configured: true,
          code: 'WALLET_LOOKUP_FAILED',
          error: 'ওয়ালেট যাচাই করতে ডাটাবেজ ত্রুটি হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।',
        });
      }

      if (!targetWallet) {
        console.warn(`[deposits] 404 WALLET_NOT_FOUND userId=${req.userId} walletId=${cleanWalletId}`);
        return res.status(404).json({
          configured: true,
          code: 'WALLET_NOT_FOUND',
          error: 'নির্বাচিত লক্ষ্য ওয়ালেটটি খুঁজে পাওয়া যায়নি। অনুগ্রহ করে পেজটি রিফ্রেশ করুন।',
        });
      }

      if (targetWallet.user_id !== req.userId!) {
        console.warn(
          `[deposits] 403 WALLET_OWNERSHIP_FORBIDDEN userId=${req.userId} walletId=${cleanWalletId} owner=${targetWallet.user_id}`
        );
        return res.status(403).json({
          configured: true,
          code: 'WALLET_OWNERSHIP_FORBIDDEN',
          error: 'অন্য ব্যবহারকারীর ওয়ালেটে ডিপোজিট অনুরোধ জমা দেওয়া যাবে না।',
        });
      }

      if (targetWallet.status !== 'active') {
        console.warn(
          `[deposits] 403 WALLET_INACTIVE userId=${req.userId} walletId=${cleanWalletId} status=${targetWallet.status}`
        );
        return res.status(403).json({
          configured: true,
          code: 'WALLET_INACTIVE',
          error: 'নির্বাচিত ওয়ালেটটি বর্তমানে সক্রিয় নয় (ফ্রিজ বা বন্ধ)।',
        });
      }

      if (targetWallet.currency !== 'BDT') {
        console.warn(
          `[deposits] 400 NON_BDT_WALLET userId=${req.userId} walletId=${cleanWalletId} currency=${targetWallet.currency}`
        );
        return res.status(400).json({
          configured: true,
          code: 'NON_BDT_WALLET',
          error: 'শুধুমাত্র BDT (৳) ওয়ালেটে ডিপোজিট গ্রহণ করা হয়। অনুগ্রহ করে পেজটি রিফ্রেশ করে আপনার BDT ওয়ালেট ব্যবহার করুন।',
        });
      }

      const { data: dupTrx } = await supabaseAdmin!
        .from('transactions')
        .select('id')
        .eq('tx_type', 'deposit')
        .in('status', ['pending', 'completed'])
        .eq('metadata->>externalTrxId', cleanTrxId)
        .limit(1)
        .maybeSingle();

      if (dupTrx) {
        return res.status(409).json({
          configured: true,
          code: 'DUPLICATE_TRX_ID',
          error: 'এই TrxID দিয়ে ইতিমধ্যে একটি ডিপোজিট অনুরোধ জমা দেওয়া হয়েছে।',
        });
      }

      const refCode = `DEP-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;
      const { data, error } = await supabaseAdmin!
        .from('transactions')
        .insert({
          reference_code: refCode,
          receiver_wallet_id: targetWallet.id,
          initiator_user_id: req.userId!,
          tx_type: 'deposit',
          amount: numericAmount,
          fee_amount: 0,
          commission_amount: 0,
          currency: 'BDT',
          status: 'pending',
          description: `${matchedMethod.name} ডিপোজিট (${cleanSender} · TrxID: ${cleanTrxId})${validPlan ? ` · ${validPlan === 'trial' ? 'Trial Plan' : 'Premium Plan'}` : ''}`,
          metadata: {
            channel: matchedMethod.id,
            channelName: matchedMethod.name,
            senderAccount: cleanSender,
            externalTrxId: cleanTrxId,
            walletType: targetWallet.wallet_type,
            planActivation: validPlan,
            hasScreenshot: Boolean(screenshotData),
          },
        })
        .select('*')
        .single();

      if (error) {
        console.error(
          `[deposits] insert_failed userId=${req.userId} walletId=${targetWallet.id} code=${error.code || 'none'} msg="${error.message}"`
        );
        return res.status(400).json({
          configured: true,
          code: error.code || 'DEPOSIT_INSERT_FAILED',
          error: error.message || 'ডিপোজিট অনুরোধ সংরক্ষণ করা যায়নি।',
        });
      }

      console.info(
        `[deposits] CREATED txId=${data.id} ref=${refCode} userId=${req.userId} channel=${matchedMethod.id} amount=${numericAmount} BDT`
      );
      return res.json({ configured: true, data });
    }
  );

  // Free Payment Gateway Activation (checks minimum ৳1,000 BDT wallet balance; deducts ৳0)
  app.post(
    '/api/gateway/activate',
    requireSupabaseAuth,
    requireRoles('agent', 'sub_agent', 'user', 'super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const { provider, accountMode, accountNumber } = req.body ?? {};
      const validProviders = ['bkash', 'nagad', 'rocket'];
      const validModes = ['personal', 'merchant', 'agent'];
      const cleanNumber = String(accountNumber || '').trim();

      if (!validProviders.includes(provider) || !validModes.includes(accountMode) || !cleanNumber) {
        return res.status(400).json({
          configured: true,
          error: 'সঠিক প্রোভাইডার (bKash, Nagad, Rocket), অ্যাকাউন্ট ধরন এবং নম্বর প্রয়োজন।',
        });
      }

      if (!/^01\d{9}$/.test(cleanNumber)) {
        return res.status(400).json({
          configured: true,
          error: 'অনুগ্রহ করে ১১ ডিজিটের সঠিক বাংলাদেশি মোবাইল নম্বর (01XXXXXXXXX) দিন।',
        });
      }

      const { data: gatewayId, error: rpcErr } = await supabaseAdmin!.rpc('activate_agent_gateway', {
        p_user_id: req.userId!,
        p_provider: provider,
        p_account_mode: accountMode,
        p_account_number: cleanNumber,
        p_min_required_balance: 1000.0,
      });

      if (rpcErr) {
        const lower = rpcErr.message.toLowerCase();
        const localized = lower.includes('insufficient')
          ? 'গেটওয়ে নম্বর সক্রিয় করতে ন্যূনতম ৳১,০০০ BDT ব্যালেন্স থাকতে হবে (অ্যাক্টিভেশনে ৳০ কাটা হয়)।'
          : lower.includes('already registered to another agent')
            ? 'এই গেটওয়ে নম্বরটি ইতিমধ্যে অন্য একটি এজেন্ট অ্যাকাউন্টে নিবন্ধিত রয়েছে।'
            : rpcErr.message;
        return res.status(400).json({ configured: true, error: localized });
      }

      return res.json({
        configured: true,
        data: {
          gatewayId,
          provider,
          accountMode,
          feeDeducted: 0,
          currency: 'BDT',
          status: 'active',
        },
      });
    }
  );

  app.get('/api/gateway/list', requireSupabaseAuth, async (req: AuthenticatedRequest, res) => {
    const { data, error } = await supabaseAdmin!
      .from('agent_gateways')
      .select('*')
      .eq('user_id', req.userId!)
      .order('activated_at', { ascending: false });

    if (error) {
      return res.status(400).json({ configured: true, error: error.message });
    }
    return res.json({ configured: true, data: data ?? [] });
  });

  app.patch(
    '/api/gateway/:id/toggle',
    requireSupabaseAuth,
    requireRoles('agent', 'sub_agent', 'user', 'super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const { isActive, accountNumber } = req.body ?? {};
      const updates: Record<string, unknown> = {};

      const { data: existingGw } = await supabaseAdmin!
        .from('agent_gateways')
        .select('*')
        .eq('id', req.params.id)
        .eq('user_id', req.userId!)
        .maybeSingle();

      if (!existingGw) {
        return res.status(404).json({ configured: true, error: 'গেটওয়ে কনফিগারেশন পাওয়া যায়নি।' });
      }

      if (typeof accountNumber === 'string' && accountNumber.trim()) {
        const cleanNum = accountNumber.trim();
        if (!/^01\d{9}$/.test(cleanNum)) {
          return res.status(400).json({ configured: true, error: 'অনুগ্রহ করে ১১ ডিজিটের সঠিক নম্বর (01XXXXXXXXX) দিন।' });
        }
        const { data: duplicateGw } = await supabaseAdmin!
          .from('agent_gateways')
          .select('id')
          .eq('provider', existingGw.provider)
          .eq('account_number', cleanNum)
          .neq('user_id', req.userId!)
          .limit(1)
          .maybeSingle();
        if (duplicateGw) {
          return res.status(400).json({
            configured: true,
            error: 'এই গেটওয়ে নম্বরটি ইতিমধ্যে অন্য একটি এজেন্ট অ্যাকাউন্টে নিবন্ধিত রয়েছে।',
          });
        }
        updates.account_number = cleanNum;
      }

      if (typeof isActive === 'boolean') {
        if (isActive) {
          const { data: wallets } = await supabaseAdmin!
            .from('wallets')
            .select('available_balance')
            .eq('user_id', req.userId!)
            .eq('currency', 'BDT')
            .eq('status', 'active')
            .in('wallet_type', ['main', 'float']);
          const maxBal = Math.max(0, ...(wallets ?? []).map((w) => Number(w.available_balance || 0)));
          if (maxBal < 1000) {
            return res.status(400).json({
              configured: true,
              error: 'গেটওয়ে নম্বর সক্রিয় করতে BDT ওয়ালেটে ন্যূনতম ৳১,০০০ ব্যালেন্স থাকতে হবে।',
            });
          }
        }
        updates.is_active = isActive;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ configured: true, error: 'আপডেট করার জন্য কোনো পরিবর্তন প্রদান করা হয়নি।' });
      }

      const { data, error } = await supabaseAdmin!
        .from('agent_gateways')
        .update(updates)
        .eq('id', req.params.id)
        .eq('user_id', req.userId!)
        .select('*')
        .single();

      if (error || !data) {
        return res.status(400).json({ configured: true, error: error?.message || 'গেটওয়ে আপডেট করা যায়নি।' });
      }
      return res.json({ configured: true, data });
    }
  );

  // Agent & Sub-Agent Cash-In / Cash-Out atomic operation (BDT-only with balanced fee ledger)
  app.post(
    '/api/agent/cash-operation',
    requireSupabaseAuth,
    requireRoles('agent', 'sub_agent', 'super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const { opType, customerEmail, amount, currency } = req.body ?? {};
      const rawIdempotency =
        (typeof req.headers['x-idempotency-key'] === 'string' && req.headers['x-idempotency-key']) ||
        (typeof req.body?.idempotencyKey === 'string' && req.body.idempotencyKey) ||
        '';
      const cleanIdempotencyKey = rawIdempotency.trim().slice(0, 120) || null;

      if (currency !== undefined && String(currency).trim().toUpperCase() !== 'BDT') {
        return res.status(400).json({ configured: true, error: 'শুধুমাত্র BDT (৳) কারেন্সিতে ক্যাশ-ইন বা ক্যাশ-আউট করা যাবে।' });
      }

      const numericAmount = Number(Number(amount).toFixed(2));

      if (!['cash_in', 'cash_out'].includes(opType) || !customerEmail || !Number.isFinite(numericAmount) || numericAmount < 50) {
        return res.status(400).json({
          configured: true,
          error: 'কার্যক্রমের ধরন (cash_in / cash_out), গ্রাহকের ইমেইল এবং ন্যূনতম ৳৫০.০০ পরিমাণ দিন।',
        });
      }

      if (cleanIdempotencyKey) {
        const { data: existingOp } = await supabaseAdmin!
          .from('transactions')
          .select('*')
          .eq('initiator_user_id', req.userId!)
          .eq('tx_type', opType)
          .eq('metadata->>idempotencyKey', cleanIdempotencyKey)
          .maybeSingle();

        if (existingOp) {
          return res.json({
            configured: true,
            idempotentReplay: true,
            data: {
              transaction: existingOp,
              feeAmount: Number(existingOp.fee_amount || 0),
              commissionAmount: Number(existingOp.commission_amount || 0),
              platformShare: Number((existingOp.metadata as Record<string, unknown> | null)?.platformShare || 0),
            },
          });
        }
      }

      const cleanEmail = String(customerEmail).trim().toLowerCase();
      const { data: customer } = await supabaseAdmin!
        .from('profiles')
        .select('id, email')
        .eq('email', cleanEmail)
        .single();

      if (!customer) {
        return res.status(404).json({ configured: true, error: 'গ্রাহকের ZentoPay অ্যাকাউন্ট খুঁজে পাওয়া যায়নি।' });
      }
      if (customer.id === req.userId) {
        return res.status(400).json({ configured: true, error: 'নিজের অ্যাকাউন্টে ক্যাশ-ইন বা ক্যাশ-আউট করা যাবে না।' });
      }

      const [operatorWalletsRes, customerWalletRes, operatorProfileRes] = await Promise.all([
        supabaseAdmin!.from('wallets').select('*').eq('user_id', req.userId!).eq('currency', 'BDT').eq('status', 'active'),
        supabaseAdmin!
          .from('wallets')
          .select('*')
          .eq('user_id', customer.id)
          .eq('wallet_type', 'main')
          .eq('currency', 'BDT')
          .eq('status', 'active')
          .single(),
        supabaseAdmin!.from('profiles').select('id, role, parent_agent_id').eq('id', req.userId!).single(),
      ]);

      const operatorWallets = operatorWalletsRes.data ?? [];
      const floatWallet = operatorWallets.find((w) => w.wallet_type === 'float') || operatorWallets.find((w) => w.wallet_type === 'main');
      const commissionWallet = operatorWallets.find((w) => w.wallet_type === 'commission') || floatWallet;
      const customerWallet = customerWalletRes.data;

      if (!floatWallet || !customerWallet) {
        return res.status(404).json({ configured: true, error: 'প্রয়োজনীয় সক্রিয় BDT ফ্লোট বা গ্রাহক ওয়ালেট পাওয়া যায়নি।' });
      }

      const isSubAgent = operatorProfileRes.data?.role === 'sub_agent';
      let parentCommWallet: typeof floatWallet | null = null;
      if (isSubAgent) {
        const { data: hierarchy } = await supabaseAdmin!
          .from('agent_hierarchy')
          .select('agent_id, float_cap, status')
          .eq('sub_agent_id', req.userId!)
          .single();

        if (hierarchy && hierarchy.status !== 'active') {
          return res.status(403).json({ configured: true, error: 'আপনার সাব-এজেন্ট কাউন্টারটি বর্তমানে স্থগিত রয়েছে।' });
        }
        if (numericAmount > Number(floatWallet.daily_limit)) {
          return res.status(400).json({ configured: true, error: 'অনুরোধকৃত পরিমাণ আপনার দৈনিক কাউন্টার সীমা অতিক্রম করেছে।' });
        }
        const parentId = hierarchy?.agent_id || operatorProfileRes.data?.parent_agent_id;
        if (parentId) {
          const { data: pCom } = await supabaseAdmin!
            .from('wallets')
            .select('*')
            .eq('user_id', parentId)
            .eq('wallet_type', 'commission')
            .eq('currency', 'BDT')
            .eq('status', 'active')
            .single();
          parentCommWallet = pCom ?? null;
        }
      }

      const feeRate = isSubAgent ? 0.015 : opType === 'cash_in' ? 0.01 : 0.015;
      const feeAmount = Number((numericAmount * feeRate).toFixed(2));
      const operatorCommission = commissionWallet
        ? Number((feeAmount * (isSubAgent ? 0.5 : 0.65)).toFixed(2))
        : 0;
      const parentCommission = isSubAgent && parentCommWallet ? Number((feeAmount * 0.25).toFixed(2)) : 0;
      const platformShare = Number((feeAmount - operatorCommission - parentCommission).toFixed(2));

      const platformFeeWallet = platformShare > 0 ? await resolvePlatformFeeWallet() : null;
      if (platformShare > 0 && !platformFeeWallet) {
        return res.status(503).json({
          configured: true,
          error: 'প্ল্যাটফর্ম ফি রেভিনিউ ওয়ালেট (BDT settlement) উপলব্ধ নয়। অনুগ্রহ করে অ্যাডমিনের সাথে যোগাযোগ করুন।',
        });
      }

      if (opType === 'cash_in') {
        const { data: updatedFloat, error: floatErr } = await supabaseAdmin!
          .from('wallets')
          .update({
            balance: Number((Number(floatWallet.balance) - numericAmount).toFixed(2)),
            available_balance: Number((Number(floatWallet.available_balance) - numericAmount).toFixed(2)),
            updated_at: new Date().toISOString(),
          })
          .eq('id', floatWallet.id)
          .gte('available_balance', numericAmount)
          .select('*')
          .single();

        if (floatErr || !updatedFloat) {
          return res.status(400).json({ configured: true, error: 'এজেন্ট ফ্লোট ওয়ালেটে পর্যাপ্ত ব্যালেন্স নেই।' });
        }

        const netCustomerCredit = Number((numericAmount - feeAmount).toFixed(2));
        const { data: updatedCustomer } = await supabaseAdmin!
          .from('wallets')
          .update({
            balance: Number((Number(customerWallet.balance) + netCustomerCredit).toFixed(2)),
            available_balance: Number((Number(customerWallet.available_balance) + netCustomerCredit).toFixed(2)),
            updated_at: new Date().toISOString(),
          })
          .eq('id', customerWallet.id)
          .select('*')
          .single();

        const { data: txRow, error: txErr } = await supabaseAdmin!
          .from('transactions')
          .insert({
            reference_code: `CI-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`,
            sender_wallet_id: floatWallet.id,
            receiver_wallet_id: customerWallet.id,
            initiator_user_id: req.userId!,
            tx_type: 'cash_in',
            amount: numericAmount,
            fee_amount: feeAmount,
            commission_amount: operatorCommission,
            currency: 'BDT',
            status: 'completed',
            description: `এজেন্ট ক্যাশ-ইন: ${cleanEmail}`,
            metadata: {
              currency: 'BDT',
              feeAmount,
              operatorCommission,
              parentCommission,
              platformShare,
              platformFeeWalletId: platformFeeWallet?.id ?? null,
              idempotencyKey: cleanIdempotencyKey,
            },
          })
          .select('*')
          .single();

        if (txErr || !txRow) {
          return res.status(400).json({ configured: true, error: txErr?.message || 'লেনদেন সংরক্ষণ ব্যর্থ হয়েছে।' });
        }

        const ledgerRows: Array<Record<string, unknown>> = [
          {
            transaction_id: txRow.id,
            wallet_id: floatWallet.id,
            entry_type: 'debit',
            amount: numericAmount,
            balance_after: Number(updatedFloat.balance),
          },
          {
            transaction_id: txRow.id,
            wallet_id: customerWallet.id,
            entry_type: 'credit',
            amount: netCustomerCredit,
            balance_after: Number(updatedCustomer?.balance ?? Number(customerWallet.balance) + netCustomerCredit),
          },
        ];

        if (commissionWallet && operatorCommission > 0) {
          const { data: latestComm } = await supabaseAdmin!.from('wallets').select('balance, available_balance').eq('id', commissionWallet.id).single();
          const newCommBal = Number((Number(latestComm?.balance ?? commissionWallet.balance) + operatorCommission).toFixed(2));
          await supabaseAdmin!
            .from('wallets')
            .update({
              balance: newCommBal,
              available_balance: Number((Number(latestComm?.available_balance ?? commissionWallet.available_balance) + operatorCommission).toFixed(2)),
              updated_at: new Date().toISOString(),
            })
            .eq('id', commissionWallet.id);
          ledgerRows.push({
            transaction_id: txRow.id,
            wallet_id: commissionWallet.id,
            entry_type: 'credit',
            amount: operatorCommission,
            balance_after: newCommBal,
          });
        }

        if (parentCommWallet && parentCommission > 0) {
          const newParentBal = Number((Number(parentCommWallet.balance) + parentCommission).toFixed(2));
          await supabaseAdmin!
            .from('wallets')
            .update({
              balance: newParentBal,
              available_balance: Number((Number(parentCommWallet.available_balance) + parentCommission).toFixed(2)),
              updated_at: new Date().toISOString(),
            })
            .eq('id', parentCommWallet.id);
          ledgerRows.push({
            transaction_id: txRow.id,
            wallet_id: parentCommWallet.id,
            entry_type: 'credit',
            amount: parentCommission,
            balance_after: newParentBal,
          });
        }

        if (platformFeeWallet && platformShare > 0) {
          const { data: latestFee } = await supabaseAdmin!.from('wallets').select('balance, available_balance').eq('id', platformFeeWallet.id).single();
          const newFeeBal = Number((Number(latestFee?.balance ?? platformFeeWallet.balance) + platformShare).toFixed(2));
          await supabaseAdmin!
            .from('wallets')
            .update({
              balance: newFeeBal,
              available_balance: Number((Number(latestFee?.available_balance ?? platformFeeWallet.available_balance) + platformShare).toFixed(2)),
              updated_at: new Date().toISOString(),
            })
            .eq('id', platformFeeWallet.id);
          ledgerRows.push({
            transaction_id: txRow.id,
            wallet_id: platformFeeWallet.id,
            entry_type: 'credit',
            amount: platformShare,
            balance_after: newFeeBal,
          });
        }

        await supabaseAdmin!.from('ledger_entries').insert(ledgerRows);
        return res.json({ configured: true, data: { transaction: txRow, feeAmount, commissionAmount: operatorCommission, platformShare } });
      }

      // Cash-Out: Customer wallet debited (amount + fee), agent float credited (amount), commissions & platform share credited
      const totalCustomerDebit = Number((numericAmount + feeAmount).toFixed(2));
      const { data: updatedCust, error: custErr } = await supabaseAdmin!
        .from('wallets')
        .update({
          balance: Number((Number(customerWallet.balance) - totalCustomerDebit).toFixed(2)),
          available_balance: Number((Number(customerWallet.available_balance) - totalCustomerDebit).toFixed(2)),
          updated_at: new Date().toISOString(),
        })
        .eq('id', customerWallet.id)
        .gte('available_balance', totalCustomerDebit)
        .select('*')
        .single();

      if (custErr || !updatedCust) {
        return res.status(400).json({ configured: true, error: 'গ্রাহকের ওয়ালেটে পর্যাপ্ত ব্যালেন্স নেই।' });
      }

      const { data: updatedFloat } = await supabaseAdmin!
        .from('wallets')
        .update({
          balance: Number((Number(floatWallet.balance) + numericAmount).toFixed(2)),
          available_balance: Number((Number(floatWallet.available_balance) + numericAmount).toFixed(2)),
          updated_at: new Date().toISOString(),
        })
        .eq('id', floatWallet.id)
        .select('*')
        .single();

      const { data: txRow, error: txErr } = await supabaseAdmin!
        .from('transactions')
        .insert({
          reference_code: `CO-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`,
          sender_wallet_id: customerWallet.id,
          receiver_wallet_id: floatWallet.id,
          initiator_user_id: req.userId!,
          tx_type: 'cash_out',
          amount: numericAmount,
          fee_amount: feeAmount,
          commission_amount: operatorCommission,
          currency: 'BDT',
          status: 'completed',
          description: `এজেন্ট ক্যাশ-আউট: ${cleanEmail}`,
          metadata: {
            currency: 'BDT',
            feeAmount,
            operatorCommission,
            parentCommission,
            platformShare,
            platformFeeWalletId: platformFeeWallet?.id ?? null,
            idempotencyKey: cleanIdempotencyKey,
          },
        })
        .select('*')
        .single();

      if (txErr || !txRow) {
        return res.status(400).json({ configured: true, error: txErr?.message || 'লেনদেন সংরক্ষণ ব্যর্থ হয়েছে।' });
      }

      const ledgerRows: Array<Record<string, unknown>> = [
        {
          transaction_id: txRow.id,
          wallet_id: customerWallet.id,
          entry_type: 'debit',
          amount: totalCustomerDebit,
          balance_after: Number(updatedCust.balance),
        },
        {
          transaction_id: txRow.id,
          wallet_id: floatWallet.id,
          entry_type: 'credit',
          amount: numericAmount,
          balance_after: Number(updatedFloat?.balance ?? Number(floatWallet.balance) + numericAmount),
        },
      ];

      if (commissionWallet && operatorCommission > 0) {
        const { data: latestComm } = await supabaseAdmin!.from('wallets').select('balance, available_balance').eq('id', commissionWallet.id).single();
        const newCommBal = Number((Number(latestComm?.balance ?? commissionWallet.balance) + operatorCommission).toFixed(2));
        await supabaseAdmin!
          .from('wallets')
          .update({
            balance: newCommBal,
            available_balance: Number((Number(latestComm?.available_balance ?? commissionWallet.available_balance) + operatorCommission).toFixed(2)),
            updated_at: new Date().toISOString(),
          })
          .eq('id', commissionWallet.id);
        ledgerRows.push({
          transaction_id: txRow.id,
          wallet_id: commissionWallet.id,
          entry_type: 'credit',
          amount: operatorCommission,
          balance_after: newCommBal,
        });
      }

      if (parentCommWallet && parentCommission > 0) {
        const newParentBal = Number((Number(parentCommWallet.balance) + parentCommission).toFixed(2));
        await supabaseAdmin!
          .from('wallets')
          .update({
            balance: newParentBal,
            available_balance: Number((Number(parentCommWallet.available_balance) + parentCommission).toFixed(2)),
            updated_at: new Date().toISOString(),
          })
          .eq('id', parentCommWallet.id);
        ledgerRows.push({
          transaction_id: txRow.id,
          wallet_id: parentCommWallet.id,
          entry_type: 'credit',
          amount: parentCommission,
          balance_after: newParentBal,
        });
      }

      if (platformFeeWallet && platformShare > 0) {
        const { data: latestFee } = await supabaseAdmin!.from('wallets').select('balance, available_balance').eq('id', platformFeeWallet.id).single();
        const newFeeBal = Number((Number(latestFee?.balance ?? platformFeeWallet.balance) + platformShare).toFixed(2));
        await supabaseAdmin!
          .from('wallets')
          .update({
            balance: newFeeBal,
            available_balance: Number((Number(latestFee?.available_balance ?? platformFeeWallet.available_balance) + platformShare).toFixed(2)),
            updated_at: new Date().toISOString(),
          })
          .eq('id', platformFeeWallet.id);
        ledgerRows.push({
          transaction_id: txRow.id,
          wallet_id: platformFeeWallet.id,
          entry_type: 'credit',
          amount: platformShare,
          balance_after: newFeeBal,
        });
      }

      await supabaseAdmin!.from('ledger_entries').insert(ledgerRows);
      return res.json({ configured: true, data: { transaction: txRow, feeAmount, commissionAmount: operatorCommission, platformShare } });
    }
  );

  // Agent overview (single unified Agent Portal for all registered members)
  app.get(
    '/api/agent/overview',
    requireSupabaseAuth,
    requireRoles('user', 'agent', 'sub_agent', 'super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const { data: hierarchyRows } = await supabaseAdmin!
        .from('agent_hierarchy')
        .select('*')
        .or(`agent_id.eq.${req.userId!},sub_agent_id.eq.${req.userId!}`)
        .order('created_at', { ascending: false });

      const subIds = (hierarchyRows ?? []).map((r) => r.sub_agent_id);
      const { data: subProfiles } =
        subIds.length > 0
          ? await supabaseAdmin!
              .from('profiles')
              .select('id, full_name, email, business_name')
              .in('id', subIds)
          : { data: [] };

      const profileMap = new Map((subProfiles ?? []).map((p) => [p.id, p]));
      const subAgents = (hierarchyRows ?? []).map((row) => ({
        ...row,
        sub_agent: profileMap.get(row.sub_agent_id),
      }));

      const { data: gateways } = await supabaseAdmin!
        .from('agent_gateways')
        .select('*')
        .eq('user_id', req.userId!)
        .order('activated_at', { ascending: false });

      const relatedIds = [req.userId!, ...subIds];
      const { data: rebalanceTickets } = await supabaseAdmin!
        .from('support_tickets')
        .select('*')
        .eq('category', 'agent_float')
        .in('user_id', relatedIds)
        .order('created_at', { ascending: false })
        .limit(20);

      return res.json({
        configured: true,
        data: {
          subAgents,
          gateways: gateways ?? [],
          rebalanceRequests: rebalanceTickets ?? [],
        },
      });
    }
  );

  // Parent Agent assigns/links a Sub-Agent by email
  app.post(
    '/api/agent/sub-agents',
    requireSupabaseAuth,
    requireRoles('agent', 'super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const { subAgentEmail, commissionRate, floatCap } = req.body ?? {};
      const cleanEmail = String(subAgentEmail || '').trim().toLowerCase();
      const rateNum = Number(commissionRate ?? 0.5);
      const capNum = Number(floatCap ?? 5000);

      if (!cleanEmail || !Number.isFinite(capNum) || capNum < 100) {
        return res.status(400).json({ configured: true, error: 'সাব-এজেন্টের ইমেইল এবং সঠিক ফ্লোট সীমা দিন।' });
      }

      const { data: targetProfile } = await supabaseAdmin!
        .from('profiles')
        .select('id, role')
        .eq('email', cleanEmail)
        .single();

      if (!targetProfile) {
        return res.status(404).json({ configured: true, error: 'এই ইমেইলে কোনো নিবন্ধিত ZentoPay ইউজার পাওয়া যায়নি।' });
      }
      if (targetProfile.id === req.userId) {
        return res.status(400).json({ configured: true, error: 'নিজেকে সাব-এজেন্ট হিসেবে যুক্ত করা যাবে না।' });
      }
      if (['super_admin', 'finance_admin', 'support_admin'].includes(targetProfile.role)) {
        return res.status(403).json({ configured: true, error: 'অ্যাডমিন অ্যাকাউন্টকে সাব-এজেন্ট করা যাবে না।' });
      }

      await supabaseAdmin!
        .from('profiles')
        .update({ role: 'sub_agent', parent_agent_id: req.userId!, updated_at: new Date().toISOString() })
        .eq('id', targetProfile.id);

      for (const walletType of ['float', 'commission'] as const) {
        await supabaseAdmin!
          .from('wallets')
          .upsert(
            {
              user_id: targetProfile.id,
              wallet_type: walletType,
              currency: 'BDT',
              daily_limit: capNum,
            },
            { onConflict: 'user_id,wallet_type,currency', ignoreDuplicates: true }
          );
      }

      const normalizedRate = rateNum > 1 ? Number((rateNum / 100).toFixed(4)) : Number(rateNum.toFixed(4));
      const { data: link, error: linkErr } = await supabaseAdmin!
        .from('agent_hierarchy')
        .upsert(
          {
            agent_id: req.userId!,
            sub_agent_id: targetProfile.id,
            commission_rate: Math.min(Math.max(normalizedRate, 0.01), 0.9),
            float_cap: capNum,
            status: 'active',
          },
          { onConflict: 'sub_agent_id' }
        )
        .select('*')
        .single();

      if (linkErr) {
        return res.status(400).json({ configured: true, error: linkErr.message });
      }

      return res.json({ configured: true, data: link });
    }
  );

  // Sub-Agent Float Rebalance Request (persisted in support_tickets with category 'agent_float')
  app.post(
    '/api/sub-agent/rebalance',
    requireSupabaseAuth,
    requireRoles('sub_agent', 'super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const numericAmount = Number(req.body?.amount);
      if (!Number.isFinite(numericAmount) || numericAmount < 500) {
        return res.status(400).json({ configured: true, error: 'ন্যূনতম ৳৫০০.০০ ফ্লোট রি-ব্যালেন্স অনুরোধ প্রদান করুন।' });
      }

      const { data: me } = await supabaseAdmin!
        .from('profiles')
        .select('parent_agent_id')
        .eq('id', req.userId!)
        .single();

      const ticketNumber = `ZP-FLT-${Math.floor(100000 + Math.random() * 900000)}`;
      const { data, error } = await supabaseAdmin!
        .from('support_tickets')
        .insert({
          ticket_number: ticketNumber,
          user_id: req.userId!,
          assigned_to: me?.parent_agent_id || null,
          category: 'agent_float',
          priority: 'high',
          subject: `ফ্লোট রি-ব্যালেন্স অনুরোধ (৳${numericAmount.toFixed(2)})`,
          description: JSON.stringify({
            requestedAmount: Number(numericAmount.toFixed(2)),
            currency: 'BDT',
            parentAgentId: me?.parent_agent_id || null,
          }),
        })
        .select('*')
        .single();

      if (error) {
        return res.status(400).json({ configured: true, error: error.message });
      }
      return res.json({ configured: true, data });
    }
  );

  // Parent Agent fulfills Sub-Agent float rebalance (verifies hierarchy ownership + BDT wallets)
  app.post(
    '/api/agent/rebalance/:id/fulfill',
    requireSupabaseAuth,
    requireRoles('agent', 'super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const { data: ticket } = await supabaseAdmin!
        .from('support_tickets')
        .select('*')
        .eq('id', req.params.id)
        .eq('category', 'agent_float')
        .single();

      if (!ticket || ticket.status !== 'open') {
        return res.status(404).json({ configured: true, error: 'খোলা রি-ব্যালেন্স অনুরোধ পাওয়া যায়নি।' });
      }

      if (req.userRole !== 'super_admin') {
        const [{ data: hierarchyLink }, { data: subProfile }] = await Promise.all([
          supabaseAdmin!
            .from('agent_hierarchy')
            .select('id')
            .eq('agent_id', req.userId!)
            .eq('sub_agent_id', ticket.user_id)
            .eq('status', 'active')
            .maybeSingle(),
          supabaseAdmin!
            .from('profiles')
            .select('parent_agent_id')
            .eq('id', ticket.user_id)
            .maybeSingle(),
        ]);

        const isAuthorizedParent = Boolean(hierarchyLink) || subProfile?.parent_agent_id === req.userId!;
        if (!isAuthorizedParent) {
          return res.status(403).json({
            configured: true,
            error: 'আপনি শুধুমাত্র আপনার নিজের অধীনস্থ সাব-এজেন্টের রি-ব্যালেন্স অনুরোধ অনুমোদন করতে পারবেন।',
          });
        }
      }

      let amount = 0;
      try {
        const parsed = JSON.parse(ticket.description);
        amount = Number(parsed.requestedAmount || 0);
      } catch {
        amount = 0;
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ configured: true, error: 'অনুরোধে সঠিক পরিমাণ নেই।' });
      }

      const [parentWalletRes, subWalletRes] = await Promise.all([
        supabaseAdmin!
          .from('wallets')
          .select('*')
          .eq('user_id', req.userId!)
          .eq('wallet_type', 'float')
          .eq('currency', 'BDT')
          .eq('status', 'active')
          .single(),
        supabaseAdmin!
          .from('wallets')
          .select('*')
          .eq('user_id', ticket.user_id)
          .eq('wallet_type', 'float')
          .eq('currency', 'BDT')
          .eq('status', 'active')
          .single(),
      ]);

      if (!parentWalletRes.data || !subWalletRes.data) {
        return res.status(404).json({ configured: true, error: 'প্যারেন্ট বা সাব-এজেন্ট সক্রিয় BDT ফ্লোট ওয়ালেট পাওয়া যায়নি।' });
      }

      const { data: rpcTxId, error: rpcErr } = await supabaseAdmin!.rpc('execute_wallet_transfer', {
        p_sender_wallet_id: parentWalletRes.data.id,
        p_receiver_wallet_id: subWalletRes.data.id,
        p_initiator_user_id: req.userId!,
        p_amount: amount,
        p_fee_amount: 0,
        p_description: `Sub-Agent Float Rebalance (${ticket.ticket_number})`,
      });

      if (rpcErr) {
        return res.status(400).json({ configured: true, error: 'আপনার BDT ফ্লোট ওয়ালেটে পর্যাপ্ত ব্যালেন্স নেই।' });
      }

      const { data: updatedTicket } = await supabaseAdmin!
        .from('support_tickets')
        .update({
          status: 'resolved',
          resolution_note: `ফ্লোট স্থানান্তর সম্পন্ন (Tx: ${rpcTxId})`,
          assigned_to: req.userId!,
          updated_at: new Date().toISOString(),
        })
        .eq('id', ticket.id)
        .select('*')
        .single();

      return res.json({ configured: true, data: updatedTicket });
    }
  );

  // Settlement / Withdraw request submission (verifies Withdraw PIN, min ৳500 BDT, atomic reservation + idempotency)
  app.post(
    '/api/settlements',
    requireSupabaseAuth,
    requireRoles('user', 'agent', 'sub_agent', 'super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const {
        walletId,
        amount,
        destinationBank,
        destinationAccount,
        accountLast4,
        withdrawPin,
        currency,
        userId: bodyUserId,
        requesterId: bodyRequesterId,
        requester_id: bodyRequesterIdSnake,
      } = req.body ?? {};

      // Strictly prevent submitting a withdrawal request on behalf of another user
      const suppliedActorId = [bodyUserId, bodyRequesterId, bodyRequesterIdSnake].find(
        (v) => v !== undefined && v !== null && String(v).trim() !== ''
      );
      if (suppliedActorId && String(suppliedActorId).trim() !== req.userId!) {
        return res.status(403).json({
          configured: true,
          code: 'IMPERSONATION_FORBIDDEN',
          error: 'অন্য ব্যবহারকারীর নামে উইথড্র অনুরোধ জমা দেওয়া যাবে না।',
        });
      }

      if (currency !== undefined && String(currency).trim().toUpperCase() !== 'BDT') {
        return res.status(400).json({ configured: true, error: 'শুধুমাত্র BDT (৳) কারেন্সিতে উইথড্র অনুরোধ করা যাবে।' });
      }

      const numericAmount = Number(Number(amount).toFixed(2));
      const cleanWalletId = typeof walletId === 'string' ? walletId.trim() : '';
      const cleanDestBank = typeof destinationBank === 'string' ? destinationBank.trim() : '';
      const cleanDestAccount =
        typeof destinationAccount === 'string' && destinationAccount.trim()
          ? destinationAccount.trim().slice(0, 80)
          : null;
      const cleanLast4 = String(accountLast4 || cleanDestAccount || '')
        .replace(/\D/g, '')
        .slice(-4)
        .padStart(4, '0');

      const rawIdempotency =
        (typeof req.headers['x-idempotency-key'] === 'string' && req.headers['x-idempotency-key']) ||
        (typeof req.body?.idempotencyKey === 'string' && req.body.idempotencyKey) ||
        '';
      const cleanIdempotencyKey = rawIdempotency.trim().slice(0, 120) || null;

      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanWalletId) ||
        !cleanDestBank ||
        !accountLast4 ||
        !Number.isFinite(numericAmount) ||
        numericAmount < 500
      ) {
        return res.status(400).json({
          configured: true,
          error: 'উইথড্র মেথড, অ্যাকাউন্ট তথ্য এবং ন্যূনতম ৳৫০০ পরিমাণ প্রদান করুন।',
        });
      }

      const { data: userProfile, error: pinLookupErr } = await supabaseAdmin!
        .from('profiles')
        .select('id, withdraw_pin_hash')
        .eq('id', req.userId!)
        .maybeSingle();

      if (pinLookupErr) {
        if (isMissingSchemaError(pinLookupErr)) {
          return res.status(503).json({
            configured: true,
            code: 'SCHEMA_PENDING',
            schemaPending: true,
            error:
              'ডাটাবেজের profiles টেবিলে withdraw_pin_hash কলাম এখনো যোগ করা হয়নি। অনুগ্রহ করে supabase/migrations/007_fix_withdraw_pin_profile.sql মাইগ্রেশনটি চালান।',
          });
        }
        return res.status(500).json({ configured: true, error: 'উইথড্র পিন যাচাই করতে ডাটাবেজ ত্রুটি হয়েছে।' });
      }

      if (!userProfile?.withdraw_pin_hash) {
        return res.status(400).json({
          configured: true,
          code: 'PIN_NOT_SET',
          error: 'উইথড্র করার আগে অনুগ্রহ করে সেটিংস থেকে আপনার উইথড্র পিন সেট করুন।',
        });
      }

      if (!verifyWithdrawPin(String(withdrawPin || '').trim(), userProfile.withdraw_pin_hash)) {
        return res.status(400).json({
          configured: true,
          code: 'INVALID_WITHDRAW_PIN',
          error: 'সঠিক উইথড্র পিন প্রদান করুন।',
        });
      }

      // Primary path: atomic row-locked PostgreSQL RPC (Migration 008)
      const { data: rpcResult, error: rpcErr } = await supabaseAdmin!.rpc('create_withdrawal_request', {
        p_agent_id: req.userId!,
        p_wallet_id: cleanWalletId,
        p_amount: numericAmount,
        p_destination_bank: cleanDestBank,
        p_account_last4: cleanLast4,
        p_destination_account: cleanDestAccount,
        p_idempotency_key: cleanIdempotencyKey,
      });

      if (!rpcErr && rpcResult) {
        const parsed = rpcResult as {
          idempotentReplay?: boolean;
          settlement?: Record<string, unknown>;
          wallet?: Record<string, unknown>;
        };
        return res.json({
          configured: true,
          idempotentReplay: Boolean(parsed.idempotentReplay),
          data: parsed.settlement ?? rpcResult,
          wallet: parsed.wallet ?? null,
        });
      }

      const rpcMsg = rpcErr?.message || '';
      const rpcCode = (rpcErr?.code || '').toUpperCase();
      const isRpcMissing =
        rpcCode === 'PGRST202' ||
        rpcMsg.includes('Could not find the function public.create_withdrawal_request');

      if (rpcErr && !isRpcMissing) {
        if (rpcMsg.includes('WALLET_NOT_FOUND')) {
          return res.status(403).json({ configured: true, error: 'নির্বাচিত ওয়ালেটের মালিকানা যাচাই ব্যর্থ হয়েছে।' });
        }
        if (rpcMsg.includes('INVALID_CURRENCY')) {
          return res.status(400).json({
            configured: true,
            error: 'নতুন উইথড্র অনুরোধ শুধুমাত্র BDT (৳) ওয়ালেট থেকে করা যাবে।',
          });
        }
        if (rpcMsg.includes('INSUFFICIENT_AVAILABLE_BALANCE')) {
          return res.status(400).json({
            configured: true,
            error: 'উত্তোলনের জন্য ওয়ালেটে পর্যাপ্ত ব্যবহারযোগ্য ব্যালেন্স নেই।',
          });
        }
        if (rpcMsg.includes('INVALID_AMOUNT')) {
          return res.status(400).json({
            configured: true,
            error: 'উইথড্র মেথড, অ্যাকাউন্ট তথ্য এবং ন্যূনতম ৳৫০০ পরিমাণ প্রদান করুন।',
          });
        }
        return res.status(400).json({ configured: true, error: rpcMsg || 'উইথড্র অনুরোধ জমা ব্যর্থ হয়েছে।' });
      }

      // Pre-008 Safe Fallback: conditional atomic wallet hold + settlement insert + pending withdrawal tx
      const { data: wallet } = await supabaseAdmin!
        .from('wallets')
        .select('*')
        .eq('id', cleanWalletId)
        .eq('user_id', req.userId!)
        .eq('status', 'active')
        .maybeSingle();

      if (!wallet) {
        return res.status(403).json({ configured: true, error: 'নির্বাচিত ওয়ালেটের মালিকানা যাচাই ব্যর্থ হয়েছে।' });
      }
      if (wallet.currency !== 'BDT') {
        return res.status(400).json({
          configured: true,
          error: 'নতুন উইথড্র অনুরোধ শুধুমাত্র BDT (৳) ওয়ালেট থেকে করা যাবে।',
        });
      }
      if (Number(wallet.available_balance) < numericAmount) {
        return res.status(400).json({ configured: true, error: 'উত্তোলনের জন্য ওয়ালেটে পর্যাপ্ত ব্যবহারযোগ্য ব্যালেন্স নেই।' });
      }

      const newAvail = Number((Number(wallet.available_balance) - numericAmount).toFixed(2));
      const { data: heldWallet, error: holdErr } = await supabaseAdmin!
        .from('wallets')
        .update({
          available_balance: newAvail,
          updated_at: new Date().toISOString(),
        })
        .eq('id', wallet.id)
        .eq('user_id', req.userId!)
        .gte('available_balance', numericAmount)
        .select('*')
        .maybeSingle();

      if (holdErr || !heldWallet) {
        return res.status(400).json({ configured: true, error: 'ব্যবহারযোগ্য ব্যালেন্স সংরক্ষণ ব্যর্থ হয়েছে। পুনরায় চেষ্টা করুন।' });
      }

      const { data, error } = await supabaseAdmin!
        .from('settlement_requests')
        .insert({
          requester_id: req.userId!,
          wallet_id: cleanWalletId,
          amount: numericAmount,
          currency: 'BDT',
          destination_bank: cleanDestBank,
          account_last4: cleanLast4,
        })
        .select('*')
        .single();

      if (error || !data) {
        await supabaseAdmin!
          .from('wallets')
          .update({
            available_balance: Number((Number(heldWallet.available_balance) + numericAmount).toFixed(2)),
            updated_at: new Date().toISOString(),
          })
          .eq('id', wallet.id);
        return res.status(400).json({ configured: true, error: error?.message || 'উইথড্র অনুরোধ সংরক্ষণ ব্যর্থ হয়েছে।' });
      }

      const refCode = `WD-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;
      await supabaseAdmin!.from('transactions').insert({
        reference_code: refCode,
        sender_wallet_id: wallet.id,
        initiator_user_id: req.userId!,
        tx_type: 'withdrawal',
        amount: numericAmount,
        fee_amount: 0,
        commission_amount: 0,
        currency: 'BDT',
        status: 'pending',
        description: `উইথড্র রিকোয়েস্ট (${cleanDestBank})`,
        metadata: {
          settlementRequestId: data.id,
          destinationBank: cleanDestBank,
          destinationAccount: cleanDestAccount,
          accountLast4: cleanLast4,
        },
      });

      await supabaseAdmin!.from('audit_logs').insert({
        actor_id: req.userId!,
        actor_role: req.userRole || 'agent',
        action: 'withdrawal_requested',
        target_table: 'settlement_requests',
        target_id: data.id,
        payload: {
          walletId: wallet.id,
          amount: numericAmount,
          availableBalanceAfter: newAvail,
        },
      });

      return res.json({ configured: true, data });
    }
  );

  // Agent approves an MFS Payment Collection or Payment Payout atomically via SQL RPC
  // Authoritative provider commission rates resolved strictly in DB/server (bKash 5%, Nagad 4%, Rocket 4%)
  app.post(
    '/api/mfs-requests/:id/approve',
    requireSupabaseAuth,
    requireRoles('user', 'agent', 'sub_agent', 'super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const requestId = String(req.params.id || '').trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
        return res.status(400).json({ configured: true, code: 'INVALID_REQUEST_ID', error: 'অবৈধ পেমেন্ট রিকোয়েস্ট আইডি।' });
      }

      const { data: existingReq, error: lookupErr } = await supabaseAdmin!
        .from('mfs_payment_requests')
        .select('id, agent_id, status')
        .eq('id', requestId)
        .maybeSingle();

      if (lookupErr) {
        if (isMissingSchemaError(lookupErr)) {
          return res.status(503).json({
            configured: true,
            code: 'SCHEMA_PENDING',
            error: 'ডাটাবেজে mfs_payment_requests টেবিল এখনো তৈরি হয়নি। অনুগ্রহ করে মাইগ্রেশন চালান।',
          });
        }
        return res.status(500).json({ configured: true, error: lookupErr.message });
      }

      if (!existingReq) {
        return res.status(404).json({ configured: true, code: 'MFS_REQUEST_NOT_FOUND', error: 'পেমেন্ট রিকোয়েস্ট খুঁজে পাওয়া যায়নি।' });
      }

      if (existingReq.agent_id !== req.userId!) {
        return res.status(403).json({
          configured: true,
          code: 'FORBIDDEN',
          error: 'এই রিকোয়েস্টটি আপনার এজেন্ট অ্যাকাউন্টের জন্য নির্ধারিত নয়।',
        });
      }

      const { trxId } = req.body ?? {};
      const cleanTrxId = typeof trxId === 'string' ? trxId.trim() : null;

      const { data: rpcResult, error: rpcErr } = await supabaseAdmin!.rpc('approve_mfs_payment_request', {
        p_request_id: requestId,
        p_agent_id: req.userId!,
        p_trx_id: cleanTrxId,
      });

      if (rpcErr) {
        const msg = rpcErr.message || '';
        const code = (rpcErr.code || '').toUpperCase();
        if (
          code === 'PGRST202' ||
          msg.includes('Could not find the function public.approve_mfs_payment_request')
        ) {
          return res.status(503).json({
            configured: true,
            code: 'SCHEMA_PENDING',
            error:
              'Supabase-এ approve_mfs_payment_request RPC এখনো ইনস্টল করা হয়নি। অনুগ্রহ করে supabase/migrations/006_fix_mfs_payout_wallet_record.sql মাইগ্রেশনটি চালান।',
          });
        }
        if (msg.includes('MFS_REQUEST_NOT_FOUND')) {
          return res.status(404).json({ configured: true, error: 'পেমেন্ট রিকোয়েস্ট খুঁজে পাওয়া যায়নি।' });
        }
        if (msg.includes('MFS_REQUEST_ALREADY_DECLINED')) {
          return res.status(400).json({ configured: true, error: 'এই রিকোয়েস্টটি ইতিমধ্যে প্রত্যাখ্যান করা হয়েছে।' });
        }
        if (msg.includes('INVALID_TRX_ID')) {
          return res.status(400).json({ configured: true, error: 'অনুমোদন করার আগে অনুগ্রহ করে বৈধ TrxID লিখুন।' });
        }
        if (msg.includes('ACTIVE_WALLET_NOT_FOUND')) {
          return res.status(404).json({ configured: true, error: 'সক্রিয় BDT ওয়ালেট পাওয়া যায়নি।' });
        }
        if (msg.includes('INSUFFICIENT_PAYOUT_BALANCE')) {
          return res.status(400).json({ configured: true, error: 'পেমেন্ট পেআউট অনুমোদনের জন্য ওয়ালেটে পর্যাপ্ত ব্যালেন্স নেই।' });
        }
        return res.status(400).json({ configured: true, error: msg || 'পেমেন্ট রিকোয়েস্ট অনুমোদন ব্যর্থ হয়েছে।' });
      }

      return res.json({ configured: true, data: rpcResult });
    }
  );

  // Agent declines a pending MFS Payment Collection / Payout request
  app.post(
    '/api/mfs-requests/:id/decline',
    requireSupabaseAuth,
    requireRoles('user', 'agent', 'sub_agent', 'super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const { data, error } = await supabaseAdmin!
        .from('mfs_payment_requests')
        .update({ status: 'declined', processed_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .eq('agent_id', req.userId!)
        .eq('status', 'pending')
        .select('*')
        .single();

      if (error || !data) {
        return res.status(404).json({ configured: true, error: 'অপেক্ষমাণ পেমেন্ট রিকোয়েস্ট পাওয়া যায়নি।' });
      }
      return res.json({ configured: true, data });
    }
  );

  // Finance & Super Admin overview (enriched settlements, deposits, transactions, wallets & ledger metrics)
  app.get(
    '/api/finance/overview',
    requireSupabaseAuth,
    requireRoles('finance_admin', 'super_admin'),
    async (_req: AuthenticatedRequest, res) => {
      const [settleRes, txRes, depositsRes, walletsRes, ledgerRes, profilesRes] = await Promise.all([
        supabaseAdmin!.from('settlement_requests').select('*').order('created_at', { ascending: false }).limit(200),
        supabaseAdmin!.from('transactions').select('*').order('created_at', { ascending: false }).limit(200),
        supabaseAdmin!
          .from('transactions')
          .select('*')
          .eq('tx_type', 'deposit')
          .order('created_at', { ascending: false })
          .limit(200),
        supabaseAdmin!.from('wallets').select('id, user_id, wallet_type, currency, balance, available_balance, status'),
        supabaseAdmin!.from('ledger_entries').select('entry_type, amount'),
        supabaseAdmin!.from('profiles').select('id, full_name, email, phone, agent_code, role').limit(300),
      ]);

      const rawSettlements = settleRes.data ?? [];
      const rawTx = txRes.data ?? [];
      const rawDeposits = depositsRes.data ?? [];
      const rawWallets = walletsRes.data ?? [];
      const rawProfiles = profilesRes.data ?? [];

      const profileMap = new Map(rawProfiles.map((p) => [p.id, p]));
      const walletMap = new Map(rawWallets.map((w) => [w.id, w]));

      const enrichedSettlements = rawSettlements.map((row) => {
        const agent = profileMap.get(row.requester_id);
        const reviewer = row.reviewed_by ? profileMap.get(row.reviewed_by) : undefined;
        const wallet = walletMap.get(row.wallet_id);
        const walletBal = wallet ? Number(wallet.balance || 0) : null;
        const walletAvail = wallet ? Number(wallet.available_balance || 0) : null;
        const walletReserved =
          walletBal !== null && walletAvail !== null ? Number(Math.max(0, walletBal - walletAvail).toFixed(2)) : null;

        return {
          ...row,
          reference_code:
            (typeof row.reference_code === 'string' && row.reference_code) ||
            `WD-${String(row.id).slice(0, 8).toUpperCase()}`,
          agent_name: agent?.full_name ?? null,
          agent_code: agent?.agent_code ?? null,
          agent_email: agent?.email ?? null,
          agent_phone: agent?.phone ?? null,
          reviewer_name: reviewer?.full_name ?? null,
          wallet_balance: walletBal,
          wallet_available_balance: walletAvail,
          wallet_reserved_balance: walletReserved,
        };
      });

      const enrichTransaction = <T extends Record<string, unknown>>(tx: T) => {
        const initiatorId = typeof tx.initiator_user_id === 'string' ? tx.initiator_user_id : '';
        const initiator = initiatorId ? profileMap.get(initiatorId) : undefined;
        return {
          ...tx,
          initiator_name: initiator?.full_name ?? null,
          initiator_agent_code: initiator?.agent_code ?? null,
          initiator_email: initiator?.email ?? null,
        };
      };

      const enrichedTx = rawTx.map(enrichTransaction);
      const enrichedDeposits = rawDeposits.map(enrichTransaction);

      const totalCustodyBalance = rawWallets.reduce((acc, w) => acc + Number(w.balance || 0), 0);
      const totalReservedBalance = rawWallets.reduce(
        (acc, w) => acc + Math.max(0, Number(w.balance || 0) - Number(w.available_balance || 0)),
        0
      );
      const collectedFeeRevenue = rawTx
        .filter((t) => t.status === 'completed')
        .reduce((acc, t) => acc + Number(t.fee_amount || 0), 0);

      let debitSum = 0;
      let creditSum = 0;
      (ledgerRes.data ?? []).forEach((row) => {
        if (row.entry_type === 'debit') debitSum += Number(row.amount || 0);
        else creditSum += Number(row.amount || 0);
      });

      const pendingDeposits = enrichedDeposits.filter((t) => t.status === 'pending');

      return res.json({
        configured: true,
        data: {
          settlements: enrichedSettlements,
          pendingDeposits,
          deposits: enrichedDeposits,
          transactions: enrichedTx,
          stats: {
            totalCustodyBalance: Number(totalCustodyBalance.toFixed(2)),
            totalReservedBalance: Number(totalReservedBalance.toFixed(2)),
            collectedFeeRevenue: Number(collectedFeeRevenue.toFixed(2)),
            netLedgerDiscrepancy: Number(Math.abs(debitSum - creditSum).toFixed(2)),
            pendingWithdrawalsCount: enrichedSettlements.filter((s) => s.status === 'pending').length,
            pendingDepositsCount: pendingDeposits.length,
          },
        },
      });
    }
  );

  // Finance & Super Admin deposit approval / rejection (concurrency-safe atomic claim before wallet credit)
  app.patch(
    '/api/finance/deposits/:id/review',
    requireSupabaseAuth,
    requireRoles('finance_admin', 'super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const { status, notes } = req.body ?? {};
      if (!['completed', 'failed'].includes(status)) {
        return res.status(400).json({ configured: true, error: 'অবৈধ ডিপোজিট সিদ্ধান্ত স্ট্যাটাস।' });
      }

      const cleanNotes = typeof notes === 'string' && notes.trim() ? notes.trim().slice(0, 500) : null;

      const { data: txRow } = await supabaseAdmin!
        .from('transactions')
        .select('*')
        .eq('id', req.params.id)
        .eq('tx_type', 'deposit')
        .maybeSingle();

      if (!txRow) {
        return res.status(404).json({ configured: true, error: 'ডিপোজিট অনুরোধ খুঁজে পাওয়া যায়নি।' });
      }
      if (txRow.status !== 'pending') {
        return res.status(400).json({ configured: true, error: 'এই ডিপোজিটটি ইতিমধ্যে প্রক্রিয়াকরণ করা হয়েছে।' });
      }

      // Atomically claim the pending deposit row first so concurrent reviews cannot double-credit
      const nextMetadata = {
        ...((txRow.metadata as Record<string, unknown> | null) ?? {}),
        reviewedBy: req.userId!,
        reviewedAt: new Date().toISOString(),
        adminNotes: cleanNotes,
      };
      const { data: updatedTx, error: claimErr } = await supabaseAdmin!
        .from('transactions')
        .update({ status, metadata: nextMetadata })
        .eq('id', txRow.id)
        .eq('tx_type', 'deposit')
        .eq('status', 'pending')
        .select('*')
        .maybeSingle();

      if (claimErr) {
        return res.status(400).json({ configured: true, error: claimErr.message });
      }
      if (!updatedTx) {
        return res.status(409).json({ configured: true, error: 'এই ডিপোজিটটি ইতিমধ্যে অন্য অ্যাডমিন প্রক্রিয়াকরণ করেছেন।' });
      }

      if (status === 'completed' && txRow.receiver_wallet_id) {
        const { data: wallet } = await supabaseAdmin!
          .from('wallets')
          .select('*')
          .eq('id', txRow.receiver_wallet_id)
          .maybeSingle();

        if (wallet && wallet.currency === txRow.currency) {
          const depositAmt = Number(txRow.amount);
          const newBal = Number((Number(wallet.balance) + depositAmt).toFixed(2));
          const newAvail = Number((Number(wallet.available_balance) + depositAmt).toFixed(2));

          await supabaseAdmin!
            .from('wallets')
            .update({
              balance: newBal,
              available_balance: newAvail,
              updated_at: new Date().toISOString(),
            })
            .eq('id', wallet.id);

          await supabaseAdmin!.from('ledger_entries').insert({
            transaction_id: txRow.id,
            wallet_id: wallet.id,
            entry_type: 'credit',
            amount: depositAmt,
            balance_after: newBal,
          });

          const planActivation = (txRow.metadata as { planActivation?: string } | null)?.planActivation;
          if (planActivation === 'trial' || planActivation === 'premium') {
            await supabaseAdmin!
              .from('profiles')
              .update({
                active_plan: planActivation,
                plan_activated_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq('id', txRow.initiator_user_id);
          }

          if (txRow.currency === 'BDT') {
            await creditEligibleAffiliateCommission({
              sourceUserId: txRow.initiator_user_id,
              baseAmount: depositAmt,
              sourceLabel: 'deposit',
              sourceRef: txRow.reference_code,
            });
          }
        }
      }

      await supabaseAdmin!.from('audit_logs').insert({
        actor_id: req.userId!,
        actor_role: req.userRole!,
        action: `deposit_${status}`,
        target_table: 'transactions',
        target_id: txRow.id,
        payload: { status, notes: cleanNotes, amount: txRow.amount, currency: txRow.currency },
      });

      await supabaseAdmin!
        .from('user_notifications')
        .insert({
          user_id: txRow.initiator_user_id,
          title: status === 'completed' ? `ডিপোজিট অনুমোদিত (${txRow.reference_code})` : `ডিপোজিট প্রত্যাখ্যাত (${txRow.reference_code})`,
          message:
            status === 'completed'
              ? `আপনার ৳${Number(txRow.amount).toLocaleString('en-US')} ডিপোজিট অনুমোদিত হয়েছে এবং ওয়ালেটে যুক্ত হয়েছে।`
              : `আপনার ৳${Number(txRow.amount).toLocaleString('en-US')} ডিপোজিট প্রত্যাখ্যান করা হয়েছে।${cleanNotes ? ` কারণ: ${cleanNotes}` : ''}`,
          created_by: req.userId!,
        })
        .then(({ error: nErr }) => {
          if (nErr && !isMissingSchemaError(nErr)) {
            console.warn('[deposits/review] notification insert warning:', nErr.message);
          }
        });

      return res.json({ configured: true, data: updatedTx });
    }
  );

  // Finance & Super Admin withdrawal / settlement approval or rejection (atomic, idempotent, zero double-debit/refund)
  app.patch(
    '/api/settlements/:id/review',
    requireSupabaseAuth,
    requireRoles('finance_admin', 'super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const requestId = String(req.params.id || '').trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
        return res.status(400).json({ configured: true, error: 'অবৈধ উইথড্র রিকোয়েস্ট আইডি।' });
      }

      const { status, notes } = req.body ?? {};
      if (!['approved', 'rejected', 'disbursed'].includes(status)) {
        return res.status(400).json({ configured: true, error: 'অবৈধ উইথড্র সিদ্ধান্ত স্ট্যাটাস।' });
      }

      const cleanNotes = typeof notes === 'string' && notes.trim() ? notes.trim().slice(0, 500) : null;
      const rpcName = status === 'rejected' ? 'reject_withdrawal_request' : 'approve_withdrawal_request';

      // Primary path: atomic row-locked PostgreSQL RPC (Migration 008)
      const { data: rpcResult, error: rpcErr } = await supabaseAdmin!.rpc(rpcName, {
        p_request_id: requestId,
        p_admin_id: req.userId!,
        p_notes: cleanNotes,
      });

      if (!rpcErr && rpcResult) {
        const parsed = rpcResult as {
          idempotentReplay?: boolean;
          settlement?: Record<string, unknown>;
          wallet?: Record<string, unknown>;
        };
        return res.json({
          configured: true,
          idempotentReplay: Boolean(parsed.idempotentReplay),
          data: parsed.settlement ?? rpcResult,
          wallet: parsed.wallet ?? null,
        });
      }

      const rpcMsg = rpcErr?.message || '';
      const rpcCode = (rpcErr?.code || '').toUpperCase();
      const isRpcMissing =
        rpcCode === 'PGRST202' ||
        rpcMsg.includes('Could not find the function public.approve_withdrawal_request') ||
        rpcMsg.includes('Could not find the function public.reject_withdrawal_request');

      if (rpcErr && !isRpcMissing) {
        if (rpcMsg.includes('SETTLEMENT_NOT_FOUND')) {
          return res.status(404).json({ configured: true, error: 'উইথড্র অনুরোধ খুঁজে পাওয়া যায়নি।' });
        }
        if (rpcMsg.includes('SETTLEMENT_ALREADY_FINALIZED')) {
          return res.status(409).json({ configured: true, error: 'এই উইথড্র অনুরোধটি ইতিমধ্যে চূড়ান্ত করা হয়েছে।' });
        }
        if (rpcMsg.includes('INSUFFICIENT_LEDGER_BALANCE')) {
          return res.status(400).json({ configured: true, error: 'ওয়ালেটের লেজার ব্যালেন্স পর্যাপ্ত নয়।' });
        }
        return res.status(400).json({ configured: true, error: rpcMsg || 'উইথড্র রিভিউ ব্যর্থ হয়েছে।' });
      }

      // Pre-008 Safe Fallback: claim pending state atomically FIRST before touching wallet balances
      const { data: existing } = await supabaseAdmin!
        .from('settlement_requests')
        .select('*')
        .eq('id', requestId)
        .maybeSingle();

      if (!existing) {
        return res.status(404).json({ configured: true, error: 'উইথড্র অনুরোধ খুঁজে পাওয়া যায়নি।' });
      }

      const targetStatus = status === 'rejected' ? 'rejected' : 'approved';
      if (existing.status === targetStatus || (existing.status === 'disbursed' && targetStatus === 'approved')) {
        return res.json({ configured: true, idempotentReplay: true, data: existing });
      }
      if (existing.status !== 'pending') {
        return res.status(409).json({ configured: true, error: 'এই উইথড্র অনুরোধটি ইতিমধ্যে চূড়ান্ত করা হয়েছে।' });
      }

      const { data: claimed, error: claimErr } = await supabaseAdmin!
        .from('settlement_requests')
        .update({
          status: targetStatus,
          notes: cleanNotes ?? existing.notes,
          reviewed_by: req.userId!,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', requestId)
        .eq('status', 'pending')
        .select('*')
        .maybeSingle();

      if (claimErr) {
        return res.status(400).json({ configured: true, error: claimErr.message });
      }
      if (!claimed) {
        return res.status(409).json({ configured: true, error: 'এই উইথড্র অনুরোধটি ইতিমধ্যে অন্য অ্যাডমিন প্রক্রিয়াকরণ করেছেন।' });
      }

      const settleAmount = Number(existing.amount);
      const { data: wallet } = await supabaseAdmin!
        .from('wallets')
        .select('*')
        .eq('id', existing.wallet_id)
        .maybeSingle();

      if (wallet) {
        if (targetStatus === 'rejected') {
          const restoredAvail = Math.min(
            Number(wallet.balance),
            Number((Number(wallet.available_balance) + settleAmount).toFixed(2))
          );
          await supabaseAdmin!
            .from('wallets')
            .update({
              available_balance: restoredAvail,
              updated_at: new Date().toISOString(),
            })
            .eq('id', wallet.id);
        } else {
          // Approve: finalize reserved debit on balance WITHOUT subtracting available_balance a second time
          const newLedgerBal = Math.max(0, Number((Number(wallet.balance) - settleAmount).toFixed(2)));
          const boundedAvail = Math.min(newLedgerBal, Number(wallet.available_balance));
          await supabaseAdmin!
            .from('wallets')
            .update({
              balance: newLedgerBal,
              available_balance: boundedAvail,
              updated_at: new Date().toISOString(),
            })
            .eq('id', wallet.id);

          if ((existing.currency || wallet.currency || 'BDT') === 'BDT') {
            const { data: settleTx } = await supabaseAdmin!
              .from('transactions')
              .insert({
                reference_code: `STL-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`,
                sender_wallet_id: wallet.id,
                initiator_user_id: existing.requester_id,
                tx_type: 'settlement',
                amount: settleAmount,
                fee_amount: 0,
                commission_amount: 0,
                currency: 'BDT',
                status: 'completed',
                description: `উইথড্র অনুমোদিত (${existing.destination_bank} ·••• ${existing.account_last4})`,
              })
              .select('*')
              .maybeSingle();

            if (settleTx) {
              await supabaseAdmin!.from('ledger_entries').insert({
                transaction_id: settleTx.id,
                wallet_id: wallet.id,
                entry_type: 'debit',
                amount: settleAmount,
                balance_after: newLedgerBal,
              });
            }
          }
        }
      }

      await supabaseAdmin!.from('audit_logs').insert({
        actor_id: req.userId!,
        actor_role: req.userRole!,
        action: `settlement_${targetStatus}`,
        target_table: 'settlement_requests',
        target_id: requestId,
        payload: { status: targetStatus, notes: cleanNotes, amount: settleAmount },
      });

      await supabaseAdmin!
        .from('user_notifications')
        .insert({
          user_id: existing.requester_id,
          title:
            targetStatus === 'approved'
              ? `উইথড্র রিকোয়েস্ট অনুমোদিত (WD-${requestId.slice(0, 8).toUpperCase()})`
              : `উইথড্র রিকোয়েস্ট প্রত্যাখ্যাত (WD-${requestId.slice(0, 8).toUpperCase()})`,
          message:
            targetStatus === 'approved'
              ? `আপনার ৳${settleAmount.toLocaleString('en-US')} উইথড্র রিকোয়েস্ট অনুমোদিত হয়েছে।${cleanNotes ? ` নোট: ${cleanNotes}` : ''}`
              : `আপনার ৳${settleAmount.toLocaleString('en-US')} উইথড্র রিকোয়েস্ট প্রত্যাখ্যান করা হয়েছে এবং অর্থ ব্যবহারযোগ্য ব্যালেন্সে ফেরত পাঠানো হয়েছে।${cleanNotes ? ` কারণ: ${cleanNotes}` : ''}`,
          created_by: req.userId!,
        })
        .then(({ error: nErr }) => {
          if (nErr && !isMissingSchemaError(nErr)) {
            console.warn('[settlements/review] notification insert warning:', nErr.message);
          }
        });

      return res.json({ configured: true, data: claimed });
    }
  );

  // Support Ticket Creation
  app.post('/api/tickets', requireSupabaseAuth, async (req: AuthenticatedRequest, res) => {
    const { category, priority, subject, description } = req.body ?? {};
    if (!subject || !description) {
      return res.status(400).json({ configured: true, error: 'বিষয় এবং বিস্তারিত বিবরণ প্রয়োজন।' });
    }

    const ticketNumber = `ZP-TKT-${Math.floor(100000 + Math.random() * 900000)}`;
    const { data, error } = await supabaseAdmin!
      .from('support_tickets')
      .insert({
        ticket_number: ticketNumber,
        user_id: req.userId!,
        category: category || 'wallet',
        priority: priority || 'medium',
        subject: String(subject).trim(),
        description: String(description).trim(),
      })
      .select('*')
      .single();

    if (error) {
      return res.status(400).json({ configured: true, error: error.message });
    }
    return res.json({ configured: true, data });
  });

  // Support Admin overview (tickets & KYC queue)
  app.get(
    '/api/support/overview',
    requireSupabaseAuth,
    requireRoles('support_admin', 'super_admin'),
    async (_req: AuthenticatedRequest, res) => {
      const [ticketRes, kycRes] = await Promise.all([
        supabaseAdmin!.from('support_tickets').select('*').order('created_at', { ascending: false }).limit(100),
        supabaseAdmin!.from('kyc_submissions').select('*').order('created_at', { ascending: false }).limit(100),
      ]);

      return res.json({
        configured: true,
        data: {
          tickets: ticketRes.data ?? [],
          kycQueue: kycRes.data ?? [],
        },
      });
    }
  );

  // Support Admin ticket update
  app.patch(
    '/api/tickets/:id',
    requireSupabaseAuth,
    requireRoles('support_admin', 'super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const { status, resolutionNote } = req.body ?? {};
      if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
        return res.status(400).json({ configured: true, error: 'অবৈধ টিকিট স্ট্যাটাস।' });
      }
      const { data, error } = await supabaseAdmin!
        .from('support_tickets')
        .update({
          status,
          resolution_note: resolutionNote || null,
          assigned_to: req.userId!,
          updated_at: new Date().toISOString(),
        })
        .eq('id', req.params.id)
        .select('*')
        .single();

      if (error || !data) {
        return res.status(404).json({ configured: true, error: error?.message || 'টিকিট পাওয়া যায়নি।' });
      }

      await supabaseAdmin!.from('audit_logs').insert({
        actor_id: req.userId!,
        actor_role: req.userRole!,
        action: `ticket_${status}`,
        target_table: 'support_tickets',
        target_id: req.params.id,
        payload: { status, resolutionNote: resolutionNote || null },
      });

      return res.json({ configured: true, data });
    }
  );

  // Support Admin KYC Document Review (approve / reject + updates profiles.kyc_status)
  app.patch(
    '/api/support/kyc/:id/review',
    requireSupabaseAuth,
    requireRoles('support_admin', 'super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const { status, reviewNotes } = req.body ?? {};
      if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ configured: true, error: 'অবৈধ KYC সিদ্ধান্ত স্ট্যাটাস।' });
      }

      const { data: submission, error: kycErr } = await supabaseAdmin!
        .from('kyc_submissions')
        .update({
          status,
          reviewer_id: req.userId!,
          review_notes: reviewNotes || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', req.params.id)
        .select('*')
        .single();

      if (kycErr || !submission) {
        return res.status(404).json({ configured: true, error: kycErr?.message || 'KYC ডকুমেন্ট রেকর্ড পাওয়া যায়নি।' });
      }

      const profileKycStatus = status === 'approved' ? 'verified' : 'rejected';
      await supabaseAdmin!
        .from('profiles')
        .update({ kyc_status: profileKycStatus, updated_at: new Date().toISOString() })
        .eq('id', submission.user_id);

      await supabaseAdmin!.from('audit_logs').insert({
        actor_id: req.userId!,
        actor_role: req.userRole!,
        action: `kyc_${status}`,
        target_table: 'kyc_submissions',
        target_id: submission.id,
        payload: { userId: submission.user_id, profileKycStatus, reviewNotes: reviewNotes || null },
      });

      return res.json({ configured: true, data: submission });
    }
  );

  // Support Admin private KYC signed download URL for document inspection
  app.post(
    '/api/support/kyc/:id/view-url',
    requireSupabaseAuth,
    requireRoles('support_admin', 'super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const { data: submission } = await supabaseAdmin!
        .from('kyc_submissions')
        .select('storage_path')
        .eq('id', req.params.id)
        .single();

      if (!submission) {
        return res.status(404).json({ configured: true, error: 'KYC রেকর্ড পাওয়া যায়নি।' });
      }

      const { data, error } = await supabaseAdmin!.storage
        .from('kyc-documents')
        .createSignedUrl(submission.storage_path, 120);

      if (error || !data) {
        return res.status(400).json({ configured: true, error: error?.message || 'ফাইল ভিউ লিংক তৈরি ব্যর্থ হয়েছে।' });
      }
      return res.json({ configured: true, data: { signedUrl: data.signedUrl } });
    }
  );

  // KYC Signed Upload Path Generator (keeps storage bucket private)
  app.post('/api/kyc/upload-url', requireSupabaseAuth, async (req: AuthenticatedRequest, res) => {
    const { fileName, documentType } = req.body ?? {};
    if (!fileName || !documentType) {
      return res.status(400).json({ configured: true, error: 'ফাইলের নাম এবং নথির ধরন প্রয়োজন।' });
    }

    const safeFileName = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${req.userId}/${Date.now()}_${safeFileName}`;
    const { data, error } = await supabaseAdmin!.storage
      .from('kyc-documents')
      .createSignedUploadUrl(storagePath);

    if (error) {
      return res.status(400).json({ configured: true, error: error.message });
    }

    return res.json({
      configured: true,
      data: {
        signedUrl: data.signedUrl,
        token: data.token,
        storagePath,
      },
    });
  });

  // KYC Submission Finalization after direct private storage upload
  app.post('/api/kyc/submit', requireSupabaseAuth, async (req: AuthenticatedRequest, res) => {
    const { documentType, storagePath, fullName, dob, nidNumber } = req.body ?? {};
    const validTypes = ['passport', 'national_id', 'business_license', 'proof_of_address'];

    if (!validTypes.includes(documentType) || !storagePath || !String(storagePath).startsWith(`${req.userId}/`)) {
      return res.status(400).json({ configured: true, error: 'সঠিক নথির ধরন এবং আপলোড পাথ প্রয়োজন।' });
    }

    const fileSegment = String(storagePath).slice(`${req.userId}/`.length);
    const { data: listed } = await supabaseAdmin!.storage.from('kyc-documents').list(req.userId!, {
      search: fileSegment,
      limit: 5,
    });
    if (!listed || !listed.some((item) => item.name === fileSegment)) {
      return res.status(400).json({ configured: true, error: 'প্রাইভেট স্টোরেজে আপলোডকৃত ডকুমেন্ট পাওয়া যায়নি।' });
    }

    const metadata = {
      fullName: typeof fullName === 'string' ? fullName.trim() : null,
      dob: typeof dob === 'string' ? dob.trim() : null,
      nidNumber: typeof nidNumber === 'string' ? nidNumber.trim() : null,
    };

    const { data: submission, error } = await supabaseAdmin!
      .from('kyc_submissions')
      .insert({
        user_id: req.userId!,
        document_type: documentType,
        storage_path: String(storagePath),
        status: 'pending',
        metadata,
      })
      .select('*')
      .single();

    if (error) {
      return res.status(400).json({ configured: true, error: error.message });
    }

    await supabaseAdmin!
      .from('profiles')
      .update({ kyc_status: 'pending', updated_at: new Date().toISOString() })
      .eq('id', req.userId!);

    await supabaseAdmin!.from('audit_logs').insert({
      actor_id: req.userId!,
      actor_role: req.userRole!,
      action: 'kyc_submitted',
      target_table: 'kyc_submissions',
      target_id: submission.id,
      payload: { documentType, storagePath, ...metadata },
    });

    return res.json({ configured: true, data: submission });
  });

  // Super Admin overview (all profiles, audit logs & persisted fee matrix)
  app.get(
    '/api/admin/overview',
    requireSupabaseAuth,
    requireRoles('super_admin'),
    async (_req: AuthenticatedRequest, res) => {
      const [profilesRes, auditRes, feeRes] = await Promise.all([
        supabaseAdmin!.from('profiles').select('*').order('created_at', { ascending: false }).limit(200),
        supabaseAdmin!.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(100),
        supabaseAdmin!
          .from('audit_logs')
          .select('payload, created_at')
          .eq('action', 'fee_matrix_updated')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      return res.json({
        configured: true,
        data: {
          profiles: profilesRes.data ?? [],
          auditLogs: auditRes.data ?? [],
          feeMatrix: feeRes.data?.payload
            ? {
                ...(feeRes.data.payload as Record<string, unknown>),
                updatedAt: feeRes.data.created_at,
              }
            : { p2pBps: 50, gatewayBps: 150, agentSplitPct: 65 },
        },
      });
    }
  );

  // Super Admin persistent fee matrix configuration via audit_logs
  app.post(
    '/api/admin/fee-matrix',
    requireSupabaseAuth,
    requireRoles('super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const p2pBps = Number(req.body?.p2pBps);
      const gatewayBps = Number(req.body?.gatewayBps);
      const agentSplitPct = Number(req.body?.agentSplitPct);

      if (
        !Number.isFinite(p2pBps) ||
        p2pBps < 0 ||
        !Number.isFinite(gatewayBps) ||
        gatewayBps < 0 ||
        !Number.isFinite(agentSplitPct) ||
        agentSplitPct < 0 ||
        agentSplitPct > 100
      ) {
        return res.status(400).json({ configured: true, error: 'সঠিক ফি বেসিস পয়েন্ট ও কমিশন শতাংশ প্রদান করুন।' });
      }

      const payload = { p2pBps, gatewayBps, agentSplitPct };
      const { data, error } = await supabaseAdmin!
        .from('audit_logs')
        .insert({
          actor_id: req.userId!,
          actor_role: req.userRole!,
          action: 'fee_matrix_updated',
          target_table: 'gateway_merchants',
          payload,
        })
        .select('*')
        .single();

      if (error) {
        return res.status(400).json({ configured: true, error: error.message });
      }

      return res.json({ configured: true, data: { ...payload, updatedAt: data.created_at } });
    }
  );

  // Super Admin / Support Admin user role & freeze management
  app.patch(
    '/api/admin/users/:id',
    requireSupabaseAuth,
    requireRoles('super_admin', 'support_admin'),
    async (req: AuthenticatedRequest, res) => {
      const { role, isFrozen } = req.body ?? {};
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

      if (typeof isFrozen === 'boolean') {
        updates.is_frozen = isFrozen;
      }
      if (role) {
        if (req.userRole !== 'super_admin') {
          return res.status(403).json({ configured: true, error: 'রোল পরিবর্তনের জন্য সুপার অ্যাডমিন অনুমতি প্রয়োজন।' });
        }
        const validRoles = ['user', 'agent', 'sub_agent', 'super_admin', 'finance_admin', 'support_admin'];
        if (!validRoles.includes(role)) {
          return res.status(400).json({ configured: true, error: 'অবৈধ ইউজার রোল।' });
        }
        updates.role = role;
      }

      const { data, error } = await supabaseAdmin!
        .from('profiles')
        .update(updates)
        .eq('id', req.params.id)
        .select('*')
        .single();

      if (error || !data) {
        return res.status(404).json({ configured: true, error: error?.message || 'টার্গেট ইউজার প্রোফাইল পাওয়া যায়নি।' });
      }

      // Ensure agent / sub_agent roles always have float & commission wallets provisioned strictly in BDT
      if (role === 'agent' || role === 'sub_agent') {
        for (const walletType of ['main', 'float', 'commission'] as const) {
          await supabaseAdmin!
            .from('wallets')
            .upsert(
              { user_id: req.params.id, wallet_type: walletType, currency: 'BDT' },
              { onConflict: 'user_id,wallet_type,currency', ignoreDuplicates: true }
            );
        }
      }

      await supabaseAdmin!.from('audit_logs').insert({
        actor_id: req.userId!,
        actor_role: req.userRole!,
        action: 'admin_user_update',
        target_table: 'profiles',
        target_id: req.params.id,
        payload: updates,
      });

      return res.json({ configured: true, data: sanitizeProfile(data as Record<string, unknown>) });
    }
  );

  // Finance & Super Admin: RLS-verified Agent Directory & Search Endpoint
  app.get(
    '/api/finance/agents',
    requireSupabaseAuth,
    requireRoles('finance_admin', 'super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const rlsClient = req.accessToken ? createUserScopedRlsClient(req.accessToken) : null;
      const reader = rlsClient ?? supabaseAdmin!;
      const searchQ = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';

      const { data: rawAgents, error: agentsErr } = await reader
        .from('profiles')
        .select('*')
        .in('role', ['user', 'agent', 'sub_agent'])
        .order('created_at', { ascending: false })
        .limit(200);

      if (agentsErr) {
        return res.status(403).json({
          configured: true,
          error: `এজেন্ট তালিকা লোড করতে RLS অনুমতি ব্যর্থ হয়েছে: ${agentsErr.message}`,
        });
      }

      const formatted = (rawAgents ?? [])
        .map((row: Record<string, unknown>) => ({
          id: String(row.id),
          full_name: String(row.full_name || ''),
          email: String(row.email || ''),
          phone: typeof row.phone === 'string' ? row.phone : null,
          agent_code: typeof row.agent_code === 'string' ? row.agent_code : null,
          role: String(row.role || 'user'),
          active_plan: (typeof row.active_plan === 'string' ? row.active_plan : null) as 'trial' | 'premium' | null,
          kyc_status: typeof row.kyc_status === 'string' ? row.kyc_status : 'unverified',
          is_frozen: Boolean(row.is_frozen),
        }))
        .filter((a) => {
          if (!searchQ) return true;
          return (
            a.id.toLowerCase().includes(searchQ) ||
            a.full_name.toLowerCase().includes(searchQ) ||
            a.email.toLowerCase().includes(searchQ) ||
            (a.phone || '').toLowerCase().includes(searchQ) ||
            (a.agent_code || '').toLowerCase().includes(searchQ)
          );
        });

      return res.json({ configured: true, data: formatted });
    }
  );

  // Admin: List MFS Payment Collection & Payout Requests + RLS-verified Agent Directory
  app.get(
    '/api/admin/mfs-requests',
    requireSupabaseAuth,
    requireRoles('finance_admin', 'super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const rlsClient = req.accessToken ? createUserScopedRlsClient(req.accessToken) : null;
      const reader = rlsClient ?? supabaseAdmin!;

      const [mfsRes, agentsRes] = await Promise.all([
        reader.from('mfs_payment_requests').select('*').order('created_at', { ascending: false }).limit(120),
        reader
          .from('profiles')
          .select('*')
          .in('role', ['user', 'agent', 'sub_agent'])
          .order('created_at', { ascending: false })
          .limit(200),
      ]);

      if (mfsRes.error && !isMissingSchemaError(mfsRes.error)) {
        console.warn(`[admin/mfs-requests] query error role=${req.userRole}: ${mfsRes.error.code || ''} ${mfsRes.error.message}`);
      }
      if (agentsRes.error) {
        console.warn(`[admin/mfs-requests] agents query error role=${req.userRole}: ${agentsRes.error.code || ''} ${agentsRes.error.message}`);
      }

      const ensuredAgentRows = await Promise.all(
        (agentsRes.data ?? []).map((row) => ensureProfileAgentCode(row as Record<string, unknown>))
      );

      const agentsList = ensuredAgentRows.map((row: Record<string, unknown>) => ({
        id: String(row.id),
        full_name: String(row.full_name || ''),
        email: String(row.email || ''),
        phone: typeof row.phone === 'string' ? row.phone : null,
        agent_code: typeof row.agent_code === 'string' ? row.agent_code : null,
        role: String(row.role || 'user'),
        active_plan: (typeof row.active_plan === 'string' ? row.active_plan : null) as 'trial' | 'premium' | null,
        kyc_status: typeof row.kyc_status === 'string' ? row.kyc_status : 'unverified',
        is_frozen: Boolean(row.is_frozen),
      }));

      const agentMap = new Map(agentsList.map((a) => [a.id, a]));
      const mfsRows = (mfsRes.data ?? []).map((item: Record<string, unknown>) => {
        const assigned = typeof item.agent_id === 'string' ? agentMap.get(item.agent_id) : undefined;
        return {
          ...item,
          agent_name: assigned?.full_name ?? null,
          agent_code: assigned?.agent_code ?? null,
        };
      });

      const schemaPending = isMissingSchemaError(mfsRes.error);

      return res.json({
        configured: true,
        data: {
          mfsRequests: mfsRows,
          agents: agentsList,
          schemaPending,
          mfsError: mfsRes.error && !schemaPending ? mfsRes.error.message : null,
          rlsError: agentsRes.error ? agentsRes.error.message : null,
        },
      });
    }
  );

  // Admin: Dispatch an MFS Payment Collection or Payout request to an Agent
  // Commission rate is strictly resolved on backend/DB by provider (bKash 5%, Nagad 4%, Rocket 4%)
  app.post(
    '/api/admin/mfs-requests',
    requireSupabaseAuth,
    requireRoles('finance_admin', 'super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const { agentIdentifier, requestType, method, accountMode, agentAccountNumber, customerAccount, amount } =
        req.body ?? {};
      const rawIdempotency =
        (typeof req.headers['x-idempotency-key'] === 'string' && req.headers['x-idempotency-key']) ||
        (typeof req.body?.idempotencyKey === 'string' && req.body.idempotencyKey) ||
        '';
      const cleanIdempotencyKey = rawIdempotency.trim().slice(0, 120) || null;

      const numericAmount = Number(Number(amount).toFixed(2));
      const validTypes = ['payment_collection', 'payment_payout'];
      const validMethods = ['bkash', 'nagad', 'rocket'];
      const validModes = ['personal', 'merchant', 'agent'];

      if (
        !agentIdentifier ||
        !validTypes.includes(requestType) ||
        !validMethods.includes(method) ||
        !validModes.includes(accountMode) ||
        !agentAccountNumber ||
        !Number.isFinite(numericAmount) ||
        numericAmount <= 0
      ) {
        return res.status(400).json({
          configured: true,
          error: 'এজেন্ট আইডি/ইমেইল, রিকোয়েস্ট ধরন, পেমেন্ট মেথড, নম্বর এবং সঠিক BDT পরিমাণ দিন।',
        });
      }

      if (cleanIdempotencyKey) {
        const { data: existingReq } = await supabaseAdmin!
          .from('mfs_payment_requests')
          .select('*')
          .eq('idempotency_key', cleanIdempotencyKey)
          .maybeSingle();

        if (existingReq) {
          return res.json({ configured: true, idempotentReplay: true, data: existingReq });
        }
      }

      const rlsClient = req.accessToken ? createUserScopedRlsClient(req.accessToken) : null;
      const resolution = await resolveProfileByIdentifier(String(agentIdentifier), {
        allowedRoles: ['user', 'agent', 'sub_agent'],
        requireAuthUser: true,
        rlsClient,
      });

      if (!resolution.profile) {
        return res.status(resolution.status || 404).json({
          configured: true,
          code: resolution.code || 'AGENT_NOT_FOUND',
          error: resolution.error || 'নির্বাচিত এজেন্ট খুঁজে পাওয়া যায়নি।',
        });
      }

      const agentProfile = await ensureProfileAgentCode(resolution.profile);
      const { config: platformCfg } = await readPlatformConfig();
      const { rate: commissionRate, commissionAmount } = computeCommissionAmount(
        numericAmount,
        method,
        platformCfg.commissionRates
      );
      const refCode = `${requestType === 'payment_collection' ? 'MPC' : 'MPO'}-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;

      const { data, error } = await supabaseAdmin!
        .from('mfs_payment_requests')
        .insert({
          reference_code: refCode,
          idempotency_key: cleanIdempotencyKey,
          agent_id: agentProfile.id,
          request_type: requestType,
          method,
          account_mode: accountMode,
          agent_account_number: String(agentAccountNumber).trim(),
          customer_account: customerAccount ? String(customerAccount).trim() : null,
          amount: numericAmount,
          currency: 'BDT',
          commission_rate: commissionRate,
          commission_amount: commissionAmount,
          status: 'pending',
          created_by: req.userId!,
        })
        .select('*')
        .single();

      if (error) {
        if (error.code === '23505' && cleanIdempotencyKey) {
          const { data: replayRow } = await supabaseAdmin!
            .from('mfs_payment_requests')
            .select('*')
            .eq('idempotency_key', cleanIdempotencyKey)
            .maybeSingle();
          if (replayRow) {
            return res.json({ configured: true, idempotentReplay: true, data: replayRow });
          }
        }
        if (isMissingSchemaError(error)) {
          return res.status(503).json({
            configured: true,
            code: 'SCHEMA_PENDING',
            resolvedAgent: {
              id: agentProfile.id,
              full_name: agentProfile.full_name,
              email: agentProfile.email,
              agent_code: agentProfile.agent_code ?? null,
              role: agentProfile.role,
            },
            error: `এজেন্ট "${agentProfile.full_name}" যাচাই সফল হয়েছে, তবে Supabase ডাটাবেজে mfs_payment_requests টেবিল এখনো তৈরি হয়নি। অনুগ্রহ করে supabase/migrations/004_mfs_requests_and_notifications.sql মাইগ্রেশন চালান।`,
          });
        }
        return res.status(400).json({ configured: true, error: error.message });
      }

      const featureTitle = requestType === 'payment_collection' ? 'Bet Deposit' : 'Bet Payout';
      const { error: notifErr } = await supabaseAdmin!.from('user_notifications').insert({
        user_id: agentProfile.id,
        title: `নতুন ${featureTitle} রিকোয়েস্ট (${refCode})`,
        message: `${String(method).toUpperCase()} (${accountMode}) মাধ্যমে ৳${numericAmount.toLocaleString('en-US')} ${featureTitle} রিকোয়েস্ট পাঠানো হয়েছে। কমিশন: ৳${commissionAmount.toFixed(2)}।`,
        created_by: req.userId!,
      });
      if (notifErr) {
        console.warn(
          `[admin/mfs-requests] notification insert warning agentId=${agentProfile.id} ref=${refCode}: ${notifErr.message}`
        );
      }

      await supabaseAdmin!.from('audit_logs').insert({
        actor_id: req.userId!,
        actor_role: req.userRole!,
        action: `admin_dispatched_${requestType}`,
        target_table: 'mfs_payment_requests',
        target_id: data.id,
        payload: {
          agentId: agentProfile.id,
          agentCode: agentProfile.agent_code ?? null,
          amount: numericAmount,
          currency: 'BDT',
          method,
          commissionRate,
          commissionAmount,
          notificationDelivered: !notifErr,
        },
      });

      return res.json({
        configured: true,
        data: {
          ...data,
          agent_name: agentProfile.full_name,
          agent_code: agentProfile.agent_code ?? null,
          notificationDelivered: !notifErr,
        },
      });
    }
  );

  // Admin: Read & Update Platform Configuration (deposit payment methods, commission rates, support links, social, partners, global alerts)
  app.get(
    '/api/admin/platform-config',
    requireSupabaseAuth,
    requireRoles('super_admin', 'finance_admin'),
    async (_req: AuthenticatedRequest, res) => {
      const { config, schemaPending, fromDb } = await readPlatformConfig();
      return res.json({
        configured: true,
        schemaPending,
        fromDb,
        data: config,
      });
    }
  );

  app.put(
    '/api/admin/platform-config',
    requireSupabaseAuth,
    requireRoles('super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const body = req.body ?? {};
      const { config: current, schemaPending } = await readPlatformConfig();

      if (schemaPending) {
        return res.status(503).json({
          configured: true,
          code: 'SCHEMA_PENDING',
          error:
            'Supabase ডাটাবেজে public.platform_config টেবিল এখনো তৈরি হয়নি। অনুগ্রহ করে 002b_agent_bdt_config_fix.sql মাইগ্রেশন প্রয়োগ করুন।',
        });
      }

      if (Array.isArray(body.depositMethods)) {
        const hasDisallowed = body.depositMethods.some(
          (m: unknown) =>
            m &&
            typeof m === 'object' &&
            typeof (m as { id?: unknown }).id === 'string' &&
            DISALLOWED_PAYMENT_IDS.has((m as { id: string }).id.trim().toLowerCase())
        );
        if (hasDisallowed) {
          return res.status(400).json({
            configured: true,
            error: 'ZentoPay শুধুমাত্র BDT পেমেন্ট মাধ্যম সমর্থন করে (Binance/USDT অনুমোদিত নয়)।',
          });
        }
      }

      let nextCommissionRates = current.commissionRates;
      if (body.commissionRates && typeof body.commissionRates === 'object') {
        const rawRates = body.commissionRates as Record<string, unknown>;
        for (const provider of ['bkash', 'nagad', 'rocket'] as const) {
          const val = Number(rawRates[provider]);
          if (!Number.isFinite(val) || val < 0 || val > MAX_PROVIDER_COMMISSION_RATE) {
            return res.status(400).json({
              configured: true,
              error: `${provider.toUpperCase()} কমিশন রেট অবশ্যই ০% থেকে ২৫%-এর মধ্যে হতে হবে।`,
            });
          }
        }
        nextCommissionRates = sanitizeCommissionRates(rawRates);
      }

      const nextConfig = sanitizePlatformConfig({
        depositMethods: Array.isArray(body.depositMethods) ? body.depositMethods : current.depositMethods,
        commissionRates: nextCommissionRates,
        supportLinks: body.supportLinks ? { ...current.supportLinks, ...body.supportLinks } : current.supportLinks,
        socialNetworks: Array.isArray(body.socialNetworks) ? body.socialNetworks : current.socialNetworks,
        partners: Array.isArray(body.partners) ? body.partners : current.partners,
        globalNotifications: Array.isArray(body.globalNotifications)
          ? body.globalNotifications
          : current.globalNotifications,
      });

      const { error } = await supabaseAdmin!
        .from('platform_config')
        .upsert(
          {
            config_key: 'ewallet_config',
            config_value: nextConfig,
            updated_by: req.userId!,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'config_key' }
        );

      if (error) {
        if (isMissingSchemaError(error)) {
          return res.status(503).json({
            configured: true,
            code: 'SCHEMA_PENDING',
            error:
              'Supabase ডাটাবেজে public.platform_config টেবিল এখনো তৈরি হয়নি। অনুগ্রহ করে 002b_agent_bdt_config_fix.sql মাইগ্রেশন প্রয়োগ করুন।',
          });
        }
        return res.status(400).json({ configured: true, error: error.message });
      }

      await supabaseAdmin!.from('audit_logs').insert({
        actor_id: req.userId!,
        actor_role: req.userRole!,
        action: 'platform_config_updated',
        target_table: 'platform_config',
        payload: {
          keys: Object.keys(nextConfig),
          depositMethodCount: nextConfig.depositMethods.length,
          commissionRates: nextConfig.commissionRates,
        },
      });

      return res.json({ configured: true, data: nextConfig });
    }
  );

  // Admin: Dedicated Provider Commission Rate Update (Super Admin only; applies strictly to future transactions)
  app.put(
    '/api/admin/commission-rates',
    requireSupabaseAuth,
    requireRoles('super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const { config: current, schemaPending } = await readPlatformConfig();
      if (schemaPending) {
        return res.status(503).json({
          configured: true,
          code: 'SCHEMA_PENDING',
          error:
            'Supabase ডাটাবেজে public.platform_config টেবিল এখনো তৈরি হয়নি। অনুগ্রহ করে 002b_agent_bdt_config_fix.sql মাইগ্রেশন প্রয়োগ করুন।',
        });
      }

      const body = req.body ?? {};
      for (const provider of ['bkash', 'nagad', 'rocket'] as const) {
        const val = Number(body[provider]);
        if (!Number.isFinite(val) || val < 0 || val > MAX_PROVIDER_COMMISSION_RATE) {
          return res.status(400).json({
            configured: true,
            error: `${provider.toUpperCase()} কমিশন রেট অবশ্যই ০% থেকে ২৫% (0.00 - 0.25)-এর মধ্যে হতে হবে।`,
          });
        }
      }

      const nextRates = sanitizeCommissionRates({
        bkash: Number(body.bkash),
        nagad: Number(body.nagad),
        rocket: Number(body.rocket),
      });

      const nextConfig = {
        ...current,
        commissionRates: nextRates,
      };

      const { error } = await supabaseAdmin!
        .from('platform_config')
        .upsert(
          {
            config_key: 'ewallet_config',
            config_value: nextConfig,
            updated_by: req.userId!,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'config_key' }
        );

      if (error) {
        return res.status(isMissingSchemaError(error) ? 503 : 400).json({ configured: true, error: error.message });
      }

      await supabaseAdmin!.from('audit_logs').insert({
        actor_id: req.userId!,
        actor_role: req.userRole!,
        action: 'commission_rates_updated',
        target_table: 'platform_config',
        payload: {
          previousRates: current.commissionRates,
          nextRates,
          retroactiveRecalculation: false,
        },
      });

      return res.json({ configured: true, data: nextConfig });
    }
  );

  // Admin: Dedicated Payment Method CRUD (add / edit / enable-disable / delete custom BDT payment methods)
  app.post(
    '/api/admin/payment-methods',
    requireSupabaseAuth,
    requireRoles('super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const { config: current, schemaPending } = await readPlatformConfig();
      if (schemaPending) {
        return res.status(503).json({
          configured: true,
          code: 'SCHEMA_PENDING',
          error:
            'Supabase ডাটাবেজে public.platform_config টেবিল এখনো তৈরি হয়নি। অনুগ্রহ করে 002b_agent_bdt_config_fix.sql মাইগ্রেশন প্রয়োগ করুন।',
        });
      }

      const candidate = sanitizeDepositMethod({
        id: req.body?.id || String(req.body?.name || '').trim().toLowerCase().replace(/\s+/g, '_'),
        name: req.body?.name,
        accountNumber: req.body?.accountNumber ?? '',
        accountLabel: req.body?.accountLabel ?? '',
        enabled: req.body?.enabled ?? true,
      });

      if (!candidate) {
        return res.status(400).json({
          configured: true,
          error: 'অনুগ্রহ করে বৈধ BDT পেমেন্ট মাধ্যমের আইডি ও নাম প্রদান করুন।',
        });
      }

      if (current.depositMethods.some((m) => m.id === candidate.id)) {
        return res.status(409).json({
          configured: true,
          error: `পেমেন্ট মাধ্যম "${candidate.id}" ইতিমধ্যে বিদ্যমান। অনুগ্রহ করে সম্পাদনা করুন।`,
        });
      }

      const nextConfig = {
        ...current,
        depositMethods: [...current.depositMethods, candidate],
      };

      const { error } = await supabaseAdmin!
        .from('platform_config')
        .upsert(
          {
            config_key: 'ewallet_config',
            config_value: nextConfig,
            updated_by: req.userId!,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'config_key' }
        );

      if (error) {
        return res.status(isMissingSchemaError(error) ? 503 : 400).json({ configured: true, error: error.message });
      }

      await supabaseAdmin!.from('audit_logs').insert({
        actor_id: req.userId!,
        actor_role: req.userRole!,
        action: 'payment_method_added',
        target_table: 'platform_config',
        payload: { id: candidate.id, name: candidate.name, enabled: candidate.enabled },
      });

      return res.status(201).json({ configured: true, data: nextConfig });
    }
  );

  app.patch(
    '/api/admin/payment-methods/:id',
    requireSupabaseAuth,
    requireRoles('super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const targetId = String(req.params.id || '').trim().toLowerCase();
      const { config: current, schemaPending } = await readPlatformConfig();
      if (schemaPending) {
        return res.status(503).json({
          configured: true,
          code: 'SCHEMA_PENDING',
          error: 'public.platform_config টেবিল এখনো Supabase-এ তৈরি হয়নি।',
        });
      }

      const idx = current.depositMethods.findIndex((m) => m.id === targetId);
      if (idx === -1) {
        return res.status(404).json({ configured: true, error: 'পেমেন্ট মাধ্যম খুঁজে পাওয়া যায়নি।' });
      }

      const existing = current.depositMethods[idx];
      const updated = sanitizeDepositMethod({
        id: existing.id,
        name: req.body?.name ?? existing.name,
        accountNumber: req.body?.accountNumber ?? existing.accountNumber,
        accountLabel: req.body?.accountLabel ?? existing.accountLabel,
        enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : existing.enabled,
      });

      if (!updated) {
        return res.status(400).json({ configured: true, error: 'অবৈধ পেমেন্ট মাধ্যম তথ্য।' });
      }

      const nextMethods = [...current.depositMethods];
      nextMethods[idx] = updated;
      const nextConfig = { ...current, depositMethods: nextMethods };

      const { error } = await supabaseAdmin!
        .from('platform_config')
        .upsert(
          {
            config_key: 'ewallet_config',
            config_value: nextConfig,
            updated_by: req.userId!,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'config_key' }
        );

      if (error) {
        return res.status(isMissingSchemaError(error) ? 503 : 400).json({ configured: true, error: error.message });
      }

      await supabaseAdmin!.from('audit_logs').insert({
        actor_id: req.userId!,
        actor_role: req.userRole!,
        action: 'payment_method_updated',
        target_table: 'platform_config',
        payload: { id: updated.id, name: updated.name, enabled: updated.enabled },
      });

      return res.json({ configured: true, data: nextConfig });
    }
  );

  app.delete(
    '/api/admin/payment-methods/:id',
    requireSupabaseAuth,
    requireRoles('super_admin'),
    async (req: AuthenticatedRequest, res) => {
      const targetId = String(req.params.id || '').trim().toLowerCase();
      const { config: current, schemaPending } = await readPlatformConfig();
      if (schemaPending) {
        return res.status(503).json({
          configured: true,
          code: 'SCHEMA_PENDING',
          error: 'public.platform_config টেবিল এখনো Supabase-এ তৈরি হয়নি।',
        });
      }

      if (!current.depositMethods.some((m) => m.id === targetId)) {
        return res.status(404).json({ configured: true, error: 'পেমেন্ট মাধ্যম খুঁজে পাওয়া যায়নি।' });
      }

      const nextConfig = {
        ...current,
        depositMethods: current.depositMethods.filter((m) => m.id !== targetId),
      };

      const { error } = await supabaseAdmin!
        .from('platform_config')
        .upsert(
          {
            config_key: 'ewallet_config',
            config_value: nextConfig,
            updated_by: req.userId!,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'config_key' }
        );

      if (error) {
        return res.status(isMissingSchemaError(error) ? 503 : 400).json({ configured: true, error: error.message });
      }

      await supabaseAdmin!.from('audit_logs').insert({
        actor_id: req.userId!,
        actor_role: req.userRole!,
        action: 'payment_method_deleted',
        target_table: 'platform_config',
        payload: { id: targetId },
      });

      return res.json({ configured: true, data: nextConfig });
    }
  );

  // Admin: Send Personal User Notification
  app.post(
    '/api/admin/notifications',
    requireSupabaseAuth,
    requireRoles('super_admin', 'finance_admin', 'support_admin'),
    async (req: AuthenticatedRequest, res) => {
      const { userIdentifier, title, message } = req.body ?? {};
      if (!userIdentifier || !title || !message) {
        return res.status(400).json({ configured: true, error: 'ব্যবহারকারী আইডি/ইমেইল, শিরোনাম এবং বার্তা প্রয়োজন।' });
      }

      const rlsClient = req.accessToken ? createUserScopedRlsClient(req.accessToken) : null;
      const resolution = await resolveProfileByIdentifier(String(userIdentifier), {
        requireAuthUser: true,
        rlsClient,
      });

      if (!resolution.profile) {
        return res.status(resolution.status || 404).json({
          configured: true,
          code: resolution.code || 'USER_NOT_FOUND',
          error: resolution.error || 'টার্গেট ব্যবহারকারী খুঁজে পাওয়া যায়নি।',
        });
      }

      const targetUser = resolution.profile;
      const { data, error } = await supabaseAdmin!
        .from('user_notifications')
        .insert({
          user_id: targetUser.id,
          title: String(title).trim(),
          message: String(message).trim(),
          created_by: req.userId!,
        })
        .select('*')
        .single();

      if (error) {
        if (error.code === 'PGRST205') {
          return res.status(503).json({
            configured: true,
            code: 'SCHEMA_PENDING',
            error: 'user_notifications টেবিল এখনো Supabase-এ তৈরি হয়নি (003_ewalletup_replica.sql মাইগ্রেশন চালান)।',
          });
        }
        return res.status(400).json({ configured: true, error: error.message });
      }
      return res.json({ configured: true, data });
    }
  );

  // Strictly Development-Only Endpoints (Blocked in production: returns 404)
  // Allows inspecting auth/profile role integrity and provisioning test Super Admin & Finance Admin accounts
  if (process.env.NODE_ENV !== 'production') {
    const DEV_SUPER_ADMIN_EMAIL = (process.env.DEV_SUPER_ADMIN_EMAIL || 'superadmin@zentopay.dev').trim().toLowerCase();
    const DEV_SUPER_ADMIN_PASSWORD = process.env.DEV_SUPER_ADMIN_PASSWORD || 'ZentoSuper@2026!';
    const DEV_FINANCE_ADMIN_EMAIL = (process.env.DEV_FINANCE_ADMIN_EMAIL || 'financeadmin@zentopay.dev').trim().toLowerCase();
    const DEV_FINANCE_ADMIN_PASSWORD = process.env.DEV_FINANCE_ADMIN_PASSWORD || 'ZentoFinance@2026!';

    const listAllAuthUsers = async () => {
      const users: Array<{
        id: string;
        email?: string;
        email_confirmed_at?: string | null;
        last_sign_in_at?: string | null;
        created_at: string;
      }> = [];
      let page = 1;
      const perPage = 200;
      while (page <= 10) {
        const { data, error } = await supabaseAdmin!.auth.admin.listUsers({ page, perPage });
        if (error || !data?.users?.length) break;
        users.push(...data.users);
        if (data.users.length < perPage) break;
        page += 1;
      }
      return users;
    };

    app.get('/api/dev/auth-status', async (_req, res) => {
      if (!isServerConfigured || !supabaseAdmin) {
        return res.status(503).json({ configured: false, error: 'Supabase not configured' });
      }

      const [authUsers, profilesRes] = await Promise.all([
        listAllAuthUsers(),
        supabaseAdmin.from('profiles').select('id, email, full_name, role, is_frozen, kyc_status, created_at'),
      ]);

      const profiles = profilesRes.data ?? [];
      const profileById = new Map(profiles.map((p) => [p.id, p]));
      const authById = new Map(authUsers.map((u) => [u.id, u]));

      const roleCounts: Record<string, number> = {};
      for (const p of profiles) {
        roleCounts[p.role] = (roleCounts[p.role] || 0) + 1;
      }

      const orphanedAuthUsers = authUsers
        .filter((u) => !profileById.has(u.id))
        .map((u) => ({
          id: u.id,
          emailMasked: u.email ? maskEmail(u.email) : 'none',
          emailConfirmed: Boolean(u.email_confirmed_at),
        }));

      const profileAudit = profiles.map((p) => {
        const au = authById.get(p.id);
        return {
          id: p.id,
          emailMasked: maskEmail(p.email),
          role: p.role,
          isFrozen: p.is_frozen,
          hasAuthUser: Boolean(au),
          emailConfirmed: Boolean(au?.email_confirmed_at),
          lastSignInAt: au?.last_sign_in_at ?? null,
        };
      });

      return res.json({
        configured: true,
        environment: process.env.NODE_ENV || 'development',
        authUsersTotal: authUsers.length,
        profilesTotal: profiles.length,
        profilesError: profilesRes.error?.message || null,
        roleCounts,
        hasSuperAdmin: (roleCounts['super_admin'] || 0) > 0,
        hasFinanceAdmin: (roleCounts['finance_admin'] || 0) > 0,
        hasSupportAdmin: (roleCounts['support_admin'] || 0) > 0,
        orphanedAuthUsers,
        profiles: profileAudit,
      });
    });

    app.post('/api/dev/seed-admins', async (req, res) => {
      if (!isServerConfigured || !supabaseAdmin) {
        return res.status(503).json({ configured: false, error: 'Supabase not configured' });
      }

      const resetDevPasswords = Boolean(req.body?.resetDevPasswords);
      const authUsers = await listAllAuthUsers();
      const { data: existingProfiles } = await supabaseAdmin
        .from('profiles')
        .select('id, email, role, is_frozen');

      const profiles = existingProfiles ?? [];

      const ensureDevAdmin = async (cfg: {
        role: 'super_admin' | 'finance_admin';
        email: string;
        password: string;
        fullName: string;
        phone: string;
      }) => {
        // Check if another active account already has this role
        const existingWithRole = profiles.filter((p) => p.role === cfg.role && !p.is_frozen);
        const devAuthMatch = authUsers.find((u) => u.email?.toLowerCase() === cfg.email);
        const devProfileMatch = profiles.find((p) => p.email.toLowerCase() === cfg.email);

        if (existingWithRole.length > 0 && !devAuthMatch && !resetDevPasswords) {
          return {
            role: cfg.role,
            action: 'preserved_existing',
            userId: existingWithRole[0].id,
            email: existingWithRole[0].email,
            password: null as string | null,
          };
        }

        let userId = devAuthMatch?.id || devProfileMatch?.id || '';

        if (!devAuthMatch) {
          const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
            email: cfg.email,
            password: cfg.password,
            email_confirm: true,
            user_metadata: {
              full_name: cfg.fullName,
              phone: cfg.phone,
              country: 'BD',
            },
          });
          if (createErr || !created.user) {
            throw new Error(`Failed to create ${cfg.role} auth user: ${createErr?.message || 'unknown error'}`);
          }
          userId = created.user.id;
        } else {
          // Ensure email confirmed and optionally reset dev test password (ONLY on @zentopay.dev dev account)
          const updatePayload: { email_confirm: boolean; password?: string } = { email_confirm: true };
          if (resetDevPasswords || !devProfileMatch) {
            updatePayload.password = cfg.password;
          }
          await supabaseAdmin.auth.admin.updateUserById(devAuthMatch.id, updatePayload);
        }

        // Safely ensure public.profiles row exists and has the exact admin role (never modifies non-dev accounts)
        const { data: currentProf } = await supabaseAdmin
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .maybeSingle();

        if (!currentProf) {
          const { error: insErr } = await supabaseAdmin.from('profiles').insert({
            id: userId,
            email: cfg.email,
            full_name: cfg.fullName,
            phone: cfg.phone,
            country: 'BD',
            role: cfg.role,
            kyc_status: 'verified',
            is_frozen: false,
          });
          if (insErr) {
            throw new Error(`Failed to insert ${cfg.role} profile: ${insErr.message}`);
          }
        } else if (currentProf.role !== cfg.role) {
          const { error: updErr } = await supabaseAdmin
            .from('profiles')
            .update({
              role: cfg.role,
              kyc_status: 'verified',
              is_frozen: false,
              updated_at: new Date().toISOString(),
            })
            .eq('id', userId);
          if (updErr) {
            throw new Error(`Failed to update ${cfg.role} profile: ${updErr.message}`);
          }
        }

        if (currentProf) {
          await ensureProfileAgentCode(currentProf as Record<string, unknown>);
        }

        await supabaseAdmin
          .from('wallets')
          .upsert(
            { user_id: userId, wallet_type: 'main', currency: 'BDT', balance: 0, available_balance: 0 },
            { onConflict: 'user_id,wallet_type,currency', ignoreDuplicates: true }
          );

        await supabaseAdmin.from('audit_logs').insert({
          actor_id: userId,
          actor_role: cfg.role,
          action: devAuthMatch ? 'dev_admin_verified' : 'dev_admin_seeded',
          target_table: 'profiles',
          target_id: userId,
          payload: { role: cfg.role, devOnly: true },
        });

        return {
          role: cfg.role,
          action: devAuthMatch ? (resetDevPasswords ? 'password_reset_and_verified' : 'verified') : 'created',
          userId,
          email: cfg.email,
          password: cfg.password,
        };
      };

      try {
        const [superAdminRes, financeAdminRes] = await Promise.all([
          ensureDevAdmin({
            role: 'super_admin',
            email: DEV_SUPER_ADMIN_EMAIL,
            password: DEV_SUPER_ADMIN_PASSWORD,
            fullName: 'ZentoPay Super Admin (Dev)',
            phone: '01700000901',
          }),
          ensureDevAdmin({
            role: 'finance_admin',
            email: DEV_FINANCE_ADMIN_EMAIL,
            password: DEV_FINANCE_ADMIN_PASSWORD,
            fullName: 'ZentoPay Finance Admin (Dev)',
            phone: '01700000902',
          }),
        ]);

        return res.status(200).json({
          configured: true,
          devOnly: true,
          accounts: [superAdminRes, financeAdminRes],
        });
      } catch (err) {
        return res.status(500).json({
          configured: true,
          error: err instanceof Error ? err.message : 'Failed to provision dev admin accounts',
        });
      }
    });
  }

  // Vercel serves the Vite dist folder as static output. The Express app
  // handles API requests only in serverless mode.
  if (process.env.VERCEL !== '1') {
    if (process.env.NODE_ENV === 'production') {
      const distPath = path.join(__dirname, 'dist');
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    } else {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    }
  }

  return app;
}

// Reuse one initialized Express application across warm Vercel invocations.
let appPromise: ReturnType<typeof createApp> | undefined;
export function getApp() {
  if (!appPromise) appPromise = createApp();
  return appPromise;
}

// Keep the existing local development workflow: `npm run dev` runs this file.
if (process.env.VERCEL !== '1') {
  void getApp()
    .then((app) => {
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`ZentoPay server listening on http://0.0.0.0:${PORT}`);
      });
    })
    .catch((error) => {
      console.error('[ZentoPay] Failed to start server:', error);
      process.exitCode = 1;
    });
}
