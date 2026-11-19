import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowDownUp,
  ArrowUpFromLine,
  ArrowUpRight,
  Bell,
  Clock,
  FileSpreadsheet,
  Landmark,
  LayoutDashboard,
  Percent,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Users,
  Wallet,
} from 'lucide-react';
import { DashboardLayout, type DashboardNavItem } from '../../components/DashboardLayout.tsx';
import { StatMetricCard } from '../../components/StatMetricCard.tsx';
import { DataTable, type TableColumn } from '../../components/DataTable.tsx';
import { ModalDrawer } from '../../components/ModalDrawer.tsx';
import { WithdrawalRequestsPanel } from '../../components/admin/WithdrawalRequestsPanel.tsx';
import { DepositRequestsPanel } from '../../components/admin/DepositRequestsPanel.tsx';
import { MfsDispatchPanel, type AgentDirectoryRow } from '../../components/admin/MfsDispatchPanel.tsx';
import { useAuth } from '../../context/AuthContext.tsx';
import { apiRequest, formatCurrency, formatDateTime, formatTaka } from '../../lib/api.ts';
import {
  AUTHORITATIVE_COMMISSION_RATES,
  formatCommissionPercentBn,
  MAX_PROVIDER_COMMISSION_RATE,
} from '../../lib/commissions.ts';
import type {
  AuditLogEntry,
  CommissionRatesConfig,
  DepositMethodConfig,
  FeeMatrixConfig,
  GlobalNotificationItem,
  MfsPaymentRequest,
  PartnerItemConfig,
  PlatformConfigData,
  SettlementRequest,
  SocialLinkConfig,
  TransactionRecord,
  UserProfile,
  UserRole,
} from '../../types/zentopay.ts';

const NAV_ITEMS: DashboardNavItem[] = [
  { id: 'overview', label: 'ড্যাশবোর্ড', icon: LayoutDashboard, section: 'প্রধান' },
  { id: 'withdrawals', label: 'উইথড্র রিকোয়েস্ট', icon: ArrowUpRight, section: 'আর্থিক ও রিকোয়েস্ট' },
  { id: 'deposits', label: 'ডিপোজিট রিকোয়েস্ট', icon: ArrowDownLeft, section: 'আর্থিক ও রিকোয়েস্ট' },
  { id: 'bet_deposit', label: 'Bet Deposit', icon: ArrowDownToLine, section: 'আর্থিক ও রিকোয়েস্ট' },
  { id: 'bet_payout', label: 'Bet Payout', icon: ArrowUpFromLine, section: 'আর্থিক ও রিকোয়েস্ট' },
  { id: 'transactions', label: 'লেনদেন', icon: ArrowDownUp, section: 'আর্থিক ও রিকোয়েস্ট' },
  { id: 'users', label: 'ইউজার ও এজেন্ট', icon: Users, section: 'ব্যবস্থাপনা' },
  { id: 'payment_methods', label: 'পেমেন্ট মাধ্যম', icon: Wallet, section: 'ব্যবস্থাপনা' },
  { id: 'commissions', label: 'কমিশন', icon: Percent, section: 'ব্যবস্থাপনা' },
  { id: 'reports', label: 'রিপোর্ট', icon: FileSpreadsheet, section: 'ব্যবস্থাপনা' },
  { id: 'settings', label: 'সেটিংস', icon: Settings2, section: 'ব্যবস্থাপনা' },
];

const ROLE_BN: Record<string, string> = {
  user: 'এজেন্ট',
  agent: 'এজেন্ট',
  sub_agent: 'সাব-এজেন্ট',
  finance_admin: 'ফাইন্যান্স অ্যাডমিন',
  support_admin: 'সাপোর্ট অ্যাডমিন',
  super_admin: 'সুপার অ্যাডমিন',
};

const KYC_STATUS_BN: Record<string, string> = {
  unverified: 'অযাচাইকৃত',
  pending: 'পর্যালোচনাধীন',
  verified: 'যাচাইকৃত',
  rejected: 'প্রত্যাখ্যাত',
};

const TX_TYPE_BN: Record<string, string> = {
  deposit: 'ডিপোজিট',
  payment_collection: 'Bet Deposit',
  payment_payout: 'Bet Payout',
  bet_deposit: 'Bet Deposit (আর্কাইভ)',
  bet_payout: 'Bet Payout (আর্কাইভ)',
  affiliate_commission: 'অ্যাফিলিয়েট কমিশন',
  transfer: 'ট্রান্সফার',
  p2p_transfer: 'ট্রান্সফার',
  withdrawal: 'উইথড্র (হোল্ড)',
  cash_in: 'ক্যাশ-ইন',
  cash_out: 'ক্যাশ-আউট',
  gateway_payment: 'গেটওয়ে পেমেন্ট',
  commission: 'কমিশন',
  settlement: 'উইথড্র / সেটেলমেন্ট',
  adjustment: 'সমন্বয়',
};

