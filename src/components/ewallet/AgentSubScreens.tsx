import React, { useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Copy,
  ExternalLink,
  MessageCircle,
  RefreshCw,
  Send,
  Share2,
  Upload,
} from 'lucide-react';
import { apiRequest, formatDateTime, formatTaka } from '../../lib/api.ts';
import { formatCommissionPercent } from '../../lib/commissions.ts';
import type {
  AgentGateway,
  DepositMethodConfig,
  MfsPaymentRequest,
  PlatformConfigData,
  UserProfile,
  Wallet,
} from '../../types/zentopay.ts';
import { MethodLogo } from './MethodLogo.tsx';
import type { GatewayEditTarget } from './AgentModals.tsx';

export type AgentSubScreenId =
  | 'gateway'
  | 'add-funds'
  | 'payment-detail'
  | 'payment-collection'
  | 'payment-payout'
  | 'withdraw'
  | 'withdraw-form'
  | 'support'
  | 'partners'
  | 'social'
  | 'affiliates';

interface AgentSubScreensProps {
  screen: AgentSubScreenId;
  onBack: () => void;
  onNavigateSub: (s: AgentSubScreenId) => void;
  profile: UserProfile | null;
  primaryWallet: Wallet | null;
  availableBalance: number;
  reservedBalance?: number;
  gateways: AgentGateway[];
  mfsRequests: MfsPaymentRequest[];
  mfsSchemaPending?: boolean;
  referralCount: number;
  platformConfig: PlatformConfigData;
  selectedDepositMethod: DepositMethodConfig | null;
  onSelectDepositMethod: (m: DepositMethodConfig) => void;
  planDepositLock: { plan: 'trial' | 'premium'; amount: number } | null;
  withdrawMethod: 'bkash' | 'nagad' | 'rocket' | 'bank';
  onSelectWithdrawMethod: (m: 'bkash' | 'nagad' | 'rocket' | 'bank') => void;
  onOpenGatewayModal: (target: GatewayEditTarget) => void;
  onOpenPinModal: () => void;
  onRefresh: () => Promise<void>;
  onRefreshMfs?: () => Promise<void>;
  onToast: (msg: string) => void;
}

const SCREEN_TITLES: Record<AgentSubScreenId, string> = {
  gateway: 'MFS Gateway',
  'add-funds': 'Select Payment Method',
  'payment-detail': 'Deposit Details',
  'payment-collection': 'Bet Deposit',
  'payment-payout': 'Bet Payout',
  withdraw: 'Select Withdraw Method',
  'withdraw-form': 'Withdraw Funds',
  support: 'Help & Support',
  partners: 'Our Partners',
  social: 'Social Networks',
  affiliates: 'Affiliate Program',
};

const PROVIDERS: Array<'bkash' | 'nagad' | 'rocket'> = ['bkash', 'nagad', 'rocket'];
const MODES: Array<{ key: 'personal' | 'agent' | 'merchant'; label: string }> = [
  { key: 'personal', label: 'Personal Number' },
  { key: 'agent', label: 'Agent Number' },
  { key: 'merchant', label: 'Merchant Number' },
];

