import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from '../lib/supabase.ts';
import { apiRequest } from '../lib/api.ts';
import { AUTHORITATIVE_COMMISSION_RATES, sanitizeCommissionRates } from '../lib/commissions.ts';
import type {
  AgentGateway,
  KycSubmission,
  MfsPaymentRequest,
  PlatformConfigData,
  SettlementRequest,
  SupportTicket,
  TransactionRecord,
  UserNotificationItem,
  UserProfile,
  UserRole,
  Wallet,
} from '../types/zentopay.ts';

const EMPTY_PLATFORM_CONFIG: PlatformConfigData = {
  depositMethods: [],
  commissionRates: { ...AUTHORITATIVE_COMMISSION_RATES },
  supportLinks: { telegram: '', whatsapp: '', affiliateManagerTelegram: '' },
  socialNetworks: [],
  partners: [],
  globalNotifications: [],
};

interface AuthMePayload {
  profile: UserProfile;
  wallets: Wallet[];
  transactions: TransactionRecord[];
  settlements?: SettlementRequest[];
  kycSubmissions?: KycSubmission[];
  tickets?: SupportTicket[];
  gateways?: AgentGateway[];
  mfsRequests?: MfsPaymentRequest[];
  notifications?: UserNotificationItem[];
  mfsSchemaPending?: boolean;
  referralCount?: number;
  platformConfig?: PlatformConfigData;
}

