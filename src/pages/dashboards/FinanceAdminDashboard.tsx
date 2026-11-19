import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowDownUp,
  ArrowUpFromLine,
  ArrowUpRight,
  Clock,
  FileSpreadsheet,
  Landmark,
  LayoutDashboard,
  RefreshCw,
  Scale,
} from 'lucide-react';
import { DashboardLayout, type DashboardNavItem } from '../../components/DashboardLayout.tsx';
import { StatMetricCard } from '../../components/StatMetricCard.tsx';
import { DataTable, type TableColumn } from '../../components/DataTable.tsx';
import { WithdrawalRequestsPanel } from '../../components/admin/WithdrawalRequestsPanel.tsx';
import { DepositRequestsPanel } from '../../components/admin/DepositRequestsPanel.tsx';
import { MfsDispatchPanel, type AgentDirectoryRow } from '../../components/admin/MfsDispatchPanel.tsx';
import { useAuth } from '../../context/AuthContext.tsx';
import { apiRequest, formatCurrency, formatDateTime, formatTaka } from '../../lib/api.ts';
import type { MfsPaymentRequest, SettlementRequest, TransactionRecord } from '../../types/zentopay.ts';

const NAV_ITEMS: DashboardNavItem[] = [
  { id: 'overview', label: 'ড্যাশবোর্ড', icon: LayoutDashboard, section: 'প্রধান' },
  { id: 'withdrawals', label: 'উইথড্র রিকোয়েস্ট', icon: ArrowUpRight, section: 'আর্থিক ও রিকোয়েস্ট' },
  { id: 'deposits', label: 'ডিপোজিট রিকোয়েস্ট', icon: ArrowDownLeft, section: 'আর্থিক ও রিকোয়েস্ট' },
  { id: 'bet_deposit', label: 'Bet Deposit', icon: ArrowDownToLine, section: 'আর্থিক ও রিকোয়েস্ট' },
  { id: 'bet_payout', label: 'Bet Payout', icon: ArrowUpFromLine, section: 'আর্থিক ও রিকোয়েস্ট' },
  { id: 'transactions', label: 'লেনদেন', icon: ArrowDownUp, section: 'হিসাব ও রিপোর্ট' },
  { id: 'reports', label: 'রিপোর্ট', icon: FileSpreadsheet, section: 'হিসাব ও রিপোর্ট' },
];

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