const TX_STATUS_BN: Record<string, { label: string; cls: string }> = {
  pending: { label: 'অপেক্ষমাণ', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  completed: { label: 'সম্পন্ন', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  failed: { label: 'প্রত্যাখ্যাত', cls: 'bg-rose-50 text-rose-800 border-rose-200' },
  reversed: { label: 'ফেরতকৃত', cls: 'bg-slate-100 text-slate-700 border-slate-200' },
};

const DEFAULT_DEPOSIT_METHODS: DepositMethodConfig[] = [
  { id: 'bkash', name: 'bKash', accountNumber: '', accountLabel: 'bKash পার্সোনাল / এজেন্ট', enabled: true },
  { id: 'nagad', name: 'Nagad', accountNumber: '', accountLabel: 'Nagad পার্সোনাল / এজেন্ট', enabled: true },
  { id: 'rocket', name: 'Rocket', accountNumber: '', accountLabel: 'Rocket পার্সোনাল / এজেন্ট', enabled: true },
];

const DEFAULT_SOCIAL_NETWORKS: SocialLinkConfig[] = [
  { id: 'facebook', name: 'Facebook', url: '' },
  { id: 'youtube', name: 'YouTube', url: '' },
  { id: 'telegram', name: 'Telegram', url: '' },
];

export function SuperAdminDashboard() {
  const { profile, refreshAccountData, refreshPublicConfig } = useAuth();
  const [activeTab, setActiveTab] = useState('overview');
  const [loadingData, setLoadingData] = useState(false);
  const [roleModalOpen, setRoleModalOpen] = useState(false);

  const [profilesList, setProfilesList] = useState<UserProfile[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [settlements, setSettlements] = useState<SettlementRequest[]>([]);
  const [allDeposits, setAllDeposits] = useState<TransactionRecord[]>([]);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [mfsRequests, setMfsRequests] = useState<MfsPaymentRequest[]>([]);
  const [mfsAgents, setMfsAgents] = useState<AgentDirectoryRow[]>([]);
  const [mfsSchemaPending, setMfsSchemaPending] = useState(false);
  const [mfsLoadError, setMfsLoadError] = useState<string | null>(null);
  const [financeStats, setFinanceStats] = useState({
    totalCustodyBalance: 0,
    totalReservedBalance: 0,
    collectedFeeRevenue: 0,
    netLedgerDiscrepancy: 0,
    pendingWithdrawalsCount: 0,
    pendingDepositsCount: 0,
  });

  const [targetUserId, setTargetUserId] = useState('');
  const [assignedRole, setAssignedRole] = useState<UserRole>('agent');
  const [freezeAccount, setFreezeAccount] = useState(false);
  const [roleFeedback, setRoleFeedback] = useState('');
  const [roleSubmitting, setRoleSubmitting] = useState(false);

  const [p2pBps, setP2pBps] = useState('50');
  const [gatewayBps, setGatewayBps] = useState('150');
  const [agentSplitPct, setAgentSplitPct] = useState('65');
  const [configSaved, setConfigSaved] = useState('');
  const [configSaving, setConfigSaving] = useState(false);

  // Platform Config Editor State
  const [depositMethods, setDepositMethods] = useState<DepositMethodConfig[]>(DEFAULT_DEPOSIT_METHODS);
  const [commissionRates, setCommissionRates] = useState<CommissionRatesConfig>(AUTHORITATIVE_COMMISSION_RATES);
  const [supportLinks, setSupportLinks] = useState({
    telegram: '',
    whatsapp: '',
    affiliateManagerTelegram: '',
  });
  const [socialNetworks, setSocialNetworks] = useState<SocialLinkConfig[]>(DEFAULT_SOCIAL_NETWORKS);
  const [partners, setPartners] = useState<PartnerItemConfig[]>([]);
  const [globalNotifications, setGlobalNotifications] = useState<GlobalNotificationItem[]>([]);

  const [newPartnerName, setNewPartnerName] = useState('');
  const [newPartnerLogo, setNewPartnerLogo] = useState('');
  const [newPartnerDesc, setNewPartnerDesc] = useState('');
  const [newGlobalTitle, setNewGlobalTitle] = useState('');
  const [newGlobalMsg, setNewGlobalMsg] = useState('');
  const [platformSaveMsg, setPlatformSaveMsg] = useState('');
  const [platformSaveError, setPlatformSaveError] = useState(false);
  const [platformSaving, setPlatformSaving] = useState(false);
  const [configSchemaPending, setConfigSchemaPending] = useState(false);

  // Payment method add / update / delete state
  const [newMethodName, setNewMethodName] = useState('');
  const [newMethodId, setNewMethodId] = useState('');
  const [newMethodAccount, setNewMethodAccount] = useState('');
  const [newMethodLabel, setNewMethodLabel] = useState('');
  const [newMethodEnabled, setNewMethodEnabled] = useState(true);
  const [methodBusyId, setMethodBusyId] = useState<string | null>(null);
  const [methodActionMsg, setMethodActionMsg] = useState('');
  const [methodActionError, setMethodActionError] = useState(false);

  // Authoritative MFS Provider Commission Rates (percent inputs 0 - 25, defaults: bKash 5%, Nagad 4%, Rocket 4%)
  const [bkashRatePct, setBkashRatePct] = useState('5');
  const [nagadRatePct, setNagadRatePct] = useState('4');
  const [rocketRatePct, setRocketRatePct] = useState('4');
  const [rateSaving, setRateSaving] = useState(false);
  const [rateMsg, setRateMsg] = useState('');
  const [rateError, setRateError] = useState(false);

  // Targeted Personal Notification State
  const [notifUserIdent, setNotifUserIdent] = useState('');
  const [notifTitle, setNotifTitle] = useState('');
  const [notifMessage, setNotifMessage] = useState('');
  const [notifFeedback, setNotifFeedback] = useState('');
  const [notifSending, setNotifSending] = useState(false);

  const loadOverview = useCallback(async () => {
    if (!profile) return;
    setLoadingData(true);
    const [ovRes, cfgRes, finRes, mfsRes] = await Promise.all([
      apiRequest<{
        profiles: UserProfile[];
        auditLogs: AuditLogEntry[];
        feeMatrix: FeeMatrixConfig;
      }>('/api/admin/overview'),
      apiRequest<PlatformConfigData>('/api/admin/platform-config'),
      apiRequest<{
        settlements: SettlementRequest[];
        pendingDeposits: TransactionRecord[];
        deposits?: TransactionRecord[];
        transactions: TransactionRecord[];
        stats: {
          totalCustodyBalance: number;
          totalReservedBalance?: number;
          collectedFeeRevenue: number;
          netLedgerDiscrepancy: number;
          pendingWithdrawalsCount?: number;
          pendingDepositsCount?: number;
        };
      }>('/api/finance/overview'),
      apiRequest<{
        mfsRequests: MfsPaymentRequest[];
        agents: AgentDirectoryRow[];
        schemaPending?: boolean;
        mfsError?: string | null;
        rlsError?: string | null;
      }>('/api/admin/mfs-requests'),
    ]);
    setLoadingData(false);

    if (ovRes.ok && ovRes.data) {
      setProfilesList(ovRes.data.profiles ?? []);
      setAuditLogs(ovRes.data.auditLogs ?? []);
      if (ovRes.data.feeMatrix) {
        setP2pBps(String(ovRes.data.feeMatrix.p2pBps ?? 50));
        setGatewayBps(String(ovRes.data.feeMatrix.gatewayBps ?? 150));
        setAgentSplitPct(String(ovRes.data.feeMatrix.agentSplitPct ?? 65));
      }
    }

    if (cfgRes.ok && cfgRes.data) {
      const cfg = cfgRes.data;
      setConfigSchemaPending(Boolean(cfgRes.schemaPending));
      const incomingMethods = Array.isArray(cfg.depositMethods)
        ? cfg.depositMethods.filter((m) => !['binance', 'usdt'].includes(String(m.id).toLowerCase()))
        : DEFAULT_DEPOSIT_METHODS;
      setDepositMethods(incomingMethods);
      setSupportLinks({
        telegram: cfg.supportLinks?.telegram || '',
        whatsapp: cfg.supportLinks?.whatsapp || '',
        affiliateManagerTelegram: cfg.supportLinks?.affiliateManagerTelegram || '',
      });
      setSocialNetworks(
        DEFAULT_SOCIAL_NETWORKS.map((def) => {
          const found = (cfg.socialNetworks || []).find((s) => s.id === def.id);
          return found ? { ...def, ...found } : def;
        })
      );
      setPartners(cfg.partners ?? []);
      setGlobalNotifications(cfg.globalNotifications ?? []);
      const rates = cfg.commissionRates ?? AUTHORITATIVE_COMMISSION_RATES;
      setCommissionRates(rates);
      setBkashRatePct(String(Number((Number(rates.bkash) * 100).toFixed(2))));
      setNagadRatePct(String(Number((Number(rates.nagad) * 100).toFixed(2))));
      setRocketRatePct(String(Number((Number(rates.rocket) * 100).toFixed(2))));
    } else if (!cfgRes.ok) {
      setConfigSchemaPending(Boolean(cfgRes.schemaPending || cfgRes.code === 'SCHEMA_PENDING'));
    }

    if (finRes.ok && finRes.data) {
      setSettlements(finRes.data.settlements ?? []);
      setAllDeposits(finRes.data.deposits ?? finRes.data.pendingDeposits ?? []);
      setTransactions(finRes.data.transactions ?? []);
      if (finRes.data.stats) {
        setFinanceStats({
          totalCustodyBalance: Number(finRes.data.stats.totalCustodyBalance || 0),
          totalReservedBalance: Number(finRes.data.stats.totalReservedBalance || 0),
          collectedFeeRevenue: Number(finRes.data.stats.collectedFeeRevenue || 0),
          netLedgerDiscrepancy: Number(finRes.data.stats.netLedgerDiscrepancy || 0),
          pendingWithdrawalsCount:
            finRes.data.stats.pendingWithdrawalsCount ??
            (finRes.data.settlements ?? []).filter((s) => s.status === 'pending').length,
          pendingDepositsCount:
            finRes.data.stats.pendingDepositsCount ?? (finRes.data.pendingDeposits ?? []).length,
        });
      }
    }

    if (mfsRes.ok && mfsRes.data) {
      setMfsRequests(mfsRes.data.mfsRequests ?? []);
      setMfsAgents(mfsRes.data.agents ?? []);
      setMfsSchemaPending(Boolean(mfsRes.data.schemaPending));
      setMfsLoadError(mfsRes.data.mfsError || mfsRes.data.rlsError || null);
    } else if (!mfsRes.ok) {
      setMfsLoadError(mfsRes.error || 'Bet Deposit / Bet Payout তালিকা লোড করা যায়নি।');
    }
  }, [profile]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const handleFullRefresh = useCallback(async () => {
    await Promise.all([loadOverview(), refreshAccountData()]);
  }, [loadOverview, refreshAccountData]);

  const agentsDirectory = useMemo<AgentDirectoryRow[]>(() => {
    if (mfsAgents.length > 0) return mfsAgents;
    return profilesList
      .filter((p) => ['agent', 'sub_agent', 'user'].includes(p.role))
      .map((p) => ({
        id: p.id,
        full_name: p.full_name,
        email: p.email,
        phone: p.phone,
        agent_code: p.agent_code,
        role: p.role,
        active_plan: p.active_plan,
        kyc_status: p.kyc_status,
        is_frozen: p.is_frozen,
      }));
  }, [mfsAgents, profilesList]);

  const pendingWithdrawalsCount = useMemo(
    () => settlements.filter((s) => s.status === 'pending').length,
    [settlements]
  );

  const pendingDepositsCount = useMemo(
    () => allDeposits.filter((d) => d.status === 'pending').length,
    [allDeposits]
  );

  const openManageUserModal = (user?: UserProfile) => {
    setRoleFeedback('');
    if (user) {
      setTargetUserId(user.id);
      setAssignedRole(user.role);
      setFreezeAccount(Boolean(user.is_frozen));
    } else {
      setTargetUserId('');
      setAssignedRole('agent');
      setFreezeAccount(false);
    }
    setRoleModalOpen(true);
  };

  const handleRoleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setRoleFeedback('');
    if (!targetUserId.trim()) {
      setRoleFeedback('সঠিক Supabase ইউজার UUID প্রদান করুন।');
      return;
    }
    setRoleSubmitting(true);
    const res = await apiRequest(`/api/admin/users/${targetUserId.trim()}`, {
      method: 'PATCH',
      body: JSON.stringify({
        role: assignedRole,
        isFrozen: freezeAccount,
      }),
    });
    setRoleSubmitting(false);
    if (res.ok) {
      setRoleFeedback('রোল এবং ফ্রিজ অবস্থা সফলভাবে আপডেট ও অডিট লগে সংরক্ষণ করা হয়েছে।');
      await handleFullRefresh();
    } else {
      setRoleFeedback(res.error || 'আপডেট ব্যর্থ হয়েছে।');
    }
  };

  const handleFeeMatrixSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setConfigSaved('');
    setConfigSaving(true);
    const res = await apiRequest<FeeMatrixConfig>('/api/admin/fee-matrix', {
      method: 'POST',
      body: JSON.stringify({
        p2pBps: Number(p2pBps),
        gatewayBps: Number(gatewayBps),
        agentSplitPct: Number(agentSplitPct),
      }),
    });
    setConfigSaving(false);
    if (res.ok && res.data) {
      setConfigSaved(
        `ফি ম্যাট্রিক্স স্থায়ীভাবে সংরক্ষিত হয়েছে (${res.data.p2pBps} bps P2P · ${res.data.gatewayBps} bps গেটওয়ে · ${res.data.agentSplitPct}% এজেন্ট অংশ)।`
      );
      await loadOverview();
    } else {
      setConfigSaved(res.error || 'ফি ম্যাট্রিক্স সংরক্ষণ ব্যর্থ হয়েছে।');
    }
  };

  const handleSaveCommissionRates = async () => {
    setRateMsg('');
    setRateError(false);

    const parsed = {
      bkash: Number(bkashRatePct),
      nagad: Number(nagadRatePct),
      rocket: Number(rocketRatePct),
    };
    const maxPct = MAX_PROVIDER_COMMISSION_RATE * 100;

    for (const [key, pct] of Object.entries(parsed)) {
      if (!Number.isFinite(pct) || pct < 0 || pct > maxPct) {
        setRateError(true);
        setRateMsg(`${key.toUpperCase()} কমিশন হার অবশ্যই ০% থেকে ${maxPct}%-এর মধ্যে হতে হবে।`);
        return;
      }
    }

    setRateSaving(true);
    const res = await apiRequest<PlatformConfigData>('/api/admin/commission-rates', {
      method: 'PUT',
      body: JSON.stringify({
        bkash: Number((parsed.bkash / 100).toFixed(4)),
        nagad: Number((parsed.nagad / 100).toFixed(4)),
        rocket: Number((parsed.rocket / 100).toFixed(4)),
      }),
    });
    setRateSaving(false);

    if (res.ok && res.data) {
      setConfigSchemaPending(false);
      setRateError(false);
      const saved = res.data.commissionRates;
      setCommissionRates(saved);
      setRateMsg(
        `কমিশন রেট সংরক্ষিত হয়েছে — bKash: ${formatCommissionPercentBn(saved.bkash)}, Nagad: ${formatCommissionPercentBn(saved.nagad)}, Rocket: ${formatCommissionPercentBn(saved.rocket)} (ভবিষ্যতের নতুন লেনদেনে প্রযোজ্য)।`
      );
      await Promise.all([loadOverview(), refreshPublicConfig()]);
    } else {
      if (res.schemaPending || res.code === 'SCHEMA_PENDING') {
        setConfigSchemaPending(true);
      }
      setRateError(true);
      setRateMsg(res.error || 'কমিশন রেট সংরক্ষণ করা যায়নি।');
    }
  };

  const handlePlatformConfigSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setPlatformSaveMsg('');
    setPlatformSaveError(false);
    const bkashDecimal = Number((Number(bkashRatePct) / 100).toFixed(4));
    const nagadDecimal = Number((Number(nagadRatePct) / 100).toFixed(4));
    const rocketDecimal = Number((Number(rocketRatePct) / 100).toFixed(4));
    if (
      !Number.isFinite(bkashDecimal) ||
      bkashDecimal < 0 ||
      bkashDecimal > MAX_PROVIDER_COMMISSION_RATE ||
      !Number.isFinite(nagadDecimal) ||
      nagadDecimal < 0 ||
      nagadDecimal > MAX_PROVIDER_COMMISSION_RATE ||
      !Number.isFinite(rocketDecimal) ||
      rocketDecimal < 0 ||
      rocketDecimal > MAX_PROVIDER_COMMISSION_RATE
    ) {
      setPlatformSaveError(true);
      setPlatformSaveMsg('প্রোভাইডার কমিশন হার ০% থেকে ২৫%-এর মধ্যে হতে হবে।');
      return;
    }

    setPlatformSaving(true);
    const res = await apiRequest<PlatformConfigData>('/api/admin/platform-config', {
      method: 'PUT',
      body: JSON.stringify({
        depositMethods,
        commissionRates: {
          bkash: bkashDecimal,
          nagad: nagadDecimal,
          rocket: rocketDecimal,
        },
        supportLinks,
        socialNetworks,
        partners,
        globalNotifications,
      }),
    });
    setPlatformSaving(false);
    if (res.ok) {
      setConfigSchemaPending(false);
      setPlatformSaveError(false);
      setPlatformSaveMsg('প্ল্যাটফর্ম কনফিগারেশন সফলভাবে সংরক্ষিত হয়েছে এবং এজেন্ট পোর্টালে প্রয়োগ করা হয়েছে।');
      await Promise.all([loadOverview(), refreshPublicConfig()]);
    } else {
      if (res.schemaPending || res.code === 'SCHEMA_PENDING') {
        setConfigSchemaPending(true);
      }
      setPlatformSaveError(true);
      setPlatformSaveMsg(res.error || 'কনফিগারেশন সংরক্ষণ ব্যর্থ হয়েছে।');
    }
  };

  const handleAddPaymentMethod = async () => {
    setMethodActionMsg('');
    setMethodActionError(false);
    const cleanName = newMethodName.trim();
    const derivedId = (newMethodId.trim() || cleanName)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '');

    if (!cleanName || !derivedId) {
      setMethodActionError(true);
      setMethodActionMsg('অনুগ্রহ করে বৈধ BDT পেমেন্ট মাধ্যমের নাম ও ইংরেজি আইডি (যেমন: upay) লিখুন।');
      return;
    }

    setMethodBusyId('__add__');
    const res = await apiRequest<PlatformConfigData>('/api/admin/payment-methods', {
      method: 'POST',
      body: JSON.stringify({
        id: derivedId,
        name: cleanName,
        accountNumber: newMethodAccount.trim(),
        accountLabel: newMethodLabel.trim(),
        enabled: newMethodEnabled,
      }),
    });
    setMethodBusyId(null);

    if (res.ok && res.data) {
      setConfigSchemaPending(false);
      setDepositMethods(res.data.depositMethods ?? []);
      setNewMethodId('');
      setNewMethodName('');
      setNewMethodAccount('');
      setNewMethodLabel('');
      setNewMethodEnabled(true);
      setMethodActionError(false);
      setMethodActionMsg(`নতুন BDT পেমেন্ট মাধ্যম "${cleanName}" স্থায়ীভাবে সংরক্ষিত হয়েছে।`);
      await refreshPublicConfig();
    } else {
      if (res.schemaPending || res.code === 'SCHEMA_PENDING') {
        setConfigSchemaPending(true);
      }
      setMethodActionError(true);
      setMethodActionMsg(res.error || 'পেমেন্ট মাধ্যম যোগ করা যায়নি।');
    }
  };

  const handleSaveSinglePaymentMethod = async (method: DepositMethodConfig) => {
    setMethodActionMsg('');
    setMethodActionError(false);
    setMethodBusyId(method.id);
    const res = await apiRequest<PlatformConfigData>(
      `/api/admin/payment-methods/${encodeURIComponent(method.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          name: method.name,
          accountNumber: method.accountNumber,
          accountLabel: method.accountLabel || '',
          enabled: method.enabled,
        }),
      }
    );
    setMethodBusyId(null);

    if (res.ok && res.data) {
      setConfigSchemaPending(false);
      setDepositMethods(res.data.depositMethods ?? []);
      setMethodActionError(false);
      setMethodActionMsg(`"${method.name}" আপডেট ও সংরক্ষিত হয়েছে।`);
      await refreshPublicConfig();
    } else {
      if (res.schemaPending || res.code === 'SCHEMA_PENDING') {
        setConfigSchemaPending(true);
      }
      setMethodActionError(true);
      setMethodActionMsg(res.error || 'পেমেন্ট মাধ্যম আপডেট ব্যর্থ হয়েছে।');
    }
  };

  const handleDeletePaymentMethod = async (method: DepositMethodConfig) => {
    setMethodActionMsg('');
    setMethodActionError(false);
    setMethodBusyId(method.id);
    const res = await apiRequest<PlatformConfigData>(
      `/api/admin/payment-methods/${encodeURIComponent(method.id)}`,
      { method: 'DELETE' }
    );
    setMethodBusyId(null);

    if (res.ok && res.data) {
      setConfigSchemaPending(false);
      setDepositMethods(res.data.depositMethods ?? []);
      setMethodActionError(false);
      setMethodActionMsg(`পেমেন্ট মাধ্যম "${method.name}" মুছে ফেলা হয়েছে।`);
      await refreshPublicConfig();
    } else {
      if (res.schemaPending || res.code === 'SCHEMA_PENDING') {
        setConfigSchemaPending(true);
      }
      setMethodActionError(true);
      setMethodActionMsg(res.error || 'পেমেন্ট মাধ্যম মুছে ফেলা যায়নি।');
    }
  };

  const handleAddPartner = () => {
    if (!newPartnerName.trim()) return;
    setPartners((prev) => [
      ...prev,
      {
        id: `prt-${Date.now()}`,
        name: newPartnerName.trim(),
        logoUrl: newPartnerLogo.trim() || undefined,
        description: newPartnerDesc.trim() || undefined,
      },
    ]);
    setNewPartnerName('');
    setNewPartnerLogo('');
    setNewPartnerDesc('');
  };

  const handleAddGlobalNotification = () => {
    if (!newGlobalTitle.trim() || !newGlobalMsg.trim()) return;
    setGlobalNotifications((prev) => [
      {
        id: `gl-${Date.now()}`,
        title: newGlobalTitle.trim(),
        message: newGlobalMsg.trim(),
        createdAt: new Date().toISOString(),
      },
      ...prev,
    ]);
    setNewGlobalTitle('');
    setNewGlobalMsg('');
  };

  const handleSendPersonalNotif = async (e: React.FormEvent) => {
    e.preventDefault();
    setNotifFeedback('');
    if (!notifUserIdent.trim() || !notifTitle.trim() || !notifMessage.trim()) {
      setNotifFeedback('টার্গেট ইউজার, শিরোনাম এবং বার্তা পূরণ করুন।');
      return;
    }
    setNotifSending(true);
    const res = await apiRequest('/api/admin/notifications', {
      method: 'POST',
      body: JSON.stringify({
        userIdentifier: notifUserIdent.trim(),
        title: notifTitle.trim(),
        message: notifMessage.trim(),
      }),
    });
    setNotifSending(false);
    if (res.ok) {
      setNotifFeedback('ব্যক্তিগত নোটিফিকেশন সফলভাবে পাঠানো হয়েছে।');
      setNotifTitle('');
      setNotifMessage('');
    } else {
      setNotifFeedback(res.error || 'নোটিফিকেশন পাঠানো যায়নি।');
    }
  };

  const userColumns: TableColumn<UserProfile>[] = [
    {
      key: 'name',
      header: 'অ্যাকাউন্টধারী ও Agent ID',
      render: (r) => (
        <div>
          <p className="font-medium text-slate-900">
            {r.full_name}{' '}
            {r.agent_code && (
              <span className="ml-1 px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-mono text-[10px]">
                #{r.agent_code}
              </span>
            )}
          </p>
          <p className="text-xs text-slate-500">{r.email}</p>
          <p className="text-[11px] font-mono text-slate-400">{r.id}</p>
        </div>
      ),
      csvValue: (r) => `${r.full_name} (${r.agent_code || ''}) ${r.email}`,
    },
    {
      key: 'role',
      header: 'রোল ও প্ল্যান',
      render: (r) => (
        <div>
          <span className="text-xs font-semibold text-slate-800 block">{ROLE_BN[r.role] || r.role}</span>
          <span className="text-[11px] text-slate-500">
            {r.active_plan === 'premium' ? 'Premium Plan' : r.active_plan === 'trial' ? 'Trial Plan' : 'ফ্রি'}
          </span>
        </div>
      ),
      csvValue: (r) => `${r.role} (${r.active_plan || 'none'})`,
    },
    {
      key: 'kyc',
      header: 'KYC ও অবস্থা',
      render: (r) => (
        <div className="space-y-0.5">
          <p className="text-xs font-medium text-slate-800">{KYC_STATUS_BN[r.kyc_status] || r.kyc_status}</p>
          <p className={`text-[11px] font-medium ${r.is_frozen ? 'text-rose-600' : 'text-emerald-600'}`}>
            {r.is_frozen ? 'ফ্রিজকৃত' : 'সক্রিয়'}
          </p>
        </div>
      ),
      csvValue: (r) => `${r.kyc_status} (${r.is_frozen ? 'frozen' : 'active'})`,
    },
    {
      key: 'created',
      header: 'তৈরির তারিখ',
      align: 'right',
      render: (r) => <span className="text-xs text-slate-500 tabular-nums">{formatDateTime(r.created_at)}</span>,
      csvValue: (r) => r.created_at,
    },
    {
      key: 'manage',
      header: 'কার্যক্রম',
      align: 'right',
      render: (r) => (
        <button
          type="button"
          onClick={() => openManageUserModal(r)}
          className="px-2.5 py-1 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-md cursor-pointer"
        >
          পরিচালনা
        </button>
      ),
      csvValue: (r) => r.id,
    },
  ];

  const txColumns: TableColumn<TransactionRecord>[] = [
    {
      key: 'ref',
      header: 'রেফারেন্স ও সময়',
      render: (r) => (
        <div>
          <p className="font-mono text-xs font-bold text-slate-900">{r.reference_code}</p>
          <p className="text-[11px] text-slate-500 tabular-nums">{formatDateTime(r.created_at)}</p>
        </div>
      ),
      csvValue: (r) => `${r.reference_code} (${r.created_at})`,
    },
    {
      key: 'agent',
      header: 'এজেন্ট',
      render: (r) => (
        <div>
          <p className="text-xs font-semibold text-slate-900">
            {r.initiator_name || 'Agent'}{' '}
            {r.initiator_agent_code && (
              <span className="ml-1 px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-mono text-[10px]">
                #{r.initiator_agent_code}
              </span>
            )}
          </p>
          <p className="text-[11px] text-slate-500">{r.initiator_email || r.initiator_user_id.slice(0, 8)}</p>
        </div>
      ),
      csvValue: (r) => `${r.initiator_name || ''} ${r.initiator_agent_code || ''} ${r.initiator_email || ''}`,
    },
    {
      key: 'type',
      header: 'ধরন ও বিবরণ',
      render: (r) => (
        <div>
          <p className="text-xs font-semibold text-slate-800">{TX_TYPE_BN[r.tx_type] || r.tx_type}</p>
          {r.description && <p className="text-[11px] text-slate-500 max-w-[240px] truncate">{r.description}</p>}
        </div>
      ),
      csvValue: (r) => `${r.tx_type} ${r.description || ''}`,
    },
    {
      key: 'amount',
      header: 'পরিমাণ ও ফি',
      align: 'right',
      render: (r) => (
        <div>
          <p className="font-mono text-xs font-bold text-slate-900 tabular-nums">
            {formatCurrency(Number(r.amount), r.currency || 'BDT')}
          </p>
          {Number(r.fee_amount || 0) > 0 && (
            <p className="font-mono text-[11px] text-slate-500 tabular-nums">
              ফি: {formatCurrency(Number(r.fee_amount), r.currency || 'BDT')}
            </p>
          )}
        </div>
      ),
      csvValue: (r) => r.amount,
    },
    {
      key: 'status',
      header: 'অবস্থা',
      render: (r) => {
        const badge = TX_STATUS_BN[r.status] || {
          label: r.status,
          cls: 'bg-slate-100 text-slate-700 border-slate-200',
        };
        return (
          <span className={`inline-block px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${badge.cls}`}>
            {badge.label}
          </span>
        );
      },
      csvValue: (r) => r.status,
    },
  ];

  const auditColumns: TableColumn<AuditLogEntry>[] = [
    {
      key: 'action',
      header: 'কার্যক্রম',
      render: (r) => <span className="font-mono text-xs text-slate-900">{r.action}</span>,
      csvValue: (r) => r.action,
    },
    {
      key: 'actor',
      header: 'পরিচালনাকারী রোল',
      render: (r) => <span className="text-xs">{ROLE_BN[r.actor_role] || r.actor_role}</span>,
      csvValue: (r) => r.actor_role,
    },
    {
      key: 'target',
      header: 'টার্গেট টেবিল',
      render: (r) => <span className="font-mono text-xs text-slate-600">{r.target_table}</span>,
      csvValue: (r) => r.target_table,
    },
    {
      key: 'time',
      header: 'সময়',
      align: 'right',
      render: (r) => <span className="text-xs text-slate-500 tabular-nums">{formatDateTime(r.created_at)}</span>,
      csvValue: (r) => r.created_at,
    },
  ];

  return (
    <DashboardLayout
      role="super_admin"
      navItems={NAV_ITEMS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      primaryAction={{
        label: 'উইথড্র রিকোয়েস্ট দেখুন',
        onClick: () => setActiveTab('withdrawals'),
      }}
    >
      {/* Top KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatMetricCard
          label="নিবন্ধিত ইউজার ও এজেন্ট"
          value={`${profilesList.length} জন`}
          helper="৬টি রোল স্তর RLS দ্বারা সুরক্ষিত"
          icon={ShieldCheck}
          tone="emerald"
        />
        <button
          type="button"
          onClick={() => setActiveTab('withdrawals')}
          className="text-left cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
        >
          <StatMetricCard
            label="অপেক্ষমাণ উইথড্র"
            value={`${pendingWithdrawalsCount}টি`}
            helper={`সংরক্ষিত ব্যালেন্স: ${formatTaka(financeStats.totalReservedBalance)} · ক্লিক করে দেখুন`}
            icon={Clock}
            tone="amber"
          />
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('deposits')}
          className="text-left cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
        >
          <StatMetricCard
            label="অপেক্ষমাণ ডিপোজিট"
            value={`${pendingDepositsCount}টি`}
            helper="এজেন্ট অ্যাড-ফান্ড যাচাই কিউ"
            icon={ArrowDownLeft}
            tone="amber"
          />
        </button>
        <StatMetricCard
          label="মোট কাস্টডি ব্যালেন্স"
          value={formatTaka(financeStats.totalCustodyBalance)}
          helper={`সক্রিয় পেমেন্ট মাধ্যম: ${depositMethods.filter((m) => m.enabled && m.accountNumber).length}টি`}
          icon={Landmark}
          tone="emerald"
        />
      </div>

      {/* 1. DASHBOARD OVERVIEW */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-bold text-slate-950">দ্রুত পরিচালনা কেন্দ্র</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  এক ক্লিকে উইথড্র রিকোয়েস্ট অনুমোদন, ডিপোজিট যাচাই, Bet Deposit / Bet Payout পাঠানো বা ইউজার পরিচালনা করুন।
                </p>
              </div>
              <button
                type="button"
                disabled={loadingData}
                onClick={() => void handleFullRefresh()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg cursor-pointer self-start disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingData ? 'animate-spin' : ''}`} />
                সকল ডাটা রিফ্রেশ
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <button
                type="button"
                onClick={() => setActiveTab('withdrawals')}
                className="p-4 rounded-xl border border-amber-200 bg-amber-50/70 hover:bg-amber-50 text-left cursor-pointer transition-colors"
              >
                <p className="text-xs font-bold text-amber-950">উইথড্র রিকোয়েস্ট ({pendingWithdrawalsCount}টি পেন্ডিং)</p>
                <p className="text-[11px] text-amber-800 mt-1">অনুমোদন বা প্রত্যাখ্যান করুন</p>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('deposits')}
                className="p-4 rounded-xl border border-emerald-200 bg-emerald-50/70 hover:bg-emerald-50 text-left cursor-pointer transition-colors"
              >
                <p className="text-xs font-bold text-emerald-950">ডিপোজিট রিকোয়েস্ট ({pendingDepositsCount}টি পেন্ডিং)</p>
                <p className="text-[11px] text-emerald-800 mt-1">TrxID যাচাই করে ব্যালেন্স ক্রেডিট দিন</p>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('bet_deposit')}
                className="p-4 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-left cursor-pointer transition-colors"
              >
                <p className="text-xs font-bold text-slate-900">Bet Deposit পাঠান</p>
                <p className="text-[11px] text-slate-600 mt-1">এজেন্ট নম্বরে কালেকশন রিকোয়েস্ট পাঠান</p>
              </button>
              <button
                type="button"
                onClick={() => openManageUserModal()}
                className="p-4 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-left cursor-pointer transition-colors"
              >
                <p className="text-xs font-bold text-slate-900">ইউজার ও রোল পরিচালনা</p>
                <p className="text-[11px] text-slate-600 mt-1">রোল নির্ধারণ বা অ্যাকাউন্ট ফ্রিজ করুন</p>
              </button>
            </div>
          </div>

          <WithdrawalRequestsPanel
            settlements={settlements}
            onRefresh={handleFullRefresh}
            loading={loadingData}
          />
        </div>
      )}

      {/* 2. WITHDRAWAL REQUESTS */}
      {activeTab === 'withdrawals' && (
        <WithdrawalRequestsPanel
          settlements={settlements}
          onRefresh={handleFullRefresh}
          loading={loadingData}
        />
      )}

      {/* 3. DEPOSIT REQUESTS */}
      {activeTab === 'deposits' && (
        <DepositRequestsPanel
          deposits={allDeposits}
          onRefresh={handleFullRefresh}
          loading={loadingData}
        />
      )}

      {/* 4. BET DEPOSIT */}
      {activeTab === 'bet_deposit' && (
        <MfsDispatchPanel
          mode="collection"
          mfsRequests={mfsRequests}
          agentsList={agentsDirectory}
          commissionRates={commissionRates}
          schemaPending={mfsSchemaPending}
          loadError={mfsLoadError}
          onRefresh={handleFullRefresh}
        />
      )}

      {/* 5. BET PAYOUT */}
      {activeTab === 'bet_payout' && (
        <MfsDispatchPanel
          mode="payout"
          mfsRequests={mfsRequests}
          agentsList={agentsDirectory}
          commissionRates={commissionRates}
          schemaPending={mfsSchemaPending}
          loadError={mfsLoadError}
          onRefresh={handleFullRefresh}
        />
      )}

      {/* 6. ALL TRANSACTIONS */}
      {activeTab === 'transactions' && (
        <DataTable
          title="সকল লেনদেনের ইতিহাস"
          subtitle="ডিপোজিট, উইথড্র, Bet Deposit, Bet Payout, ট্রান্সফার ও কমিশনের সম্পূর্ণ রেকর্ড"
          rows={transactions}
          columns={txColumns}
          searchPlaceholder="রেফারেন্স, এজেন্ট নাম, #67XXXXXX বা বিবরণ..."
          getSearchText={(r) =>
            `${r.reference_code} ${r.initiator_name || ''} ${r.initiator_agent_code || ''} ${r.initiator_email || ''} ${r.tx_type} ${r.description || ''}`
          }
          filterOptions={[
            { value: 'all', label: 'সকল' },
            { value: 'deposit', label: 'ডিপোজিট' },
            { value: 'settlement', label: 'উইথড্র / সেটেলমেন্ট' },
            { value: 'withdrawal', label: 'উইথড্র (হোল্ড)' },
            { value: 'payment_collection', label: 'Bet Deposit' },
            { value: 'payment_payout', label: 'Bet Payout' },
            { value: 'commission', label: 'কমিশন' },
          ]}
          getFilterValue={(r) => r.tx_type}
          enableDateFilter
          getDateValue={(r) => r.created_at}
          toolbarExtra={
            <button
              type="button"
              disabled={loadingData}
              onClick={() => void handleFullRefresh()}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingData ? 'animate-spin' : ''}`} />
              রিফ্রেশ
            </button>
          }
          emptyTitle="কোনো লেনদেন পাওয়া যায়নি"
          emptyDescription="এজেন্ট বা অ্যাডমিন কার্যক্রম সম্পন্ন হলে এখানে লেনদেনের তালিকা দেখা যাবে।"
          exportFilename="zentopay-transactions.csv"
        />
      )}

      {/* 7. USERS & AGENTS */}
      {activeTab === 'users' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-bold text-slate-950">ইউজার ও এজেন্ট ব্যবস্থাপনা</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                এজেন্ট আইডি (#67XXXXXX), রোল নির্ধারণ, প্ল্যান এবং অ্যাকাউন্ট ফ্রিজ/আনফ্রিজ পরিচালনা করুন।
              </p>
            </div>
            <button
              type="button"
              onClick={() => openManageUserModal()}
              className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer self-start"
            >
              রোল নির্ধারণ / ফ্রিজ করুন
            </button>
          </div>

          <DataTable
            title="ইউজার ও এজেন্ট ডিরেক্টরি"
            subtitle="তালিকার যেকোনো ইউজার খুঁজুন এবং পরিচালনা বাটনে ক্লিক করে রোল বা ফ্রিজ অবস্থা পরিবর্তন করুন"
            rows={profilesList}
            columns={userColumns}
            getSearchText={(r) => `${r.full_name} ${r.email} ${r.agent_code || ''} ${r.role} ${r.id}`}
            filterOptions={[
              { value: 'all', label: 'সকল' },
              { value: 'agent', label: 'এজেন্ট' },
              { value: 'sub_agent', label: 'সাব-এজেন্ট' },
              { value: 'user', label: 'এজেন্ট (User)' },
              { value: 'finance_admin', label: 'ফাইন্যান্স অ্যাডমিন' },
              { value: 'support_admin', label: 'সাপোর্ট অ্যাডমিন' },
              { value: 'super_admin', label: 'সুপার অ্যাডমিন' },
            ]}
            getFilterValue={(r) => r.role}
            emptyTitle="কোনো ইউজার তালিকা লোড হয়নি"
            emptyDescription="প্ল্যাটফর্মের public.profiles দেখতে সুপার অ্যাডমিন হিসেবে লগইন করুন।"
            emptyActionLabel="UUID দিয়ে রোল আপডেট করুন"
            onEmptyAction={() => openManageUserModal()}
            exportFilename="zentopay-users.csv"
          />
        </div>
      )}

      {/* 8. PAYMENT METHODS */}
      {activeTab === 'payment_methods' && (
        <div className="space-y-6">
          {configSchemaPending && (
            <div className="bg-amber-50 border border-amber-300 rounded-xl px-4 py-3 text-xs text-amber-950 space-y-1">
              <p className="font-bold">
                Supabase ডাটাবেজে <span className="font-mono">public.platform_config</span> টেবিল এখনো পাওয়া যায়নি।
              </p>
              <p>
                পেমেন্ট মাধ্যম যোগ, সম্পাদনা বা সংরক্ষণ করতে অনুগ্রহ করে{' '}
                <span className="font-mono font-semibold">supabase/migrations/002b_agent_bdt_config_fix.sql</span>{' '}
                মাইগ্রেশন প্রয়োগ করুন।
              </p>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <h2 className="font-display text-lg font-bold text-slate-950">
                  ডিপোজিট পেমেন্ট মাধ্যম (bKash, Nagad, Rocket ও কাস্টম মাধ্যম)
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  এজেন্টরা Add Balance-এ যে নম্বরগুলোতে টাকা পাঠাবেন তা এখানে যোগ, সম্পাদনা বা নিষ্ক্রিয় করুন।
                </p>
              </div>
              <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 self-start">
                মোট {depositMethods.length}টি মাধ্যম
              </span>
            </div>

            {methodActionMsg && (
              <p
                className={`text-xs rounded-lg px-3.5 py-2.5 border ${
                  methodActionError
                    ? 'text-rose-800 bg-rose-50 border-rose-200'
                    : 'text-emerald-800 bg-emerald-50 border-emerald-200'
                }`}
              >
                {methodActionMsg}
              </p>
            )}

            {depositMethods.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-xs text-slate-500">
                কোনো ডিপোজিট পেমেন্ট মাধ্যম নেই। নিচের ফর্ম থেকে নতুন BDT পেমেন্ট মাধ্যম যোগ করুন।
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {depositMethods.map((method, idx) => (
                  <div
                    key={method.id}
                    className="border border-slate-200 rounded-xl p-4 bg-slate-50/70 space-y-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <span className="font-bold text-sm text-slate-900">{method.name}</span>
                        <span className="ml-2 text-[10px] font-mono text-slate-400">({method.id})</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={method.enabled}
                            onChange={(e) =>
                              setDepositMethods((prev) =>
                                prev.map((item, i) => (i === idx ? { ...item, enabled: e.target.checked } : item))
                              )
                            }
                            className="accent-emerald-600"
                          />
                          সক্রিয়
                        </label>
                        <button
                          type="button"
                          disabled={methodBusyId === method.id}
                          onClick={() => handleDeletePaymentMethod(method)}
                          title="পেমেন্ট মাধ্যম মুছুন"
                          aria-label={`${method.name} মুছুন`}
                          className="p-1 text-rose-600 hover:bg-rose-50 rounded cursor-pointer disabled:opacity-50"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">মাধ্যমের নাম</label>
                      <input
                        type="text"
                        value={method.name}
                        onChange={(e) =>
                          setDepositMethods((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, name: e.target.value } : item))
                          )
                        }
                        className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        গ্রহণকারী নম্বর / অ্যাকাউন্ট আইডি
                      </label>
                      <input
                        type="text"
                        value={method.accountNumber}
                        onChange={(e) =>
                          setDepositMethods((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, accountNumber: e.target.value } : item))
                          )
                        }
                        placeholder="যেমন: 017XXXXXXXX"
                        className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg"
                      />
                    </div>
                    <div className="flex items-end gap-2">
                      <div className="flex-1">
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                          অ্যাকাউন্ট লেবেল
                        </label>
                        <input
                          type="text"
                          value={method.accountLabel || ''}
                          onChange={(e) =>
                            setDepositMethods((prev) =>
                              prev.map((item, i) => (i === idx ? { ...item, accountLabel: e.target.value } : item))
                            )
                          }
                          className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg"
                        />
                      </div>
                      <button
                        type="button"
                        disabled={methodBusyId === method.id}
                        onClick={() => handleSaveSinglePaymentMethod(method)}
                        className="px-3 py-2 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg cursor-pointer whitespace-nowrap disabled:opacity-50"
                      >
                        {methodBusyId === method.id ? 'সংরক্ষণ...' : 'সংরক্ষণ'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Add New Custom BDT Payment Method */}
            <div className="border-t border-slate-200 pt-4 space-y-3">
              <h3 className="text-xs font-extrabold text-slate-800">নতুন BDT পেমেন্ট মাধ্যম যোগ করুন</h3>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
                <input
                  type="text"
                  value={newMethodName}
                  onChange={(e) => setNewMethodName(e.target.value)}
                  placeholder="নাম (যেমন: Upay)"
                  className="px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
                />
                <input
                  type="text"
                  value={newMethodId}
                  onChange={(e) => setNewMethodId(e.target.value)}
                  placeholder="স্লাগ আইডি (যেমন: upay)"
                  className="px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg bg-white"
                />
                <input
                  type="text"
                  value={newMethodAccount}
                  onChange={(e) => setNewMethodAccount(e.target.value)}
                  placeholder="গ্রহণকারী নম্বর (01XXXXXXXXX)"
                  className="px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg bg-white"
                />
                <input
                  type="text"
                  value={newMethodLabel}
                  onChange={(e) => setNewMethodLabel(e.target.value)}
                  placeholder="লেবেল (যেমন: Upay এজেন্ট)"
                  className="px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newMethodEnabled}
                    onChange={(e) => setNewMethodEnabled(e.target.checked)}
                    className="accent-emerald-600"
                  />
                  যোগ করার সাথে সাথে সক্রিয় রাখুন
                </label>
                <button
                  type="button"
                  disabled={methodBusyId === '__add__'}
                  onClick={handleAddPaymentMethod}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer disabled:opacity-50"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {methodBusyId === '__add__' ? 'যোগ হচ্ছে...' : 'পেমেন্ট মাধ্যম যোগ করুন'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 9. COMMISSIONS & FEE MATRIX */}
      {activeTab === 'commissions' && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <h2 className="font-display text-lg font-bold text-slate-950">
                  MFS প্রোভাইডার কমিশন রেট (Single Source of Truth)
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  প্রতিটি প্রোভাইডারের এজেন্ট কমিশন হার নির্ধারণ করুন (ডিফল্ট: bKash ৫%, Nagad ৪%, Rocket ৪%)। পরিবর্তন শুধুমাত্র ভবিষ্যতের নতুন লেনদেনে প্রযোজ্য হবে।
                </p>
              </div>
              <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 self-start">
                ০% – ২৫% সীমা
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/70 space-y-1.5">
                <label htmlFor="rate-bkash" className="block text-xs font-bold text-slate-800">
                  bKash কমিশন হার (%)
                </label>
                <input
                  id="rate-bkash"
                  type="number"
                  step="0.1"
                  min="0"
                  max="25"
                  value={bkashRatePct}
                  onChange={(e) => setBkashRatePct(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-200 rounded-lg"
                />
                <p className="text-[11px] text-slate-500">অনুমোদিত ডিফল্ট: ৫%</p>
              </div>

              <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/70 space-y-1.5">
                <label htmlFor="rate-nagad" className="block text-xs font-bold text-slate-800">
                  Nagad কমিশন হার (%)
                </label>
                <input
                  id="rate-nagad"
                  type="number"
                  step="0.1"
                  min="0"
                  max="25"
                  value={nagadRatePct}
                  onChange={(e) => setNagadRatePct(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-200 rounded-lg"
                />
                <p className="text-[11px] text-slate-500">অনুমোদিত ডিফল্ট: ৪%</p>
              </div>

              <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/70 space-y-1.5">
                <label htmlFor="rate-rocket" className="block text-xs font-bold text-slate-800">
                  Rocket কমিশন হার (%)
                </label>
                <input
                  id="rate-rocket"
                  type="number"
                  step="0.1"
                  min="0"
                  max="25"
                  value={rocketRatePct}
                  onChange={(e) => setRocketRatePct(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-200 rounded-lg"
                />
                <p className="text-[11px] text-slate-500">অনুমোদিত ডিফল্ট: ৪%</p>
              </div>
            </div>

            {rateMsg && (
              <p
                className={`text-xs rounded-lg px-3.5 py-2.5 border ${
                  rateError
                    ? 'text-rose-800 bg-rose-50 border-rose-200'
                    : 'text-emerald-800 bg-emerald-50 border-emerald-200'
                }`}
              >
                {rateMsg}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-[11px] text-slate-500">সব পরিবর্তন অপরিবর্তনীয় অডিট লগে সংরক্ষিত হয়।</span>
              <button
                type="button"
                disabled={rateSaving}
                onClick={handleSaveCommissionRates}
                className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded-lg cursor-pointer"
              >
                {rateSaving ? 'সংরক্ষণ হচ্ছে...' : 'কমিশন রেট সংরক্ষণ করুন'}
              </button>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-6 max-w-2xl">
            <h2 className="font-display text-lg font-bold text-slate-950">গেটওয়ে ও P2P ফি ম্যাট্রিক্স</h2>
            <p className="text-xs text-slate-500 mt-1">
              সার্ভার-সাইড ফাংশন দ্বারা প্রয়োগকৃত বেসিস-পয়েন্ট প্রসেসিং ফি ও এজেন্ট অংশ নির্ধারণ করুন।
            </p>
            <form onSubmit={handleFeeMatrixSave} className="mt-5 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label htmlFor="p2p-bps" className="block text-xs font-semibold text-slate-700 mb-1.5">
                    P2P ট্রান্সফার (bps)
                  </label>
                  <input
                    id="p2p-bps"
                    type="number"
                    min="0"
                    value={p2pBps}
                    onChange={(e) => setP2pBps(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm font-mono tabular-nums border border-slate-200 rounded-lg"
                  />
                </div>
                <div>
                  <label htmlFor="gw-bps" className="block text-xs font-semibold text-slate-700 mb-1.5">
                    গেটওয়ে ফি (bps)
                  </label>
                  <input
                    id="gw-bps"
                    type="number"
                    min="0"
                    value={gatewayBps}
                    onChange={(e) => setGatewayBps(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm font-mono tabular-nums border border-slate-200 rounded-lg"
                  />
                </div>
                <div>
                  <label htmlFor="ag-pct" className="block text-xs font-semibold text-slate-700 mb-1.5">
                    এজেন্ট অংশ (%)
                  </label>
                  <input
                    id="ag-pct"
                    type="number"
                    min="0"
                    max="100"
                    value={agentSplitPct}
                    onChange={(e) => setAgentSplitPct(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm font-mono tabular-nums border border-slate-200 rounded-lg"
                  />
                </div>
              </div>
              {configSaved && (
                <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3.5 py-2.5">
                  {configSaved}
                </p>
              )}
              <button
                type="submit"
                disabled={configSaving}
                className="px-5 py-2.5 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-lg cursor-pointer"
              >
                {configSaving ? 'সংরক্ষণ হচ্ছে...' : 'ম্যাট্রিক্স সংরক্ষণ করুন'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* 10. FINANCIAL REPORTS */}
      {activeTab === 'reports' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatMetricCard
              label="মোট কাস্টডি ব্যালেন্স"
              value={formatTaka(financeStats.totalCustodyBalance)}
              helper="সকল সক্রিয় ওয়ালেটের সমষ্টি"
              icon={Landmark}
              tone="emerald"
            />
            <StatMetricCard
              label="সংরক্ষিত / হোল্ড ব্যালেন্স"
              value={formatTaka(financeStats.totalReservedBalance)}
              helper="অপেক্ষমাণ উইথড্র রিকোয়েস্টের বিপরীতে হোল্ড"
              icon={Clock}
              tone="amber"
            />
            <StatMetricCard
              label="সংগৃহীত প্ল্যাটফর্ম ফি"
              value={formatTaka(financeStats.collectedFeeRevenue)}
              helper="সম্পন্ন লেনদেনের মোট ফি"
              icon={SlidersHorizontal}
            />
            <StatMetricCard
              label="লেজার অসামঞ্জস্য"
              value={formatTaka(financeStats.netLedgerDiscrepancy)}
              helper="ডেবিট ও ক্রেডিট সমতার পার্থক্য"
              icon={Activity}
            />
          </div>

          <DataTable
            title="আর্থিক সমন্বয় ও রিপোর্ট"
            subtitle="যেকোনো তারিখ ও ধরন অনুযায়ী ফিল্টার করে CSV আকারে রিপোর্ট ডাউনলোড করুন"
            rows={transactions}
            columns={txColumns}
            searchPlaceholder="রেফারেন্স বা এজেন্ট..."
            getSearchText={(r) =>
              `${r.reference_code} ${r.initiator_name || ''} ${r.initiator_agent_code || ''} ${r.tx_type}`
            }
            enableDateFilter
            getDateValue={(r) => r.created_at}
            emptyTitle="কোনো আর্থিক রিপোর্ট রেকর্ড নেই"
            emptyDescription="সম্পন্ন ও অপেক্ষমাণ লেনদেন থাকলে এখানে রিপোর্ট প্রদর্শিত হবে।"
            exportFilename="zentopay-superadmin-financial-report.csv"
          />
        </div>
      )}

      {/* 11. SETTINGS & AUDIT LOGS */}
      {activeTab === 'settings' && (
        <div className="space-y-6">
          <form onSubmit={handlePlatformConfigSave} className="space-y-6">
            {/* Support & Social Links */}
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <h2 className="font-display text-lg font-bold text-slate-950">সাপোর্ট ও সোশ্যাল লিংক</h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">Telegram সাপোর্ট লিংক</label>
                  <input
                    type="url"
                    value={supportLinks.telegram}
                    onChange={(e) => setSupportLinks((p) => ({ ...p, telegram: e.target.value }))}
                    placeholder="https://t.me/..."
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">WhatsApp সাপোর্ট লিংক</label>
                  <input
                    type="url"
                    value={supportLinks.whatsapp}
                    onChange={(e) => setSupportLinks((p) => ({ ...p, whatsapp: e.target.value }))}
                    placeholder="https://wa.me/..."
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                    অ্যাফিলিয়েট ম্যানেজার Telegram
                  </label>
                  <input
                    type="url"
                    value={supportLinks.affiliateManagerTelegram}
                    onChange={(e) =>
                      setSupportLinks((p) => ({ ...p, affiliateManagerTelegram: e.target.value }))
                    }
                    placeholder="https://t.me/..."
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
                {socialNetworks.map((s, idx) => (
                  <div key={s.id}>
                    <label className="block text-xs font-semibold text-slate-700 mb-1.5">{s.name} URL</label>
                    <input
                      type="url"
                      value={s.url}
                      onChange={(e) =>
                        setSocialNetworks((prev) =>
                          prev.map((item, i) => (i === idx ? { ...item, url: e.target.value } : item))
                        )
                      }
                      placeholder={`https://${s.id}.com/...`}
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Partners & Global Notifications */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                <h2 className="font-display text-base font-bold text-slate-950">আমাদের পার্টনার</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <input
                    type="text"
                    value={newPartnerName}
                    onChange={(e) => setNewPartnerName(e.target.value)}
                    placeholder="পার্টনারের নাম"
                    className="px-3 py-2 text-xs border border-slate-200 rounded-lg"
                  />
                  <input
                    type="url"
                    value={newPartnerLogo}
                    onChange={(e) => setNewPartnerLogo(e.target.value)}
                    placeholder="লোগো URL (ঐচ্ছিক)"
                    className="px-3 py-2 text-xs border border-slate-200 rounded-lg"
                  />
                  <input
                    type="text"
                    value={newPartnerDesc}
                    onChange={(e) => setNewPartnerDesc(e.target.value)}
                    placeholder="সংক্ষিপ্ত বিবরণ (ঐচ্ছিক)"
                    className="sm:col-span-2 px-3 py-2 text-xs border border-slate-200 rounded-lg"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleAddPartner}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  পার্টনার যোগ করুন
                </button>

                {partners.length > 0 && (
                  <div className="space-y-2 pt-2">
                    {partners.map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-xs"
                      >
                        <div>
                          <p className="font-bold text-slate-900">{p.name}</p>
                          {p.description && <p className="text-[11px] text-slate-500">{p.description}</p>}
                        </div>
                        <button
                          type="button"
                          onClick={() => setPartners((prev) => prev.filter((item) => item.id !== p.id))}
                          className="p-1 text-rose-600 hover:bg-rose-50 rounded cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                <h2 className="font-display text-base font-bold text-slate-950">গ্লোবাল সিস্টম নোটিফিকেশন</h2>
                <div className="space-y-2.5">
                  <input
                    type="text"
                    value={newGlobalTitle}
                    onChange={(e) => setNewGlobalTitle(e.target.value)}
                    placeholder="নোটিফিকেশন শিরোনাম"
                    className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg"
                  />
                  <textarea
                    rows={2}
                    value={newGlobalMsg}
                    onChange={(e) => setNewGlobalMsg(e.target.value)}
                    placeholder="সকল এজেন্টের জন্য বার্তা..."
                    className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleAddGlobalNotification}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  গ্লোবাল বার্তা তালিকায় যোগ করুন
                </button>

                {globalNotifications.length > 0 && (
                  <div className="space-y-2 pt-2">
                    {globalNotifications.map((g) => (
                      <div
                        key={g.id}
                        className="flex items-start justify-between gap-2 px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-xs"
                      >
                        <div>
                          <p className="font-bold text-slate-900">{g.title}</p>
                          <p className="text-[11px] text-slate-500">{g.message}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setGlobalNotifications((prev) => prev.filter((item) => item.id !== g.id))
                          }
                          className="p-1 text-rose-600 hover:bg-rose-50 rounded cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {platformSaveMsg && (
              <p
                className={`text-xs rounded-lg px-4 py-2.5 border ${
                  platformSaveError
                    ? 'text-rose-800 bg-rose-50 border-rose-200'
                    : 'text-emerald-800 bg-emerald-50 border-emerald-200'
                }`}
              >
                {platformSaveMsg}
              </p>
            )}

            <button
              type="submit"
              disabled={platformSaving}
              className="px-6 py-2.5 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-lg cursor-pointer"
            >
              {platformSaving ? 'সংরক্ষণ হচ্ছে...' : 'সেটিংস ও কনফিগারেশন সংরক্ষণ করুন'}
            </button>
          </form>

          {/* Send Targeted Personal Notification */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 max-w-2xl space-y-4">
            <div className="flex items-center gap-2">
              <Bell className="w-5 h-5 text-emerald-600" />
              <h2 className="font-display text-base font-bold text-slate-950">
                নির্দিষ্ট এজেন্টকে ব্যক্তিগত নোটিফিকেশন পাঠান
              </h2>
            </div>
            <form onSubmit={handleSendPersonalNotif} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  টার্গেট ইউজার (Agent ID, ইমেইল অথবা UUID)
                </label>
                <input
                  type="text"
                  required
                  value={notifUserIdent}
                  onChange={(e) => setNotifUserIdent(e.target.value)}
                  placeholder="যেমন: 67123456 অথবা agent@example.com"
                  className="w-full px-3.5 py-2 text-xs border border-slate-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">শিরোনাম</label>
                <input
                  type="text"
                  required
                  value={notifTitle}
                  onChange={(e) => setNotifTitle(e.target.value)}
                  placeholder="অ্যাকাউন্ট সংক্রান্ত গুরুত্বপূর্ণ বার্তা"
                  className="w-full px-3.5 py-2 text-xs border border-slate-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">বার্তা</label>
                <textarea
                  rows={2}
                  required
                  value={notifMessage}
                  onChange={(e) => setNotifMessage(e.target.value)}
                  placeholder="বিস্তারিত বার্তা লিখুন..."
                  className="w-full px-3.5 py-2 text-xs border border-slate-200 rounded-lg"
                />
              </div>
              {notifFeedback && (
                <p className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2">
                  {notifFeedback}
                </p>
              )}
              <button
                type="submit"
                disabled={notifSending}
                className="px-5 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-lg cursor-pointer"
              >
                {notifSending ? 'পাঠানো হচ্ছে...' : 'ব্যক্তিগত নোটিফিকেশন পাঠান'}
              </button>
            </form>
          </div>

          <DataTable
            title="নিরাপত্তা ও প্রশাসনিক অডিট লগ"
            subtitle="রোল পরিবর্তন, উইথড্র অনুমোদন/প্রত্যাখ্যান ও সেটিংস পরিবর্তনের অপরিবর্তনীয় রেকর্ড"
            rows={auditLogs}
            columns={auditColumns}
            getSearchText={(r) => `${r.action} ${r.actor_role} ${r.target_table}`}
            enableDateFilter
            getDateValue={(r) => r.created_at}
            emptyTitle="অডিট লগ স্ট্রিম খালি"
            emptyDescription="রোল আপডেট, অ্যাকাউন্ট ফ্রিজ ও আর্থিক অনুমোদন স্বয়ংক্রিয়ভাবে public.audit_logs-এ সংরক্ষিত হয়।"
            exportFilename="zentopay-audit-logs.csv"
          />
        </div>
      )}

      <ModalDrawer
        open={roleModalOpen}
        onClose={() => setRoleModalOpen(false)}
        title="রোল নির্ধারণ বা অ্যাকাউন্ট ফ্রিজ"
        description="নির্বাচিত অ্যাকাউন্টের রোল ও নিরাপত্তা অবস্থা পরিবর্তন করুন"
      >
        <form onSubmit={handleRoleUpdate} className="space-y-4">
          <div>
            <label htmlFor="sa-uid" className="block text-xs font-semibold text-slate-700 mb-1.5">
              টার্গেট ইউজার UUID
            </label>
            <input
              id="sa-uid"
              type="text"
              required
              value={targetUserId}
              onChange={(e) => setTargetUserId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              className="w-full px-3.5 py-2.5 text-sm font-mono border border-slate-200 rounded-lg"
            />
          </div>
          <div>
            <label htmlFor="sa-role" className="block text-xs font-semibold text-slate-700 mb-1.5">
              নির্ধারিত প্ল্যাটফর্ম রোল
            </label>
            <select
              id="sa-role"
              value={assignedRole}
              onChange={(e) => setAssignedRole(e.target.value as UserRole)}
              className="w-full px-3.5 py-2.5 text-sm border border-slate-200 rounded-lg"
            >
              <option value="user">এজেন্ট (User)</option>
              <option value="agent">এজেন্ট (Agent)</option>
              <option value="sub_agent">সাব-এজেন্ট (Sub-Agent)</option>
              <option value="finance_admin">ফাইন্যান্স অ্যাডমিন (Finance Admin)</option>
              <option value="support_admin">সাপোর্ট অ্যাডমিন (Support Admin)</option>
              <option value="super_admin">সুপার অ্যাডমিন (Super Admin)</option>
            </select>
          </div>
          <label className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={freezeAccount}
              onChange={(e) => setFreezeAccount(e.target.checked)}
              className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-600"
            />
            অ্যাকাউন্টের ওয়ালেট ও API অ্যাক্সেস ফ্রিজ করুন
          </label>
          {roleFeedback && (
            <p className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2.5">
              {roleFeedback}
            </p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setRoleModalOpen(false)}
              className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
            >
              বাতিল
            </button>
            <button
              type="submit"
              disabled={roleSubmitting}
              className="px-4 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-lg cursor-pointer"
            >
              {roleSubmitting ? 'সংরক্ষণ হচ্ছে...' : 'পরিবর্তন সংরক্ষণ করুন'}
            </button>
          </div>
        </form>
      </ModalDrawer>
    </DashboardLayout>
  );
}
