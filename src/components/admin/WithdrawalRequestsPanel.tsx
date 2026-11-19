import React, { useMemo, useState } from 'react';
import { CheckCircle2, Clock, Eye, RefreshCw, XCircle } from 'lucide-react';
import { DataTable, type TableColumn } from '../DataTable.tsx';
import { ModalDrawer } from '../ModalDrawer.tsx';
import { apiRequest, formatCurrency, formatDateTime, formatTaka } from '../../lib/api.ts';
import type { SettlementRequest } from '../../types/zentopay.ts';

interface WithdrawalRequestsPanelProps {
  settlements: SettlementRequest[];
  onRefresh: () => Promise<void>;
  loading?: boolean;
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  pending: {
    label: 'অপেক্ষমাণ',
    cls: 'bg-amber-50 text-amber-800 border-amber-200',
  },
  approved: {
    label: 'অনুমোদিত',
    cls: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  },
  disbursed: {
    label: 'অনুমোদিত',
    cls: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  },
  rejected: {
    label: 'প্রত্যাখ্যাত',
    cls: 'bg-rose-50 text-rose-800 border-rose-200',
  },
};

export function WithdrawalRequestsPanel({
  settlements,
  onRefresh,
  loading = false,
}: WithdrawalRequestsPanelProps) {
  const [selected, setSelected] = useState<SettlementRequest | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [adminNote, setAdminNote] = useState('');
  const [submittingAction, setSubmittingAction] = useState<'approved' | 'rejected' | null>(null);
  const [actionMsg, setActionMsg] = useState('');
  const [actionError, setActionError] = useState(false);

  const summary = useMemo(() => {
    let pendingCount = 0;
    let pendingAmount = 0;
    let approvedCount = 0;
    let approvedAmount = 0;
    let rejectedCount = 0;

    for (const s of settlements) {
      const amt = Number(s.amount || 0);
      if (s.status === 'pending') {
        pendingCount += 1;
        pendingAmount += amt;
      } else if (s.status === 'approved' || s.status === 'disbursed') {
        approvedCount += 1;
        approvedAmount += amt;
      } else if (s.status === 'rejected') {
        rejectedCount += 1;
      }
    }
    return {
      total: settlements.length,
      pendingCount,
      pendingAmount,
      approvedCount,
      approvedAmount,
      rejectedCount,
    };
  }, [settlements]);

  const openDetailModal = (row: SettlementRequest) => {
    setSelected(row);
    setAdminNote(row.notes || '');
    setActionMsg('');
    setActionError(false);
    setModalOpen(true);
  };

  const executeDecision = async (row: SettlementRequest, status: 'approved' | 'rejected', noteText: string) => {
    if (submittingAction) return;
    setActionMsg('');
    setActionError(false);
    setSubmittingAction(status);

    const res = await apiRequest<SettlementRequest>(`/api/settlements/${row.id}/review`, {
      method: 'PATCH',
      body: JSON.stringify({
        status,
        notes: noteText.trim() || null,
      }),
    });
    setSubmittingAction(null);

    if (!res.ok) {
      setActionError(true);
      setActionMsg(res.error || 'সিদ্ধান্ত প্রক্রিয়াকরণ ব্যর্থ হয়েছে।');
      return;
    }

    setActionError(false);
    setActionMsg(
      status === 'approved'
        ? 'উইথড্র রিকোয়েস্ট অনুমোদিত হয়েছে এবং সংরক্ষিত ব্যালেন্স চূড়ান্তভাবে সমন্বয় করা হয়েছে।'
        : 'উইথড্র রিকোয়েস্ট প্রত্যাখ্যান করা হয়েছে এবং সংরক্ষিত অর্থ এজেন্টের ব্যবহারযোগ্য ব্যালেন্সে ফেরত পাঠানো হয়েছে।'
    );

    if (res.data) {
      setSelected((prev) => (prev && prev.id === row.id ? { ...prev, ...res.data } : prev));
    }
    await onRefresh();
  };

  const columns: TableColumn<SettlementRequest>[] = [
    {
      key: 'ref',
      header: 'রিকোয়েস্ট আইডি ও তারিখ',
      render: (r) => (
        <div>
          <p className="font-mono text-xs font-bold text-slate-900">
            {r.reference_code || `WD-${r.id.slice(0, 8).toUpperCase()}`}
          </p>
          <p className="text-[11px] text-slate-500 tabular-nums">{formatDateTime(r.created_at)}</p>
        </div>
      ),
      csvValue: (r) => `${r.reference_code || r.id} (${r.created_at})`,
    },
    {
      key: 'agent',
      header: 'এজেন্টের তথ্য',
      render: (r) => (
        <div>
          <p className="text-xs font-semibold text-slate-900">
            {r.agent_name || 'Agent'}{' '}
            {r.agent_code && (
              <span className="ml-1 px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-mono text-[10px]">
                #{r.agent_code}
              </span>
            )}
          </p>
          <p className="text-[11px] text-slate-500">{r.agent_email || r.requester_id.slice(0, 8)}</p>
        </div>
      ),
      csvValue: (r) => `${r.agent_name || ''} ${r.agent_code || ''} ${r.agent_email || r.requester_id}`,
    },
    {
      key: 'destination',
      header: 'পেমেন্ট মাধ্যম ও নম্বর',
      render: (r) => (
        <div>
          <p className="text-xs font-semibold text-slate-800">{r.destination_bank}</p>
          <p className="text-[11px] font-mono text-slate-500">
            {r.destination_account || `অ্যাকাউন্ট •••• ${r.account_last4}`}
          </p>
        </div>
      ),
      csvValue: (r) => `${r.destination_bank} ${r.destination_account || r.account_last4}`,
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
        const meta = STATUS_BADGE[r.status] || { label: r.status, cls: 'bg-slate-100 text-slate-700 border-slate-200' };
        return (
          <div className="space-y-0.5">
            <span className={`inline-block px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${meta.cls}`}>
              {meta.label}
            </span>
            {r.notes && (
              <p className="text-[10.5px] text-slate-500 max-w-[160px] truncate" title={r.notes}>
                নোট: {r.notes}
              </p>
            )}
          </div>
        );
      },
      csvValue: (r) => `${r.status}${r.notes ? ` (${r.notes})` : ''}`,
    },
    {
      key: 'actions',
      header: 'কার্যক্রম',
      align: 'right',
      render: (r) => (
        <div className="inline-flex items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={() => openDetailModal(r)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
          >
            <Eye className="w-3.5 h-3.5" />
            দেখুন
          </button>
          {r.status === 'pending' && (
            <>
              <button
                type="button"
                onClick={() => openDetailModal(r)}
                className="px-2.5 py-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-md cursor-pointer"
              >
                অনুমোদন
              </button>
              <button
                type="button"
                onClick={() => openDetailModal(r)}
                className="px-2.5 py-1.5 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-md cursor-pointer"
              >
                প্রত্যাখ্যান
              </button>
            </>
          )}
        </div>
      ),
      csvValue: (r) => r.id,
    },
  ];

  return (
    <div className="space-y-5">
      {/* Beginner-friendly summary strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-amber-900">অপেক্ষমাণ উইথড্র</p>
            <p className="text-xl font-bold text-amber-950 tabular-nums mt-1">
              {summary.pendingCount}টি · {formatTaka(summary.pendingAmount)}
            </p>
          </div>
          <Clock className="w-6 h-6 text-amber-600 shrink-0" />
        </div>

        <div className="bg-emerald-50/70 border border-emerald-200 rounded-xl p-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-emerald-900">অনুমোদিত উইথড্র</p>
            <p className="text-xl font-bold text-emerald-950 tabular-nums mt-1">
              {summary.approvedCount}টি · {formatTaka(summary.approvedAmount)}
            </p>
          </div>
          <CheckCircle2 className="w-6 h-6 text-emerald-600 shrink-0" />
        </div>

        <div className="bg-rose-50/70 border border-rose-200 rounded-xl p-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-rose-900">প্রত্যাখ্যাত (ফেরতকৃত)</p>
            <p className="text-xl font-bold text-rose-950 tabular-nums mt-1">{summary.rejectedCount}টি</p>
          </div>
          <XCircle className="w-6 h-6 text-rose-600 shrink-0" />
        </div>
      </div>

      <DataTable
        title="উইথড্র রিকোয়েস্ট তালিকা ও ইতিহাস"
        subtitle="এজেন্টদের সকল অপেক্ষমাণ, অনুমোদিত ও প্রত্যাখ্যাত উইথড্র অনুরোধ দেখুন এবং যাচাই করে সিদ্ধান্ত দিন"
        rows={settlements}
        columns={columns}
        searchPlaceholder="এজেন্ট নাম, #67XXXXXX বা রিকোয়েস্ট আইডি..."
        getSearchText={(r) =>
          `${r.reference_code || ''} ${r.id} ${r.agent_name || ''} ${r.agent_code || ''} ${r.agent_email || ''} ${r.destination_bank} ${r.destination_account || ''} ${r.account_last4}`
        }
        filterOptions={[
          { value: 'all', label: `সকল (${summary.total})` },
          { value: 'pending', label: `অপেক্ষমাণ (${summary.pendingCount})` },
          { value: 'approved', label: `অনুমোদিত (${summary.approvedCount})` },
          { value: 'rejected', label: `প্রত্যাখ্যাত (${summary.rejectedCount})` },
        ]}
        getFilterValue={(r) => (r.status === 'disbursed' ? 'approved' : r.status)}
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
        emptyTitle="কোনো উইথড্র রিকোয়েস্ট পাওয়া যায়নি"
        emptyDescription="এজেন্টরা উইথড্র রিকোয়েস্ট পাঠালে অথবা আপনার ফিল্টার পরিবর্তন করলে এখানে তালিকা দেখা যাবে।"
        exportFilename="zentopay-withdrawal-requests.csv"
      />

      <ModalDrawer
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="উইথড্র রিকোয়েস্ট বিস্তারিত ও সিদ্ধান্ত"
        description="তথ্য যাচাই করে রিকোয়েস্টটি অনুমোদন বা প্রত্যাখ্যান করুন"
      >
        {selected && (
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2.5 text-xs">
              <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-200">
                <div>
                  <span className="text-slate-500 block">রিকোয়েস্ট আইডি</span>
                  <span className="font-mono font-bold text-slate-900">
                    {selected.reference_code || `WD-${selected.id.slice(0, 8).toUpperCase()}`}
                  </span>
                </div>
                <span
                  className={`px-2.5 py-1 rounded-full text-[11px] font-bold border ${
                    (STATUS_BADGE[selected.status] || STATUS_BADGE.pending).cls
                  }`}
                >
                  {(STATUS_BADGE[selected.status] || { label: selected.status }).label}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-slate-500 block">এজেন্টের নাম</span>
                  <span className="font-semibold text-slate-900">{selected.agent_name || 'Agent'}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">এজেন্ট আইডি</span>
                  <span className="font-mono font-semibold text-emerald-800">
                    {selected.agent_code ? `#${selected.agent_code}` : '—'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">উইথড্র পরিমাণ</span>
                  <span className="text-base font-extrabold font-mono text-slate-950">
                    {formatCurrency(Number(selected.amount), selected.currency || 'BDT')}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">আবেদনের তারিখ</span>
                  <span className="font-medium text-slate-800">{formatDateTime(selected.created_at)}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">পেমেন্ট মাধ্যম</span>
                  <span className="font-semibold text-slate-900">{selected.destination_bank}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">প্রাপকের নম্বর / অ্যাকাউন্ট</span>
                  <span className="font-mono font-semibold text-slate-900">
                    {selected.destination_account || `•••• ${selected.account_last4}`}
                  </span>
                </div>
              </div>

              {selected.wallet_balance !== null && selected.wallet_balance !== undefined && (
                <div className="pt-2 border-t border-slate-200 grid grid-cols-3 gap-2 text-[11px]">
                  <div>
                    <span className="text-slate-500 block">ওয়ালেট মোট</span>
                    <span className="font-mono font-bold text-slate-900">
                      {formatTaka(Number(selected.wallet_balance || 0))}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">ব্যবহারযোগ্য</span>
                    <span className="font-mono font-bold text-emerald-700">
                      {formatTaka(Number(selected.wallet_available_balance || 0))}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">সংরক্ষিত (হোল্ড)</span>
                    <span className="font-mono font-bold text-amber-700">
                      {formatTaka(Number(selected.wallet_reserved_balance || 0))}
                    </span>
                  </div>
                </div>
              )}

              {selected.reviewed_at && (
                <div className="pt-2 border-t border-slate-200 text-[11px] text-slate-600">
                  পর্যালোচনা: {selected.reviewer_name || 'Admin'} · {formatDateTime(selected.reviewed_at)}
                </div>
              )}
            </div>

            {selected.status === 'pending' ? (
              <>
                <div className="rounded-lg bg-emerald-50/70 border border-emerald-200 px-3.5 py-2.5 text-[11px] text-emerald-950 space-y-1">
                  <p>
                    <strong>অনুমোদন করলে:</strong> সংরক্ষিত {formatTaka(Number(selected.amount))} স্থায়ীভাবে সমন্বয় হবে এবং
                    এজেন্টের লেনদেন ইতিহাসে যুক্ত হবে।
                  </p>
                  <p>
                    <strong>প্রত্যাখ্যান করলে:</strong> সংরক্ষিত {formatTaka(Number(selected.amount))} এজেন্টের ব্যবহারযোগ্য
                    ব্যালেন্সে স্বয়ংক্রিয়ভাবে ফেরত যাবে।
                  </p>
                </div>

                <div>
                  <label htmlFor="wd-admin-note" className="block text-xs font-semibold text-slate-700 mb-1.5">
                    অ্যাডমিন নোট (প্রত্যাখ্যান করলে কারণ উল্লেখ করুন)
                  </label>
                  <textarea
                    id="wd-admin-note"
                    rows={3}
                    value={adminNote}
                    onChange={(e) => setAdminNote(e.target.value)}
                    placeholder="যেমন: পেমেন্ট পাঠানো হয়েছে / ভুল অ্যাকাউন্ট নম্বর"
                    className="w-full px-3.5 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-600"
                  />
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {['ভুল অ্যাকাউন্ট নম্বর', 'অপর্যাপ্ত যাচাই তথ্য', 'সন্দেহজনক লেনদেন'].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setAdminNote(preset)}
                        className="px-2 py-1 text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-700 rounded cursor-pointer"
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              selected.notes && (
                <div className="rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-xs text-slate-700">
                  <span className="font-semibold text-slate-900">অ্যাডমিন নোট:</span> {selected.notes}
                </div>
              )
            )}

            {actionMsg && (
              <p
                className={`text-xs rounded-lg px-3.5 py-2.5 border ${
                  actionError
                    ? 'bg-rose-50 text-rose-800 border-rose-200'
                    : 'bg-emerald-50 text-emerald-800 border-emerald-200'
                }`}
              >
                {actionMsg}
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
                    disabled={submittingAction !== null}
                    onClick={() => void executeDecision(selected, 'rejected', adminNote)}
                    className="px-4 py-2 text-sm font-semibold text-white bg-rose-600 hover:bg-rose-700 disabled:opacity-50 rounded-lg cursor-pointer"
                  >
                    {submittingAction === 'rejected' ? 'প্রত্যাখ্যান হচ্ছে...' : 'প্রত্যাখ্যান করুন'}
                  </button>
                  <button
                    type="button"
                    disabled={submittingAction !== null}
                    onClick={() => void executeDecision(selected, 'approved', adminNote)}
                    className="px-4 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded-lg cursor-pointer"
                  >
                    {submittingAction === 'approved' ? 'অনুমোদন হচ্ছে...' : 'অনুমোদন করুন'}
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