interface AuthContextValue {
  isConfigured: boolean;
  isLoading: boolean;
  session: Session | null;
  authUser: User | null;
  profile: UserProfile | null;
  profileError: string | null;
  wallets: Wallet[];
  transactions: TransactionRecord[];
  settlements: SettlementRequest[];
  kycSubmissions: KycSubmission[];
  tickets: SupportTicket[];
  gateways: AgentGateway[];
  mfsRequests: MfsPaymentRequest[];
  notifications: UserNotificationItem[];
  mfsSchemaPending: boolean;
  referralCount: number;
  platformConfig: PlatformConfigData;
  previewRole: UserRole;
  setPreviewRole: (role: UserRole) => void;
  signIn: (email: string, password: string) => Promise<{ error?: string; role?: UserRole }>;
  signUp: (params: {
    email: string;
    password: string;
    fullName: string;
    phone: string;
    country: string;
    businessName?: string;
    referralCode?: string;
  }) => Promise<{ error?: string; errorCode?: string; role?: UserRole }>;
  resetPassword: (email: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  refreshAccountData: () => Promise<void>;
  refreshMfsRequests: () => Promise<void>;
  refreshPublicConfig: () => Promise<void>;
  markWithdrawPinConfigured: () => void;
}

function translateSupabaseAuthError(rawMessage: string, errorCode?: string): string {
  const lower = rawMessage.toLowerCase();
  const code = (errorCode || '').toLowerCase();
  if (lower.includes('invalid login credentials')) {
    return 'ইমেইল অথবা পাসওয়ার্ড সঠিক নয়।';
  }
  if (code === 'email_provider_disabled' || lower.includes('email logins are disabled')) {
    return 'Supabase-এ Email লগইন প্রোভাইডার বন্ধ রয়েছে। অনুগ্রহ করে Supabase Dashboard → Authentication → Providers → Email চালু করুন।';
  }
  if (lower.includes('email not confirmed')) {
    return 'অ্যাকাউন্টে প্রবেশ করা যায়নি। অনুগ্রহ করে সঠিক ইমেইল ও পাসওয়ার্ড দিয়ে চেষ্টা করুন অথবা সাপোর্টে যোগাযোগ করুন।';
  }
  if (lower.includes('user already registered') || lower.includes('already been registered')) {
    return 'এই ইমেইল দিয়ে ইতিমধ্যে একটি অ্যাকাউন্ট নিবন্ধিত রয়েছে। অনুগ্রহ করে লগইন করুন।';
  }
  if (lower.includes('password should be at least')) {
    return 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।';
  }
  if (lower.includes('unable to validate email address') || lower.includes('invalid email')) {
    return 'অনুগ্রহ করে একটি সঠিক ইমেইল ঠিকানা লিখুন।';
  }
  if (code === 'over_email_send_rate_limit' || lower.includes('email rate limit')) {
    return 'অতিরিক্ত ইমেইল অনুরোধের কারণে সাময়িকভাবে বিরতি দেওয়া হয়েছে। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।';
  }
  if (lower.includes('rate limit') || lower.includes('security purposes')) {
    return 'অতিরিক্ত অনুরোধের কারণে সাময়িকভাবে বিরতি দেওয়া হয়েছে। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।';
  }
  if (lower.includes('database error saving new user')) {
    return 'ডাটাবেজে ব্যবহারকারীর প্রোফাইল সংরক্ষণে ত্রুটি হয়েছে। সাইনআপ ট্রিগার (on_auth_user_created) ও স্কিমা যাচাই করুন।';
  }
  return `অথেনটিকেশন ত্রুটি: ${rawMessage}`;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isLoading, setIsLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [settlements, setSettlements] = useState<SettlementRequest[]>([]);
  const [kycSubmissions, setKycSubmissions] = useState<KycSubmission[]>([]);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [gateways, setGateways] = useState<AgentGateway[]>([]);
  const [mfsRequests, setMfsRequests] = useState<MfsPaymentRequest[]>([]);
  const [notifications, setNotifications] = useState<UserNotificationItem[]>([]);
  const [mfsSchemaPending, setMfsSchemaPending] = useState(false);
  const [referralCount, setReferralCount] = useState(0);
  const [platformConfig, setPlatformConfig] = useState<PlatformConfigData>(EMPTY_PLATFORM_CONFIG);
  const [previewRole, setPreviewRole] = useState<UserRole>('agent');

  const applyMePayload = useCallback((data: AuthMePayload) => {
    setProfile(data.profile);
    setProfileError(null);
    setWallets(data.wallets ?? []);
    setTransactions(data.transactions ?? []);
    setSettlements(data.settlements ?? []);
    setKycSubmissions(data.kycSubmissions ?? []);
    setTickets(data.tickets ?? []);
    setGateways(data.gateways ?? []);
    setMfsRequests(data.mfsRequests ?? []);
    setNotifications(data.notifications ?? []);
    setMfsSchemaPending(Boolean(data.mfsSchemaPending));
    setReferralCount(data.referralCount ?? 0);
    if (data.platformConfig) {
      setPlatformConfig({
        ...EMPTY_PLATFORM_CONFIG,
        ...data.platformConfig,
        commissionRates: sanitizeCommissionRates(data.platformConfig.commissionRates),
      });
    }
    setPreviewRole(data.profile.role);
  }, []);

  const clearAccountState = useCallback(() => {
    setProfile(null);
    setProfileError(null);
    setWallets([]);
    setTransactions([]);
    setSettlements([]);
    setKycSubmissions([]);
    setTickets([]);
    setGateways([]);
    setMfsRequests([]);
    setNotifications([]);
    setMfsSchemaPending(false);
    setReferralCount(0);
  }, []);

  const refreshPublicConfig = useCallback(async () => {
    const res = await apiRequest<PlatformConfigData>('/api/public/platform-config');
    if (res.ok && res.data) {
      setPlatformConfig({
        ...EMPTY_PLATFORM_CONFIG,
        ...res.data,
        depositMethods: Array.isArray(res.data.depositMethods) ? res.data.depositMethods : [],
        commissionRates: sanitizeCommissionRates(res.data.commissionRates),
      });
    }
  }, []);

  const refreshAccountData = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) return;
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      clearAccountState();
      return;
    }

    const res = await apiRequest<AuthMePayload>('/api/auth/me');
    if (res.ok && res.data?.profile) {
      applyMePayload(res.data);
    } else {
      clearAccountState();
      setProfileError(res.error || 'ব্যবহারকারীর প্রোফাইল তথ্য লোড করা যায়নি।');
    }
  }, [applyMePayload, clearAccountState]);

  const markWithdrawPinConfigured = useCallback(() => {
    setProfile((prev) => (prev ? { ...prev, has_withdraw_pin: true } : prev));
  }, []);

  const refreshMfsRequests = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) return;
    const { data } = await supabase.auth.getSession();
    if (!data.session) return;

    const res = await apiRequest<{
      mfsRequests: MfsPaymentRequest[];
      notifications: UserNotificationItem[];
      schemaPending?: boolean;
    }>('/api/agent/mfs-requests');
    if (res.ok && res.data) {
      setMfsRequests(res.data.mfsRequests ?? []);
      setNotifications(res.data.notifications ?? []);
      setMfsSchemaPending(Boolean(res.data.schemaPending));
    }
  }, []);

  useEffect(() => {
    refreshPublicConfig();
  }, [refreshPublicConfig]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setIsLoading(false);
      return;
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthUser(data.session?.user ?? null);
      if (data.session) {
        refreshAccountData().finally(() => setIsLoading(false));
      } else {
        setIsLoading(false);
      }
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthUser(nextSession?.user ?? null);
      if (nextSession) {
        refreshAccountData();
      } else {
        clearAccountState();
      }
    });

    return () => subscription.subscription.unsubscribe();
  }, [refreshAccountData, clearAccountState]);

  const signIn = async (identifier: string, password: string) => {
    if (!isSupabaseConfigured || !supabase) {
      return {
        error:
          'Supabase অথেনটিকেশন এখনো কনফিগার করা হয়নি। অনুগ্রহ করে এনভায়রনমেন্ট ভ্যারিয়েবলে VITE_SUPABASE_URL এবং VITE_SUPABASE_ANON_KEY যুক্ত করুন।',
      };
    }

    const loginRes = await apiRequest<{
      session?: { access_token: string; refresh_token: string };
      role?: UserRole;
    }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: identifier.trim(), password }),
    });

    if (!loginRes.ok || !loginRes.data?.session) {
      return {
        error: loginRes.error || 'ইমেইল অথবা পাসওয়ার্ড সঠিক নয়।',
      };
    }

    const { data: sessionData, error: sessionErr } = await supabase.auth.setSession(
      loginRes.data.session
    );
    if (sessionErr) {
      return {
        error: translateSupabaseAuthError(
          sessionErr.message,
          (sessionErr as { code?: string }).code
        ),
      };
    }

    setSession(sessionData.session);
    setAuthUser(sessionData.session?.user ?? null);

    let resolvedRole: UserRole = loginRes.data.role || 'agent';
    const res = await apiRequest<AuthMePayload>('/api/auth/me');

    if (res.ok && res.data?.profile) {
      applyMePayload(res.data);
      resolvedRole = res.data.profile.role;
    } else if (!res.ok) {
      setProfileError(res.error || 'ডাটাবেজ থেকে প্রোফাইল পাওয়া যায়নি।');
    }

    return { role: resolvedRole };
  };

  const signUp = async (params: {
    email: string;
    password: string;
    fullName: string;
    phone: string;
    country: string;
    businessName?: string;
    referralCode?: string;
  }) => {
    if (!isSupabaseConfigured || !supabase) {
      return {
        error:
          'Supabase অথেনটিকেশন এখনো কনফিগার করা হয়নি। লাইভ রেজিস্ট্রেশন চালু করতে VITE_SUPABASE_URL এবং VITE_SUPABASE_ANON_KEY সেট করুন।',
      };
    }

    const res = await apiRequest<{
      user?: { id: string; email: string | null } | null;
      role?: UserRole;
      session?: { access_token: string; refresh_token: string } | null;
    }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: params.email,
        password: params.password,
        fullName: params.fullName,
        phone: params.phone,
        country: params.country,
        businessName: params.businessName || null,
        referralCode: params.referralCode || null,
      }),
    });

    if (!res.ok) {
      return {
        error: res.error || 'রেজিস্ট্রেশন সম্পন্ন করা যায়নি। অনুগ্রহ করে আবার চেষ্টা করুন।',
        errorCode: res.code,
      };
    }

    let resolvedRole: UserRole = res.data?.role || 'agent';

    if (!res.data?.session) {
      return {
        error: 'অ্যাকাউন্ট তৈরি হয়েছে, তবে তাৎক্ষণিক সেশন শুরু করা যায়নি। অনুগ্রহ করে লগইন পেজ থেকে লগইন করুন।',
        errorCode: 'LOGIN_REQUIRED',
      };
    }

    const { data: sessionData, error: sessionErr } = await supabase.auth.setSession(res.data.session);
    if (sessionErr) {
      return { error: translateSupabaseAuthError(sessionErr.message, (sessionErr as { code?: string }).code) };
    }

    setSession(sessionData.session);
    setAuthUser(sessionData.session?.user ?? null);

    const meRes = await apiRequest<AuthMePayload>('/api/auth/me');
    if (meRes.ok && meRes.data?.profile) {
      applyMePayload(meRes.data);
      resolvedRole = meRes.data.profile.role;
    }

    return { role: resolvedRole };
  };

  const resetPassword = async (email: string) => {
    if (!isSupabaseConfigured || !supabase) {
      return {
        error:
          'Supabase অথেনটিকেশন কনফিগার করা হয়নি। পাসওয়ার্ড রিসেট ইমেইল পাঠাতে VITE_SUPABASE_URL সেট করুন।',
      };
    }
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/login`,
    });
    if (error) {
      return { error: translateSupabaseAuthError(error.message, (error as { code?: string }).code) };
    }
    return {};
  };

  const signOut = async () => {
    if (supabase) {
      await supabase.auth.signOut();
    }
    setSession(null);
    setAuthUser(null);
    clearAccountState();
  };

  return (
    <AuthContext.Provider
      value={{
        isConfigured: isSupabaseConfigured,
        isLoading,
        session,
        authUser,
        profile,
        profileError,
        wallets,
        transactions,
        settlements,
        kycSubmissions,
        tickets,
        gateways,
        mfsRequests,
        notifications,
        mfsSchemaPending,
        referralCount,
        platformConfig,
        previewRole,
        setPreviewRole,
        signIn,
        signUp,
        resetPassword,
        signOut,
        refreshAccountData,
        refreshMfsRequests,
        refreshPublicConfig,
        markWithdrawPinConfigured,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
