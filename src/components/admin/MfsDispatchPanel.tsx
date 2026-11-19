import React, { useEffect, useState } from 'react';
import { RefreshCw, Send } from 'lucide-react';
import { DataTable, type TableColumn } from '../DataTable.tsx';
import { ModalDrawer } from '../ModalDrawer.tsx';
import { apiRequest, formatDateTime, formatTaka } from '../../lib/api.ts';
import {
  computeCommissionAmount,
  formatCommissionPercent,
  getAuthoritativeProviderRate,
} from '../../lib/commissions.ts';
import type { CommissionRatesConfig, MfsPaymentRequest } from '../../types/zentopay.ts';

export interface AgentDirectoryRow {
  id: string;
  full_name: string;
  email: string;
  phone?: string | null;
  agent_code: string | null;
  role: string;
  active_plan: string | null;
  kyc_status?: string;
  is_frozen?: boolean;
}

interface MfsDispatchPanelProps {
  mode: 'collection' | 'payout' | 'all';
  mfsRequests: MfsPaymentRequest[];
  agentsList: AgentDirectoryRow[];
  commissionRates: CommissionRatesConfig;
  schemaPending: boolean;
  loadError: string | null;
  onRefresh: () => Promise<void>;
}

const MFS_STATUS_BN: Record<string, { label: string; cls: string }> = {
  pending: { label: 'অপেক্ষমাণ', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  approved: { label: 'অনুমোদিত', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  declined: { label: 'প্রত্যাখ্যাত', cls: 'bg-rose-50 text-rose-800 border-rose-200' },
};

export function MfsDispatchPanel({
  mode,
  mfsRequests,
  agentsList,
  commissionRates,
  schemaPending,
  loadError,
  onRefresh,
}: MfsDispatchPanelProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [agentSearch, setAgentSearch] = useState('');
  const [mfsAgentIdent, setMfsAgentIdent] = useState('');
  const [mfsRequestType, setMfsRequestType] = useState<'payment_collection' | 'payment_payout'>(
    mode === 'payout' ? 'payment_payout' : 'payment_collection'
  );
  const [mfsMethod, setMfsMethod] = useState<'bkash' | 'nagad' | 'rocket'>('bkash');
  const [mfsAccountMode, setMfsAccountMode] = useState<'personal' | 'agent' | 'merchant'>('personal');
  const [mfsAgentNumber, setMfsAgentNumber] = useState('');
  const [mfsCustomerAcc, setMfsCustomerAcc] = useState('');
  const [mfsAmount, setMfsAmount] = useState('');
  const [mfsMsg, setMfsMsg] = useState('');
  const [mfsSubmitting, setMfsSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    setMfsRequestType(mode === 'payout' ? 'payment_payout' : 'payment_collection');
  }, [mode]);

  useEffect(() => {
    if (!modalOpen || mfsAgentIdent || agentsList.length === 0) return;
    const activeAgents = agentsList.filter((a) => !a.is_frozen);
    if (activeAgents.length > 0) {
      setMfsAgentIdent(activeAgents[0].id);
    }
  }, [modalOpen, mfsAgentIdent, agentsList]);

  const scopedRequests = mfsRequests.filter((r) => {
    if (mode === 'collection') return r.request_type === 'payment_collection';
    if (mode === 'payout') return r.request_type === 'payment_payout';
    return true;
  });

  const filteredAgentsList = agentsList.filter((a) => {
    const q = agentSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      a.full_name.toLowerCase().includes(q) ||
      a.email.toLowerCase().includes(q) ||
      (a.phone || '').toLowerCase().includes(q) ||
      (a.agent_code || '').toLowerCase().includes(q) ||
      a.id.toLowerCase().includes(q)
    );
  });

  const normalizedIdent = mfsAgentIdent.trim().replace(/^#+/, '');
  const matchedSelectedAgent = agentsList.find(
    (a) =>
      a.id === mfsAgentIdent.trim() ||
      a.email.toLowerCase() === mfsAgentIdent.trim().toLowerCase() ||
      (a.agent_code && a.agent_code === normalizedIdent) ||
      (a.phone && a.phone === mfsAgentIdent.trim())
  );

  const selectedProviderRate = getAuthoritativeProviderRate(mfsMethod, commissionRates);
  const numericPreviewAmount = Number(mfsAmount);
  const previewCommission =
    Number.isFinite(numericPreviewAmount) && numericPreviewAmount > 0
      ? computeCommissionAmount(numericPreviewAmount, mfsMethod, commissionRates).commissionAmount
      : 0;

  const openModal = () => {
    setMfsMsg('');
    setAgentSearch('');
    setMfsRequestType(mode === 'payout' ? 'payment_payout' : 'payment_collection');
    const activeAgents = agentsList.filter((a) => !a.is_frozen);
    if (!mfsAgentIdent && activeAgents.length > 0) {
      setMfsAgentIdent(activeAgents[0].id);
    }
    setModalOpen(true);
  };

  const handleDispatchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMfsMsg('');
    const amt = Number(mfsAmount);
    if (!mfsAgentIdent.trim() || !mfsAgentNumber.trim() || !Number.isFinite(amt) || amt <= 0) {
      setMfsMsg('এজেন্ট নির্বাচন, এজেন্ট MFS নম্বর এবং সঠিক BDT পরিমাণ প্রদান করুন।');
      return;
    }
    const idempotencyKey = `mfs-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    setMfsSubmitting(true);
    const res = await apiRequest<MfsPaymentRequest>('/api/admin/mfs-requests', {
      method: 'POST',
      headers: {
        'X-Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        agentIdentifier: mfsAgentIdent.trim(),
        requestType: mfsRequestType,
        method: mfsMethod,
        accountMode: mfsAccountMode,
        agentAccountNumber: mfsAgentNumber.trim(),
        customerAccount: mfsCustomerAcc.trim() || null,
        amount: amt,
        idempotencyKey,
      }),
    });
    setMfsSubmitting(false);

    if (res.ok && res.data) {
      const resolvedRatePct = formatCommissionPercent(Number(res.data.commission_rate));
      setMfsMsg(
        `রিকোয়েস্ট ${res.data.reference_code} সফলভাবে পাঠানো হয়েছে (${res.data.method.toUpperCase()} ${resolvedRatePct} কমিশন)।`
      );
      setMfsAmount('');
      setMfsCustomerAcc('');
      await onRefresh();
    } else {
      setMfsMsg(res.error || 'রিকোয়েস্ট পাঠানো যায়নি।');
    }
  };

  const featureLabel = mode === 'collection' ? 'Bet Deposit' : mode === 'payout' ? 'Bet Payout' : 'Bet Deposit ও Bet Payout';

  const columns: TableColumn<MfsPaymentRequest>[] = [
    {
      key: 'ref',
      header: 'রেফারেন্স ও ধরন',
      render: (r) => (
        <div>
          <p className="font-mono text-xs font-semibold text-slate-900">{r.reference_code}</p>
          <p className="text-[11px] text-slate-500">
            {r.request_type === 'payment_collection' ? 'Bet Deposit' : 'Bet Payout'} (
            {formatCommissionPercent(Number(r.commission_rate))})
          </p>
        </div>
      ),
      csvValue: (r) => `${r.reference_code} ${r.request_type}`,
    },
    {
      key: 'agent',
      header: 'এজেন্ট',
      render: (r) => {
        const matched = agentsList.find((a) => a.id === r.agent_id);
        const agentName = r.agent_name || matched?.full_name || 'Agent';
        const agentCode = r.agent_code || matched?.agent_code;
        return (
          <div>
            <p className="text-xs font-semibold text-slate-900">{agentName}</p>
            <p className="text-[11px] font-mono text-slate-500">
              {agentCode ? `#${agentCode}` : r.agent_id.slice(0, 8)}
            </p>
          </div>
        );
      },
      csvValue: (r) => {
        const matched = agentsList.find((a) => a.id === r.agent_id);
        return `${r.agent_name || matched?.full_name || ''} ${r.agent_code || matched?.agent_code || r.agent_id}`;
      },
    },
    {
      key: 'method',
      header: 'MFS ও নম্বর',
      render: (r) => (
        <div>
          <p className="text-xs font-semibold uppercase text-slate-800">
            {r.method} ({r.account_mode})
          </p>
          <p className="text-[11px] font-mono text-slate-500">{r.agent_account_number}</p>
        </div>
      ),
      csvValue: (r) => `${r.method} ${r.agent_account_number}`,
    },
    {
      key: 'amount',
      header: 'পরিমাণ ও কমিশন',
      align: 'right',
      render: (r) => (
        <div>
          <p className="font-mono tabular-nums text-xs font-semibold">{formatTaka(Number(r.amount))}</p>
          <p className="font-mono tabular-nums text-[11px] text-emerald-700">
            +{formatTaka(Number(r.commission_amount))}
          </p>
        </div>
      ),
      csvValue: (r) => r.amount,
    },
    {
      key: 'status',
      header: 'TrxID ও অবস্থা',
      render: (r) => {
        const meta = MFS_STATUS_BN[r.status] || { label: r.status, cls: 'bg-slate-100 text-slate-700 border-slate-200' };
        return (
          <div className="space-y-0.5">
            <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold border ${meta.cls}`}>
              {meta.label}
            </span>
            {r.trx_id && <p className="text-[11px] font-mono text-slate-500">{r.trx_id}</p>}
          </div>
        );
      },
      csvValue: (r) => `${r.status} ${r.trx_id || ''}`,
    },
    {
      key: 'time',
      header: 'সময়',
      align: 'right',
      render: (r) => <span className="text-xs text-slate-500 tabular-nums">{formatDateTime(r.created_at)}</span>,
      csvValue: (r) => r.created_at,
    },
  ];

  return (
    <div className="space-y-5">
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-bold text-slate-950">{featureLabel} পরিচালনা</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            সক্রিয় এজেন্টের গেটওয়ে নম্বরে {featureLabel} রিকোয়েস্ট পাঠান। বর্তমান কমিশন হার: bKash{' '}
            {formatCommissionPercent(commissionRates.bkash)}, Nagad {formatCommissionPercent(commissionRates.nagad)}, Rocket{' '}
            {formatCommissionPercent(commissionRates.rocket)}।
          </p>
        </div>
        <button
          type="button"
          onClick={openModal}
          className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer whitespace-nowrap"
        >
          <Send className="w-4 h-4" />
          নতুন {mode === 'all' ? 'MFS রিকোয়েস্ট' : featureLabel} পাঠান
        </button>
      </div>

      {(schemaPending || loadError) && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-950 space-y-1">
          <p className="font-bold">
            {schemaPending
              ? 'Supabase ডাটাবেজে mfs_payment_requests টেবিল এখনো প্রয়োগ করা হয়নি'
              : 'রিকোয়েস্ট তালিকা লোড করতে ত্রুটি হয়েছে'}
          </p>
          <p>
            {schemaPending
              ? 'এজেন্টের ড্যাশবোর্ডে Bet Deposit এবং Bet Payout রিকোয়েস্ট পৌঁছাতে অনুগ্রহ করে supabase/migrations/004_mfs_requests_and_notifications.sql মাইগ্রেশনটি চালান।'
              : loadError}
          </p>
        </div>
      )}

      <DataTable
        title={`${featureLabel} তালিকা`}
        subtitle="সকল পাঠানো রিকোয়েস্ট ও এজেন্ট অনুমোদনের বর্তমান অবস্থা"
        rows={scopedRequests}
        columns={columns}
        searchPlaceholder="এজেন্ট নাম, #67XXXXXX, নম্বর বা TrxID..."
        getSearchText={(r) => {
          const matched = agentsList.find((a) => a.id === r.agent_id);
          return `${r.reference_code} ${r.agent_name || matched?.full_name || ''} ${r.agent_code || matched?.agent_code || ''} ${r.agent_account_number} ${r.method} ${r.trx_id || ''}`;
        }}
        filterOptions={[
          { value: 'all', label: 'সকল' },
          { value: 'pending', label: 'অপেক্ষমাণ' },
          { value: 'approved', label: 'অনুমোদিত' },
          { value: 'declined', label: 'প্রত্যাখ্যাত' },
        ]}
        getFilterValue={(r) => r.status}
        enableDateFilter
        getDateValue={(r) => r.created_at}
        toolbarExtra={
          <button
            type="button"
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              await onRefresh();
              setRefreshing(false);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            রিফ্রেশ
          </button>
        }
        emptyTitle={`কোনো ${featureLabel} রিকোয়েস্ট নেই`}
        emptyDescription="উপরের বাটনে ক্লিক করে একজন এজেন্টের কাছে নতুন রিকোয়েস্ট পাঠান।"
        emptyActionLabel={`নতুন ${mode === 'all' ? 'রিকোয়েস্ট' : featureLabel} পাঠান`}
        onEmptyAction={openModal}
        exportFilename={`zentopay-${mode}-requests.csv`}
      />

      <ModalDrawer
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={`নতুন ${mode === 'all' ? 'Bet Deposit / Bet Payout' : featureLabel} রিকোয়েস্ট পাঠান`}
        description="সঠিক এজেন্ট ও তার MFS নম্বর নির্বাচন করে রিকোয়েস্ট পাঠান"
      >
        <form onSubmit={handleDispatchSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="mfs-agent-ident" className="block text-xs font-semibold text-slate-700">
              এজেন্ট খুঁজুন ও নির্বাচন করুন ({agentsList.length} জন এজেন্ট)
            </label>
            {agentsList.length > 0 && (
              <>
                <input
                  type="text"
                  value={agentSearch}
                  onChange={(e) => setAgentSearch(e.target.value)}
                  placeholder="নাম, ইমেইল, ফোন নম্বর বা Agent ID দিয়ে খুঁজুন..."
                  className="w-full px-3.5 py-2 text-xs border border-slate-200 rounded-lg bg-slate-50"
                />
                <select
                  aria-label="এজেন্ট তালিকা থেকে নির্বাচন করুন"
                  value={agentsList.some((a) => a.id === mfsAgentIdent) ? mfsAgentIdent : ''}
                  onChange={(e) => setMfsAgentIdent(e.target.value)}
                  className="w-full px-3.5 py-2 text-xs border border-slate-200 rounded-lg"
                >
                  <option value="">-- তালিকা থেকে এজেন্ট বাছাই করুন ({filteredAgentsList.length}টি) --</option>
                  {filteredAgentsList.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.full_name} · {a.agent_code ? `#${a.agent_code}` : a.phone || a.role} · {a.email}
                      {a.is_frozen ? ' (ফ্রিজ)' : ''}
                    </option>
                  ))}
                </select>
              </>
            )}
            <input
              id="mfs-agent-ident"
              type="text"
              required
              value={mfsAgentIdent}
              onChange={(e) => setMfsAgentIdent(e.target.value)}
              placeholder="Agent ID (67XXXXXX), ইমেইল, ফোন নম্বর বা UUID"
              className="w-full px-3.5 py-2.5 text-xs font-mono border border-slate-200 rounded-lg"
            />
            {matchedSelectedAgent && (
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-[11px] text-emerald-900">
                <span className="font-bold">নির্বাচিত এজেন্ট:</span> {matchedSelectedAgent.full_name}
                {matchedSelectedAgent.agent_code ? ` (#${matchedSelectedAgent.agent_code})` : ''} ·{' '}
                <span className="font-mono">{matchedSelectedAgent.email}</span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="mfs-req-type" className="block text-xs font-semibold text-slate-700 mb-1.5">
                রিকোয়েস্ট ধরন
              </label>
              <select
                id="mfs-req-type"
                value={mfsRequestType}
                onChange={(e) => setMfsRequestType(e.target.value as 'payment_collection' | 'payment_payout')}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg"
              >
                <option value="payment_collection">Bet Deposit</option>
                <option value="payment_payout">Bet Payout</option>
              </select>
            </div>
            <div>
              <label htmlFor="mfs-req-method" className="block text-xs font-semibold text-slate-700 mb-1.5">
                MFS মাধ্যম
              </label>
              <select
                id="mfs-req-method"
                value={mfsMethod}
                onChange={(e) => setMfsMethod(e.target.value as 'bkash' | 'nagad' | 'rocket')}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg"
              >
                <option value="bkash">bKash ({formatCommissionPercent(commissionRates.bkash)})</option>
                <option value="nagad">Nagad ({formatCommissionPercent(commissionRates.nagad)})</option>
                <option value="rocket">Rocket ({formatCommissionPercent(commissionRates.rocket)})</option>
              </select>
            </div>
            <div>
              <label htmlFor="mfs-req-mode" className="block text-xs font-semibold text-slate-700 mb-1.5">
                অ্যাকাউন্ট ধরন
              </label>
              <select
                id="mfs-req-mode"
                value={mfsAccountMode}
                onChange={(e) => setMfsAccountMode(e.target.value as 'personal' | 'agent' | 'merchant')}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg"
              >
                <option value="personal">Personal</option>
                <option value="agent">Agent</option>
                <option value="merchant">Merchant</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="mfs-req-num" className="block text-xs font-semibold text-slate-700 mb-1.5">
                এজেন্টের MFS নম্বর
              </label>
              <input
                id="mfs-req-num"
                type="tel"
                required
                value={mfsAgentNumber}
                onChange={(e) => setMfsAgentNumber(e.target.value)}
                placeholder="01XXXXXXXXX"
                className="w-full px-3.5 py-2.5 text-xs font-mono border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label htmlFor="mfs-req-cust" className="block text-xs font-semibold text-slate-700 mb-1.5">
                গ্রাহক/রেফারেন্স (ঐচ্ছিক)
              </label>
              <input
                id="mfs-req-cust"
                type="text"
                value={mfsCustomerAcc}
                onChange={(e) => setMfsCustomerAcc(e.target.value)}
                placeholder="01XXXXXXXXX বা রেফারেন্স"
                className="w-full px-3.5 py-2.5 text-xs font-mono border border-slate-200 rounded-lg"
              />
            </div>
          </div>

          <div>
            <label htmlFor="mfs-req-amt" className="block text-xs font-semibold text-slate-700 mb-1.5">
              পরিমাণ (৳)
            </label>
            <input
              id="mfs-req-amt"
              type="number"
              required
              min={100}
              value={mfsAmount}
              onChange={(e) => setMfsAmount(e.target.value)}
              placeholder="যেমন: 2000"
              className="w-full px-3.5 py-2.5 text-sm font-mono border border-slate-200 rounded-lg"
            />
          </div>

          <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3.5 py-2.5 text-xs text-emerald-950 space-y-0.5">
            <div className="flex items-center justify-between font-semibold">
              <span>{mfsMethod.toUpperCase()} কমিশন হার:</span>
              <span className="font-mono">{formatCommissionPercent(selectedProviderRate)}</span>
            </div>
            {previewCommission > 0 && (
              <div className="flex items-center justify-between text-[11px] text-emerald-800">
                <span>আনুমানিক এজেন্ট কমিশন:</span>
                <span className="font-mono font-bold">+{formatTaka(previewCommission)}</span>
              </div>
            )}
          </div>

          {mfsMsg && (
            <p className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2.5">
              {mfsMsg}
            </p>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
            >
              বন্ধ করুন
            </button>
            <button
              type="submit"
              disabled={mfsSubmitting}
              className="px-4 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-lg cursor-pointer"
            >
              {mfsSubmitting ? 'পাঠানো হচ্ছে...' : 'রিকোয়েস্ট পাঠান'}
            </button>
          </div>
        </form>
      </ModalDrawer>
    </div>
  );
}
