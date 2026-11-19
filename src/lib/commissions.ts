export type MfsProviderId = 'bkash' | 'nagad' | 'rocket';

export interface CommissionRatesConfig {
  bkash: number;
  nagad: number;
  rocket: number;
}

export const AUTHORITATIVE_COMMISSION_RATES: Readonly<CommissionRatesConfig> = {
  bkash: 0.05,
  nagad: 0.04,
  rocket: 0.04,
} as const;

export const MAX_PROVIDER_COMMISSION_RATE = 0.25;

export function sanitizeProviderRate(rawValue: unknown, fallback: number): number {
  const num = typeof rawValue === 'number' ? rawValue : Number(rawValue);
  if (!Number.isFinite(num) || num < 0 || num > MAX_PROVIDER_COMMISSION_RATE) {
    return fallback;
  }
  return Number(num.toFixed(4));
}

export function sanitizeCommissionRates(raw: unknown): CommissionRatesConfig {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    bkash: sanitizeProviderRate(obj.bkash, AUTHORITATIVE_COMMISSION_RATES.bkash),
    nagad: sanitizeProviderRate(obj.nagad, AUTHORITATIVE_COMMISSION_RATES.nagad),
    rocket: sanitizeProviderRate(obj.rocket, AUTHORITATIVE_COMMISSION_RATES.rocket),
  };
}

export function getAuthoritativeProviderRate(
  provider: string,
  rates?: Partial<CommissionRatesConfig> | null
): number {
  const normalized = String(provider || '').trim().toLowerCase() as MfsProviderId;
  if (normalized === 'bkash') {
    return sanitizeProviderRate(rates?.bkash, AUTHORITATIVE_COMMISSION_RATES.bkash);
  }
  if (normalized === 'nagad') {
    return sanitizeProviderRate(rates?.nagad, AUTHORITATIVE_COMMISSION_RATES.nagad);
  }
  if (normalized === 'rocket') {
    return sanitizeProviderRate(rates?.rocket, AUTHORITATIVE_COMMISSION_RATES.rocket);
  }
  throw new Error(`Unsupported MFS provider for commission rate: ${provider}`);
}

export function computeCommissionAmount(
  amount: number,
  provider: string,
  rates?: Partial<CommissionRatesConfig> | null
): { rate: number; commissionAmount: number } {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('Commission amount calculation requires a positive transaction amount');
  }
  const rate = getAuthoritativeProviderRate(provider, rates);
  return {
    rate,
    commissionAmount: Number((numericAmount * rate).toFixed(2)),
  };
}

export function formatCommissionPercent(rate: number): string {
  const pct = Number((Number(rate) * 100).toFixed(2));
  return `${pct}%`;
}

export function formatCommissionPercentBn(rate: number): string {
  const pct = Number((Number(rate) * 100).toFixed(2));
  const enToBn: Record<string, string> = {
    '0': '০',
    '1': '১',
    '2': '২',
    '3': '৩',
    '4': '৪',
    '5': '৫',
    '6': '৬',
    '7': '৭',
    '8': '৮',
    '9': '৯',
  };
  return `${String(pct).replace(/\d/g, (d) => enToBn[d] ?? d)}%`;
}
