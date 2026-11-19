import React, { useCallback, useEffect, useState } from 'react';
import {
  ExternalLink,
  FileCheck2,
  Headphones,
  LayoutDashboard,
  Lock,
  MessageSquareWarning,
  Search,
} from 'lucide-react';
import { DashboardLayout, type DashboardNavItem } from '../../components/DashboardLayout.tsx';
import { StatMetricCard } from '../../components/StatMetricCard.tsx';
import { DataTable, type TableColumn } from '../../components/DataTable.tsx';
import { ModalDrawer } from '../../components/ModalDrawer.tsx';
import { useAuth } from '../../context/AuthContext.tsx';
import { apiRequest, formatDateTime } from '../../lib/api.ts';
import type { KycSubmission, SupportTicket } from '../../types/zentopay.ts';

const NAV_ITEMS: DashboardNavItem[] = [
  { id: 'overview', label: 'ড্যাশবোর্ড', icon: LayoutDashboard, section: 'প্রধান' },
  { id: 'tickets', label: 'সাপোর্ট টিকিট', icon: Headphones, section: 'সহায়তা ও নিরাপত্তা' },
  { id: 'kyc_queue', label: 'KYC যাচাই', icon: FileCheck2, section: 'সহায়তা ও নিরাপত্তা' },
  { id: 'accounts', label: 'অ্যাকাউন্ট নিরাপত্তা', icon: Lock, section: 'সহায়তা ও নিরাপত্তা' },
];

const TICKET_STATUS_BN: Record<string, string> = {
  open: 'খোলা',
  in_progress: 'চলমান',
  resolved: 'সমাধানকৃত',
  closed: 'বন্ধ',
};

const PRIORITY_BN: Record<string, string> = {
  low: 'সাধারণ',
  medium: 'মাঝারি',
  high: 'উচ্চ',
  urgent: 'জরুরি',
};

const KYC_REVIEW_BN: Record<string, string> = {
  pending: 'পর্যালোচনাধীন',
  approved: 'অনুমোদিত',
  rejected: 'প্রত্যাখ্যাত',
};

const DOC_TYPE_BN: Record<string, string> = {
  national_id: 'জাতীয় পরিচয়পত্র (NID)',
  passport: 'পাসপোর্ট',
  business_license: 'ট্রেড লাইসেন্স',
  proof_of_address: 'ঠিকানার প্রমাণপত্র',
};

