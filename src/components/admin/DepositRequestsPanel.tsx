import React, { useMemo, useState } from 'react';
import { CheckCircle2, Clock, Eye, RefreshCw, XCircle } from 'lucide-react';
import { DataTable, type TableColumn } from '../DataTable.tsx';
import { ModalDrawer } from '../ModalDrawer.tsx';
import { apiRequest, formatCurrency, formatDateTime, formatTaka } from '../../lib/api.ts';
import type { TransactionRecord } from '../../types/zentopay.ts';

interface DepositRequestsPanelProps {
  deposits: TransactionRecord[];
  onRefresh: () => Promise<void>;
  loading?: boolean;
}

const DEPOSIT_STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  pending: {
    label: 'অপেক্ষমাণ',
    cls: 'bg-amber-50 text-amber-800 border-amber-200',
  },
  completed: {
    label: 'অনুমোদিত',
    cls: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  },
  failed: {
    label: 'প্রত্যাখ্যাত',
    cls: 'bg-rose-50 text-rose-800 border-rose-200',
  },
};

export function DepositRequestsPanel({
  deposits,
  onRefresh,
  loading = false,
}: DepositRequestsPanelProps) {
  const [selected, setSelected] = useState<TransactionRecord | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [submittingStatus, setSubmittingStatus] = useState<'completed' | 'failed' | null>(null);
  const [msg, setMsg] = useState('');
  const [isError, setIsError] = useState(false);

  const summary = useMemo(() => {
    let pendingCount = 0;
    let pendingAmount = 0;
    let approvedCount = 0;
    let approvedAmount = 0;
    let rejectedCount = 0;

    for (const d of deposits) {
      const amt = Number(d.amount || 0);
      if (d.status === 'pending') {
        pendingCount += 1;
        pendingAmount += amt;
      } else if (d.status === 'completed') {
        approvedCount += 1;
        approvedAmount += amt;
      } else {
        rejectedCount += 1;
      }
    }
    return {
      total: deposits.length,
      pendingCount,
      pendingAmount,
      approvedCount,
      approvedAmount,
      rejectedCount,
    };
  }, [deposits]);

  const openModal = (row: TransactionRecord) => {
    setSelected(row);
    setNotes(String((row.metadata as { adminNotes?: string } | undefined)?.adminNotes || ''));
    setMsg('');
    setIsError(false);
    setModalOpen(true);
  };

  const handleDecision = async (row: TransactionRecord, status: 'completed' | 'failed') => {
    if (submittingStatus) return;
    setMsg('');
    setIsError(false);
    setSubmittingStatus(status);

    const res = await apiRequest<TransactionRecord>(`/api/finance/deposits/${row.id}/review`, {
      method: 'PATCH',
      body: JSON.stringify({ status, notes: notes.trim() || null }),
    });
    setSubmittingStatus(null);

    if (!res.ok) {
      setIsError(true);
      setMsg(res.error || 'ডিপোজিট পর্যালোচনা ব্যর্থ হয়েছে।');
      return;
    }

    setIsError(false);
    setMsg(
      status === 'completed'
        ? 'ডিপোজিট অনুমোদিত হয়েছে এবং এজেন্টের ওয়ালেটে ব্যালেন্স যুক্ত হয়েছে।'
        : 'ডিপোজিট অনুরোধ প্রত্যাখ্যান করা হয়েছে।'
    );
    if (res.data) {
      setSelected((prev) => (prev && prev.id === row.id ? { ...prev, ...res.data } : prev));
    }
    await onRefresh();
  };

  const columns: TableColumn<TransactionRecord>[] = [
    {
      key: 'ref',
      header: 'রেফারেন্স ও তারিখ',
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
      header: 'এজেন্টের তথ্য',
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
      key: 'details',
      header: 'বিবরণ ও TrxID',
      render: (r) => {
        const meta = (r.metadata || {}) as {
          channel?: string;
          senderAccount?: string;
          externalTrxId?: string;
          planActivation?: string;
        };
        return (
          <div className="space-y-0.5">
            <p className="text-xs font-medium text-slate-800">
              {meta.channel ? meta.channel.toUpperCase() : r.description || 'ডিপোজিট'}
              {meta.senderAccount ? ` · ${meta.senderAccount}` : ''}
            </p>
            {meta.externalTrxId && (
              <p className="text-[11px] font-mono text-slate-500">TrxID: {meta.externalTrxId}</p>
            )}
            {meta.planActivation && (
              <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
                {meta.planActivation === 'premium' ? 'Premium Plan' : 'Trial Plan'}
              </span>
            )}
          </div>
        );
      },
      csvValue: (r) => r.description || '',
    },
    {
      key: 'amount',
      header: 'পরিমাণ',
      align: 'right',
      render: (r) => (
        <span className="font-mono text-sm font-bold text-slate-900 tabular-nums">
          {formatCurrency(Number(r.amount), r.currency || 'BDT')}
        </span>
      ),
      csvValue: (r) => Number(r.amount || 0),
    },
    {
      key: 'status',
      header: 'অবস্থা',
      render: (r) => {
        const badge = DEPOSIT_STATUS_BADGE[r.status] || {
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
    {
      key: 'actions',
      header: 'কার্যক্রম',
      align: 'right',
      render: (r) => (
        <div className="inline-flex items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={() => openModal(r)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
          >
            <Eye className="w-3.5 h-3.5" />
            দেখুন
          </button>
          {r.status === 'pending' && (
            <button
              type="button"
              onClick={() => openModal(r)}
              className="px-2.5 py-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-md cursor-pointer"
            >
              যাচাই ও অনুমোদন
            </button>
          )}
        </div>
      ),
      csvValue: (r) => r.id,
    },
  ];

  const meta = (selected?.metadata || {}) as {
    channel?: string;
    senderAccount?: string;
    externalTrxId?: string;
    planActivation?: string;
    screenshotData?: string;
    adminNotes?: string;
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-amber-900">অপেক্ষমাণ ডিপোজিট</p>
            <p className="text-xl font-bold text-amber-950 tabular-nums mt-1">
              {summary.pendingCount}টি · {formatTaka(summary.pendingAmount)}
            </p>
          </div>
          <Clock className="w-6 h-6 text-amber-600 shrink-0" />
        </div>

        <div className="bg-emerald-50/70 border border-emerald-200 rounded-xl p-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-emerald-900">অনুমোদিত ডিপোজিট</p>
            <p className="text-xl font-bold text-emerald-950 tabular-nums mt-1">
              {summary.approvedCount}টি · {formatTaka(summary.approvedAmount)}
            </p>
          </div>
          <CheckCircle2 className="w-6 h-6 text-emerald-600 shrink-0" />
        </div>

        <div className="bg-rose-50/70 border border-rose-200 rounded-xl p-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-rose-900">বাতিলকৃত ডিপোজিট</p>
            <p className="text-xl font-bold text-rose-950 tabular-nums mt-1">{summary.rejectedCount}টি</p>
          </div>
          <XCircle className="w-6 h-6 text-rose-600 shrink-0" />
        </div>
      </div>

      <DataTable
        title="ডিপোজিট রিকোয়েস্ট তালিকা"
        subtitle="bKash, Nagad, Rocket ও অন্যান্য BDT ডিপোজিট যাচাই করে ব্যালেন্স ও প্ল্যান অনুমোদন করুন"
        rows={deposits}
        columns={columns}
        searchPlaceholder="এজেন্ট নাম, #67XXXXXX, TrxID বা রেফারেন্স..."
        getSearchText={(r) => {
          const m = (r.metadata || {}) as { externalTrxId?: string; senderAccount?: string; channel?: string };
          return `${r.reference_code} ${r.initiator_name || ''} ${r.initiator_agent_code || ''} ${r.initiator_email || ''} ${m.externalTrxId || ''} ${m.senderAccount || ''} ${m.channel || ''} ${r.description || ''}`;
        }}
        filterOptions={[
          { value: 'all', label: `সকল (${summary.total})` },
          { value: 'pending', label: `অপেক্ষমাণ (${summary.pendingCount})` },
          { value: 'completed', label: `অনুমোদিত (${summary.approvedCount})` },
          { value: 'failed', label: `প্রত্যাখ্যাত (${summary.rejectedCount})` },
        ]}
        getFilterValue={(r) => r.status}
        enableDateFilter
        getDateValue={(r) => r.created_at}
        toolbarExtra={
          <button
            type="button"
            disabled={loading}
            onClick={() => void onRefresh()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            রিফ্রেশ
          </button>
        }
        emptyTitle="কোনো ডিপোজিট অনুরোধ পাওয়া যায়নি"
        emptyDescription="এজেন্টরা নতুন ডিপোজিট জমা দিলে এখানে যাচাই ও অনুমোদনের জন্য প্রদর্শিত হবে।"
        exportFilename="zentopay-deposit-requests.csv"
      />

      <ModalDrawer
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="ডিপোজিট রিকোয়েস্ট বিস্তারিত ও যাচাই"
        description="প্রেরকের নম্বর ও TrxID যাচাই করে অনুমোদন বা প্রত্যাখ্যান করুন"
      >
        {selected && (
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2.5 text-xs">
              <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-200">
                <div>
                  <span className="text-slate-500 block">রেফারেন্স</span>
                  <span className="font-mono font-bold text-slate-900">{selected.reference_code}</span>
                </div>
                <span
                  className={`px-2.5 py-1 rounded-full text-[11px] font-bold border ${
                    (DEPOSIT_STATUS_BADGE[selected.status] || DEPOSIT_STATUS_BADGE.pending).cls
                  }`}
                >
                  {(DEPOSIT_STATUS_BADGE[selected.status] || { label: selected.status }).label}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-slate-500 block">এজেন্টের নাম</span>
                  <span className="font-semibold text-slate-900">{selected.initiator_name || 'Agent'}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">এজেন্ট আইডি</span>
                  <span className="font-mono font-semibold text-emerald-800">
                    {selected.initiator_agent_code ? `#${selected.initiator_agent_code}` : '—'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">পরিমাণ</span>
                  <span className="text-base font-extrabold font-mono text-slate-950">
                    {formatCurrency(Number(selected.amount), selected.currency || 'BDT')}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">তারিখ</span>
                  <span className="font-medium text-slate-800">{formatDateTime(selected.created_at)}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">প্রেরক নম্বর</span>
                  <span className="font-mono font-semibold text-slate-900">{meta.senderAccount || '—'}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">TrxID</span>
                  <span className="font-mono font-bold text-emerald-800">{meta.externalTrxId || '—'}</span>
                </div>
              </div>

              {meta.screenshotData && (
                <div className="pt-2 border-t border-slate-200">
                  <span className="text-slate-500 block mb-1.5">পেমেন্ট স্ক্রিনশট</span>
                  <img
                    src={meta.screenshotData}
                    alt="ডিপোজিট স্ক্রিনশট"
                    className="max-h-52 rounded-lg border border-slate-200 object-contain bg-white"
                  />
                </div>
              )}
            </div>

            {selected.status === 'pending' ? (
              <div>
                <label htmlFor="dep-admin-note" className="block text-xs font-semibold text-slate-700 mb-1.5">
                  অ্যাডমিন নোট (ঐচ্ছিক)
                </label>
                <textarea
                  id="dep-admin-note"
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="যাচাই সংক্রান্ত মন্তব্য বা বাতিলের কারণ লিখুন"
                  className="w-full px-3.5 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
            ) : (
              meta.adminNotes && (
                <div className="rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-xs text-slate-700">
                  <span className="font-semibold text-slate-900">অ্যাডমিন নোট:</span> {meta.adminNotes}
                </div>
              )
            )}

            {msg && (
              <p
                className={`text-xs rounded-lg px-3.5 py-2.5 border ${
                  isError
                    ? 'bg-rose-50 text-rose-800 border-rose-200'
                    : 'bg-emerald-50 text-emerald-800 border-emerald-200'
                }`}
              >
                {msg}
              </p>
            )}

            <div className="flex flex-wrap justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
              >
                বন্ধ করুন
              </button>
              {selected.status === 'pending' && (
                <>
                  <button
                    type="button"
                    disabled={submittingStatus !== null}
                    onClick={() => void handleDecision(selected, 'failed')}
                    className="px-4 py-2 text-sm font-semibold text-white bg-rose-600 hover:bg-rose-700 disabled:opacity-50 rounded-lg cursor-pointer"
                  >
                    {submittingStatus === 'failed' ? 'প্রত্যাখ্যান হচ্ছে...' : 'প্রত্যাখ্যান করুন'}
                  </button>
                  <button
                    type="button"
                    disabled={submittingStatus !== null}
                    onClick={() => void handleDecision(selected, 'completed')}
                    className="px-4 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded-lg cursor-pointer"
                  >
                    {submittingStatus === 'completed' ? 'অনুমোদন হচ্ছে...' : 'অনুমোদন ও ক্রেডিট দিন'}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </ModalDrawer>
    </div>
  );
}
