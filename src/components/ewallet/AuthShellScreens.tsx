import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  HelpCircle,
  Lock,
  Mail,
  Phone,
  ShieldCheck,
  User,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { useRouter } from '../../context/RouterContext.tsx';
import { ROLE_TO_ROUTE } from '../../types/zentopay.ts';
import { ZentoPayEmblem } from './MethodLogo.tsx';

type AuthMode = 'splash' | 'login' | 'register';

export function AuthShellScreens({ initialMode }: { initialMode: AuthMode }) {
  const { navigate } = useRouter();
  const { isConfigured, isLoading, authUser, profile, signIn, signUp, resetPassword, platformConfig } = useAuth();

  const [screen, setScreen] = useState<AuthMode>(initialMode);
  const [toastMsg, setToastMsg] = useState('');

  // Login state
  const [loginEmail, setLoginEmail] = useState(() => {
    try {
      return localStorage.getItem('zentopay_remember_email') || '';
    } catch {
      return '';
    }
  });
  const [loginPassword, setLoginPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(() => {
    try {
      return Boolean(localStorage.getItem('zentopay_remember_email'));
    } catch {
      return false;
    }
  });
  const [showLoginPass, setShowLoginPass] = useState(false);
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [loginError, setLoginError] = useState('');

  // Forgot Password modal state
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotStatus, setForgotStatus] = useState('');
  const [forgotSending, setForgotSending] = useState(false);

  // Register state
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirm, setRegConfirm] = useState('');
  const [regReferralCode, setRegReferralCode] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('ref') || '';
    } catch {
      return '';
    }
  });
  const [regTerms, setRegTerms] = useState(false);
  const [showRegPass, setShowRegPass] = useState(false);
  const [showRegConfirm, setShowRegConfirm] = useState(false);
  const [regSubmitting, setRegSubmitting] = useState(false);
  const [regError, setRegError] = useState('');

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(''), 3000);
  };

  useEffect(() => {
    setScreen(initialMode);
  }, [initialMode]);

  // Splash auto-transition & authenticated session auto-redirect
  useEffect(() => {
    if (isLoading) return;
    if (authUser && profile) {
      navigate(ROLE_TO_ROUTE[profile.role]);
      return;
    }
    if (screen === 'splash') {
      const timer = setTimeout(() => {
        setScreen('login');
      }, 1350);
      return () => clearTimeout(timer);
    }
  }, [isLoading, authUser, profile, screen, navigate]);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    const email = loginEmail.trim();
    if (!email || !loginPassword) {
      setLoginError('অনুগ্রহ করে আপনার ইমেইল এবং পাসওয়ার্ড লিখুন।');
      return;
    }

    setLoginSubmitting(true);
    const res = await signIn(email, loginPassword);
    setLoginSubmitting(false);

    if (res.error) {
      setLoginError(res.error);
      return;
    }

    try {
      if (rememberMe) {
        localStorage.setItem('zentopay_remember_email', email);
      } else {
        localStorage.removeItem('zentopay_remember_email');
      }
    } catch {
      // ignore storage quota errors
    }

    const targetRole = res.role || 'agent';
    navigate(ROLE_TO_ROUTE[targetRole]);
  };

  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setForgotStatus('');
    if (!forgotEmail.trim()) {
      setForgotStatus('অনুগ্রহ করে আপনার নিবন্ধিত ইমেইল ঠিকানা লিখুন।');
      return;
    }
    setForgotSending(true);
    const res = await resetPassword(forgotEmail.trim());
    setForgotSending(false);
    if (res.error) {
      setForgotStatus(res.error);
    } else {
      setForgotStatus('আপনার ইমেইলে পাসওয়ার্ড রিসেট লিংক পাঠানো হয়েছে। ইনবক্স বা স্প্যাম ফোল্ডার চেক করুন।');
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegError('');

    if (!regName.trim() || !regEmail.trim() || !regPhone.trim()) {
      setRegError('অনুগ্রহ করে নাম, ইমেইল এবং ফোন নম্বর সঠিকভাবে পূরণ করুন।');
      return;
    }
    if (regPassword.length < 6) {
      setRegError('পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।');
      return;
    }
    if (regPassword !== regConfirm) {
      setRegError('পাসওয়ার্ড এবং নিশ্চিত পাসওয়ার্ড মিলছে না।');
      return;
    }
    if (!regTerms) {
      setRegError('এজেন্ট অ্যাকাউন্ট খুলতে শর্তাবলী ও নীতিমালায় সম্মতি দিন।');
      return;
    }

    setRegSubmitting(true);
    const res = await signUp({
      email: regEmail.trim(),
      password: regPassword,
      fullName: regName.trim(),
      phone: regPhone.trim(),
      country: 'BD',
      referralCode: regReferralCode.trim() || undefined,
    });
    setRegSubmitting(false);

    if (res.error) {
      setRegError(res.error);
      return;
    }

    navigate(ROLE_TO_ROUTE[res.role || 'agent']);
  };

  const handleHelpClick = () => {
    const tg = platformConfig.supportLinks.telegram;
    if (tg) {
      window.open(tg, '_blank', 'noopener,noreferrer');
    } else {
      navigate('/policy');
    }
  };

  return (
    <div className="ew-mobile-viewport">
      <div className="app-container">
        {/* Toast */}
        <div className={`ew-toast ${toastMsg ? 'active' : ''}`} role="status">
          {toastMsg}
        </div>

        {/* SCREEN 1: SPLASH SCREEN */}
        {screen === 'splash' && (
          <section className="ew-splash-screen" aria-label="ZentoPay লোডিং স্ক্রিন">
            <div className="splash-logo-wrap">
              <ZentoPayEmblem size={56} />
            </div>
            <h1 className="splash-title">ZentoPay</h1>
            <p className="splash-sub">ভেরিফাইড এমএফএস এজেন্ট ওয়ালেট</p>
            <div className="splash-progress-track">
              <div className="splash-progress-bar" />
            </div>
          </section>
        )}

        {/* SCREEN 2: LOGIN SCREEN */}
        {screen === 'login' && (
          <section className="ew-screen ew-screen-no-nav">
            <div className="ew-auth-container">
              <div className="flex items-center justify-between mb-4">
                <button
                  type="button"
                  onClick={() => navigate('/policy')}
                  className="text-xs font-bold text-[#075B3A] hover:underline cursor-pointer"
                >
                  Agent Policy
                </button>
                <button
                  type="button"
                  onClick={handleHelpClick}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-[#E2EBE6] text-xs font-bold text-[#12251D] cursor-pointer"
                >
                  <HelpCircle className="w-3.5 h-3.5 text-[#075B3A]" />
                  Help
                </button>
              </div>

              <div className="flex flex-col items-center text-center mb-6 mt-2">
                <ZentoPayEmblem size={54} />
                <h1 className="text-[22px] font-extrabold text-[#12251D] mt-3">
                  ZentoPay এজেন্ট লগইন
                </h1>
                <p className="text-xs font-medium text-[#6B7C73] mt-1">
                  আপনার ইমেইল ও পাসওয়ার্ড দিয়ে ড্যাশবোর্ডে প্রবেশ করুন
                </p>
              </div>

              {!isConfigured && (
                <div className="mb-4 rounded-xl bg-amber-50 border border-amber-200 px-3.5 py-2.5 text-xs text-amber-900 leading-relaxed">
                  Supabase এনভায়রনমেন্ট ভ্যারিয়েবল সেট করা নেই। লাইভ লগইনের জন্য VITE_SUPABASE_URL ও VITE_SUPABASE_ANON_KEY যোগ করুন।
                </div>
              )}

              <div className="ew-auth-card">
                <form onSubmit={handleLoginSubmit}>
                  <div className="ew-input-group">
                    <label className="ew-input-label" htmlFor="ew-login-email">
                      ইমেইল ঠিকানা
                    </label>
                    <div className="ew-input-wrapper">
                      <Mail className="w-[18px] h-[18px] text-[#6B7C73] absolute left-3.5 pointer-events-none" />
                      <input
                        id="ew-login-email"
                        type="email"
                        required
                        autoComplete="email"
                        value={loginEmail}
                        onChange={(e) => setLoginEmail(e.target.value)}
                        placeholder="agent@example.com"
                        className="ew-input-control"
                      />
                    </div>
                  </div>

                  <div className="ew-input-group">
                    <label className="ew-input-label" htmlFor="ew-login-password">
                      পাসওয়ার্ড
                    </label>
                    <div className="ew-input-wrapper">
                      <Lock className="w-[18px] h-[18px] text-[#6B7C73] absolute left-3.5 pointer-events-none" />
                      <input
                        id="ew-login-password"
                        type={showLoginPass ? 'text' : 'password'}
                        required
                        autoComplete="current-password"
                        value={loginPassword}
                        onChange={(e) => setLoginPassword(e.target.value)}
                        placeholder="••••••••"
                        className="ew-input-control pr-11"
                      />
                      <button
                        type="button"
                        onClick={() => setShowLoginPass((v) => !v)}
                        aria-label={showLoginPass ? 'পাসওয়ার্ড লুকান' : 'পাসওয়ার্ড দেখুন'}
                        className="absolute right-3.5 text-[#6B7C73] cursor-pointer"
                      >
                        {showLoginPass ? <EyeOff className="w-[18px] h-[18px]" /> : <Eye className="w-[18px] h-[18px]" />}
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between mb-4 text-xs">
                    <label className="inline-flex items-center gap-2 text-[#12251D] font-semibold cursor-pointer">
                      <input
                        type="checkbox"
                        checked={rememberMe}
                        onChange={(e) => setRememberMe(e.target.checked)}
                        className="accent-[#075B3A] w-4 h-4 rounded"
                      />
                      মনে রাখুন
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setForgotEmail(loginEmail);
                        setForgotStatus('');
                        setForgotOpen(true);
                      }}
                      className="font-bold text-[#075B3A] hover:underline cursor-pointer"
                    >
                      পাসওয়ার্ড ভুলে গেছেন?
                    </button>
                  </div>

                  {loginError && (
                    <div className="mb-3.5 rounded-xl bg-red-50 border border-red-200 px-3 py-2.5 text-xs font-semibold text-[#E53935]">
                      {loginError}
                    </div>
                  )}

                  <button type="submit" disabled={loginSubmitting} className="ew-btn">
                    {loginSubmitting ? 'যাচাই হচ্ছে...' : 'লগইন করুন'}
                  </button>
                </form>

                <div className="flex items-center gap-3 my-4 text-[11px] font-semibold text-[#6B7C73]">
                  <div className="flex-1 h-px bg-[#E2EBE6]" />
                  <span>অথবা</span>
                  <div className="flex-1 h-px bg-[#E2EBE6]" />
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => showToast('অ্যাকাউন্ট সুরক্ষার জন্য ইমেইল ও পাসওয়ার্ড দিয়ে লগইন করুন।')}
                    className="py-2.5 px-3 rounded-xl border border-[#E2EBE6] bg-[#F4F7F5] text-xs font-bold text-[#12251D] flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <span className="font-black text-[#EA4335]">G</span> Google
                  </button>
                  <button
                    type="button"
                    onClick={() => showToast('অ্যাকাউন্ট সুরক্ষার জন্য ইমেইল ও পাসওয়ার্ড দিয়ে লগইন করুন।')}
                    className="py-2.5 px-3 rounded-xl border border-[#E2EBE6] bg-[#F4F7F5] text-xs font-bold text-[#12251D] flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <span className="font-black text-[#12251D]"></span> Apple
                  </button>
                </div>
              </div>

              <div className="mt-5 text-center text-xs font-semibold text-[#6B7C73]">
                নতুন এজেন্ট হতে চান?{' '}
                <button
                  type="button"
                  onClick={() => {
                    setScreen('register');
                    navigate('/register');
                  }}
                  className="text-[#075B3A] font-extrabold hover:underline cursor-pointer"
                >
                  রেজিস্ট্রেশন করুন
                </button>
              </div>

              <div className="mt-4 flex items-center justify-center gap-1.5 text-[11px] font-semibold text-[#6B7C73]">
                <ShieldCheck className="w-3.5 h-3.5 text-[#16A66A]" />
                SSL এনক্রিপ্টেড · ভেরিফাইড ZentoPay এজেন্ট সিস্টেম
              </div>
            </div>
          </section>
        )}

        {/* SCREEN 3: REGISTER SCREEN */}
        {screen === 'register' && (
          <section className="ew-screen ew-screen-no-nav">
            <div className="ew-page-header">
              <button
                type="button"
                className="ew-header-btn"
                onClick={() => {
                  setScreen('login');
                  navigate('/login');
                }}
                aria-label="পিছনে যান"
              >
                <ArrowLeft className="w-4 h-4 text-[#12251D]" />
              </button>
              <span className="ew-page-header-title">নতুন এজেন্ট রেজিস্ট্রেশন</span>
              <div className="w-10" />
            </div>

            <div className="ew-auth-container">
              <div className="ew-auth-card">
                <form onSubmit={handleRegisterSubmit}>
                  <div className="ew-input-group">
                    <label className="ew-input-label" htmlFor="ew-reg-name">
                      পূর্ণ নাম
                    </label>
                    <div className="ew-input-wrapper">
                      <User className="w-[18px] h-[18px] text-[#6B7C73] absolute left-3.5 pointer-events-none" />
                      <input
                        id="ew-reg-name"
                        type="text"
                        required
                        value={regName}
                        onChange={(e) => setRegName(e.target.value)}
                        placeholder="আপনার পূর্ণ নাম লিখুন"
                        className="ew-input-control"
                      />
                    </div>
                  </div>

                  <div className="ew-input-group">
                    <label className="ew-input-label" htmlFor="ew-reg-email">
                      ইমেইল ঠিকানা
                    </label>
                    <div className="ew-input-wrapper">
                      <Mail className="w-[18px] h-[18px] text-[#6B7C73] absolute left-3.5 pointer-events-none" />
                      <input
                        id="ew-reg-email"
                        type="email"
                        required
                        value={regEmail}
                        onChange={(e) => setRegEmail(e.target.value)}
                        placeholder="agent@example.com"
                        className="ew-input-control"
                      />
                    </div>
                  </div>

                  <div className="ew-input-group">
                    <label className="ew-input-label" htmlFor="ew-reg-phone">
                      ফোন নম্বর (বাংলাদেশ)
                    </label>
                    <div className="ew-input-wrapper">
                      <Phone className="w-[18px] h-[18px] text-[#6B7C73] absolute left-3.5 pointer-events-none" />
                      <input
                        id="ew-reg-phone"
                        type="tel"
                        required
                        value={regPhone}
                        onChange={(e) => setRegPhone(e.target.value)}
                        placeholder="01XXXXXXXXX"
                        className="ew-input-control"
                      />
                    </div>
                  </div>

                  <div className="ew-input-group">
                    <label className="ew-input-label" htmlFor="ew-reg-pass">
                      পাসওয়ার্ড (কমপক্ষে ৬ অক্ষর)
                    </label>
                    <div className="ew-input-wrapper">
                      <Lock className="w-[18px] h-[18px] text-[#6B7C73] absolute left-3.5 pointer-events-none" />
                      <input
                        id="ew-reg-pass"
                        type={showRegPass ? 'text' : 'password'}
                        required
                        minLength={6}
                        value={regPassword}
                        onChange={(e) => setRegPassword(e.target.value)}
                        placeholder="••••••••"
                        className="ew-input-control pr-11"
                      />
                      <button
                        type="button"
                        onClick={() => setShowRegPass((v) => !v)}
                        className="absolute right-3.5 text-[#6B7C73] cursor-pointer"
                      >
                        {showRegPass ? <EyeOff className="w-[18px] h-[18px]" /> : <Eye className="w-[18px] h-[18px]" />}
                      </button>
                    </div>
                  </div>

                  <div className="ew-input-group">
                    <label className="ew-input-label" htmlFor="ew-reg-confirm">
                      পাসওয়ার্ড নিশ্চিত করুন
                    </label>
                    <div className="ew-input-wrapper">
                      <Lock className="w-[18px] h-[18px] text-[#6B7C73] absolute left-3.5 pointer-events-none" />
                      <input
                        id="ew-reg-confirm"
                        type={showRegConfirm ? 'text' : 'password'}
                        required
                        minLength={6}
                        value={regConfirm}
                        onChange={(e) => setRegConfirm(e.target.value)}
                        placeholder="••••••••"
                        className="ew-input-control pr-11"
                      />
                      <button
                        type="button"
                        onClick={() => setShowRegConfirm((v) => !v)}
                        className="absolute right-3.5 text-[#6B7C73] cursor-pointer"
                      >
                        {showRegConfirm ? <EyeOff className="w-[18px] h-[18px]" /> : <Eye className="w-[18px] h-[18px]" />}
                      </button>
                    </div>
                  </div>

                  <div className="ew-input-group">
                    <label className="ew-input-label" htmlFor="ew-reg-ref">
                      অ্যাফিলিয়েট রেফারেল আইডি (ঐচ্ছিক)
                    </label>
                    <div className="ew-input-wrapper">
                      <Users className="w-[18px] h-[18px] text-[#6B7C73] absolute left-3.5 pointer-events-none" />
                      <input
                        id="ew-reg-ref"
                        type="text"
                        value={regReferralCode}
                        onChange={(e) => setRegReferralCode(e.target.value)}
                        placeholder="যেমন: 67123456"
                        className="ew-input-control"
                      />
                    </div>
                  </div>

                  <label className="flex items-start gap-2.5 text-xs text-[#12251D] mb-4 cursor-pointer leading-relaxed">
                    <input
                      type="checkbox"
                      checked={regTerms}
                      onChange={(e) => setRegTerms(e.target.checked)}
                      className="accent-[#075B3A] w-4 h-4 mt-0.5 shrink-0"
                    />
                    <span>
                      আমি ZentoPay-এর{' '}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          navigate('/policy');
                        }}
                        className="font-bold text-[#075B3A] underline cursor-pointer"
                      >
                        এজেন্ট নীতিমালা ও গোপনীয়তা নীতি
                      </button>{' '}
                      মেনে নিচ্ছি।
                    </span>
                  </label>

                  {regError && (
                    <div className="mb-3.5 rounded-xl bg-red-50 border border-red-200 px-3 py-2.5 text-xs font-semibold text-[#E53935]">
                      {regError}
                    </div>
                  )}

                  <button type="submit" disabled={regSubmitting} className="ew-btn">
                    {regSubmitting ? 'অ্যাকাউন্ট তৈরি হচ্ছে...' : 'অ্যাকাউন্ট তৈরি করুন'}
                  </button>
                </form>
              </div>

              <div className="mt-5 text-center text-xs font-semibold text-[#6B7C73]">
                ইতিমধ্যে অ্যাকাউন্ট আছে?{' '}
                <button
                  type="button"
                  onClick={() => {
                    setScreen('login');
                    navigate('/login');
                  }}
                  className="text-[#075B3A] font-extrabold hover:underline cursor-pointer"
                >
                  লগইন করুন
                </button>
              </div>
            </div>
          </section>
        )}

        {/* FORGOT PASSWORD MODAL */}
        {forgotOpen && (
          <div className="ew-modal-overlay" role="dialog" aria-modal="true" aria-label="পাসওয়ার্ড রিসেট">
            <div className="ew-modal-content">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-extrabold text-[#12251D]">পাসওয়ার্ড পুনরুদ্ধার</h2>
                <button
                  type="button"
                  onClick={() => setForgotOpen(false)}
                  className="p-1.5 rounded-full bg-[#F4F7F5] text-[#6B7C73] cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <p className="text-xs text-[#6B7C73] mb-4 leading-relaxed">
                আপনার অ্যাকাউন্টের ইমেইল ঠিকানা দিন। পাসওয়ার্ড রিসেট করার নিরাপদ লিংক আপনার ইমেইলে পাঠানো হবে।
              </p>
              <form onSubmit={handleForgotSubmit}>
                <div className="ew-input-group">
                  <label className="ew-input-label" htmlFor="ew-forgot-email">
                    নিবন্ধিত ইমেইল
                  </label>
                  <input
                    id="ew-forgot-email"
                    type="email"
                    required
                    value={forgotEmail}
                    onChange={(e) => setForgotEmail(e.target.value)}
                    placeholder="agent@example.com"
                    className="ew-input-control no-icon"
                  />
                </div>
                {forgotStatus && (
                  <div className="mb-3 rounded-xl bg-[#E9F7F0] border border-[#16A66A]/25 px-3 py-2.5 text-xs font-semibold text-[#075B3A] flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{forgotStatus}</span>
                  </div>
                )}
                <button type="submit" disabled={forgotSending} className="ew-btn">
                  {forgotSending ? 'পাঠানো হচ্ছে...' : 'রিসেট লিংক পাঠান'}
                </button>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
