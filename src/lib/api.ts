import { supabase } from './supabase.ts';

export interface ApiResponse<T> {
  ok: boolean;
  configured: boolean;
  status?: number;
  code?: string;
  schemaPending?: boolean;
  fromDb?: boolean;
  data?: T;
  error?: string;
}

async function getAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const token = await getAccessToken();
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  try {
    const res = await fetch(path, {
      ...options,
      cache: options.cache ?? 'no-store',
      headers,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        configured: payload.configured ?? res.status !== 503,
        status: res.status,
        code: payload.code,
        schemaPending: payload.schemaPending ?? payload.code === 'SCHEMA_PENDING',
        error: payload.error || `অনুরোধ ব্যর্থ হয়েছে (${res.status})`,
      };
    }
    return {
      ok: true,
      configured: payload.configured ?? true,
      status: res.status,
      code: payload.code,
      schemaPending: payload.schemaPending,
      fromDb: payload.fromDb,
      data: payload.data ?? payload,
    };
  } catch (err) {
    return {
      ok: false,
      configured: false,
      error: err instanceof Error ? err.message : 'নেটওয়ার্ক ত্রুটি',
    };
  }
}

export function formatCurrency(amount: number, currency = 'BDT'): string {
  const num = Number.isFinite(amount) ? amount : 0;
  const code = (currency || 'BDT').toUpperCase();
  if (code === 'BDT') {
    return `৳ ${new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num)}`;
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: code,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

export function formatTaka(amount: number): string {
  const num = Number.isFinite(amount) ? amount : 0;
  return `৳ ${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num)}`;
}

export function formatBdt(amount: number, lang: 'bn' | 'en' = 'bn'): string {
  const num = Number.isFinite(amount) ? amount : 0;
  const hasDecimals = Math.abs(num % 1) > 0.001;
  const formatted = new Intl.NumberFormat(lang === 'bn' ? 'bn-BD' : 'en-US', {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(num);
  return `৳${formatted}`;
}

export function formatDateTime(iso: string, lang: 'bn' | 'en' = 'bn'): string {
  return new Intl.DateTimeFormat(lang === 'bn' ? 'bn-BD' : 'en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function exportRowsToCsv(filename: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const csvLines = [
    headers.join(','),
    ...rows.map((row) =>
      headers
        .map((key) => {
          const val = row[key] ?? '';
          const escaped = String(val).replace(/"/g, '""');
          return `"${escaped}"`;
        })
        .join(',')
    ),
  ];
  const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