export function SupportAdminDashboard() {
  const { profile, refreshAccountData } = useAuth();
  const [activeTab, setActiveTab] = useState('overview');
  const [ticketModalOpen, setTicketModalOpen] = useState(false);
  const [kycModalOpen, setKycModalOpen] = useState(false);

  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [kycQueue, setKycQueue] = useState<KycSubmission[]>([]);

  const [ticketId, setTicketId] = useState('');
  const [ticketStatus, setTicketStatus] = useState<'in_progress' | 'resolved' | 'closed'>('resolved');
  const [resolutionNote, setResolutionNote] = useState('');
  const [ticketFeedback, setTicketFeedback] = useState('');
  const [ticketSubmitting, setTicketSubmitting] = useState(false);

  const [selectedKyc, setSelectedKyc] = useState<KycSubmission | null>(null);
  const [kycDecision, setKycDecision] = useState<'approved' | 'rejected'>('approved');
  const [kycReviewNotes, setKycReviewNotes] = useState('');
  const [kycSignedUrl, setKycSignedUrl] = useState('');
  const [kycFeedback, setKycFeedback] = useState('');
  const [kycSubmitting, setKycSubmitting] = useState(false);

  const [safetyUserId, setSafetyUserId] = useState('');
  const [safetyFreeze, setSafetyFreeze] = useState(true);
  const [safetyFeedback, setSafetyFeedback] = useState('');

  const loadSupportOverview = useCallback(async () => {
    if (!profile) return;
    const res = await apiRequest<{
      tickets: SupportTicket[];
      kycQueue: KycSubmission[];
    }>('/api/support/overview');

    if (res.ok && res.data) {
      setTickets(res.data.tickets ?? []);
      setKycQueue(res.data.kycQueue ?? []);
    }
  }, [profile]);

  useEffect(() => {
    loadSupportOverview();
  }, [loadSupportOverview]);

  const openTicketModal = (ticket?: SupportTicket) => {
    setTicketFeedback('');
    setTicketId(ticket ? ticket.id : '');
    setTicketStatus('resolved');
    setResolutionNote(ticket?.resolution_note || '');
    setTicketModalOpen(true);
  };

  const openKycModal = async (submission: KycSubmission) => {
    setSelectedKyc(submission);
    setKycDecision('approved');
    setKycReviewNotes(submission.review_notes || '');
    setKycSignedUrl('');
    setKycFeedback('');
    setKycModalOpen(true);

    const urlRes = await apiRequest<{ signedUrl: string }>(`/api/support/kyc/${submission.id}/view-url`, {
      method: 'POST',
    });
    if (urlRes.ok && urlRes.data?.signedUrl) {
      setKycSignedUrl(urlRes.data.signedUrl);
    }
  };

  const handleTicketUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setTicketFeedback('');
    if (!ticketId.trim()) {
      setTicketFeedback('সঠিক সাপোর্ট টিকিট UUID লিখুন।');
      return;
    }
    setTicketSubmitting(true);
    const res = await apiRequest(`/api/tickets/${ticketId.trim()}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: ticketStatus, resolutionNote }),
    });
    setTicketSubmitting(false);
    if (res.ok) {
      setTicketFeedback(`টিকিটের অবস্থা "${TICKET_STATUS_BN[ticketStatus]}" হিসেবে আপডেট হয়েছে।`);
      await Promise.all([loadSupportOverview(), refreshAccountData()]);
    } else {
      setTicketFeedback(res.error || 'আপডেট ব্যর্থ হয়েছে।');
    }
  };

  const handleKycReviewSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedKyc) return;
    setKycFeedback('');
    setKycSubmitting(true);
    const res = await apiRequest(`/api/support/kyc/${selectedKyc.id}/review`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: kycDecision,
        reviewNotes: kycReviewNotes,
      }),
    });
    setKycSubmitting(false);
    if (res.ok) {
      setKycFeedback(`KYC ডকুমেন্ট "${KYC_REVIEW_BN[kycDecision]}" হিসেবে সংরক্ষণ করা হয়েছে।`);
      await Promise.all([loadSupportOverview(), refreshAccountData()]);
    } else {
      setKycFeedback(res.error || 'KYC রিভিউ সংরক্ষণ ব্যর্থ হয়েছে।');
    }
  };

  const handleSafetySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSafetyFeedback('');
    if (!safetyUserId.trim()) {
      setSafetyFeedback('সঠিক ইউজার UUID প্রদান করুন।');
      return;
    }
    const res = await apiRequest(`/api/admin/users/${safetyUserId.trim()}`, {
      method: 'PATCH',
      body: JSON.stringify({ isFrozen: safetyFreeze }),
    });
    setSafetyFeedback(
      res.ok
        ? `অ্যাকাউন্ট ${safetyFreeze ? 'ফ্রিজ' : 'আনফ্রিজ'} করা হয়েছে এবং অডিট লগে সংরক্ষিত হয়েছে।`
        : res.error || 'কার্যক্রম ব্যর্থ হয়েছে।'
    );
  };

  const ticketColumns: TableColumn<SupportTicket>[] = [
    {
      key: 'num',
      header: 'টিকিট নং',
      render: (r) => <span className="font-mono text-xs">{r.ticket_number}</span>,
      csvValue: (r) => r.ticket_number,
    },
    {
      key: 'subject',
      header: 'বিষয়',
      render: (r) => <span className="font-medium text-slate-900">{r.subject}</span>,
      csvValue: (r) => r.subject,
    },
    {
      key: 'priority',
      header: 'অগ্রাধিকার',
      render: (r) => <span>{PRIORITY_BN[r.priority] || r.priority}</span>,
      csvValue: (r) => r.priority,
    },
    {
      key: 'status',
      header: 'অবস্থা',
      render: (r) => <span className="font-medium">{TICKET_STATUS_BN[r.status] || r.status}</span>,
      csvValue: (r) => r.status,
    },
    {
      key: 'created',
      header: 'তৈরির সময়',
      align: 'right',
      render: (r) => <span className="text-xs text-slate-500 tabular-nums">{formatDateTime(r.created_at)}</span>,
      csvValue: (r) => r.created_at,
    },
    {
      key: 'action',
      header: 'সমাধান',
      align: 'right',
      render: (r) => (
        <button
          type="button"
          onClick={() => openTicketModal(r)}
          className="px-2.5 py-1 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-md cursor-pointer"
        >
          আপডেট
        </button>
      ),
      csvValue: (r) => r.id,
    },
  ];

  const kycColumns: TableColumn<KycSubmission>[] = [
    {
      key: 'user',
      header: 'ইউজার UUID',
      render: (r) => <span className="font-mono text-xs">{r.user_id.slice(0, 8)}</span>,
      csvValue: (r) => r.user_id,
    },
    {
      key: 'doc',
      header: 'ডকুমেন্টের ধরন',
      render: (r) => <span>{DOC_TYPE_BN[r.document_type] || r.document_type}</span>,
      csvValue: (r) => r.document_type,
    },
    {
      key: 'status',
      header: 'রিভিউ অবস্থা',
      render: (r) => <span className="font-medium">{KYC_REVIEW_BN[r.status] || r.status}</span>,
      csvValue: (r) => r.status,
    },
    {
      key: 'created',
      header: 'জমার সময়',
      align: 'right',
      render: (r) => <span className="text-xs text-slate-500 tabular-nums">{formatDateTime(r.created_at)}</span>,
      csvValue: (r) => r.created_at,
    },
    {
      key: 'inspect',
      header: 'পর্যালোচনা',
      align: 'right',
      render: (r) => (
        <button
          type="button"
          onClick={() => openKycModal(r)}
          className="px-2.5 py-1 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-md cursor-pointer"
        >
          যাচাই করুন
        </button>
      ),
      csvValue: (r) => r.id,
    },
  ];

  return (
    <DashboardLayout
      role="support_admin"
      navItems={NAV_ITEMS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      primaryAction={{
        label: 'টিকিট সমাধান করুন',
        onClick: () => openTicketModal(),
      }}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatMetricCard
          label="খোলা সাপোর্ট টিকিট"
          value={String(tickets.filter((t) => t.status === 'open').length)}
          helper="গ্রাহক ও এজেন্টদের জিজ্ঞাসা"
          icon={Headphones}
          tone="emerald"
        />
        <StatMetricCard
          label="অপেক্ষমাণ KYC রিভিউ"
          value={String(kycQueue.filter((k) => k.status === 'pending').length)}
          helper="প্রাইভেট স্টোরেজ ডকুমেন্ট কিউ"
          icon={FileCheck2}
          tone="amber"
        />
        <StatMetricCard
          label="জরুরি বিরোধ"
          value={String(tickets.filter((t) => t.priority === 'urgent').length)}
          helper="উচ্চ-অগ্রাধিকার পেমেন্ট অভিযোগ"
          icon={MessageSquareWarning}
        />
        <StatMetricCard
          label="সুরক্ষা লক ব্যবস্থা"
          value="RLS সক্রিয়"
          helper="তাৎক্ষণিক ওয়ালেট ফ্রিজ নিয়ন্ত্রণ"
          icon={Search}
        />
      </div>

      {(activeTab === 'overview' || activeTab === 'tickets') && (
        <DataTable
          title="গ্রাহক সাপোর্ট ও বিরোধ নিষ্পত্তি কিউ"
          subtitle="ZentoPay ইউজার ও এজেন্টদের জমা দেওয়া টিকিট পর্যালোচনা ও সমাধান করুন"
          rows={tickets}
          columns={ticketColumns}
          getSearchText={(r) => `${r.ticket_number} ${r.subject} ${r.category}`}
          filterOptions={[
            { value: 'all', label: 'সকল' },
            { value: 'open', label: 'খোলা' },
            { value: 'in_progress', label: 'চলমান' },
            { value: 'resolved', label: 'সমাধানকৃত' },
          ]}
          getFilterValue={(r) => r.status}
          emptyTitle="সাপোর্ট টিকিট কিউ খালি"
          emptyDescription="ইউজার বা এজেন্ট পোর্টাল থেকে নতুন টিকিট তৈরি করলে এখানে স্বয়ংক্রিয়ভাবে দেখা যাবে।"
          emptyActionLabel="আইডি দিয়ে টিকিট আপডেট"
          onEmptyAction={() => openTicketModal()}
          exportFilename="zentopay-support-tickets.csv"
        />
      )}

      {activeTab === 'kyc_queue' && (
        <DataTable
          title="KYC পরিচয়পত্র পর্যালোচনা কিউ"
          subtitle="প্রাইভেট Supabase Storage-এ আপলোড করা পরিচয়পত্র যাচাই করুন"
          rows={kycQueue}
          columns={kycColumns}
          getSearchText={(r) => `${r.user_id} ${r.document_type} ${r.status}`}
          filterOptions={[
            { value: 'all', label: 'সকল' },
            { value: 'pending', label: 'পর্যালোচনাধীন' },
            { value: 'approved', label: 'অনুমোদিত' },
            { value: 'rejected', label: 'প্রত্যাখ্যাত' },
          ]}
          getFilterValue={(r) => r.status}
          emptyTitle="কোনো অপেক্ষমাণ KYC ডকুমেন্ট নেই"
          emptyDescription="সাপোর্ট অ্যাডমিন যাচাইয়ের জন্য আপলোড করা পাসপোর্ট, NID এবং ঠিকানার প্রমাণপত্র এখানে প্রদর্শিত হয়।"
          exportFilename="zentopay-kyc-queue.csv"
        />
      )}

      {activeTab === 'accounts' && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 max-w-lg">
          <h2 className="font-display text-lg font-bold text-slate-950">
            অ্যাকাউন্ট নিরাপত্তা ফ্রিজ / আনফ্রিজ
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            প্রতারণা বা বিরোধ তদন্তের সময় তাৎক্ষণিকভাবে অ্যাকাউন্টের API অ্যাক্সেস লক বা পুনরায় চালু করুন।
          </p>
          <form onSubmit={handleSafetySubmit} className="mt-5 space-y-4">
            <div>
              <label htmlFor="sup-uid" className="block text-xs font-semibold text-slate-700 mb-1.5">
                অ্যাকাউন্ট UUID
              </label>
              <input
                id="sup-uid"
                type="text"
                required
                value={safetyUserId}
                onChange={(e) => setSafetyUserId(e.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000"
                className="w-full px-3.5 py-2.5 text-sm font-mono border border-slate-200 rounded-lg"
              />
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input
                  type="radio"
                  name="freezeMode"
                  checked={safetyFreeze}
                  onChange={() => setSafetyFreeze(true)}
                />
                অ্যাকাউন্ট ফ্রিজ করুন
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input
                  type="radio"
                  name="freezeMode"
                  checked={!safetyFreeze}
                  onChange={() => setSafetyFreeze(false)}
                />
                অ্যাকাউন্ট আনফ্রিজ করুন
              </label>
            </div>
            {safetyFeedback && (
              <p className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2.5">
                {safetyFeedback}
              </p>
            )}
            <button
              type="submit"
              className="px-5 py-2.5 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer"
            >
              নিরাপত্তা অবস্থা প্রয়োগ করুন
            </button>
          </form>
        </div>
      )}

      <ModalDrawer
        open={ticketModalOpen}
        onClose={() => setTicketModalOpen(false)}
        title="সাপোর্ট টিকিট সমাধান করুন"
        description="টিকিটের অবস্থা ও সমাধান নোট আপডেট করুন"
      >
        <form onSubmit={handleTicketUpdate} className="space-y-4">
          <div>
            <label htmlFor="sup-tid" className="block text-xs font-semibold text-slate-700 mb-1.5">
              টিকিট UUID
            </label>
            <input
              id="sup-tid"
              type="text"
              required
              value={ticketId}
              onChange={(e) => setTicketId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              className="w-full px-3.5 py-2.5 text-sm font-mono border border-slate-200 rounded-lg"
            />
          </div>
          <div>
            <label htmlFor="sup-stat" className="block text-xs font-semibold text-slate-700 mb-1.5">
              পরবর্তী অবস্থা
            </label>
            <select
              id="sup-stat"
              value={ticketStatus}
              onChange={(e) => setTicketStatus(e.target.value as 'in_progress' | 'resolved' | 'closed')}
              className="w-full px-3.5 py-2.5 text-sm border border-slate-200 rounded-lg"
            >
              <option value="in_progress">চলমান</option>
              <option value="resolved">সমাধানকৃত</option>
              <option value="closed">বন্ধ</option>
            </select>
          </div>
          <div>
            <label htmlFor="sup-note" className="block text-xs font-semibold text-slate-700 mb-1.5">
              সমাধানের বিবরণ
            </label>
            <textarea
              id="sup-note"
              rows={3}
              required
              value={resolutionNote}
              onChange={(e) => setResolutionNote(e.target.value)}
              placeholder="গৃহীত যাচাই বা সমাধানের পদক্ষেপ লিখুন।"
              className="w-full px-3.5 py-2.5 text-sm border border-slate-200 rounded-lg"
            />
          </div>
          {ticketFeedback && (
            <p className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2.5">
              {ticketFeedback}
            </p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setTicketModalOpen(false)}
              className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
            >
              বাতিল
            </button>
            <button
              type="submit"
              disabled={ticketSubmitting}
              className="px-4 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-lg cursor-pointer"
            >
              {ticketSubmitting ? 'আপডেট হচ্ছে...' : 'টিকিট আপডেট করুন'}
            </button>
          </div>
        </form>
      </ModalDrawer>

      <ModalDrawer
        open={kycModalOpen}
        onClose={() => setKycModalOpen(false)}
        title="KYC পরিচয়পত্র যাচাই ও অনুমোদন"
        description="প্রাইভেট স্টোরেজ থেকে স্বাক্ষরিত অস্থায়ী লিংকে নথি পরীক্ষা করুন"
      >
        <form onSubmit={handleKycReviewSubmit} className="space-y-4">
          {selectedKyc && (
            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-1.5 text-xs">
              <p className="text-slate-600">
                <span className="font-semibold text-slate-900">ইউজার আইডি:</span>{' '}
                <span className="font-mono">{selectedKyc.user_id}</span>
              </p>
              <p className="text-slate-600">
                <span className="font-semibold text-slate-900">নথির ধরন:</span>{' '}
                {DOC_TYPE_BN[selectedKyc.document_type] || selectedKyc.document_type}
              </p>
              {Boolean(selectedKyc.metadata?.fullName) && (
                <p className="text-slate-600">
                  <span className="font-semibold text-slate-900">NID নাম:</span>{' '}
                  {String(selectedKyc.metadata?.fullName)}
                </p>
              )}
              {Boolean(selectedKyc.metadata?.dob) && (
                <p className="text-slate-600">
                  <span className="font-semibold text-slate-900">জন্ম তারিখ:</span>{' '}
                  {String(selectedKyc.metadata?.dob)}
                </p>
              )}
              {Boolean(selectedKyc.metadata?.nidNumber) && (
                <p className="text-slate-600">
                  <span className="font-semibold text-slate-900">NID নম্বর:</span>{' '}
                  <span className="font-mono">{String(selectedKyc.metadata?.nidNumber)}</span>
                </p>
              )}
              <p className="text-slate-600">
                <span className="font-semibold text-slate-900">প্রাইভেট পাথ:</span>{' '}
                <span className="font-mono break-all">{selectedKyc.storage_path}</span>
              </p>
              {kycSignedUrl && (
                <div className="pt-2">
                  <a
                    href={kycSignedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 hover:text-emerald-800 underline"
                  >
                    নথি নিরাপদ ট্যাবে খুলুন (১২০ সেকেন্ড মেয়াদ)
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              )}
            </div>
          )}

          <div>
            <label htmlFor="kyc-dec" className="block text-xs font-semibold text-slate-700 mb-1.5">
              যাচাই সিদ্ধান্ত
            </label>
            <select
              id="kyc-dec"
              value={kycDecision}
              onChange={(e) => setKycDecision(e.target.value as 'approved' | 'rejected')}
              className="w-full px-3.5 py-2.5 text-sm border border-slate-200 rounded-lg"
            >
              <option value="approved">অনুমোদন করুন (Verified)</option>
              <option value="rejected">প্রত্যাখ্যান করুন (Rejected)</option>
            </select>
          </div>
          <div>
            <label htmlFor="kyc-notes" className="block text-xs font-semibold text-slate-700 mb-1.5">
              পর্যালোচনা নোট
            </label>
            <textarea
              id="kyc-notes"
              rows={3}
              value={kycReviewNotes}
              onChange={(e) => setKycReviewNotes(e.target.value)}
              placeholder="যাচাই ফলাফল বা পুনঃজমার কারণ লিখুন"
              className="w-full px-3.5 py-2.5 text-sm border border-slate-200 rounded-lg"
            />
          </div>
          {kycFeedback && (
            <p className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2.5">
              {kycFeedback}
            </p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setKycModalOpen(false)}
              className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
            >
              বন্ধ করুন
            </button>
            <button
              type="submit"
              disabled={kycSubmitting}
              className="px-4 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-lg cursor-pointer"
            >
              {kycSubmitting ? 'সংরক্ষণ হচ্ছে...' : 'KYC সিদ্ধান্ত সংরক্ষণ করুন'}
            </button>
          </div>
        </form>
      </ModalDrawer>
    </DashboardLayout>
  );
}
