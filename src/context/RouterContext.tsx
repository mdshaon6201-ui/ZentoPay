import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { AppRoute } from '../types/zentopay.ts';

const VALID_ROUTES: AppRoute[] = [
  '/',
  '/login',
  '/register',
  '/policy',
  '/dashboard/agent',
  '/dashboard/super-admin',
  '/dashboard/finance-admin',
  '/dashboard/support-admin',
];

function normalizeRoute(pathname: string): AppRoute {
  if (pathname === '/dashboard/user' || pathname === '/dashboard/sub-agent') {
    return '/dashboard/agent';
  }
  if (VALID_ROUTES.includes(pathname as AppRoute)) {
    return pathname as AppRoute;
  }
  return '/';
}

interface RouterContextValue {
  route: AppRoute;
  navigate: (to: AppRoute, hash?: string) => void;
}

const RouterContext = createContext<RouterContextValue | null>(null);

export function RouterProvider({ children }: { children: React.ReactNode }) {
  const [route, setRoute] = useState<AppRoute>(() => normalizeRoute(window.location.pathname));

  useEffect(() => {
    const handlePopState = () => {
      setRoute(normalizeRoute(window.location.pathname));
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback((to: AppRoute, hash?: string) => {
    const targetUrl = hash ? `${to}#${hash}` : to;
    if (window.location.pathname !== to || hash) {
      window.history.pushState({}, '', targetUrl);
    }
    setRoute(to);

    if (hash) {
      requestAnimationFrame(() => {
        const el = document.getElementById(hash);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth' });
        }
      });
    } else {
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    }
  }, []);

  return (
    <RouterContext.Provider value={{ route, navigate }}>
      {children}
    </RouterContext.Provider>
  );
}

export function useRouter() {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error('useRouter must be used within RouterProvider');
  return ctx;
}
