import React from 'react';
import { Lock, ShieldAlert } from 'lucide-react';
import { RouterProvider, useRouter } from './context/RouterContext.tsx';
import { AuthProvider, useAuth } from './context/AuthContext.tsx';
import { LandingPage } from './pages/LandingPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { RegisterPage } from './pages/RegisterPage.tsx';
import { PolicyPage } from './pages/PolicyPage.tsx';
import { AgentDashboard } from './pages/dashboards/AgentDashboard.tsx';
import { SuperAdminDashboard } from './pages/dashboards/SuperAdminDashboard.tsx';
import { FinanceAdminDashboard } from './pages/dashboards/FinanceAdminDashboard.tsx';
import { SupportAdminDashboard } from './pages/dashboards/SupportAdminDashboard.tsx';
import { ROLE_LABELS, ROLE_TO_ROUTE, type UserRole } from './types/zentopay.ts';

function RoleGuardedPortal({
  requiredRole,
  children,
}: {
  requiredRole: UserRole;
  children: React.ReactNode;
}) {
  const { isConfigured, isLoading, authUser, profile, profileError, signOut, refreshAccountData } = useAuth();
  const { navigate } = useRouter();

  const handleSwitchAccount = async () => {
    await signOut();
    navigate('/login');
  };

  if (isConfigured && isLoading) {
    return (
      <div className="min-h-screen bg-[#043824] flex items-center justify-center p-6">
        <p className="text-sm font-semibold text-[#E9F7F0]">সেশন ও রোল অনুমতি যাচাই হচ্ছে...</p>
      </div>
    );
  }

  // Require authentication before accessing Agent Portal or Admin portals
  if (isConfigured && !authUser) {
    return (
      <div className="ew-mobile-viewport">
        <div className="app-container justify-center p-6 bg-[#F4F7F5]">
          <div className="bg-white border border-[#E2EBE6] rounded-3xl p-7 text-center shadow-sm">
            <div className="w-12 h-12 mx-auto rounded-2xl bg-[#E9F7F0] border border-[#16A66A]/25 text-[#075B3A] flex items-center justify-center">
              <Lock className="w-6 h-6" />
            </div>
            <h1 className="mt-4 text-xl font-extrabold text-[#12251D]">লগইন প্রয়োজন</h1>
            <p className="mt-2 text-xs text-[#6B7C73] leading-relaxed">
              এই পোর্টালে প্রবেশ করতে অনুগ্রহ করে আপনার ZentoPay ({ROLE_LABELS[requiredRole]}) অ্যাকাউন্টে লগইন করুন।
            </p>
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => navigate('/login')}
                className="ew-btn py-3 text-sm"
              >
                লগইন করুন
              </button>
              <button
                type="button"
                onClick={() => navigate('/')}
                className="ew-btn ew-btn-secondary py-3 text-sm"
              >
                হোম পেজ
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Wait for profile resolution or display actionable recovery if profile lookup failed
  if (isConfigured && authUser && !profile) {
    if (profileError) {
      return (
        <div className="ew-mobile-viewport">
          <div className="app-container justify-center p-6 bg-[#F4F7F5]">
            <div className="bg-white border border-[#E2EBE6] rounded-3xl p-7 text-center shadow-sm">
              <div className="w-12 h-12 mx-auto rounded-2xl bg-amber-50 border border-amber-200 text-amber-700 flex items-center justify-center">
                <ShieldAlert className="w-6 h-6" />
              </div>
              <h1 className="mt-4 text-xl font-extrabold text-[#12251D]">প্রোফাইল যাচাই করা যায়নি</h1>
              <p className="mt-2 text-xs text-[#6B7C73] leading-relaxed">{profileError}</p>
              <div className="mt-6 flex flex-col gap-2.5">
                <button
                  type="button"
                  onClick={() => refreshAccountData()}
                  className="ew-btn py-3 text-sm"
                >
                  আবার চেষ্টা করুন
                </button>
                <button
                  type="button"
                  onClick={handleSwitchAccount}
                  className="ew-btn ew-btn-secondary py-3 text-sm"
                >
                  লগআউট করে অন্য অ্যাকাউন্টে লগইন করুন
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-[#043824] flex items-center justify-center p-6">
        <p className="text-sm font-semibold text-[#E9F7F0]">ব্যবহারকারীর প্রোফাইল ও রোল লোড হচ্ছে...</p>
      </div>
    );
  }

  // Enforce strict role isolation when authenticated against live Supabase
  if (isConfigured && authUser && profile) {
    const isAgentPortalMember =
      requiredRole === 'agent' &&
      (profile.role === 'user' ||
        profile.role === 'agent' ||
        profile.role === 'sub_agent' ||
        profile.role === 'super_admin');
    const isAdminAllowed =
      requiredRole !== 'agent' &&
      (profile.role === requiredRole || profile.role === 'super_admin');

    if (!isAgentPortalMember && !isAdminAllowed) {
      return (
        <div className="ew-mobile-viewport">
          <div className="app-container justify-center p-6 bg-[#F4F7F5]">
            <div className="bg-white border border-[#E2EBE6] rounded-3xl p-7 text-center shadow-sm">
              <div className="w-12 h-12 mx-auto rounded-2xl bg-red-50 border border-red-200 text-[#E53935] flex items-center justify-center">
                <ShieldAlert className="w-6 h-6" />
              </div>
              <h1 className="mt-4 text-xl font-extrabold text-[#12251D]">অ্যাক্সেস সীমাবদ্ধ</h1>
              <p className="mt-2 text-xs text-[#6B7C73] leading-relaxed">
                আপনার লগইন করা অ্যাকাউন্ট রোল ({ROLE_LABELS[profile.role]}) দিয়ে {ROLE_LABELS[requiredRole]} পোর্টালে প্রবেশের অনুমতি নেই।
              </p>
              <div className="mt-6 flex flex-col gap-2.5">
                <button
                  type="button"
                  onClick={() => navigate(ROLE_TO_ROUTE[profile.role])}
                  className="ew-btn py-3 text-sm"
                >
                  {ROLE_LABELS[profile.role]}-এ ফিরে যান
                </button>
                <button
                  type="button"
                  onClick={handleSwitchAccount}
                  className="ew-btn ew-btn-secondary py-3 text-sm"
                >
                  লগআউট করে অ্যাডমিন অ্যাকাউন্টে লগইন করুন
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }
  }

  return <>{children}</>;
}

function ZentoPayRouterView() {
  const { route } = useRouter();

  switch (route) {
    case '/':
      return <LandingPage />;
    case '/login':
      return <LoginPage />;
    case '/register':
      return <RegisterPage />;
    case '/policy':
      return <PolicyPage />;
    case '/dashboard/agent':
      return (
        <RoleGuardedPortal requiredRole="agent">
          <AgentDashboard />
        </RoleGuardedPortal>
      );
    case '/dashboard/super-admin':
      return (
        <RoleGuardedPortal requiredRole="super_admin">
          <SuperAdminDashboard />
        </RoleGuardedPortal>
      );
    case '/dashboard/finance-admin':
      return (
        <RoleGuardedPortal requiredRole="finance_admin">
          <FinanceAdminDashboard />
        </RoleGuardedPortal>
      );
    case '/dashboard/support-admin':
      return (
        <RoleGuardedPortal requiredRole="support_admin">
          <SupportAdminDashboard />
        </RoleGuardedPortal>
      );
    default:
      return <LandingPage />;
  }
}

export default function App() {
  return (
    <RouterProvider>
      <AuthProvider>
        <ZentoPayRouterView />
      </AuthProvider>
    </RouterProvider>
  );
}
