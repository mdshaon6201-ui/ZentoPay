import React, { useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  LogOut,
  Menu,
  ShieldAlert,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { BrandMark } from './BrandMark.tsx';
import { useRouter } from '../context/RouterContext.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { ROLE_LABELS, type UserRole } from '../types/zentopay.ts';

export interface DashboardNavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  section?: string;
}

interface DashboardLayoutProps {
  role: UserRole;
  navItems: DashboardNavItem[];
  activeTab: string;
  onTabChange: (id: string) => void;
  primaryAction?: {
    label: string;
    onClick: () => void;
  };
  children: React.ReactNode;
}

export function DashboardLayout({
  role,
  navItems,
  activeTab,
  onTabChange,
  primaryAction,
  children,
}: DashboardLayoutProps) {
  const { navigate } = useRouter();
  const { isConfigured, profile, profileError, authUser, signOut } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const activeNav = navItems.find((item) => item.id === activeTab) || navItems[0];

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  const sidebarContent = (
    <div className="flex flex-col h-full bg-white border-r border-slate-200">
      {/* Brand Header */}
      <div className="h-16 px-5 border-b border-slate-200 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 rounded-md"
        >
          <BrandMark />
        </button>
        <button
          type="button"
          onClick={() => setSidebarOpen(false)}
          className="lg:hidden p-1.5 rounded-lg text-slate-500 hover:bg-slate-100"
          aria-label="সাইডবার বন্ধ করুন"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Active Workspace Title (unboxed clean metadata) */}
      <div className="px-5 pt-5 pb-3 border-b border-slate-100">
        <p className="text-xs font-medium text-slate-500">Active Workspace</p>
        <p className="font-display text-sm font-bold text-emerald-800 mt-0.5">
          {ROLE_LABELS[role]}
        </p>
      </div>

      {/* Primary Role Navigation */}
      <nav aria-label="Dashboard Navigation" className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
        {navItems.map((item, idx) => {
          const Icon = item.icon;
          const isActive = item.id === activeTab;
          const prevSection = idx > 0 ? navItems[idx - 1].section : undefined;
          const showSectionHeader = Boolean(item.section && item.section !== prevSection);
          return (
            <React.Fragment key={item.id}>
              {showSectionHeader && (
                <p
                  className={`px-3 text-[11px] font-bold tracking-wide text-slate-400 ${
                    idx === 0 ? 'pb-1' : 'pt-3 pb-1'
                  }`}
                >
                  {item.section}
                </p>
              )}
              <button
                type="button"
                onClick={() => {
                  onTabChange(item.id);
                  setSidebarOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  isActive
                    ? 'bg-emerald-50 text-emerald-800 font-semibold'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <Icon
                  className={`w-4 h-4 shrink-0 ${
                    isActive ? 'text-emerald-700' : 'text-slate-400'
                  }`}
                />
                <span className="truncate">{item.label}</span>
              </button>
            </React.Fragment>
          );
        })}
      </nav>

      {/* Footer Controls */}
      <div className="p-4 border-t border-slate-200 bg-slate-50/70">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-emerald-700 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Home
          </button>
          {authUser ? (
            <button
              type="button"
              onClick={handleSignOut}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-rose-700 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              Logout
            </button>
          ) : (
            <button
              type="button"
              onClick={() => navigate('/login')}
              className="text-xs font-semibold text-emerald-700 hover:text-emerald-800 cursor-pointer"
            >
              Login
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 sticky top-0 h-screen">
        {sidebarContent}
      </aside>

      {/* Mobile / Tablet Slide-Over Sidebar */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/40"
            onClick={() => setSidebarOpen(false)}
          />
          <aside className="relative w-72 max-w-[85vw] h-full z-10">
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Utility Header */}
        <header className="sticky top-0 z-30 h-16 bg-white border-b border-slate-200 px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 cursor-pointer"
              aria-label="নেভিগেশন সাইডবার খুলুন"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="hidden sm:inline text-slate-400">ZentoPay</span>
              <ChevronRight className="hidden sm:inline w-4 h-4 text-slate-300 shrink-0" />
              <span className="text-slate-600 font-medium truncate">
                {ROLE_LABELS[role]}
              </span>
              <ChevronRight className="w-4 h-4 text-slate-300 shrink-0" />
              <span className="font-semibold text-slate-900 truncate">
                {activeNav?.label}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <div className="hidden md:block text-right">
              <p className="text-xs font-semibold text-slate-900 truncate max-w-[180px]">
                {profile?.full_name || authUser?.email || 'ওয়ার্কস্পেস প্রিভিউ'}
              </p>
              <p className="text-[11px] text-slate-500">
                {profile
                  ? `${ROLE_LABELS[profile.role]} · KYC: ${
                      profile.kyc_status === 'verified'
                        ? 'যাচাইকৃত'
                        : profile.kyc_status === 'pending'
                          ? 'পর্যালোচনাধীন'
                          : profile.kyc_status === 'rejected'
                            ? 'বাতিল'
                            : 'অযাচাইকৃত'
                    }`
                  : 'লগইনবিহীন প্রিভিউ'}
              </p>
            </div>
            {primaryAction && (
              <button
                type="button"
                onClick={primaryAction.onClick}
                className="px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {primaryAction.label}
              </button>
            )}
          </div>
        </header>

        {/* Honest Supabase Environment Notice (Never fakes financial records) */}
        {!isConfigured && (
          <div className="bg-emerald-950 text-emerald-50 px-4 sm:px-6 lg:px-8 py-2.5 border-b border-emerald-900">
            <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-emerald-300 shrink-0" />
                <span>
                  এই প্রিভিউতে Supabase PostgreSQL ও Auth এনভায়রনমেন্ট ভ্যারিয়েবল কনফিগার করা নেই। সংযোগ না হওয়া পর্যন্ত লাইভ ব্যালেন্স ও লেনদেন রেকর্ড খালি থাকবে।
                </span>
              </div>
              <button
                type="button"
                onClick={() => navigate('/', 'trust')}
                className="text-emerald-200 hover:text-white font-medium underline underline-offset-2 whitespace-nowrap shrink-0 text-left sm:text-right cursor-pointer"
              >
                নিরাপত্তা ও তথ্য দেখুন
              </button>
            </div>
          </div>
        )}

        {/* Honest Supabase Profile/Schema Error Notice (Never fakes data) */}
        {isConfigured && authUser && profileError && (
          <div className="bg-amber-50 text-amber-950 px-4 sm:px-6 lg:px-8 py-2.5 border-b border-amber-200">
            <div className="max-w-7xl mx-auto flex items-center gap-2 text-xs">
              <ShieldAlert className="w-4 h-4 text-amber-700 shrink-0" />
              <span>{profileError}</span>
            </div>
          </div>
        )}

        {/* Workspace Viewport */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto space-y-6">
          {children}
        </main>
      </div>
    </div>
  );
}