export function AgentSubScreens({
  screen,
  onBack,
  onNavigateSub,
  profile,
  primaryWallet,
  availableBalance,
  reservedBalance = 0,
  gateways,
  mfsRequests,
  mfsSchemaPending = false,
  referralCount,
  platformConfig,
  selectedDepositMethod,
  onSelectDepositMethod,
  planDepositLock,
  withdrawMethod,
  onSelectWithdrawMethod,
  onOpenGatewayModal,
  onOpenPinModal,
  onRefresh,
  onRefreshMfs,
  onToast,
}: AgentSubScreensProps) {
  const [refreshingMfs, setRefreshingMfs] = useState(false);
  // Deposit form state
  const [depAmount, setDepAmount] = useState(() => (planDepositLock ? String(planDepositLock.amount) : ''));
  const [depSender, setDepSender] = useState('');
  const [depTrxId, setDepTrxId] = useState('');
  const [depScreenshot, setDepScreenshot] = useState('');
  const [depSubmitting, setDepSubmitting] = useState(false);

  // MFS Payment request TrxID map
  const [mfsTrxMap, setMfsTrxMap] = useState<Record<string, string>>({});
  const [processingRequestId, setProcessingRequestId] = useState<string | null>(null);

  // Withdraw form state
  const [wdAmount, setWdAmount] = useState('');
  const [wdRecipientNum, setWdRecipientNum] = useState('');
  const [wdBankName, setWdBankName] = useState('');
  const [wdBankAccName, setWdBankAccName] = useState('');
  const [wdBankAccNum, setWdBankAccNum] = useState('');
  const [wdPin, setWdPin] = useState('');
  const [wdError, setWdError] = useState('');
  const [wdSubmitting, setWdSubmitting] = useState(false);

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onToast(`${label} কপি করা হয়েছে!`);
    } catch {
      onToast('কপি করা সম্ভব হয়নি।');
    }
  };

  const handleDepositScreenshot = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setDepScreenshot(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const handleDepositSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!primaryWallet || !selectedDepositMethod) {
      onToast('সক্রিয় BDT ওয়ালেট বা পেমেন্ট মেথড পাওয়া যায়নি। অনুগ্রহ করে পেজটি রিফ্রেশ করুন।');
      return;
    }
    const amt = planDepositLock ? planDepositLock.amount : Number(depAmount);
    if (!Number.isFinite(amt) || amt < 1000) {
      onToast('ন্যূনতম ডিপোজিট পরিমাণ ৳১,০০০।');
      return;
    }
    if (depSender.trim().length < 5 || depTrxId.trim().length < 4) {
      onToast('সঠিক প্রেরক নম্বর (কমপক্ষে ৫ অক্ষর) এবং TrxID (কমপক্ষে ৪ অক্ষর) আবশ্যক।');
      return;
    }

    setDepSubmitting(true);
    const res = await apiRequest('/api/deposits', {
      method: 'POST',
      body: JSON.stringify({
        walletId: primaryWallet.id,
        channel: selectedDepositMethod.id,
        senderAccount: depSender.trim(),
        externalTrxId: depTrxId.trim(),
        amount: amt,
        planActivation: planDepositLock?.plan || null,
        screenshotData: depScreenshot || null,
      }),
    });
    setDepSubmitting(false);

    if (!res.ok) {
      onToast(res.error || 'ডিপোজিট অনুরোধ জমা দেওয়া যায়নি।');
      return;
    }

    setDepAmount('');
    setDepSender('');
    setDepTrxId('');
    setDepScreenshot('');
    await onRefresh();
    onToast('ডিপোজিট রিকোয়েস্ট জমা হয়েছে! অ্যাডমিন অনুমোদনের পর ব্যালেন্স যুক্ত হবে।');
    onBack();
  };

  const handleApproveMfsRequest = async (reqItem: MfsPaymentRequest) => {
    const trxId = (mfsTrxMap[reqItem.id] || '').trim();
    if (reqItem.request_type === 'payment_collection' && trxId.length < 4) {
      onToast('অনুমোদন করার আগে বৈধ TrxID লিখুন।');
      return;
    }
    if (reqItem.request_type === 'payment_payout' && availableBalance < Number(reqItem.amount)) {
      onToast('পেমেন্ট পেআউট সম্পন্ন করতে আপনার ওয়ালেটে পর্যাপ্ত ব্যালেন্স নেই।');
      return;
    }

    setProcessingRequestId(reqItem.id);
    const res = await apiRequest<{ commissionAmount?: number; idempotentReplay?: boolean }>(
      `/api/mfs-requests/${reqItem.id}/approve`,
      {
        method: 'POST',
        body: JSON.stringify({ trxId }),
      }
    );
    setProcessingRequestId(null);

    if (!res.ok) {
      onToast(res.error || 'অনুমোদন ব্যর্থ হয়েছে।');
      return;
    }

    const creditedCommission = Number(res.data?.commissionAmount ?? reqItem.commission_amount);
    await onRefresh();
    onToast(
      reqItem.request_type === 'payment_collection'
        ? `পেমেন্ট কালেকশন অনুমোদিত! +${formatTaka(creditedCommission)} কমিশন যুক্ত হয়েছে।`
        : `পেমেন্ট পেআউট অনুমোদিত! +${formatTaka(creditedCommission)} কমিশন যুক্ত হয়েছে।`
    );
  };

  const handleDeclineMfsRequest = async (reqItem: MfsPaymentRequest) => {
    setProcessingRequestId(reqItem.id);
    const res = await apiRequest(`/api/mfs-requests/${reqItem.id}/decline`, {
      method: 'POST',
    });
    setProcessingRequestId(null);
    if (!res.ok) {
      onToast(res.error || 'প্রত্যাখ্যান ব্যর্থ হয়েছে।');
      return;
    }
    await onRefresh();
    onToast('রিকোয়েস্ট প্রত্যাখ্যান করা হয়েছে।');
  };

  const handleWithdrawSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!primaryWallet || wdSubmitting) return;
    setWdError('');
    const amt = Number(wdAmount);
    if (!Number.isFinite(amt) || amt < 500) {
      const msg = 'ন্যূনতম উইথড্র পরিমাণ ৳৫০০।';
      setWdError(msg);
      onToast(msg);
      return;
    }
    if (amt > availableBalance) {
      const msg = 'আপনার ওয়ালেটে পর্যাপ্ত ব্যালেন্স নেই।';
      setWdError(msg);
      onToast(msg);
      return;
    }
    if (!profile?.has_withdraw_pin) {
      const msg = 'উইথড্র করার আগে আপনার ৪–৬ সংখ্যার উইথড্র পিন সেট করুন।';
      setWdError(msg);
      onToast(msg);
      onOpenPinModal();
      return;
    }
    if (!/^\d{4,6}$/.test(wdPin.trim())) {
      const msg = 'সঠিক ৪–৬ সংখ্যার উইথড্র পিন লিখুন।';
      setWdError(msg);
      onToast(msg);
      return;
    }

    const destinationLabel =
      withdrawMethod === 'bank'
        ? `Bank: ${wdBankName.trim()} (${wdBankAccName.trim()})`
        : `${withdrawMethod.toUpperCase()} (${wdRecipientNum.trim()})`;
    const last4Source = withdrawMethod === 'bank' ? wdBankAccNum.trim() : wdRecipientNum.trim();
    if (!last4Source) {
      const msg = 'অনুগ্রহ করে প্রাপকের নম্বর বা ব্যাংক অ্যাকাউন্ট নম্বর দিন।';
      setWdError(msg);
      onToast(msg);
      return;
    }

    const cleanDestAccount = withdrawMethod === 'bank' ? wdBankAccNum.trim() : wdRecipientNum.trim();
    const idempotencyKey = `wd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    setWdSubmitting(true);
    const res = await apiRequest('/api/settlements', {
      method: 'POST',
      headers: {
        'X-Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        walletId: primaryWallet.id,
        amount: amt,
        destinationBank: destinationLabel,
        destinationAccount: cleanDestAccount,
        accountLast4: last4Source.slice(-4),
        withdrawPin: wdPin.trim(),
        idempotencyKey,
      }),
    });
    setWdSubmitting(false);

    if (!res.ok) {
      const errMsg = res.error || 'উইথড্র রিকোয়েস্ট ব্যর্থ হয়েছে।';
      setWdError(errMsg);
      onToast(errMsg);
      if (res.code === 'PIN_NOT_SET') {
        await onRefresh();
        onOpenPinModal();
      }
      return;
    }

    setWdAmount('');
    setWdRecipientNum('');
    setWdBankName('');
    setWdBankAccName('');
    setWdBankAccNum('');
    setWdPin('');
    setWdError('');
    await onRefresh();
    onToast('উইথড্র রিকোয়েস্ট সফলভাবে পাঠানো হয়েছে! অনুমোদন পর্যন্ত অর্থ সংরক্ষিত থাকবে।');
    onBack();
  };

  const enabledDepositMethods = platformConfig.depositMethods.filter((m) => m.enabled && m.accountNumber);

  // Affiliate Eligibility checks
  const accountAgeDays = profile?.created_at
    ? Math.floor((Date.now() - new Date(profile.created_at).getTime()) / (1000 * 60 * 60 * 24))
    : 0;
  const has30Days = accountAgeDays >= 30;
  const hasPremium = profile?.active_plan === 'premium';
  const affiliateEligible = has30Days && hasPremium;
  const referralUrl =
    typeof window !== 'undefined' && profile?.agent_code
      ? `${window.location.origin}/register?ref=${profile.agent_code}`
      : '';

  return (
    <section className="ew-screen ew-screen-no-nav">
      <div className="ew-page-header">
        <button type="button" className="ew-header-btn" onClick={onBack} aria-label="পিছনে যান">
          <ArrowLeft className="w-4 h-4 text-[#12251D]" />
        </button>
        <span className="ew-page-header-title">{SCREEN_TITLES[screen]}</span>
        <div className="w-10" />
      </div>

      {/* 1. MFS GATEWAY */}
      {screen === 'gateway' && (
        <div className="p-5 space-y-4">
          <div className="p-3.5 rounded-2xl bg-[#E9F7F0] border border-[#16A66A]/25 text-xs font-semibold text-[#075B3A]">
            গেটওয়ে নম্বর যোগ বা সক্রিয় করতে ওয়ালেটে ন্যূনতম ৳১,০০০ ব্যালেন্স প্রয়োজন। কোনো চার্জ কাটা হয় না (৳০)।
          </div>

          {PROVIDERS.map((provider) => (
            <div key={provider} className="bg-white rounded-3xl border border-[#E2EBE6] p-4 shadow-xs">
              <div className="flex items-center gap-3 pb-3 mb-3 border-b border-[#E2EBE6]">
                <MethodLogo method={provider} size={40} />
                <div>
                  <h3 className="text-sm font-extrabold text-[#12251D] uppercase">{provider}</h3>
                  <p className="text-[11px] font-medium text-[#6B7C73]">Personal, Agent ও Merchant গেটওয়ে</p>
                </div>
              </div>

              <div className="space-y-2.5">
                {MODES.map((mode) => {
                  const found = gateways.find(
                    (g) => g.provider === provider && g.account_mode === mode.key
                  );
                  return (
                    <div
                      key={mode.key}
                      className="bg-[#F4F7F5] border border-[#E2EBE6] rounded-2xl px-3.5 py-3 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <p className="text-xs font-extrabold text-[#12251D]">{mode.label}</p>
                        {found ? (
                          <p
                            className={`text-[11px] font-bold mt-0.5 ${
                              found.is_active ? 'text-[#075B3A]' : 'text-[#6B7C73]'
                            }`}
                          >
                            {found.account_number} · {found.is_active ? 'সক্রিয়' : 'নিষ্ক্রিয়'}
                          </p>
                        ) : (
                          <p className="text-[11px] font-semibold text-[#6B7C73] mt-0.5">
                            কনফিগার করা হয়নি
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          onOpenGatewayModal({
                            provider,
                            accountMode: mode.key,
                            existing: found,
                          })
                        }
                        className="px-3.5 py-1.5 rounded-full bg-white border border-[#E2EBE6] text-xs font-bold text-[#075B3A] hover:bg-[#E9F7F0] shrink-0 cursor-pointer"
                      >
                        {found ? 'সম্পাদনা' : 'যোগ করুন'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 2. ADD FUNDS / PAYMENT METHOD SELECT */}
      {screen === 'add-funds' && (
        <div className="p-5">
          {planDepositLock && (
            <div className="mb-4 p-3.5 rounded-2xl bg-[#E9F7F0] border border-[#16A66A]/30 text-xs font-bold text-[#075B3A]">
              {planDepositLock.plan === 'trial' ? 'Trial Plan' : 'Premium Plan'} আনলক করতে নির্ধারিত{' '}
              {formatTaka(planDepositLock.amount)} ডিপোজিটের জন্য নিচের একটি পেমেন্ট মাধ্যম নির্বাচন করুন।
            </div>
          )}

          {enabledDepositMethods.length === 0 ? (
            <div className="bg-white rounded-3xl border border-[#E2EBE6] p-8 text-center space-y-2">
              <p className="text-sm font-extrabold text-[#12251D]">কোনো পেমেন্ট মাধ্যম সক্রিয় নেই</p>
              <p className="text-xs text-[#6B7C73] leading-relaxed">
                সুপার অ্যাডমিন প্যানেল থেকে এখনো কোনো ডিপোজিট নম্বর কনফিগার করা হয়নি। অনুগ্রহ করে পরে চেষ্টা করুন বা সাপোর্টে যোগাযোগ করুন।
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3.5">
              {enabledDepositMethods.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    onSelectDepositMethod(m);
                    if (planDepositLock) {
                      setDepAmount(String(planDepositLock.amount));
                    }
                    onNavigateSub('payment-detail');
                  }}
                  className="bg-white border border-[#E2EBE6] hover:border-[#075B3A] rounded-2xl p-4 flex flex-col items-center gap-2.5 shadow-xs cursor-pointer"
                >
                  <MethodLogo method={m.id} size={50} />
                  <span className="text-sm font-extrabold text-[#12251D]">{m.name}</span>
                  {m.accountLabel && (
                    <span className="text-[10px] font-semibold text-[#6B7C73] text-center">{m.accountLabel}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 3. PAYMENT DETAILS / SUBMIT DEPOSIT */}
      {screen === 'payment-detail' && selectedDepositMethod && (
        <div className="p-5">
          <div className="bg-white rounded-3xl border border-[#E2EBE6] p-5 shadow-xs space-y-4">
            <div className="flex items-center gap-3">
              <MethodLogo method={selectedDepositMethod.id} size={42} />
              <div>
                <h3 className="text-sm font-extrabold text-[#12251D]">{selectedDepositMethod.name} ডিপোজিট</h3>
                <p className="text-[11px] font-semibold text-[#6B7C73]">
                  {selectedDepositMethod.accountLabel || 'অফিশিয়াল পেমেন্ট অ্যাকাউন্ট'}
                </p>
              </div>
            </div>

            <div className="bg-[#E9F7F0] border border-dashed border-[#16A66A] rounded-xl px-4 py-3.5 flex items-center justify-between gap-4">
              <span className="flex-1 min-w-0 pr-2 text-sm font-extrabold text-[#075B3A] font-mono tracking-wide break-all select-all">
                {selectedDepositMethod.accountNumber}
              </span>
              <button
                type="button"
                onClick={() => copyText(selectedDepositMethod.accountNumber, 'পেমেন্ট নম্বর')}
                className="px-4 py-1.5 rounded-full bg-[#075B3A] text-white text-[11px] font-bold shrink-0 cursor-pointer hover:bg-[#05452B] transition-colors"
              >
                কপি করুন
              </button>
            </div>

            <form onSubmit={handleDepositSubmit} className="space-y-3.5">
              <div>
                <label className="ew-input-label" htmlFor="dep-amt">ডিপোজিট পরিমাণ (৳)</label>
                <input
                  id="dep-amt"
                  type="number"
                  required
                  min={1000}
                  readOnly={Boolean(planDepositLock)}
                  value={planDepositLock ? String(planDepositLock.amount) : depAmount}
                  onChange={(e) => setDepAmount(e.target.value)}
                  placeholder="ন্যূনতম ১,০০০ টাকা"
                  className="ew-input-control no-icon"
                />
              </div>

              <div>
                <label className="ew-input-label" htmlFor="dep-sender">আপনার প্রেরক নম্বর / আইডি</label>
                <input
                  id="dep-sender"
                  type="text"
                  required
                  value={depSender}
                  onChange={(e) => setDepSender(e.target.value)}
                  placeholder="যেমন: 017XXXXXXXX"
                  className="ew-input-control no-icon"
                />
              </div>

              <div>
                <label className="ew-input-label" htmlFor="dep-trx">ট্রানজেকশন আইডি (TrxID)</label>
                <input
                  id="dep-trx"
                  type="text"
                  required
                  value={depTrxId}
                  onChange={(e) => setDepTrxId(e.target.value)}
                  placeholder="যেমন: 9A8B7C6D5E"
                  className="ew-input-control no-icon font-mono"
                />
              </div>

              <div>
                <span className="ew-input-label">পেমেন্ট স্ক্রিনশট (ঐচ্ছিক)</span>
                <label className="w-full h-24 border-2 border-dashed border-[#E2EBE6] rounded-xl bg-[#F4F7F5] flex items-center justify-center gap-2 cursor-pointer overflow-hidden">
                  {depScreenshot ? (
                    <img src={depScreenshot} alt="স্ক্রিনশট" className="w-full h-full object-cover" />
                  ) : (
                    <>
                      <Upload className="w-4 h-4 text-[#6B7C73]" />
                      <span className="text-xs font-semibold text-[#6B7C73]">স্ক্রিনশট আপলোড করুন</span>
                    </>
                  )}
                  <input type="file" accept="image/*" onChange={handleDepositScreenshot} className="hidden" />
                </label>
              </div>

              <button type="submit" disabled={depSubmitting} className="ew-btn">
                {depSubmitting ? 'জমা হচ্ছে...' : 'ডিপোজিট সাবমিট করুন'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* 4. MFS PAYMENT COLLECTION & PAYOUT (bKash 5%, Nagad 4%, Rocket 4%) */}
      {(screen === 'payment-collection' || screen === 'payment-payout') && (
        <div className="p-5 space-y-3.5">
          <div className="p-3.5 rounded-2xl bg-[#E9F7F0] border border-[#16A66A]/25 text-xs font-semibold text-[#075B3A] flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="block">প্রোভাইডার কমিশন হার:</span>
              <span className="font-bold">
                bKash {formatCommissionPercent(platformConfig.commissionRates.bkash)} · Nagad{' '}
                {formatCommissionPercent(platformConfig.commissionRates.nagad)} · Rocket{' '}
                {formatCommissionPercent(platformConfig.commissionRates.rocket)}
              </span>
            </div>
            <button
              type="button"
              disabled={refreshingMfs}
              onClick={async () => {
                setRefreshingMfs(true);
                await (onRefreshMfs ? onRefreshMfs() : onRefresh());
                setRefreshingMfs(false);
                onToast('রিকোয়েস্ট তালিকা রিফ্রেশ হয়েছে।');
              }}
              aria-label="রিকোয়েস্ট তালিকা রিফ্রেশ করুন"
              className="px-2.5 py-1.5 rounded-xl bg-white border border-[#16A66A]/30 text-[11px] font-bold text-[#075B3A] inline-flex items-center gap-1 cursor-pointer disabled:opacity-60"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshingMfs ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
          {mfsSchemaPending && (
            <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-300 text-xs text-amber-950 space-y-1">
              <p className="font-bold">সার্ভার ডাটাবেজ টেবিল অপেক্ষমাণ</p>
              <p>
                Supabase ডাটাবেজে <code className="font-mono">mfs_payment_requests</code> টেবিল এখনো তৈরি হয়নি। অ্যাডমিন মাইগ্রেশন সম্পন্ন করলে সকল {screen === 'payment-collection' ? 'Bet Deposit' : 'Bet Payout'} রিকোয়েস্ট এখানে দেখা যাবে।
              </p>
            </div>
          )}
          {(() => {
            const targetType = screen === 'payment-collection' ? 'payment_collection' : 'payment_payout';
            const filtered = mfsRequests.filter((b) => b.request_type === targetType);

            if (filtered.length === 0) {
              return (
                <div className="bg-white rounded-3xl border border-[#E2EBE6] p-8 text-center space-y-2">
                  <p className="text-sm font-extrabold text-[#12251D]">
                    কোনো {screen === 'payment-collection' ? 'Bet Deposit' : 'Bet Payout'} রিকোয়েস্ট নেই
                  </p>
                  <p className="text-xs text-[#6B7C73]">
                    নতুন রিকোয়েস্ট এলে এখানে স্বয়ংক্রিয়ভাবে প্রদর্শিত হবে।
                  </p>
                </div>
              );
            }

            return filtered.map((item) => {
              const isPending = item.status === 'pending';
              const isApproved = item.status === 'approved';
              return (
                <div
                  key={item.id}
                  className="bg-white rounded-3xl border border-[#E2EBE6] p-4 shadow-xs space-y-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <MethodLogo method={item.method} size={38} />
                      <div>
                        <p className="text-xs font-extrabold text-[#12251D] uppercase">
                          {item.method} ({item.account_mode})
                        </p>
                        <p className="text-[11px] font-mono text-[#6B7C73]">{item.reference_code}</p>
                      </div>
                    </div>
                    <span
                      className={`px-2.5 py-1 rounded-full text-[10px] font-extrabold ${
                        isApproved
                          ? 'bg-[#E9F7F0] text-[#075B3A]'
                          : isPending
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-red-100 text-[#E53935]'
                      }`}
                    >
                      {isApproved ? 'অনুমোদিত' : isPending ? 'অপেক্ষমাণ' : 'প্রত্যাখ্যাত'}
                    </span>
                  </div>

                  <div className="divide-y divide-[#F0F4F2] text-xs">
                    <div className="py-1.5 flex justify-between">
                      <span className="text-[#6B7C73] font-semibold">এজেন্ট নম্বর</span>
                      <span className="font-bold text-[#12251D] font-mono">{item.agent_account_number}</span>
                    </div>
                    {item.customer_account && (
                      <div className="py-1.5 flex justify-between">
                        <span className="text-[#6B7C73] font-semibold">গ্রাহক অ্যাকাউন্ট</span>
                        <span className="font-bold text-[#12251D] font-mono">{item.customer_account}</span>
                      </div>
                    )}
                    <div className="py-1.5 flex justify-between">
                      <span className="text-[#6B7C73] font-semibold">পরিমাণ</span>
                      <span className="font-extrabold text-[#12251D] tabular-nums">
                        {formatTaka(Number(item.amount))}
                      </span>
                    </div>
                    <div className="py-1.5 flex justify-between">
                      <span className="text-[#6B7C73] font-semibold">
                        কমিশন (
                        {formatCommissionPercent(
                          Number(item.commission_rate) > 0
                            ? Number(item.commission_rate)
                            : Number(item.amount) > 0
                              ? Number(item.commission_amount) / Number(item.amount)
                              : platformConfig.commissionRates[item.method]
                        )}
                        )
                      </span>
                      <span className="font-extrabold text-[#16A66A] tabular-nums">
                        +{formatTaka(Number(item.commission_amount))}
                      </span>
                    </div>
                    {item.trx_id && (
                      <div className="py-1.5 flex justify-between">
                        <span className="text-[#6B7C73] font-semibold">TrxID</span>
                        <span className="font-bold font-mono text-[#075B3A]">{item.trx_id}</span>
                      </div>
                    )}
                    <div className="py-1.5 flex justify-between">
                      <span className="text-[#6B7C73] font-semibold">সময়</span>
                      <span className="text-[#6B7C73]">{formatDateTime(item.created_at)}</span>
                    </div>
                  </div>

                  {isPending && (
                    <div className="space-y-2.5 pt-1">
                      {targetType === 'payment_collection' && (
                        <input
                          type="text"
                          value={mfsTrxMap[item.id] || ''}
                          onChange={(e) => setMfsTrxMap((prev) => ({ ...prev, [item.id]: e.target.value }))}
                          placeholder="প্রাপ্ত TrxID লিখুন"
                          className="ew-input-control no-icon font-mono"
                        />
                      )}
                      <div className="grid grid-cols-2 gap-2.5">
                        <button
                          type="button"
                          disabled={processingRequestId === item.id}
                          onClick={() => handleDeclineMfsRequest(item)}
                          className="ew-btn ew-btn-outline-danger py-2.5 text-xs"
                        >
                          প্রত্যাখ্যান
                        </button>
                        <button
                          type="button"
                          disabled={processingRequestId === item.id}
                          onClick={() => handleApproveMfsRequest(item)}
                          className="ew-btn py-2.5 text-xs"
                        >
                          {processingRequestId === item.id ? 'অপেক্ষা...' : 'অনুমোদন করুন'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            });
          })()}
        </div>
      )}

      {/* 5. WITHDRAW METHOD SELECT */}
      {screen === 'withdraw' && (
        <div className="p-5 grid grid-cols-2 gap-3.5">
          {([
            { id: 'bkash', label: 'bKash' },
            { id: 'nagad', label: 'Nagad' },
            { id: 'rocket', label: 'Rocket' },
            { id: 'bank', label: 'Bank Transfer' },
          ] as const).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelectWithdrawMethod(item.id);
                onNavigateSub('withdraw-form');
              }}
              className="bg-white border border-[#E2EBE6] hover:border-[#075B3A] rounded-2xl p-5 flex flex-col items-center gap-3 shadow-xs cursor-pointer"
            >
              <MethodLogo method={item.id} size={52} />
              <span className="text-sm font-extrabold text-[#12251D]">{item.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* 6. WITHDRAW FORM */}
      {screen === 'withdraw-form' && (
        <div className="p-5">
          <div className="bg-white rounded-3xl border border-[#E2EBE6] p-5 shadow-xs space-y-4">
            <div className="pb-3 border-b border-[#F0F4F2] space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#6B7C73]">উত্তোলনযোগ্য (ব্যবহারযোগ্য) ব্যালেন্স</span>
                <span className="text-base font-extrabold text-[#075B3A] tabular-nums">
                  {formatTaka(availableBalance)}
                </span>
              </div>
              {reservedBalance > 0 && (
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-[#6B7C73]">পেন্ডিং উইথড্র বাবদ সংরক্ষিত</span>
                  <span className="font-bold text-amber-700 tabular-nums">{formatTaka(reservedBalance)}</span>
                </div>
              )}
            </div>

            <form onSubmit={handleWithdrawSubmit} className="space-y-3.5">
              <div>
                <label className="ew-input-label" htmlFor="wd-amt">উইথড্র পরিমাণ (ন্যূনতম ৳৫০০)</label>
                <input
                  id="wd-amt"
                  type="number"
                  required
                  min={500}
                  value={wdAmount}
                  onChange={(e) => setWdAmount(e.target.value)}
                  placeholder="৳ ৫০০ বা তার বেশি"
                  className="ew-input-control no-icon"
                />
              </div>

              {withdrawMethod === 'bank' ? (
                <>
                  <div>
                    <label className="ew-input-label" htmlFor="wd-bank-name">ব্যাংকের নাম</label>
                    <input
                      id="wd-bank-name"
                      type="text"
                      required
                      value={wdBankName}
                      onChange={(e) => setWdBankName(e.target.value)}
                      placeholder="যেমন: ইসলামী ব্যাংক / ডাচ-বাংলা"
                      className="ew-input-control no-icon"
                    />
                  </div>
                  <div>
                    <label className="ew-input-label" htmlFor="wd-acc-name">অ্যাকাউন্টের নাম</label>
                    <input
                      id="wd-acc-name"
                      type="text"
                      required
                      value={wdBankAccName}
                      onChange={(e) => setWdBankAccName(e.target.value)}
                      placeholder="অ্যাকাউন্ট হোল্ডারের নাম"
                      className="ew-input-control no-icon"
                    />
                  </div>
                  <div>
                    <label className="ew-input-label" htmlFor="wd-acc-num">ব্যাংক অ্যাকাউন্ট নম্বর</label>
                    <input
                      id="wd-acc-num"
                      type="text"
                      required
                      value={wdBankAccNum}
                      onChange={(e) => setWdBankAccNum(e.target.value)}
                      placeholder="অ্যাকাউন্ট নম্বর লিখুন"
                      className="ew-input-control no-icon font-mono"
                    />
                  </div>
                </>
              ) : (
                <div>
                  <label className="ew-input-label" htmlFor="wd-mfs-num">
                    প্রাপক {withdrawMethod.toUpperCase()} নম্বর
                  </label>
                  <input
                    id="wd-mfs-num"
                    type="tel"
                    required
                    value={wdRecipientNum}
                    onChange={(e) => setWdRecipientNum(e.target.value)}
                    placeholder="01XXXXXXXXX"
                    className="ew-input-control no-icon font-mono"
                  />
                </div>
              )}

              {profile?.has_withdraw_pin ? (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-[13px] font-semibold text-[#12251D]" htmlFor="wd-pin">
                      উইথড্র পিন যাচাই করুন (৪–৬ সংখ্যা)
                    </label>
                    <button
                      type="button"
                      onClick={onOpenPinModal}
                      className="text-[11px] font-bold text-[#075B3A] hover:underline cursor-pointer"
                    >
                      পিন পরিবর্তন / ভুলে গেছেন?
                    </button>
                  </div>
                  <input
                    id="wd-pin"
                    type="password"
                    inputMode="numeric"
                    required
                    minLength={4}
                    maxLength={6}
                    value={wdPin}
                    onChange={(e) => {
                      setWdPin(e.target.value.replace(/\D/g, ''));
                      if (wdError) setWdError('');
                    }}
                    placeholder="••••"
                    className="ew-input-control no-icon font-mono tracking-widest"
                  />
                </div>
              ) : (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3.5 space-y-2.5">
                  <p className="text-xs font-semibold text-amber-900 leading-relaxed">
                    উইথড্র রিকোয়েস্ট পাঠানোর আগে একবার ৪–৬ সংখ্যার গোপন উইথড্র পিন সেট করুন।
                  </p>
                  <button
                    type="button"
                    onClick={onOpenPinModal}
                    className="w-full py-2.5 px-3 rounded-xl bg-[#075B3A] text-white text-xs font-bold hover:bg-[#05472D] transition cursor-pointer"
                  >
                    উইথড্র পিন সেট করুন
                  </button>
                </div>
              )}

              {wdError && (
                <p className="text-xs font-semibold text-[#E53935]">{wdError}</p>
              )}

              <button type="submit" disabled={wdSubmitting} className="ew-btn">
                {wdSubmitting ? 'যাচাই ও জমা হচ্ছে...' : 'উইথড্র রিকোয়েস্ট পাঠান'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* 7. HELP & SUPPORT */}
      {screen === 'support' && (
        <div className="p-5 space-y-3.5">
          <button
            type="button"
            onClick={() => {
              if (platformConfig.supportLinks.telegram) {
                window.open(platformConfig.supportLinks.telegram, '_blank', 'noopener,noreferrer');
              } else {
                onToast('টেলিগ্রাম সাপোর্ট লিংক এখনো কনফিগার করা হয়নি।');
              }
            }}
            className="w-full bg-white border border-[#E2EBE6] rounded-2xl p-4 flex items-center gap-3.5 shadow-xs text-left cursor-pointer"
          >
            <div className="w-12 h-12 rounded-2xl bg-[#E3F2FD] text-[#0088cc] flex items-center justify-center shrink-0">
              <Send className="w-6 h-6" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-extrabold text-[#12251D]">Telegram সাপোর্ট</p>
              <p className="text-xs text-[#6B7C73]">তাৎক্ষণিক এজেন্ট সহায়তার জন্য টেলিগ্রামে যুক্ত হোন</p>
            </div>
            <ExternalLink className="w-4 h-4 text-[#6B7C73]" />
          </button>

          <button
            type="button"
            onClick={() => {
              if (platformConfig.supportLinks.whatsapp) {
                window.open(platformConfig.supportLinks.whatsapp, '_blank', 'noopener,noreferrer');
              } else {
                onToast('হোয়াটসঅ্যাপ সাপোর্ট লিংক এখনো কনফিগার করা হয়নি।');
              }
            }}
            className="w-full bg-white border border-[#E2EBE6] rounded-2xl p-4 flex items-center gap-3.5 shadow-xs text-left cursor-pointer"
          >
            <div className="w-12 h-12 rounded-2xl bg-[#E9F7F0] text-[#16A66A] flex items-center justify-center shrink-0">
              <MessageCircle className="w-6 h-6" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-extrabold text-[#12251D]">WhatsApp সাপোর্ট</p>
              <p className="text-xs text-[#6B7C73]">হোয়াটসঅ্যাপের মাধ্যমে সাপোর্ট টিমের সাথে কথা বলুন</p>
            </div>
            <ExternalLink className="w-4 h-4 text-[#6B7C73]" />
          </button>
        </div>
      )}

      {/* 8. OUR PARTNERS */}
      {screen === 'partners' && (
        <div className="p-5">
          {platformConfig.partners.length === 0 ? (
            <div className="bg-white rounded-3xl border border-[#E2EBE6] p-8 text-center space-y-2">
              <p className="text-sm font-extrabold text-[#12251D]">কোনো পার্টনার তালিকাভুক্ত নেই</p>
              <p className="text-xs text-[#6B7C73]">
                সুপার অ্যাডমিন প্যানেল থেকে পার্টনার তথ্য যোগ করা হলে এখানে প্রদর্শিত হবে।
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {platformConfig.partners.map((p) => (
                <div
                  key={p.id}
                  className="bg-white border border-[#E2EBE6] rounded-2xl p-4 flex flex-col items-center text-center gap-2 shadow-xs"
                >
                  {p.logoUrl ? (
                    <img
                      src={p.logoUrl}
                      alt={p.name}
                      referrerPolicy="no-referrer"
                      className="w-12 h-12 rounded-xl object-contain"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-xl bg-[#E9F7F0] text-[#075B3A] font-extrabold flex items-center justify-center">
                      {p.name.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <p className="text-xs font-extrabold text-[#12251D]">{p.name}</p>
                  {p.description && <p className="text-[11px] text-[#6B7C73]">{p.description}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 9. SOCIAL NETWORK */}
      {screen === 'social' && (
        <div className="p-5">
          <div className="bg-white rounded-3xl border border-[#E2EBE6] p-4 shadow-xs">
            <div className="grid grid-cols-3 gap-2.5">
              {platformConfig.socialNetworks.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    if (s.url) {
                      window.open(s.url, '_blank', 'noopener,noreferrer');
                    } else {
                      onToast(`${s.name} লিংক এখনো কনফিগার করা হয়নি।`);
                    }
                  }}
                  className="bg-[#F4F7F5] border border-[#E2EBE6] rounded-2xl py-4 px-2 flex flex-col items-center gap-2 hover:bg-[#E9F7F0] cursor-pointer"
                >
                  <Share2 className="w-5 h-5 text-[#075B3A]" />
                  <span className="text-xs font-bold text-[#12251D]">{s.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 10. AFFILIATES PROGRAM */}
      {screen === 'affiliates' && (
        <div className="p-5 space-y-4">
          <div className="bg-gradient-to-br from-[#075B3A] to-[#043824] text-white rounded-3xl p-5 shadow-md">
            <h2 className="text-lg font-extrabold mb-1.5">ZentoPay অ্যাফিলিয়েট প্রোগ্রাম</h2>
            <p className="text-xs text-white/85 leading-relaxed">
              আপনার রেফারেল লিংক বা এজেন্ট আইডি ব্যবহার করে নতুন এজেন্ট যুক্ত করুন এবং তাদের প্রতিটি সফল কার্যক্রমে কমিশন অর্জন করুন।
            </p>
          </div>

          <div className="bg-white border border-[#E2EBE6] rounded-2xl p-4 space-y-3 shadow-xs">
            <h3 className="text-sm font-extrabold text-[#075B3A]">যোগদানের যোগ্যতা ও শর্তাবলী</h3>
            <div className="space-y-2.5 text-xs">
              <div className="flex items-start gap-2.5 pb-2 border-b border-[#F0F4F2]">
                <CheckCircle2 className={`w-4 h-4 shrink-0 mt-0.5 ${has30Days ? 'text-[#16A66A]' : 'text-[#6B7C73]'}`} />
                <div>
                  <p className="font-bold text-[#12251D]">১. অ্যাকাউন্টের বয়স কমপক্ষে ৩০ দিন ({accountAgeDays} দিন সম্পন্ন)</p>
                  <p className="text-[11px] text-[#6B7C73]">{has30Days ? 'যোগ্যতা অর্জিত' : '৩০ দিন পূর্ণ হলে সক্রিয় হবে'}</p>
                </div>
              </div>
              <div className="flex items-start gap-2.5 pb-2 border-b border-[#F0F4F2]">
                <CheckCircle2 className={`w-4 h-4 shrink-0 mt-0.5 ${hasPremium ? 'text-[#16A66A]' : 'text-[#6B7C73]'}`} />
                <div>
                  <p className="font-bold text-[#12251D]">২. সক্রিয় Premium Plan থাকতে হবে</p>
                  <p className="text-[11px] text-[#6B7C73]">{hasPremium ? 'Premium Plan সক্রিয় আছে' : 'বর্তমানে Premium Plan সক্রিয় নেই'}</p>
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-[#16A66A]" />
                <div>
                  <p className="font-bold text-[#12251D]">৩. ন্যূনতম ১৮+ বছর বয়সী যাচাইকৃত এজেন্ট হতে হবে</p>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-white border border-[#E2EBE6] rounded-2xl p-4 text-center">
              <p className="text-xl font-black text-[#075B3A]">১%</p>
              <p className="text-xs font-bold text-[#12251D] mt-1">ডিপোজিট কমিশন</p>
            </div>
            <div className="bg-white border border-[#E2EBE6] rounded-2xl p-4 text-center">
              <p className="text-xl font-black text-[#075B3A]">১%</p>
              <p className="text-xs font-bold text-[#12251D] mt-1">পেআউট কমিশন</p>
            </div>
          </div>

          <div className="bg-white border border-[#E2EBE6] rounded-2xl p-4 space-y-3">
            <div className="bg-[#E9F7F0] border border-[#16A66A]/25 rounded-xl px-3 py-2 flex items-center justify-between gap-2">
              <div>
                <span className="text-[10px] font-bold text-[#6B7C73] block">আপনার স্থায়ী এজেন্ট আইডি</span>
                <span className="text-xs font-extrabold font-mono text-[#075B3A]">
                  {profile?.agent_code || '—'}
                </span>
              </div>
              {profile?.agent_code && (
                <button
                  type="button"
                  onClick={() => copyText(profile.agent_code!, 'এজেন্ট আইডি')}
                  className="px-2.5 py-1 rounded-lg bg-white border border-[#E2EBE6] text-[11px] font-bold text-[#075B3A] inline-flex items-center gap-1 cursor-pointer"
                >
                  <Copy className="w-3 h-3" />
                  কপি
                </button>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-extrabold text-[#12251D]">আপনার অ্যাফিলিয়েট লিংক</span>
              <span className="text-[11px] font-bold text-[#075B3A]">রেফারেল: {referralCount} জন</span>
            </div>
            <div className="bg-[#F4F7F5] border border-[#E2EBE6] rounded-xl p-2.5 flex items-center justify-between gap-2">
              <span className="text-[11px] font-mono text-[#12251D] truncate">
                {referralUrl || 'অ্যাকাউন্ট লোড হচ্ছে...'}
              </span>
              {referralUrl && (
                <button
                  type="button"
                  onClick={() => copyText(referralUrl, 'অ্যাফিলিয়েট লিংক')}
                  className="p-1.5 rounded-lg bg-[#075B3A] text-white shrink-0 cursor-pointer"
                  aria-label="লিংক কপি করুন"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <p className="text-[11px] font-semibold text-[#6B7C73]">
              বর্তমান অবস্থা: {affiliateEligible ? '✅ অ্যাফিলিয়েট কমিশন পাওয়ার জন্য যোগ্য' : '⏳ শর্ত পূরণ সাপেক্ষে কমিশন চালু হবে'}
            </p>
          </div>

          {platformConfig.supportLinks.affiliateManagerTelegram && (
            <a
              href={platformConfig.supportLinks.affiliateManagerTelegram}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-white border border-[#E2EBE6] rounded-2xl p-3.5 flex items-center gap-3 text-decoration-none"
            >
              <div className="w-9 h-9 rounded-full bg-[#0088cc] text-white flex items-center justify-center shrink-0">
                <Send className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <p className="text-[11px] text-[#6B7C73]">অ্যাফিলিয়েট ম্যানেজার</p>
                <p className="text-xs font-extrabold text-[#0088cc]">টেলিগ্রামে যোগাযোগ করুন</p>
              </div>
              <ExternalLink className="w-4 h-4 text-[#0088cc]" />
            </a>
          )}

          <div className="rounded-xl bg-[#FFF8E7] border border-[#F4E4B8] p-3.5 text-[11px] text-[#7A5B12] leading-relaxed">
            <strong>বিশেষ দ্রষ্টব্য:</strong> ৩০ দিনের অ্যাকাউন্ট বয়স এবং সক্রিয় Premium Plan থাকা সাপেক্ষে আপনার রেফার করা এজেন্টদের পেমেন্ট কালেকশন ও পেআউট থেকে ১% কমিশন সরাসরি ওয়ালেটে যোগ হয়।
          </div>
        </div>
      )}
    </section>
  );
}
