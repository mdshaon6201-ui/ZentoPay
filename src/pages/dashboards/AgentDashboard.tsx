import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpRight,
  BadgeCheck,
  Bell,
  Briefcase,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  CreditCard,
  Edit3,
  Gift,
  Globe,
  Handshake,
  Headphones,
  History,
  Home,
  KeyRound,
  Lock,
  LogOut,
  Menu,
  Plus,
  PlusCircle,
  Send,
  Settings,
  Share2,
  ShieldCheck,
  Smartphone,
  TrendingUp,
  Wallet as WalletIcon,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { useRouter } from '../../context/RouterContext.tsx';
import { formatDateTime, formatTaka } from '../../lib/api.ts';
import { formatCommissionPercent } from '../../lib/commissions.ts';
import type { DepositMethodConfig, TransactionRecord } from '../../types/zentopay.ts';
import { ZentoPayEmblem } from '../../components/ewallet/MethodLogo.tsx';
import { AgentSubScreens, type AgentSubScreenId } from '../../components/ewallet/AgentSubScreens.tsx';
import {
  AgentModals,
  type ActiveModalType,
  type GatewayEditTarget,
} from '../../components/ewallet/AgentModals.tsx';

type MainTabId = 'dashboard' | 'transactions' | 'service' | 'settings';

const TX_TITLES_BN: Record<string, string> = {
  deposit: 'ব্যালেন্স ডিপোজিট',
  payment_collection: 'পেমেন্ট কালেকশন',
  payment_payout: 'পেমেন্ট পেআউট',
  bet_deposit: 'ঐতিহাসিক কালেকশন (আর্কাইভ)',
  bet_payout: 'ঐতিহাসিক পেআউট (আর্কাইভ)',
  withdrawal: 'উইথড্র',
  settlement: 'উইথড্র / সেটেলমেন্ট',
  commission: 'কমিশন আয়',
  affiliate_commission: 'অ্যাফিলিয়েট কমিশন (১%)',
  gateway_payment: 'গেটওয়ে পেমেন্ট',
  cash_in: 'ক্যাশ-ইন',
  cash_out: 'ক্যাশ-আউট',
  transfer: 'ট্রান্সফার',
  adjustment: 'অ্যাডমিন সমন্বয়',
};

const SETTLEMENT_STATUS_BN: Record<string, { label: string; cls: 'approved' | 'pending' | 'rejected' }> = {
  pending: { label: 'অপেক্ষমাণ', cls: 'pending' },
  approved: { label: 'অনুমোদিত', cls: 'approved' },
  disbursed: { label: 'অনুমোদিত', cls: 'approved' },
  rejected: { label: 'প্রত্যাখ্যাত', cls: 'rejected' },
};

const KYC_BADGE_BN: Record<string, { label: string; cls: string }> = {
  unverified: { label: 'অযাচাইকৃত', cls: 'bg-slate-100 text-[#6B7C73]' },
  pending: { label: 'পর্যালোচনাধীন', cls: 'bg-amber-100 text-amber-800' },
  verified: { label: 'যাচাইকৃত', cls: 'bg-[#E9F7F0] text-[#075B3A]' },
  rejected: { label: 'প্রত্যাখ্যাত', cls: 'bg-red-100 text-[#E53935]' },
};

