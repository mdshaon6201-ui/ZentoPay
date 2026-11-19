import React, { useEffect, useState } from 'react';
import {
  Bell,
  Camera,
  CheckCircle2,
  KeyRound,
  Lock,
  LogOut,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import { apiRequest, formatDateTime } from '../../lib/api.ts';
import { supabase } from '../../lib/supabase.ts';
import type {
  AgentGateway,
  GlobalNotificationItem,
  UserNotificationItem,
  UserProfile,
} from '../../types/zentopay.ts';

export type ActiveModalType =
  | null
  | 'logout'
  | 'notifications'
  | 'gateway-edit'
  | 'avatar'
  | 'kyc'
  | 'edit-profile'
  | 'change-pass'
  | 'pin-setup';

export interface GatewayEditTarget {
  provider: 'bkash' | 'nagad' | 'rocket';
  accountMode: 'personal' | 'merchant' | 'agent';
  existing?: AgentGateway;
}

interface AgentModalsProps {
  activeModal: ActiveModalType;
  onClose: () => void;
  profile: UserProfile | null;
  availableBalance: number;
  gatewayTarget: GatewayEditTarget | null;
  globalNotifications: GlobalNotificationItem[];
  personalNotifications: UserNotificationItem[];
  onRefresh: () => Promise<void>;
  onPinConfigured?: () => void;
  onSignOut: () => Promise<void>;
  onToast: (msg: string) => void;
}

const MODE_LABELS_BN: Record<string, string> = {
  personal: 'পার্সোনাল নম্বর',
  agent: 'এজেন্ট নম্বর',
  merchant: 'মার্চেন্ট নম্বর',
};

const PROVIDER_LABELS_BN: Record<string, string> = {
  bkash: 'bKash',
  nagad: 'Nagad',
  rocket: 'Rocket',
};

export function AgentModals({
  activeModal,
  onClose,
  profile,
  availableBalance,
  gatewayTarget,
  globalNotifications,
  personalNotifications,
  onRefresh,
  onPinConfigured,
  onSignOut,
  onToast,
}: AgentModalsProps) {
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // Gateway Modal State
  const [gwNumber, setGwNumber] = useState('');
  const [gwActive, setGwActive] = useState(true);

  // Avatar Modal State
  const [avatarPreview, setAvatarPreview] = useState('');

  // KYC Modal State
  const [kycName, setKycName] = useState('');
  const [kycDob, setKycDob] = useState('');
  const [kycNid, setKycNid] = useState('');
  const [kycFile, setKycFile] = useState<File | null>(null);
  const [kycFilePreview, setKycFilePreview] = useState('');

  // Edit Profile Modal State
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editCountry, setEditCountry] = useState('BD');

  // Change Password Modal State
  const [currPass, setCurrPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [confPass, setConfPass] = useState('');

  // Withdraw PIN Modal State
  const [currPin, setCurrPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confPin, setConfPin] = useState('');

  useEffect(() => {
    setErrorMsg('');
    if (activeModal === 'gateway-edit' && gatewayTarget) {
      setGwNumber(gatewayTarget.existing?.account_number || '');
      setGwActive(gatewayTarget.existing ? gatewayTarget.existing.is_active : true);
    } else if (activeModal === 'avatar') {
      setAvatarPreview(profile?.avatar_url || '');
    } else if (activeModal === 'kyc') {
      setKycName(profile?.full_name || '');
      setKycDob('');
      setKycNid('');
      setKycFile(null);
      setKycFilePreview('');
    } else if (activeModal === 'edit-profile') {
      setEditName(profile?.full_name || '');
      setEditPhone(profile?.phone || '');
      setEditCountry(profile?.country || 'BD');
    } else if (activeModal === 'change-pass') {
      setCurrPass('');
      setNewPass('');
      setConfPass('');
    } else if (activeModal === 'pin-setup') {
      setCurrPin('');
      setNewPin('');
      setConfPin('');
    } else if (activeModal === 'notifications') {
      const hasUnread = personalNotifications.some((n) => !n.is_read);
      if (hasUnread) {
        apiRequest('/api/notifications/read', { method: 'POST' }).then(() => onRefresh());
      }
    }
  }, [activeModal, gatewayTarget, profile]);

  if (!activeModal) return null;

  const handleGatewaySave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!gatewayTarget) return;
    setErrorMsg('');
    const cleanNum = gwNumber.trim();
    if (!/^01\d{9}$/.test(cleanNum)) {
      setErrorMsg('অনুগ্রহ করে ১১ ডিজিটের সঠিক বাংলাদেশি মোবাইল নম্বর (01XXXXXXXXX) দিন।');
      return;
    }
    if (gwActive && availableBalance < 1000) {
      setErrorMsg('গেটওয়ে নম্বর সক্রিয় করতে ন্যূনতম ৳১,০০০ ব্যালেন্স থাকতে হবে (সক্রিয়করণ ফি ৳০)।');
      return;
    }

    setSubmitting(true);
    let res;
    if (gatewayTarget.existing && gatewayTarget.existing.account_number === cleanNum) {
      res = await apiRequest(`/api/gateway/${gatewayTarget.existing.id}/toggle`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: gwActive, accountNumber: cleanNum }),
      });
    } else if (gatewayTarget.existing && !gwActive) {
      res = await apiRequest(`/api/gateway/${gatewayTarget.existing.id}/toggle`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: false, accountNumber: cleanNum }),
      });
    } else {
      res = await apiRequest('/api/gateway/activate', {
        method: 'POST',
        body: JSON.stringify({
          provider: gatewayTarget.provider,
          accountMode: gatewayTarget.accountMode,
          accountNumber: cleanNum,
        }),
      });
    }
    setSubmitting(false);

    if (!res.ok) {
      setErrorMsg(res.error || 'গেটওয়ে সংরক্ষণ ব্যর্থ হয়েছে।');
      return;
    }

    await onRefresh();
    onToast(`${PROVIDER_LABELS_BN[gatewayTarget.provider]} ${MODE_LABELS_BN[gatewayTarget.accountMode]} সংরক্ষিত হয়েছে!`);
    onClose();
  };

  const handleAvatarFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxSide = 256;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          setAvatarPreview(canvas.toDataURL('image/jpeg', 0.82));
        }
      };
      if (typeof reader.result === 'string') {
        img.src = reader.result;
      }
    };
    reader.readAsDataURL(file);
  };

  const handleAvatarSave = async () => {
    if (!avatarPreview) {
      setErrorMsg('অনুগ্রহ করে একটি ছবি নির্বাচন করুন।');
      return;
    }
    setSubmitting(true);
    const res = await apiRequest('/api/agent/avatar', {
      method: 'PATCH',
      body: JSON.stringify({ avatarUrl: avatarPreview }),
    });
    setSubmitting(false);
    if (!res.ok) {
      setErrorMsg(res.error || 'প্রোফাইল ছবি আপলোড ব্যর্থ হয়েছে।');
      return;
    }
    await onRefresh();
    onToast('প্রোফাইল ছবি সফলভাবে আপডেট হয়েছে!');
    onClose();
  };

  const handleKycFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setKycFile(file);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setKycFilePreview(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleKycSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    if (!kycName.trim() || !kycDob || !kycNid.trim() || !kycFile) {
      setErrorMsg('অনুগ্রহ করে পূর্ণ নাম, জন্ম তারিখ, NID নম্বর এবং NID-এর সামনের অংশের ছবি দিন।');
      return;
    }
    if (!supabase) {
      setErrorMsg('Supabase Storage কনফিগার করা নেই।');
      return;
    }

    setSubmitting(true);
    const uploadRes = await apiRequest<{ signedUrl: string; token: string; storagePath: string }>(
      '/api/kyc/upload-url',
      {
        method: 'POST',
        body: JSON.stringify({ fileName: kycFile.name, documentType: 'national_id' }),
      }
    );

    if (!uploadRes.ok || !uploadRes.data) {
      setSubmitting(false);
      setErrorMsg(uploadRes.error || 'স্টোরেজ আপলোড লিংক তৈরি ব্যর্থ হয়েছে।');
      return;
    }

    const { error: putErr } = await supabase.storage
      .from('kyc-documents')
      .uploadToSignedUrl(uploadRes.data.storagePath, uploadRes.data.token, kycFile);

    if (putErr) {
      setSubmitting(false);
      setErrorMsg(putErr.message || 'ডকুমেন্ট আপলোড ব্যর্থ হয়েছে।');
      return;
    }

    const submitRes = await apiRequest('/api/kyc/submit', {
      method: 'POST',
      body: JSON.stringify({
        documentType: 'national_id',
        storagePath: uploadRes.data.storagePath,
        fullName: kycName.trim(),
        dob: kycDob,
        nidNumber: kycNid.trim(),
      }),
    });
    setSubmitting(false);

    if (!submitRes.ok) {
      setErrorMsg(submitRes.error || 'KYC জমা দেওয়া যায়নি।');
      return;
    }

    await onRefresh();
    onToast('আপনার KYC আবেদন সফলভাবে জমা হয়েছে!');
    onClose();
  };

  const handleProfileSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    if (editName.trim().length < 2) {
      setErrorMsg('অনুগ্রহ করে কমপক্ষে ২ অক্ষরের নাম লিখুন।');
      return;
    }
    setSubmitting(true);
    const res = await apiRequest('/api/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify({
        fullName: editName.trim(),
        phone: editPhone.trim(),
        country: editCountry.trim() || 'BD',
      }),
    });
    setSubmitting(false);
    if (!res.ok) {
      setErrorMsg(res.error || 'তথ্য আপডেট ব্যর্থ হয়েছে।');
      return;
    }
    await onRefresh();
    onToast('ব্যক্তিগত তথ্য আপডেট হয়েছে!');
    onClose();
  };

  const handleChangePass = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    if (newPass.length < 6) {
      setErrorMsg('নতুন পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।');
      return;
    }
    if (newPass !== confPass) {
      setErrorMsg('নতুন পাসওয়ার্ড ও নিশ্চিত পাসওয়ার্ড মিলছে না।');
      return;
    }
    setSubmitting(true);
    const res = await apiRequest('/api/agent/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: currPass, newPassword: newPass }),
    });
    setSubmitting(false);
    if (!res.ok) {
      setErrorMsg(res.error || 'পাসওয়ার্ড পরিবর্তন ব্যর্থ হয়েছে।');
      return;
    }
    onToast('পাসওয়ার্ড সফলভাবে পরিবর্তন হয়েছে!');
    onClose();
  };

  const handlePinSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setErrorMsg('');
    const wasConfigured = Boolean(profile?.has_withdraw_pin);
    if (wasConfigured && !/^\d{4,6}$/.test(currPin.trim())) {
      setErrorMsg('সঠিক বর্তমান ৪ থেকে ৬ সংখ্যার উইথড্র পিন দিন।');
      return;
    }
    if (!/^\d{4,6}$/.test(newPin.trim())) {
      setErrorMsg('উইথড্র পিন অবশ্যই ৪ থেকে ৬ সংখ্যার হতে হবে।');
      return;
    }
    if (newPin.trim() !== confPin.trim()) {
      setErrorMsg('নতুন পিন ও নিশ্চিত পিন মিলছে না।');
      return;
    }
    setSubmitting(true);
    const res = await apiRequest('/api/agent/withdraw-pin', {
      method: 'POST',
      body: JSON.stringify({
        currentPin: wasConfigured ? currPin.trim() : undefined,
        newPin: newPin.trim(),
        confirmPin: confPin.trim(),
      }),
    });
    setSubmitting(false);
    if (!res.ok) {
      if (res.code === 'PIN_ALREADY_SET') {
        onPinConfigured?.();
        await onRefresh();
        onToast('উইথড্র পিন ইতিমধ্যে সেট করা আছে।');
        onClose();
        return;
      }
      setErrorMsg(res.error || 'উইথড্র পিন সংরক্ষণ ব্যর্থ হয়েছে।');
      return;
    }
    onPinConfigured?.();
    await onRefresh();
    onToast(wasConfigured ? 'উইথড্র পিন পরিবর্তন হয়েছে!' : 'উইথড্র পিন সেট করা হয়েছে!');
    onClose();
  };

  const mergedNotifications = [
    ...globalNotifications.map((g) => ({
      id: `global-${g.id}`,
      title: g.title,
      message: g.message,
      createdAt: g.createdAt,
      scope: 'global' as const,
    })),
    ...personalNotifications.map((p) => ({
      id: p.id,
      title: p.title,
      message: p.message,
      createdAt: p.created_at,
      scope: 'personal' as const,
    })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <div className="ew-modal-overlay" role="dialog" aria-modal="true">
      <div className="ew-modal-content">
        {/* LOGOUT MODAL */}
        {activeModal === 'logout' && (
          <div className="text-center space-y-4">
            <div className="w-12 h-12 mx-auto rounded-full bg-red-50 text-[#E53935] flex items-center justify-center">
              <LogOut className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-base font-extrabold text-[#12251D]">অ্যাকাউন্ট থেকে লগআউট করবেন?</h2>
              <p className="text-xs text-[#6B7C73] mt-1">
                পুনরায় প্রবেশ করতে আপনার ইমেইল ও পাসওয়ার্ড দিয়ে লগইন করতে হবে।
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2.5 pt-2">
              <button type="button" onClick={onClose} className="ew-btn ew-btn-secondary">
                থাকুন
              </button>
              <button
                type="button"
                onClick={async () => {
                  await onSignOut();
                  onClose();
                }}
                className="ew-btn"
                style={{ background: '#E53935' }}
              >
                লগআউট
              </button>
            </div>
          </div>
        )}

        {/* NOTIFICATIONS MODAL */}
        {activeModal === 'notifications' && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Bell className="w-4 h-4 text-[#075B3A]" />
                <h2 className="text-base font-extrabold text-[#12251D]">নোটিফিকেশন</h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-1.5 rounded-full bg-[#F4F7F5] text-[#6B7C73] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {mergedNotifications.length === 0 ? (
              <div className="py-10 text-center text-xs font-semibold text-[#6B7C73]">
                কোনো নতুন নোটিফিকেশন নেই।
              </div>
            ) : (
              <div className="space-y-2.5">
                {mergedNotifications.map((item) => (
                  <div
                    key={item.id}
                    className="p-3.5 rounded-2xl bg-[#F4F7F5] border border-[#E2EBE6] space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-extrabold text-[#12251D]">{item.title}</span>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#E9F7F0] text-[#075B3A]">
                        {item.scope === 'global' ? 'সিস্টেম' : 'ব্যক্তিগত'}
                      </span>
                    </div>
                    <p className="text-xs text-[#6B7C73] leading-relaxed">{item.message}</p>
                    <p className="text-[10px] text-[#6B7C73] pt-0.5">
                      {formatDateTime(item.createdAt)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* GATEWAY EDIT MODAL */}
        {activeModal === 'gateway-edit' && gatewayTarget && (
          <form onSubmit={handleGatewaySave} className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-extrabold text-[#12251D]">
                {PROVIDER_LABELS_BN[gatewayTarget.provider]} — {MODE_LABELS_BN[gatewayTarget.accountMode]}
              </h2>
              <button
                type="button"
                onClick={onClose}
                className="p-1.5 rounded-full bg-[#F4F7F5] text-[#6B7C73] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-3 rounded-xl bg-[#E9F7F0] text-[11px] font-semibold text-[#075B3A] leading-relaxed">
              সক্রিয় করতে ওয়ালেটে ন্যূনতম ৳১,০০০ ব্যালেন্স থাকতে হবে। গেটওয়ে সংযোগ একদম ফ্রি (৳০ কাটা হয়)।
            </div>
            <div>
              <label className="ew-input-label" htmlFor="gw-num-input">
                {PROVIDER_LABELS_BN[gatewayTarget.provider]} {MODE_LABELS_BN[gatewayTarget.accountMode]}
              </label>
              <input
                id="gw-num-input"
                type="tel"
                required
                value={gwNumber}
                onChange={(e) => setGwNumber(e.target.value)}
                placeholder="01XXXXXXXXX"
                className="ew-input-control no-icon"
              />
            </div>
            <div className="flex items-center justify-between p-3 rounded-xl bg-[#F4F7F5] border border-[#E2EBE6]">
              <div>
                <p className="text-xs font-extrabold text-[#12251D]">গেটওয়ে স্ট্যাটাস</p>
                <p className="text-[11px] text-[#6B7C73]">{gwActive ? 'সক্রিয় (রিকোয়েস্ট চালু)' : 'নিষ্ক্রিয় (বন্ধ)'}</p>
              </div>
              <input
                type="checkbox"
                checked={gwActive}
                onChange={(e) => setGwActive(e.target.checked)}
                className="w-5 h-5 accent-[#16A66A] cursor-pointer"
              />
            </div>
            {errorMsg && <p className="text-xs font-semibold text-[#E53935]">{errorMsg}</p>}
            <button type="submit" disabled={submitting} className="ew-btn">
              {submitting ? 'সংরক্ষণ হচ্ছে...' : 'সংরক্ষণ করুন'}
            </button>
          </form>
        )}

        {/* AVATAR MODAL */}
        {activeModal === 'avatar' && (
          <div className="space-y-4 text-center">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-extrabold text-[#12251D]">প্রোফাইল ছবি পরিবর্তন</h2>
              <button type="button" onClick={onClose} className="p-1.5 rounded-full bg-[#F4F7F5] text-[#6B7C73] cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="w-24 h-24 mx-auto rounded-full bg-[#E9F7F0] border-2 border-[#16A66A] overflow-hidden flex items-center justify-center">
              {avatarPreview ? (
                <img src={avatarPreview} alt="প্রিভিউ" className="w-full h-full object-cover" />
              ) : (
                <Camera className="w-8 h-8 text-[#075B3A]" />
              )}
            </div>
            <label className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#F4F7F5] border border-[#E2EBE6] text-xs font-bold text-[#075B3A] cursor-pointer">
              <Upload className="w-4 h-4" />
              গ্যালারি থেকে ছবি বাছাই করুন
              <input type="file" accept="image/*" onChange={handleAvatarFileChange} className="hidden" />
            </label>
            {errorMsg && <p className="text-xs font-semibold text-[#E53935]">{errorMsg}</p>}
            <button type="button" disabled={submitting} onClick={handleAvatarSave} className="ew-btn">
              {submitting ? 'সংরক্ষণ হচ্ছে...' : 'ছবি সেভ করুন'}
            </button>
          </div>
        )}

        {/* KYC VERIFICATION MODAL */}
        {activeModal === 'kyc' && (
          <form onSubmit={handleKycSubmit} className="space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-[#075B3A]" />
                <h2 className="text-base font-extrabold text-[#12251D]">KYC ভেরিফিকেশন</h2>
              </div>
              <button type="button" onClick={onClose} className="p-1.5 rounded-full bg-[#F4F7F5] text-[#6B7C73] cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="ew-input-label" htmlFor="kyc-name">NID অনুযায়ী পূর্ণ নাম</label>
              <input
                id="kyc-name"
                type="text"
                required
                value={kycName}
                onChange={(e) => setKycName(e.target.value)}
                className="ew-input-control no-icon"
              />
            </div>
            <div>
              <label className="ew-input-label" htmlFor="kyc-dob">জন্ম তারিখ</label>
              <input
                id="kyc-dob"
                type="date"
                required
                value={kycDob}
                onChange={(e) => setKycDob(e.target.value)}
                className="ew-input-control no-icon"
              />
            </div>
            <div>
              <label className="ew-input-label" htmlFor="kyc-nid">NID নম্বর</label>
              <input
                id="kyc-nid"
                type="text"
                required
                value={kycNid}
                onChange={(e) => setKycNid(e.target.value)}
                placeholder="১০ বা ১৭ ডিজিটের NID নম্বর"
                className="ew-input-control no-icon"
              />
            </div>
            <div>
              <span className="ew-input-label">NID সামনের দিকের ছবি</span>
              <label className="w-full h-32 border-2 border-dashed border-[#E2EBE6] rounded-2xl bg-[#F4F7F5] flex flex-col items-center justify-center cursor-pointer overflow-hidden">
                {kycFilePreview ? (
                  <img src={kycFilePreview} alt="NID প্রিভিউ" className="w-full h-full object-cover" />
                ) : (
                  <>
                    <Upload className="w-6 h-6 text-[#6B7C73] mb-1.5" />
                    <span className="text-xs font-semibold text-[#6B7C73]">NID ছবি আপলোড করতে ট্যাপ করুন</span>
                  </>
                )}
                <input type="file" accept="image/*" onChange={handleKycFileSelect} className="hidden" />
              </label>
            </div>
            {errorMsg && <p className="text-xs font-semibold text-[#E53935]">{errorMsg}</p>}
            <button type="submit" disabled={submitting} className="ew-btn">
              {submitting ? 'আপলোড ও জমা হচ্ছে...' : 'KYC জমা দিন'}
            </button>
          </form>
        )}

        {/* EDIT PROFILE MODAL */}
        {activeModal === 'edit-profile' && (
          <form onSubmit={handleProfileSave} className="space-y-3.5">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-extrabold text-[#12251D]">ব্যক্তিগত তথ্য সম্পাদনা</h2>
              <button type="button" onClick={onClose} className="p-1.5 rounded-full bg-[#F4F7F5] text-[#6B7C73] cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="ew-input-label" htmlFor="ep-name">পূর্ণ নাম</label>
              <input id="ep-name" type="text" required value={editName} onChange={(e) => setEditName(e.target.value)} className="ew-input-control no-icon" />
            </div>
            <div>
              <label className="ew-input-label" htmlFor="ep-email">ইমেইল (পরিবর্তনযোগ্য নয়)</label>
              <input id="ep-email" type="email" readOnly value={profile?.email || ''} className="ew-input-control no-icon" />
            </div>
            <div>
              <label className="ew-input-label" htmlFor="ep-phone">ফোন নম্বর</label>
              <input id="ep-phone" type="tel" value={editPhone} onChange={(e) => setEditPhone(e.target.value)} className="ew-input-control no-icon" />
            </div>
            <div>
              <label className="ew-input-label" htmlFor="ep-country">দেশ</label>
              <input id="ep-country" type="text" value={editCountry} onChange={(e) => setEditCountry(e.target.value)} className="ew-input-control no-icon" />
            </div>
            <div>
              <label className="ew-input-label" htmlFor="ep-id">এজেন্ট আইডি</label>
              <input id="ep-id" type="text" readOnly value={profile?.agent_code || '—'} className="ew-input-control no-icon font-mono" />
            </div>
            {errorMsg && <p className="text-xs font-semibold text-[#E53935]">{errorMsg}</p>}
            <button type="submit" disabled={submitting} className="ew-btn">
              {submitting ? 'সংরক্ষণ হচ্ছে...' : 'তথ্য সেভ করুন'}
            </button>
          </form>
        )}

        {/* CHANGE PASSWORD MODAL */}
        {activeModal === 'change-pass' && (
          <form onSubmit={handleChangePass} className="space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Lock className="w-4 h-4 text-[#075B3A]" />
                <h2 className="text-base font-extrabold text-[#12251D]">পাসওয়ার্ড পরিবর্তন</h2>
              </div>
              <button type="button" onClick={onClose} className="p-1.5 rounded-full bg-[#F4F7F5] text-[#6B7C73] cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="ew-input-label" htmlFor="cp-curr">বর্তমান পাসওয়ার্ড</label>
              <input id="cp-curr" type="password" required value={currPass} onChange={(e) => setCurrPass(e.target.value)} className="ew-input-control no-icon" />
            </div>
            <div>
              <label className="ew-input-label" htmlFor="cp-new">নতুন পাসওয়ার্ড (কমপক্ষে ৬ অক্ষর)</label>
              <input id="cp-new" type="password" required minLength={6} value={newPass} onChange={(e) => setNewPass(e.target.value)} className="ew-input-control no-icon" />
            </div>
            <div>
              <label className="ew-input-label" htmlFor="cp-conf">নতুন পাসওয়ার্ড নিশ্চিত করুন</label>
              <input id="cp-conf" type="password" required minLength={6} value={confPass} onChange={(e) => setConfPass(e.target.value)} className="ew-input-control no-icon" />
            </div>
            {errorMsg && <p className="text-xs font-semibold text-[#E53935]">{errorMsg}</p>}
            <button type="submit" disabled={submitting} className="ew-btn">
              {submitting ? 'আপডেট হচ্ছে...' : 'পাসওয়ার্ড আপডেট করুন'}
            </button>
          </form>
        )}

        {/* WITHDRAW PIN MODAL */}
        {activeModal === 'pin-setup' && (
          <form onSubmit={handlePinSave} className="space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-[#075B3A]" />
                <h2 className="text-base font-extrabold text-[#12251D]">
                  {profile?.has_withdraw_pin ? 'উইথড্র পিন পরিবর্তন' : 'উইথড্র পিন সেট করুন'}
                </h2>
              </div>
              <button type="button" onClick={onClose} className="p-1.5 rounded-full bg-[#F4F7F5] text-[#6B7C73] cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-3 rounded-xl bg-[#E9F7F0] text-[11px] font-semibold text-[#075B3A] flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              উইথড্র রিকোয়েস্ট পাঠানোর সময় ৪–৬ সংখ্যার এই গোপন পিন প্রয়োজন হবে।
            </div>
            {profile?.has_withdraw_pin && (
              <div>
                <label className="ew-input-label" htmlFor="pin-curr">বর্তমান উইথড্র পিন</label>
                <input
                  id="pin-curr"
                  type="password"
                  inputMode="numeric"
                  required
                  maxLength={6}
                  value={currPin}
                  onChange={(e) => setCurrPin(e.target.value.replace(/\D/g, ''))}
                  placeholder="••••"
                  className="ew-input-control no-icon font-mono tracking-widest"
                />
              </div>
            )}
            <div>
              <label className="ew-input-label" htmlFor="pin-new">নতুন ৪–৬ ডিজিট পিন</label>
              <input
                id="pin-new"
                type="password"
                inputMode="numeric"
                required
                minLength={4}
                maxLength={6}
                value={newPin}
                disabled={submitting}
                onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
                placeholder="••••"
                className="ew-input-control no-icon font-mono tracking-widest"
              />
            </div>
            <div>
              <label className="ew-input-label" htmlFor="pin-conf">পিন নিশ্চিত করুন</label>
              <input
                id="pin-conf"
                type="password"
                inputMode="numeric"
                required
                minLength={4}
                maxLength={6}
                value={confPin}
                disabled={submitting}
                onChange={(e) => setConfPin(e.target.value.replace(/\D/g, ''))}
                placeholder="••••"
                className="ew-input-control no-icon font-mono tracking-widest"
              />
            </div>
            {errorMsg && <p className="text-xs font-semibold text-[#E53935]">{errorMsg}</p>}
            <button type="submit" disabled={submitting} className="ew-btn">
              {submitting ? 'সংরক্ষণ হচ্ছে...' : 'পিন সংরক্ষণ করুন'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