export function FinanceAdminDashboard() {
  const { profile, platformConfig, refreshAccountData } = useAuth();
  const [activeTab, setActiveTab] = useState('overview');
  const [loadingData, setLoadingData] = useState(false);

  const [settlements, setSettlements] = useState<SettlementRequest[]>([]);
  const [allDeposits, setAllDeposits] = useState<TransactionRecord[]>([]);
  const [ledgerRows, setLedgerRows] = useState<TransactionRecord[]>([]);
  const [mfsRequests, setMfsRequests] = useState<MfsPaymentRequest[]>([]);
  const [agentsList, setAgentsList] = useState<AgentDirectoryRow[]>([]);
  const [mfsSchemaPending, setMfsSchemaPending] = useState(false);
  const [mfsLoadError, setMfsLoadError] = useState<string | null>(null);
  const [stats, setStats] = useState({
    totalCustodyBalance: 0,
    totalReservedBalance: 0,
    collectedFeeRevenue: 0,
    netLedgerDiscrepancy: 0,
  });

  const loadFinanceOverview = useCallback(async () => {
    if (!profile) return;
    setLoadingData(true);
    const [finRes, mfsRes] = await Promise.all([
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

    if (finRes.ok && finRes.data) {
      setSettlements(finRes.data.settlements ?? []);
      setAllDeposits(finRes.data.deposits ?? finRes.data.pendingDeposits ?? []);
      setLedgerRows(finRes.data.transactions ?? []);
      if (finRes.data.stats) {
        setStats({
          totalCustodyBalance: Number(finRes.data.stats.totalCustodyBalance || 0),
          totalReservedBalance: Number(finRes.data.stats.totalReservedBalance || 0),
          collectedFeeRevenue: Number(finRes.data.stats.collectedFeeRevenue || 0),
          netLedgerDiscrepancy: Number(finRes.data.stats.netLedgerDiscrepancy || 0),
        });
      }
    }

    if (mfsRes.ok && mfsRes.data) {
      setMfsRequests(mfsRes.data.mfsRequests ?? []);
      setAgentsList(mfsRes.data.agents ?? []);
      setMfsSchemaPending(Boolean(mfsRes.data.schemaPending));
      setMfsLoadError(mfsRes.data.mfsError || mfsRes.data.rlsError || null);
    } else if (!mfsRes.ok) {
      setMfsLoadError(mfsRes.error || 'Bet Deposit / Bet Payout তালিকা লোড করা যায়নি।');
    }
  }, [profile]);

  useEffect(() => {
    void loadFinanceOverview();
  }, [loadFinanceOverview]);

  const handleRefreshAll = useCallback(async () => {
    await Promise.all([loadFinanceOverview(), refreshAccountData()]);
  }, [loadFinanceOverview, refreshAccountData]);

  const pendingWithdrawalsCount = useMemo(
    () => settlements.filter((s) => s.status === 'pending').length,
    [settlements]
  );

  const pendingDepositsCount = useMemo(
    () => allDeposits.filter((d) => d.status === 'pending').length,
    [allDeposits]
  );

  const ledgerColumns: TableColumn<TransactionRecord>[] = [
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
      csvValue: (r) => `${r.initiator_name || ''} ${r.initiator_agent_code || ''}`,
    },
    {
      key: 'type',
      header: 'চ্যানেল ও বিবরণ',
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

  return (
    <DashboardLayout
      role="finance_admin"
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
          label="প্ল্যাটফর্ম কাস্টডি ব্যালেন্স"
          value={formatTaka(stats.totalCustodyBalance)}
          helper="সক্রিয় ওয়ালেট মোট ব্যালেন্স"
          icon={Landmark}
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
            helper={`সংরক্ষিত ব্যালেন্স: ${formatTaka(stats.totalReservedBalance)} · ক্লিক করে দেখুন`}
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
            helper="TrxID যাচাই করে ব্যালেন্স দিন"
            icon={ArrowDownLeft}
            tone="amber"
          />
        </button>
        <StatMetricCard
          label="সংগৃহীত ফি আয়"
          value={formatTaka(stats.collectedFeeRevenue)}
          helper="যাচাইকৃত প্ল্যাটফর্ম প্রসেসিং ফি"
          icon={FileSpreadsheet}
        />
      </div>

      {/* 1. OVERVIEW */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-bold text-slate-950">ফাইন্যান্স পরিচালনা ড্যাশবোর্ড</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  সহজ ধাপে উইথড্র রিকোয়েস্ট অনুমোদন, ডিপোজিট যাচাই এবং এজেন্টদের Bet Deposit / Bet Payout পাঠান।
                </p>
              </div>
              <button
                type="button"
                disabled={loadingData}
                onClick={() => void handleRefreshAll()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg cursor-pointer self-start disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingData ? 'animate-spin' : ''}`} />
                রিফ্রেশ
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
                <p className="text-[11px] text-emerald-800 mt-1">ব্যালেন্স ক্রেডিট যাচাই করুন</p>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('bet_deposit')}
                className="p-4 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-left cursor-pointer transition-colors"
              >
                <p className="text-xs font-bold text-slate-900">Bet Deposit</p>
                <p className="text-[11px] text-slate-600 mt-1">কালেকশন রিকোয়েস্ট পাঠান</p>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('bet_payout')}
                className="p-4 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-left cursor-pointer transition-colors"
              >
                <p className="text-xs font-bold text-slate-900">Bet Payout</p>
                <p className="text-[11px] text-slate-600 mt-1">পেআউট রিকোয়েস্ট পাঠান</p>
              </button>
            </div>
          </div>

          <WithdrawalRequestsPanel
            settlements={settlements}
            onRefresh={handleRefreshAll}
            loading={loadingData}
          />
        </div>
      )}

      {/* 2. WITHDRAWAL REQUESTS */}
      {activeTab === 'withdrawals' && (
        <WithdrawalRequestsPanel
          settlements={settlements}
          onRefresh={handleRefreshAll}
          loading={loadingData}
        />
      )}

      {/* 3. DEPOSIT REQUESTS */}
      {activeTab === 'deposits' && (
        <DepositRequestsPanel
          deposits={allDeposits}
          onRefresh={handleRefreshAll}
          loading={loadingData}
        />
      )}

      {/* 4. BET DEPOSIT */}
      {activeTab === 'bet_deposit' && (
        <MfsDispatchPanel
          mode="collection"
          mfsRequests={mfsRequests}
          agentsList={agentsList}
          commissionRates={platformConfig.commissionRates}
          schemaPending={mfsSchemaPending}
          loadError={mfsLoadError}
          onRefresh={handleRefreshAll}
        />
      )}

      {/* 5. BET PAYOUT */}
      {activeTab === 'bet_payout' && (
        <MfsDispatchPanel
          mode="payout"
          mfsRequests={mfsRequests}
          agentsList={agentsList}
          commissionRates={platformConfig.commissionRates}
          schemaPending={mfsSchemaPending}
          loadError={mfsLoadError}
          onRefresh={handleRefreshAll}
        />
      )}

      {/* 6. TRANSACTIONS */}
      {activeTab === 'transactions' && (
        <DataTable
          title="সকল লেনদেনের তালিকা"
          subtitle="ডিপোজিট, উইথড্র, Bet Deposit, Bet Payout এবং কমিশনের পূর্ণ বিবরণ"
          rows={ledgerRows}
          columns={ledgerColumns}
          searchPlaceholder="রেফারেন্স, এজেন্ট নাম, #67XXXXXX বা বিবরণ..."
          getSearchText={(r) =>
            `${r.reference_code} ${r.initiator_name || ''} ${r.initiator_agent_code || ''} ${r.tx_type} ${r.description || ''}`
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
              onClick={() => void handleRefreshAll()}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingData ? 'animate-spin' : ''}`} />
              রিফ্রেশ
            </button>
          }
          emptyTitle="কোনো লেনদেন পাওয়া যায়নি"
          emptyDescription="প্ল্যাটফর্মে লেনদেন সম্পন্ন হলে এখানে প্রদর্শিত হবে।"
          exportFilename="zentopay-finance-transactions.csv"
        />
      )}

      {/* 7. FINANCIAL REPORTS */}
      {activeTab === 'reports' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatMetricCard
              label="মোট কাস্টডি ব্যালেন্স"
              value={formatTaka(stats.totalCustodyBalance)}
              helper="সক্রিয় ওয়ালেট সমষ্টি"
              icon={Landmark}
              tone="emerald"
            />
            <StatMetricCard
              label="সংরক্ষিত / হোল্ড ব্যালেন্স"
              value={formatTaka(stats.totalReservedBalance)}
              helper="অপেক্ষমাণ উইথড্র বাবদ সংরক্ষিত"
              icon={Clock}
              tone="amber"
            />
            <StatMetricCard
              label="সংগৃহীত ফি আয়"
              value={formatTaka(stats.collectedFeeRevenue)}
              helper="সম্পন্ন লেনদেন ফি"
              icon={FileSpreadsheet}
            />
            <StatMetricCard
              label="লেজার অসামঞ্জস্য"
              value={formatTaka(stats.netLedgerDiscrepancy)}
              helper="ডেবিট ও ক্রেডিট সমতার পার্থক্য"
              icon={Scale}
            />
          </div>

          <DataTable
            title="ডাবল-এন্ট্রি আর্থিক সমন্বয় ও রিপোর্ট"
            subtitle="তারিখ অনুযায়ী ফিল্টার করে CSV লেজার রিপোর্ট ডাউনলোড করুন"
            rows={ledgerRows}
            columns={ledgerColumns}
            getSearchText={(r) => `${r.reference_code} ${r.tx_type} ${r.initiator_name || ''}`}
            enableDateFilter
            getDateValue={(r) => r.created_at}
            emptyTitle="কোনো সমন্বয় রেকর্ড লোড হয়নি"
            emptyDescription="সম্পন্ন PostgreSQL লেনদেন স্বয়ংক্রিয়ভাবে এখানে যুক্ত হয়।"
            exportFilename="zentopay-finance-reconciliation.csv"
          />
        </div>
      )}
    </DashboardLayout>
  );
}