export function AgentDashboard() {
  const { navigate } = useRouter();
  const {
    profile,
    wallets,
    transactions,
    settlements,
    gateways,
    mfsRequests,
    notifications,
    mfsSchemaPending,
    referralCount,
    platformConfig,
    refreshAccountData,
    refreshMfsRequests,
    markWithdrawPinConfigured,
    signOut,
  } = useAuth();

  const [activeTab, setActiveTab] = useState<MainTabId>('dashboard');
  const [subScreen, setSubScreen] = useState<AgentSubScreenId | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState('');

  const [activeModal, setActiveModal] = useState<ActiveModalType>(null);
  const [txFilter, setTxFilter] = useState<'all' | 'withdrawals'>('all');
  const [gatewayTarget, setGatewayTarget] = useState<GatewayEditTarget | null>(null);
  const [selectedDepositMethod, setSelectedDepositMethod] = useState<DepositMethodConfig | null>(null);
  const [planDepositLock, setPlanDepositLock] = useState<{ plan: 'trial' | 'premium'; amount: number } | null>(null);
  const [withdrawMethod, setWithdrawMethod] = useState<'bkash' | 'nagad' | 'rocket' | 'bank'>('bkash');

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(''), 3200);
  };

  useEffect(() => {
    if (!profile) return;
    const syncAll = () => {
      void refreshAccountData();
      if (!mfsSchemaPending) {
        void refreshMfsRequests();
      }
    };
    const interval = window.setInterval(syncAll, 20000);
    window.addEventListener('focus', syncAll);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', syncAll);
    };
  }, [profile, mfsSchemaPending, refreshAccountData, refreshMfsRequests]);

  const primaryWallet = useMemo(() => {
    return (
      wallets.find((w) => w.currency === 'BDT' && w.wallet_type === 'main' && w.status === 'active') ||
      wallets.find((w) => w.currency === 'BDT' && w.wallet_type === 'float' && w.status === 'active') ||
      wallets.find((w) => w.currency === 'BDT' && w.status === 'active') ||
      wallets.find((w) => w.currency === 'BDT' && w.wallet_type === 'main') ||
      wallets.find((w) => w.currency === 'BDT') ||
      null
    );
  }, [wallets]);

  const totalBalance = useMemo(() => {
    const bdtWallets = wallets.filter((w) => w.currency === 'BDT');
    const source = bdtWallets.length > 0 ? bdtWallets : wallets;
    return source.reduce((acc, w) => acc + Number(w.balance || 0), 0);
  }, [wallets]);

  const availableBalance = useMemo(
    () => Number(primaryWallet?.available_balance ?? 0),
    [primaryWallet]
  );

  const totalAvailableBalance = useMemo(() => {
    const bdtWallets = wallets.filter((w) => w.currency === 'BDT');
    const source = bdtWallets.length > 0 ? bdtWallets : wallets;
    return source.reduce((acc, w) => acc + Number(w.available_balance || 0), 0);
  }, [wallets]);

  const totalReservedBalance = useMemo(() => {
    const bdtWallets = wallets.filter((w) => w.currency === 'BDT');
    const source = bdtWallets.length > 0 ? bdtWallets : wallets;
    return source.reduce(
      (acc, w) => acc + Math.max(0, Number(w.balance || 0) - Number(w.available_balance || 0)),
      0
    );
  }, [wallets]);

  const withdrawalStats = useMemo(() => {
    let pendingCount = 0;
    let pendingAmount = 0;
    let approvedCount = 0;
    let rejectedCount = 0;
    for (const s of settlements) {
      if (s.status === 'pending') {
        pendingCount += 1;
        pendingAmount += Number(s.amount || 0);
      } else if (s.status === 'approved' || s.status === 'disbursed') {
        approvedCount += 1;
      } else if (s.status === 'rejected') {
        rejectedCount += 1;
      }
    }
    return { pendingCount, pendingAmount, approvedCount, rejectedCount };
  }, [settlements]);

  const pendingCollections = useMemo(
    () => mfsRequests.filter((b) => b.request_type === 'payment_collection' && b.status === 'pending').length,
    [mfsRequests]
  );

  const pendingPayouts = useMemo(
    () => mfsRequests.filter((b) => b.request_type === 'payment_payout' && b.status === 'pending').length,
    [mfsRequests]
  );

  const unreadNotifCount = useMemo(
    () => notifications.filter((n) => !n.is_read).length + platformConfig.globalNotifications.length,
    [notifications, platformConfig.globalNotifications]
  );

  // Today's real overview computed strictly from database transactions
  const todayStats = useMemo(() => {
    const todayStr = new Date().toDateString();
    let commission = 0;
    let deposit = 0;
    let payout = 0;
    let count = 0;

    for (const tx of transactions) {
      if (new Date(tx.created_at).toDateString() !== todayStr) continue;
      count += 1;
      if (tx.status !== 'completed') continue;

      if (tx.tx_type === 'commission' || tx.tx_type === 'affiliate_commission') {
        commission += Number(tx.amount || 0);
      } else {
        commission += Number(tx.commission_amount || 0);
      }

      if (tx.tx_type === 'deposit' || tx.tx_type === 'payment_collection' || tx.tx_type === 'bet_deposit') {
        deposit += Number(tx.amount || 0);
      }
      if (
        tx.tx_type === 'payment_payout' ||
        tx.tx_type === 'bet_payout' ||
        tx.tx_type === 'withdrawal' ||
        tx.tx_type === 'settlement'
      ) {
        payout += Number(tx.amount || 0);
      }
    }

    return { commission, deposit, payout, count };
  }, [transactions]);

  // Unified transaction + settlement feed sorted descending
  const unifiedFeed = useMemo(() => {
    const txItems = transactions.map((tx: TransactionRecord) => {
      const isDebit =
        tx.tx_type === 'withdrawal' ||
        tx.tx_type === 'settlement' ||
        tx.tx_type === 'payment_payout' ||
        tx.tx_type === 'bet_payout' ||
        tx.tx_type === 'transfer';
      const statusCls: 'approved' | 'pending' | 'rejected' =
        tx.status === 'completed'
          ? 'approved'
          : tx.status === 'pending'
            ? 'pending'
            : 'rejected';
      const statusText =
        tx.status === 'completed'
          ? 'অনুমোদিত'
          : tx.status === 'pending'
            ? 'অপেক্ষমাণ'
            : 'প্রত্যাখ্যাত';
      return {
        id: `tx-${tx.id}`,
        title: TX_TITLES_BN[tx.tx_type] || tx.tx_type,
        subtitle: tx.description || tx.reference_code,
        amount: Number(tx.amount || 0),
        isDebit,
        statusCls,
        statusText,
        createdAt: tx.created_at,
      };
    });

    const settleItems = settlements.map((st) => {
      const mapped = SETTLEMENT_STATUS_BN[st.status] || { label: st.status, cls: 'pending' as const };
      const refTag = st.reference_code ? `${st.reference_code} · ` : '';
      const destLabel = st.destination_account || `অ্যাকাউন্ট •••• ${st.account_last4}`;
      const noteLabel = st.notes ? ` · নোট: ${st.notes}` : '';
      return {
        id: `st-${st.id}`,
        title: `উইথড্র (${st.destination_bank})`,
        subtitle: `${refTag}${destLabel}${noteLabel}`,
        amount: Number(st.amount || 0),
        isDebit: true,
        statusCls: mapped.cls,
        statusText: mapped.label,
        createdAt: st.created_at,
      };
    });

    return [...txItems, ...settleItems].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [transactions, settlements]);

  const openAddFunds = (planLock?: { plan: 'trial' | 'premium'; amount: number }) => {
    setPlanDepositLock(planLock || null);
    setSubScreen('add-funds');
    setDrawerOpen(false);
  };

  const openTabFromDrawer = (tab: MainTabId) => {
    setSubScreen(null);
    setActiveTab(tab);
    setDrawerOpen(false);
  };

  const openSubFromDrawer = (sub: AgentSubScreenId) => {
    setSubScreen(sub);
    setDrawerOpen(false);
  };

  const copyAgentId = async () => {
    if (!profile?.agent_code) return;
    try {
      await navigator.clipboard.writeText(profile.agent_code);
      showToast('এজেন্ট আইডি কপি করা হয়েছে!');
    } catch {
      showToast('কপি করা সম্ভব হয়নি।');
    }
  };

  const handleSignOutAndRedirect = async () => {
    await signOut();
    navigate('/login');
  };

  const displayName = profile?.full_name || 'ZentoPay এজেন্ট';
  const kycBadge = KYC_BADGE_BN[profile?.kyc_status || 'unverified'] || KYC_BADGE_BN.unverified;

  return (
    <div className="ew-mobile-viewport">
      <div className="app-container">
        {/* Global Toast */}
        <div className={`ew-toast ${toastMsg ? 'active' : ''}`} role="status">
          {toastMsg}
        </div>

        {/* Left Slide-in Drawer */}
        <div
          className={`menu-overlay ${drawerOpen ? 'active' : ''}`}
          onClick={(e) => {
            if (e.target === e.currentTarget) setDrawerOpen(false);
          }}
        >
          <aside className="menu-drawer" aria-label="এজেন্ট মেনু">
            <div className="menu-profile-header">
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="মেনু বন্ধ করুন"
                className="w-8 h-8 rounded-full bg-white/15 flex items-center justify-center absolute top-4 right-4 cursor-pointer"
              >
                <X className="w-4 h-4 text-white" />
              </button>

              <div className="w-14 h-14 rounded-full bg-white/20 border-2 border-white/40 overflow-hidden flex items-center justify-center text-xl font-extrabold mb-3">
                {profile?.avatar_url ? (
                  <img src={profile.avatar_url} alt={displayName} className="w-full h-full object-cover" />
                ) : (
                  displayName.charAt(0).toUpperCase()
                )}
              </div>

              <div className="flex items-center gap-1.5">
                <span className="text-base font-extrabold truncate">{displayName}</span>
                {profile?.kyc_status === 'verified' && (
                  <BadgeCheck className="w-4 h-4 text-[#52E5A5] shrink-0" />
                )}
              </div>
              <p className="text-[11px] font-mono text-white/85 mt-0.5">
                এজেন্ট আইডি: {profile?.agent_code || '—'}
              </p>
              <p className="text-[11px] text-white/75 truncate mt-0.5">{profile?.email || ''}</p>
            </div>

            <nav className="menu-options">
              <button type="button" className="menu-item" onClick={() => openTabFromDrawer('dashboard')}>
                <Home className="w-4 h-4 text-[#075B3A]" />
                Home
              </button>
              <button type="button" className="menu-item" onClick={() => openTabFromDrawer('transactions')}>
                <History className="w-4 h-4 text-[#075B3A]" />
                Transactions
              </button>
              <button type="button" className="menu-item" onClick={() => openTabFromDrawer('service')}>
                <Briefcase className="w-4 h-4 text-[#075B3A]" />
                Service Plans
              </button>
              <button type="button" className="menu-item" onClick={() => openSubFromDrawer('gateway')}>
                <Smartphone className="w-4 h-4 text-[#075B3A]" />
                MFS Gateway
              </button>
              <button type="button" className="menu-item" onClick={() => openSubFromDrawer('support')}>
                <Headphones className="w-4 h-4 text-[#075B3A]" />
                Help &amp; Support
              </button>
              <button type="button" className="menu-item" onClick={() => openSubFromDrawer('partners')}>
                <Handshake className="w-4 h-4 text-[#075B3A]" />
                Our Partners
              </button>
              <button type="button" className="menu-item" onClick={() => openSubFromDrawer('social')}>
                <Share2 className="w-4 h-4 text-[#075B3A]" />
                Social Networks
              </button>
              <button type="button" className="menu-item" onClick={() => openSubFromDrawer('affiliates')}>
                <Gift className="w-4 h-4 text-[#075B3A]" />
                Affiliate Program
              </button>
              <button type="button" className="menu-item" onClick={() => openTabFromDrawer('settings')}>
                <Settings className="w-4 h-4 text-[#075B3A]" />
                Settings
              </button>

              <div className="pt-2 mt-2 border-t border-[#E2EBE6]">
                <button
                  type="button"
                  onClick={() => {
                    setDrawerOpen(false);
                    setActiveModal('logout');
                  }}
                  className="menu-item text-[#E53935] hover:bg-red-50 hover:text-[#E53935]"
                >
                  <LogOut className="w-4 h-4" />
                  Logout
                </button>
              </div>
            </nav>
          </aside>
        </div>

        {/* Sub-screen vs Main Tab Container */}
        {subScreen ? (
          <AgentSubScreens
            screen={subScreen}
            onBack={() => {
              if (subScreen === 'payment-detail') {
                setSubScreen('add-funds');
              } else if (subScreen === 'withdraw-form') {
                setSubScreen('withdraw');
              } else {
                setPlanDepositLock(null);
                setSubScreen(null);
              }
            }}
            onNavigateSub={(s) => setSubScreen(s)}
            profile={profile}
            primaryWallet={primaryWallet}
            availableBalance={availableBalance}
            reservedBalance={totalReservedBalance}
            gateways={gateways}
            mfsRequests={mfsRequests}
            mfsSchemaPending={mfsSchemaPending}
            referralCount={referralCount}
            platformConfig={platformConfig}
            selectedDepositMethod={selectedDepositMethod}
            onSelectDepositMethod={(m) => setSelectedDepositMethod(m)}
            planDepositLock={planDepositLock}
            withdrawMethod={withdrawMethod}
            onSelectWithdrawMethod={(m) => setWithdrawMethod(m)}
            onOpenGatewayModal={(target) => {
              setGatewayTarget(target);
              setActiveModal('gateway-edit');
            }}
            onOpenPinModal={() => setActiveModal('pin-setup')}
            onRefresh={refreshAccountData}
            onRefreshMfs={refreshMfsRequests}
            onToast={showToast}
          />
        ) : (
          <section className="ew-screen">
            {/* Persistent App Header */}
            <header className="ew-app-header">
              <button
                type="button"
                className="ew-header-btn"
                onClick={() => setDrawerOpen(true)}
                aria-label="মেনু খুলুন"
              >
                <Menu className="w-5 h-5 text-[#12251D]" />
              </button>

              <div className="flex items-center gap-2">
                <ZentoPayEmblem size={26} />
                <span className="text-[17px] font-extrabold text-[#075B3A] tracking-tight">ZentoPay</span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="ew-header-btn"
                  onClick={() => {
                    void refreshMfsRequests();
                    setActiveModal('notifications');
                  }}
                  aria-label="নোটিফিকেশন"
                >
                  <Bell className="w-[18px] h-[18px] text-[#12251D]" />
                  {unreadNotifCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[17px] h-[17px] px-1 rounded-full bg-[#E53935] text-white text-[9.5px] font-extrabold flex items-center justify-center">
                      {unreadNotifCount > 9 ? '9+' : unreadNotifCount}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="ew-header-btn"
                  onClick={() => setSubScreen('support')}
                  aria-label="সাপোর্ট"
                >
                  <Headphones className="w-[18px] h-[18px] text-[#075B3A]" />
                </button>
              </div>
            </header>

            {/* TAB 1: DASHBOARD HOME */}
            {activeTab === 'dashboard' && (
              <div className="px-5 pt-1 pb-6">
                {/* Forest Green Balance Card */}
                <div className="ew-balance-card">
                  <div className="flex items-start justify-between gap-2 relative z-10">
                    <div>
                      <p className="text-xs font-semibold text-[#E9F7F0]/85">ব্যবহারযোগ্য ব্যালেন্স</p>
                      <h2 className="text-[30px] font-extrabold tracking-tight tabular-nums mt-0.5 leading-tight">
                        {formatTaka(totalAvailableBalance)}
                      </h2>
                      <div className="flex items-center gap-3 mt-1 text-[11px] text-[#E9F7F0]/85 tabular-nums flex-wrap">
                        <span>মোট ব্যালেন্স: <strong className="text-white">{formatTaka(totalBalance)}</strong></span>
                        {totalReservedBalance > 0 && (
                          <span>
                            সংরক্ষিত (পেন্ডিং): <strong className="text-amber-200">{formatTaka(totalReservedBalance)}</strong>
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-2 flex-wrap">
                        <span className="text-[10.5px] font-bold px-2.5 py-0.5 rounded-full bg-white/15 text-[#E9F7F0]">
                          {profile?.active_plan === 'premium'
                            ? 'Premium Plan সক্রিয়'
                            : profile?.active_plan === 'trial'
                              ? 'Trial Plan সক্রিয়'
                              : 'সাধারণ এজেন্ট'}
                        </span>
                        <button
                          type="button"
                          onClick={copyAgentId}
                          disabled={!profile?.agent_code}
                          aria-label="এজেন্ট আইডি কপি করুন"
                          className="text-[10.5px] font-mono font-bold px-2.5 py-0.5 rounded-full bg-white/15 hover:bg-white/25 text-white inline-flex items-center gap-1 cursor-pointer disabled:opacity-70 disabled:cursor-default"
                        >
                          <span>এজেন্ট আইডি: {profile?.agent_code || 'সংরক্ষিত হচ্ছে...'}</span>
                          {profile?.agent_code && <Copy className="w-2.5 h-2.5 shrink-0" />}
                        </button>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => openAddFunds()}
                      aria-label="ব্যালেন্স যোগ করুন"
                      className="w-10 h-10 rounded-full bg-white/18 hover:bg-white/25 border border-white/25 flex items-center justify-center text-white shrink-0 cursor-pointer"
                    >
                      <Plus className="w-5 h-5" />
                    </button>
                  </div>

                  {/* 4 Quick Action Icons inside Balance Card */}
                  <div className="ew-action-grid relative z-10">
                    <button
                      type="button"
                      className="ew-action-item"
                      onClick={() => setSubScreen('withdraw')}
                    >
                      <div className="ew-action-icon-box">
                        <ArrowUpRight className="w-5 h-5 text-white" />
                      </div>
                      <span className="ew-action-label">Withdraw</span>
                    </button>

                    <button
                      type="button"
                      className="ew-action-item"
                      onClick={() => setSubScreen('gateway')}
                    >
                      <div className="ew-action-icon-box">
                        <Smartphone className="w-5 h-5 text-white" />
                      </div>
                      <span className="ew-action-label">Gateway</span>
                    </button>

                    <button
                      type="button"
                      className="ew-action-item"
                      onClick={() => {
                        void refreshMfsRequests();
                        setSubScreen('payment-payout');
                      }}
                    >
                      <div className="ew-action-icon-box">
                        <ArrowUpFromLine className="w-5 h-5 text-white" />
                        {pendingPayouts > 0 && (
                          <span className="absolute -top-1.5 -right-1.5 min-w-[19px] h-[19px] px-1 rounded-full bg-[#E53935] text-white text-[10px] font-extrabold border-2 border-[#075B3A] flex items-center justify-center">
                            {pendingPayouts}
                          </span>
                        )}
                      </div>
                      <span className="ew-action-label">Bet Payout</span>
                    </button>

                    <button
                      type="button"
                      className="ew-action-item"
                      onClick={() => {
                        void refreshMfsRequests();
                        setSubScreen('payment-collection');
                      }}
                    >
                      <div className="ew-action-icon-box">
                        <ArrowDownToLine className="w-5 h-5 text-white" />
                        {pendingCollections > 0 && (
                          <span className="absolute -top-1.5 -right-1.5 min-w-[19px] h-[19px] px-1 rounded-full bg-[#E53935] text-white text-[10px] font-extrabold border-2 border-[#075B3A] flex items-center justify-center">
                            {pendingCollections}
                          </span>
                        )}
                      </div>
                      <span className="ew-action-label">Bet Deposit</span>
                    </button>
                  </div>
                </div>

                {/* Add Funds / Withdraw Split Row */}
                <div className="ew-quick-actions-bar">
                  <button
                    type="button"
                    onClick={() => openAddFunds()}
                    className="ew-quick-btn primary"
                  >
                    <PlusCircle className="w-4 h-4" />
                    Add Balance
                  </button>
                  <button
                    type="button"
                    onClick={() => setSubScreen('withdraw')}
                    className="ew-quick-btn"
                  >
                    <WalletIcon className="w-4 h-4" />
                    Withdraw
                  </button>
                </div>

                {/* Today's Overview 2x2 Grid */}
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-[15px] font-extrabold text-[#12251D]">আজকের সারসংক্ষেপ</h3>
                </div>
                <div className="ew-stats-grid">
                  <div className="ew-stat-card">
                    <div className="ew-stat-icon">
                      <TrendingUp className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold text-[#6B7C73] truncate">আজকের কমিশন</p>
                      <p className="text-sm font-extrabold text-[#12251D] tabular-nums mt-0.5">
                        {formatTaka(todayStats.commission)}
                      </p>
                    </div>
                  </div>

                  <div className="ew-stat-card">
                    <div className="ew-stat-icon">
                      <ArrowDownLeft className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold text-[#6B7C73] truncate">আজকের ডিপোজিট</p>
                      <p className="text-sm font-extrabold text-[#12251D] tabular-nums mt-0.5">
                        {formatTaka(todayStats.deposit)}
                      </p>
                    </div>
                  </div>

                  <div className="ew-stat-card">
                    <div className="ew-stat-icon">
                      <ArrowUpRight className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold text-[#6B7C73] truncate">আজকের পেআউট</p>
                      <p className="text-sm font-extrabold text-[#12251D] tabular-nums mt-0.5">
                        {formatTaka(todayStats.payout)}
                      </p>
                    </div>
                  </div>

                  <div className="ew-stat-card">
                    <div className="ew-stat-icon">
                      <CreditCard className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold text-[#6B7C73] truncate">আজকের লেনদেন</p>
                      <p className="text-sm font-extrabold text-[#12251D] tabular-nums mt-0.5">
                        {todayStats.count}টি
                      </p>
                    </div>
                  </div>
                </div>

                {settlements.length > 0 && (
                  <div className="bg-white border border-[#E2EBE6] rounded-2xl p-3.5 mb-5 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-extrabold text-[#12251D]">উইথড্র রিকোয়েস্ট সারসংক্ষেপ</p>
                      <p className="text-[11px] text-[#6B7C73] mt-0.5">
                        অপেক্ষমাণ: {withdrawalStats.pendingCount}টি · অনুমোদিত: {withdrawalStats.approvedCount}টি · প্রত্যাখ্যাত: {withdrawalStats.rejectedCount}টি
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setTxFilter('withdrawals');
                        setActiveTab('transactions');
                      }}
                      className="px-3 py-1.5 rounded-xl bg-[#E9F7F0] text-[#075B3A] text-[11px] font-extrabold shrink-0 cursor-pointer"
                    >
                      তালিকা দেখুন
                    </button>
                  </div>
                )}

                {/* Recent Transactions */}
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-[15px] font-extrabold text-[#12251D]">সাম্প্রতিক লেনদেন</h3>
                  <button
                    type="button"
                    onClick={() => setActiveTab('transactions')}
                    className="text-xs font-bold text-[#075B3A] hover:underline cursor-pointer"
                  >
                    সব দেখুন
                  </button>
                </div>

                <div className="ew-transaction-card">
                  {unifiedFeed.length === 0 ? (
                    <div className="py-8 text-center space-y-1">
                      <p className="text-xs font-extrabold text-[#12251D]">এখনো কোনো লেনদেন নেই</p>
                      <p className="text-[11px] text-[#6B7C73]">
                        আপনার ডিপোজিট, উইথড্র এবং পেমেন্ট কমিশন লেনদেন এখানে প্রদর্শিত হবে।
                      </p>
                    </div>
                  ) : (
                    unifiedFeed.slice(0, 5).map((item) => (
                      <div key={item.id} className="clean-tx-item">
                        <div className="clean-tx-icon">
                          {item.isDebit ? (
                            <ArrowUpRight className="w-4 h-4 text-[#E53935]" />
                          ) : (
                            <ArrowDownLeft className="w-4 h-4 text-[#075B3A]" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-extrabold text-[#12251D] truncate">{item.title}</p>
                          <p className="text-[11px] text-[#6B7C73] truncate">{item.subtitle}</p>
                          <p className="text-[10px] text-[#6B7C73] mt-0.5">
                            {formatDateTime(item.createdAt)}
                          </p>
                        </div>
                        <div className="text-right">
                          <p
                            className={`text-xs font-extrabold tabular-nums ${
                              item.isDebit ? 'text-[#E53935]' : 'text-[#075B3A]'
                            }`}
                          >
                            {item.isDebit ? '-' : '+'}
                            {formatTaka(item.amount)}
                          </p>
                          <span className={`clean-tx-status ${item.statusCls}`}>{item.statusText}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* TAB 2: ALL TRANSACTIONS & WITHDRAWAL HISTORY */}
            {activeTab === 'transactions' && (
              <div className="px-5 pt-1 pb-6 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-base font-extrabold text-[#12251D]">লেনদেন ও উইথড্র ইতিহাস</h2>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setTxFilter('all')}
                      className={`px-3 py-1 rounded-full text-[11px] font-bold cursor-pointer ${
                        txFilter === 'all'
                          ? 'bg-[#075B3A] text-white'
                          : 'bg-white border border-[#E2EBE6] text-[#6B7C73]'
                      }`}
                    >
                      সকল
                    </button>
                    <button
                      type="button"
                      onClick={() => setTxFilter('withdrawals')}
                      className={`px-3 py-1 rounded-full text-[11px] font-bold cursor-pointer ${
                        txFilter === 'withdrawals'
                          ? 'bg-[#075B3A] text-white'
                          : 'bg-white border border-[#E2EBE6] text-[#6B7C73]'
                      }`}
                    >
                      উইথড্র ({settlements.length})
                    </button>
                  </div>
                </div>

                {txFilter === 'withdrawals' ? (
                  <div className="ew-transaction-card">
                    {settlements.length === 0 ? (
                      <div className="py-12 text-center space-y-1.5">
                        <p className="text-sm font-extrabold text-[#12251D]">কোনো উইথড্র রিকোয়েস্ট নেই</p>
                        <p className="text-xs text-[#6B7C73]">
                          উইথড্র রিকোয়েস্ট পাঠালে এখানে অপেক্ষমাণ, অনুমোদিত ও প্রত্যাখ্যাত অবস্থা দেখতে পাবেন।
                        </p>
                      </div>
                    ) : (
                      settlements.map((st) => {
                        const mapped = SETTLEMENT_STATUS_BN[st.status] || {
                          label: st.status,
                          cls: 'pending' as const,
                        };
                        return (
                          <div key={st.id} className="clean-tx-item">
                            <div className="clean-tx-icon">
                              <ArrowUpRight className="w-4 h-4 text-[#E53935]" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-xs font-extrabold text-[#12251D] truncate">
                                {st.destination_bank}
                              </p>
                              <p className="text-[11px] text-[#6B7C73] font-mono truncate">
                                {st.reference_code || `WD-${st.id.slice(0, 8).toUpperCase()}`} ·{' '}
                                {st.destination_account || `•••• ${st.account_last4}`}
                              </p>
                              {st.notes && (
                                <p className="text-[10.5px] text-slate-600 mt-0.5 break-words">
                                  নোট: {st.notes}
                                </p>
                              )}
                              <p className="text-[10px] text-[#6B7C73] mt-0.5">
                                {formatDateTime(st.created_at)}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="text-xs font-extrabold tabular-nums text-[#E53935]">
                                -{formatTaka(Number(st.amount || 0))}
                              </p>
                              <span className={`clean-tx-status ${mapped.cls}`}>{mapped.label}</span>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                ) : (
                  <div className="ew-transaction-card">
                    {unifiedFeed.length === 0 ? (
                      <div className="py-12 text-center space-y-1.5">
                        <p className="text-sm font-extrabold text-[#12251D]">কোনো লেনদেন পাওয়া যায়নি</p>
                        <p className="text-xs text-[#6B7C73]">
                          ডিপোজিট, উইথড্র বা MFS পেমেন্ট রিকোয়েস্ট সম্পন্ন হলে এখানে বিস্তারিত তালিকা থাকবে।
                        </p>
                      </div>
                    ) : (
                      unifiedFeed.map((item) => (
                        <div key={item.id} className="clean-tx-item">
                          <div className="clean-tx-icon">
                            {item.isDebit ? (
                              <ArrowUpRight className="w-4 h-4 text-[#E53935]" />
                            ) : (
                              <ArrowDownLeft className="w-4 h-4 text-[#075B3A]" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-extrabold text-[#12251D] truncate">{item.title}</p>
                            <p className="text-[11px] text-[#6B7C73] truncate">{item.subtitle}</p>
                            <p className="text-[10px] text-[#6B7C73] mt-0.5">
                              {formatDateTime(item.createdAt)}
                            </p>
                          </div>
                          <div className="text-right">
                            <p
                              className={`text-xs font-extrabold tabular-nums ${
                                item.isDebit ? 'text-[#E53935]' : 'text-[#075B3A]'
                              }`}
                            >
                              {item.isDebit ? '-' : '+'}
                              {formatTaka(item.amount)}
                            </p>
                            <span className={`clean-tx-status ${item.statusCls}`}>{item.statusText}</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}

            {/* TAB 3: SERVICES & SUBSCRIPTION PLANS */}
            {activeTab === 'service' && (
              <div className="px-5 pt-1 pb-6 space-y-4">
                <div>
                  <h2 className="text-base font-extrabold text-[#12251D]">এজেন্টশিপ সার্ভিস প্ল্যান</h2>
                  <p className="text-xs text-[#6B7C73] mt-0.5">
                    আপনার এজেন্ট অ্যাকাউন্ট সক্রিয় করতে পছন্দের প্ল্যান নির্বাচন করুন
                  </p>
                </div>

                {/* Trial Plan Card */}
                <div className="bg-white rounded-3xl border border-[#E2EBE6] p-5 shadow-xs space-y-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <span className="inline-block px-2.5 py-0.5 rounded-full bg-[#E9F7F0] text-[#075B3A] text-[10px] font-extrabold mb-1.5">
                        ৩০ দিনের মেয়াদ
                      </span>
                      <h3 className="text-lg font-extrabold text-[#12251D]">Trial Plan</h3>
                    </div>
                    <div className="text-right">
                      <span className="text-2xl font-black text-[#075B3A]">৳৫,০০০</span>
                      <p className="text-[10px] text-[#6B7C73]">ডিপোজিট ব্যালেন্স</p>
                    </div>
                  </div>

                  <ul className="space-y-2 text-xs text-[#6B7C73]">
                    <li className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-[#16A66A] shrink-0" />
                      নতুন এজেন্টদের জন্য ৩০ দিনের ট্রায়াল মেয়াদ
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-[#16A66A] shrink-0" />
                      MFS পেমেন্ট কমিশন: bKash {formatCommissionPercent(platformConfig.commissionRates.bkash)}, Nagad{' '}
                      {formatCommissionPercent(platformConfig.commissionRates.nagad)}, Rocket{' '}
                      {formatCommissionPercent(platformConfig.commissionRates.rocket)}
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-[#16A66A] shrink-0" />
                      Personal ও Agent নম্বর গেটওয়ে সংযোগ
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-[#16A66A] shrink-0" />
                      ২৪/৭ টেলিগ্রাম ও হোয়াটসঅ্যাপ সাপোর্ট
                    </li>
                  </ul>

                  {profile?.active_plan === 'trial' ? (
                    <div className="w-full py-3 rounded-xl bg-[#E9F7F0] text-[#075B3A] font-extrabold text-xs text-center flex items-center justify-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4" />
                      বর্তমানে Trial Plan সক্রিয় রয়েছে
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => openAddFunds({ plan: 'trial', amount: 5000 })}
                      className="ew-btn"
                    >
                      Trial Plan সক্রিয় করুন (৳৫,০০০)
                    </button>
                  )}
                </div>

                {/* Premium Plan Card */}
                <div className="bg-gradient-to-br from-[#075B3A] to-[#043824] text-white rounded-3xl p-5 shadow-md space-y-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <span className="inline-block px-2.5 py-0.5 rounded-full bg-[#16A66A] text-white text-[10px] font-extrabold mb-1.5">
                        লাইফটাইম মেম্বারশিপ
                      </span>
                      <h3 className="text-lg font-extrabold">Premium Plan</h3>
                    </div>
                    <div className="text-right">
                      <span className="text-2xl font-black text-[#52E5A5]">৳১৫,০০০</span>
                      <p className="text-[10px] text-white/75">ডিপোজিট ব্যালেন্স</p>
                    </div>
                  </div>

                  <ul className="space-y-2 text-xs text-white/90">
                    <li className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-[#52E5A5] shrink-0" />
                      আজীবন (Lifetime) ভেরিফাইড এজেন্ট মেম্বারশিপ
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-[#52E5A5] shrink-0" />
                      আনলিমিটেড ও উচ্চ-পরিমাণ MFS পেমেন্ট কালেকশন / পেআউট ট্রাফিক
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-[#52E5A5] shrink-0" />
                      Personal, Agent ও Merchant সব ধরনের গেটওয়ে সাপোর্ট
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-[#52E5A5] shrink-0" />
                      ৩০ দিন পর অ্যাফিলিয়েট প্রোগ্রামে ১% + ১% কমিশন যোগ্যতা
                    </li>
                  </ul>

                  {profile?.active_plan === 'premium' ? (
                    <div className="w-full py-3 rounded-xl bg-white/15 border border-white/25 text-[#52E5A5] font-extrabold text-xs text-center flex items-center justify-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4" />
                      বর্তমানে Premium Plan সক্রিয় রয়েছে
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => openAddFunds({ plan: 'premium', amount: 15000 })}
                      className="w-full py-3.5 rounded-2xl bg-white text-[#075B3A] font-extrabold text-sm cursor-pointer shadow-sm"
                    >
                      Premium Plan সক্রিয় করুন (৳১৫,০০০)
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* TAB 4: SETTINGS */}
            {activeTab === 'settings' && (
              <div className="px-5 pt-1 pb-6 space-y-4">
                {/* Profile Card */}
                <div className="bg-white rounded-3xl border border-[#E2EBE6] p-5 shadow-xs flex flex-col items-center text-center">
                  <div className="relative mb-3">
                    <button
                      type="button"
                      onClick={() => setActiveModal('avatar')}
                      aria-label="প্রোফাইল ছবি পরিবর্তন করুন"
                      className="w-20 h-20 rounded-full bg-[#E9F7F0] border-2 border-[#16A66A] overflow-hidden flex items-center justify-center text-2xl font-extrabold text-[#075B3A] cursor-pointer"
                    >
                      {profile?.avatar_url ? (
                        <img src={profile.avatar_url} alt={displayName} className="w-full h-full object-cover" />
                      ) : (
                        displayName.charAt(0).toUpperCase()
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveModal('avatar')}
                      aria-label="ছবি আপলোড"
                      className="w-7 h-7 rounded-full bg-[#075B3A] text-white border-2 border-white flex items-center justify-center absolute bottom-0 right-0 cursor-pointer"
                    >
                      <Camera className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <h2 className="text-base font-extrabold text-[#12251D]">{displayName}</h2>
                    {profile?.kyc_status === 'verified' && (
                      <BadgeCheck className="w-4 h-4 text-[#16A66A]" />
                    )}
                  </div>
                  <p className="text-xs text-[#6B7C73] mt-0.5">{profile?.email || '—'}</p>
                  {profile?.phone && (
                    <p className="text-xs text-[#6B7C73] font-mono mt-0.5">{profile.phone}</p>
                  )}

                  <div className="w-full mt-3.5 bg-[#F4F7F5] border border-[#E2EBE6] rounded-xl px-3.5 py-2.5 flex items-center justify-between">
                    <div className="text-left">
                      <span className="text-[10px] font-bold text-[#6B7C73] block">এজেন্ট আইডি</span>
                      <span className="text-xs font-extrabold font-mono text-[#075B3A]">
                        {profile?.agent_code || '—'}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={copyAgentId}
                      className="px-3 py-1 rounded-lg bg-white border border-[#E2EBE6] text-[11px] font-bold text-[#075B3A] inline-flex items-center gap-1 cursor-pointer"
                    >
                      <Copy className="w-3 h-3" />
                      কপি
                    </button>
                  </div>
                </div>

                {/* KYC Verification Card */}
                <div className="bg-white rounded-3xl border border-[#E2EBE6] p-4 shadow-xs flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-xl bg-[#E9F7F0] text-[#075B3A] flex items-center justify-center shrink-0">
                      <ShieldCheck className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-extrabold text-[#12251D]">KYC ভেরিফিকেশন</p>
                      <span className={`inline-block mt-0.5 px-2 py-0.5 rounded-full text-[10px] font-bold ${kycBadge.cls}`}>
                        {kycBadge.label}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveModal('kyc')}
                    className="px-3.5 py-2 rounded-xl bg-[#075B3A] text-white text-xs font-bold shrink-0 cursor-pointer"
                  >
                    {profile?.kyc_status === 'verified' ? 'তথ্য দেখুন' : 'যাচাই করুন'}
                  </button>
                </div>

                {/* Personal Information Card */}
                <div className="bg-white rounded-3xl border border-[#E2EBE6] p-4 shadow-xs space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-extrabold text-[#12251D]">ব্যক্তিগত তথ্য</h3>
                    <button
                      type="button"
                      onClick={() => setActiveModal('edit-profile')}
                      className="text-xs font-bold text-[#075B3A] inline-flex items-center gap-1 cursor-pointer"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      সম্পাদনা
                    </button>
                  </div>
                  <div className="divide-y divide-[#F0F4F2] text-xs">
                    <div className="py-2 flex items-center justify-between gap-2">
                      <span className="text-[#6B7C73]">এজেন্ট আইডি</span>
                      <div className="inline-flex items-center gap-1.5">
                        <span className="font-extrabold font-mono text-[#075B3A]">
                          {profile?.agent_code || '—'}
                        </span>
                        {profile?.agent_code && (
                          <button
                            type="button"
                            onClick={copyAgentId}
                            className="px-2 py-0.5 rounded bg-[#E9F7F0] text-[#075B3A] text-[10px] font-bold inline-flex items-center gap-1 cursor-pointer"
                          >
                            <Copy className="w-2.5 h-2.5" />
                            কপি
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="py-2 flex justify-between gap-2">
                      <span className="text-[#6B7C73]">পূর্ণ নাম</span>
                      <span className="font-bold text-[#12251D]">{displayName}</span>
                    </div>
                    <div className="py-2 flex justify-between gap-2">
                      <span className="text-[#6B7C73]">ফোন নম্বর</span>
                      <span className="font-bold font-mono text-[#12251D]">{profile?.phone || 'যোগ করা হয়নি'}</span>
                    </div>
                    <div className="py-2 flex justify-between gap-2">
                      <span className="text-[#6B7C73]">দেশ</span>
                      <span className="font-bold text-[#12251D]">{profile?.country || 'BD'}</span>
                    </div>
                    <div className="py-2 flex justify-between gap-2">
                      <span className="text-[#6B7C73]">সক্রিয় প্ল্যান</span>
                      <span className="font-bold text-[#075B3A]">
                        {profile?.active_plan === 'premium'
                          ? 'Premium Plan'
                          : profile?.active_plan === 'trial'
                            ? 'Trial Plan'
                            : 'সক্রিয় নেই'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Security Card */}
                <div className="bg-white rounded-3xl border border-[#E2EBE6] p-4 shadow-xs space-y-2">
                  <h3 className="text-xs font-extrabold text-[#12251D] mb-2">নিরাপত্তা</h3>
                  <button
                    type="button"
                    onClick={() => setActiveModal('change-pass')}
                    className="w-full flex items-center justify-between p-3 rounded-2xl bg-[#F4F7F5] hover:bg-[#E9F7F0] transition cursor-pointer"
                  >
                    <div className="flex items-center gap-3">
                      <Lock className="w-4 h-4 text-[#075B3A]" />
                      <span className="text-xs font-bold text-[#12251D]">Change Password</span>
                    </div>
                    <ChevronRight className="w-4 h-4 text-[#6B7C73]" />
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveModal('pin-setup')}
                    className="w-full flex items-center justify-between p-3 rounded-2xl bg-[#F4F7F5] hover:bg-[#E9F7F0] transition cursor-pointer"
                  >
                    <div className="flex items-center gap-3">
                      <KeyRound className="w-4 h-4 text-[#075B3A]" />
                      <div className="text-left">
                        <span className="text-xs font-bold text-[#12251D] block">Withdraw PIN</span>
                        <span className="text-[10px] text-[#6B7C73]">
                          {profile?.has_withdraw_pin ? 'PIN configured (tap to update)' : 'Not configured yet'}
                        </span>
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-[#6B7C73]" />
                  </button>
                </div>

                {/* Social & Support Quick Grid */}
                <div className="bg-white rounded-3xl border border-[#E2EBE6] p-4 shadow-xs space-y-2.5">
                  <h3 className="text-xs font-extrabold text-[#12251D]">Community &amp; Support</h3>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => setSubScreen('support')}
                      className="p-3 rounded-2xl bg-[#F4F7F5] border border-[#E2EBE6] flex flex-col items-center gap-1.5 text-[11px] font-bold text-[#12251D] cursor-pointer"
                    >
                      <Send className="w-4 h-4 text-[#0088cc]" />
                      Support
                    </button>
                    <button
                      type="button"
                      onClick={() => setSubScreen('social')}
                      className="p-3 rounded-2xl bg-[#F4F7F5] border border-[#E2EBE6] flex flex-col items-center gap-1.5 text-[11px] font-bold text-[#12251D] cursor-pointer"
                    >
                      <Share2 className="w-4 h-4 text-[#075B3A]" />
                      Social
                    </button>
                    <button
                      type="button"
                      onClick={() => navigate('/policy')}
                      className="p-3 rounded-2xl bg-[#F4F7F5] border border-[#E2EBE6] flex flex-col items-center gap-1.5 text-[11px] font-bold text-[#12251D] cursor-pointer"
                    >
                      <Globe className="w-4 h-4 text-[#075B3A]" />
                      Policy
                    </button>
                  </div>
                </div>

                {/* Logout Danger Outline Button */}
                <button
                  type="button"
                  onClick={() => setActiveModal('logout')}
                  className="ew-btn ew-btn-outline-danger"
                >
                  <LogOut className="w-4 h-4" />
                  Logout
                </button>
              </div>
            )}
          </section>
        )}

        {/* Fixed 4-Tab Bottom Navigation (Shown only on Main Tabs) */}
        {!subScreen && (
          <nav className="ew-bottom-nav" aria-label="Primary Navigation">
            <button
              type="button"
              className={`ew-nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
              onClick={() => setActiveTab('dashboard')}
            >
              <Home className="w-5 h-5" />
              <span className="text-[11px] font-bold">Home</span>
            </button>

            <button
              type="button"
              className={`ew-nav-item ${activeTab === 'transactions' ? 'active' : ''}`}
              onClick={() => setActiveTab('transactions')}
            >
              <History className="w-5 h-5" />
              <span className="text-[11px] font-bold">Transactions</span>
            </button>

            <button
              type="button"
              className={`ew-nav-item ${activeTab === 'service' ? 'active' : ''}`}
              onClick={() => setActiveTab('service')}
            >
              <Briefcase className="w-5 h-5" />
              <span className="text-[11px] font-bold">Services</span>
            </button>

            <button
              type="button"
              className={`ew-nav-item ${activeTab === 'settings' ? 'active' : ''}`}
              onClick={() => setActiveTab('settings')}
            >
              <Settings className="w-5 h-5" />
              <span className="text-[11px] font-bold">Settings</span>
            </button>
          </nav>
        )}

        {/* Agent Modals */}
        <AgentModals
          activeModal={activeModal}
          onClose={() => setActiveModal(null)}
          profile={profile}
          availableBalance={availableBalance}
          gatewayTarget={gatewayTarget}
          globalNotifications={platformConfig.globalNotifications}
          personalNotifications={notifications}
          onRefresh={refreshAccountData}
          onPinConfigured={markWithdrawPinConfigured}
          onSignOut={handleSignOutAndRedirect}
          onToast={showToast}
        />
      </div>
    </div>
  );
}
