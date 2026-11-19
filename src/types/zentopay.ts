export type UserRole =
  | 'user'
  | 'agent'
  | 'sub_agent'
  | 'super_admin'
  | 'finance_admin'
  | 'support_admin';

export type KycStatus = 'unverified' | 'pending' | 'verified' | 'rejected';

export type WalletType = 'main' | 'float' | 'commission' | 'settlement';

export type TransactionType =
  | 'deposit'
  | 'transfer'
  | 'withdrawal'
  | 'cash_in'
  | 'cash_out'
  | 'gateway_payment'
  | 'commission'
  | 'settlement'
  | 'adjustment'
  | 'payment_collection'
  | 'payment_payout'
  | 'affiliate_commission'
  | 'bet_deposit'
  | 'bet_payout';

export type TransactionStatus = 'pending' | 'completed' | 'failed' | 'reversed';

export type AgentPlanType = 'trial' | 'premium' | null;

export interface UserProfile {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  country: string;
  business_name: string | null;
  role: UserRole;
  kyc_status: KycStatus;
  parent_agent_id: string | null;
  is_frozen: boolean;
  agent_code: string | null;
  avatar_url: string | null;
  has_withdraw_pin?: boolean;
  active_plan: AgentPlanType;
  plan_activated_at: string | null;
  referred_by_agent_id: string | null;
  created_at: string;
}

export interface Wallet {
  id: string;
  user_id: string;
  wallet_type: WalletType;
  currency: string;
  balance: number;
  available_balance: number;
  reserved_balance?: number;
  daily_limit: number;
  status: 'active' | 'frozen' | 'closed';
  created_at: string;
}

export interface TransactionRecord {
  id: string;
  reference_code: string;
  sender_wallet_id: string | null;
  receiver_wallet_id: string | null;
  initiator_user_id: string;
  initiator_name?: string | null;
  initiator_agent_code?: string | null;
  initiator_email?: string | null;
  tx_type: TransactionType;
  amount: number;
  fee_amount: number;
  commission_amount: number;
  currency: string;
  status: TransactionStatus;
  description: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface SettlementRequest {
  id: string;
  requester_id: string;
  wallet_id: string;
  amount: number;
  currency: string;
  destination_bank: string;
  destination_account?: string | null;
  account_last4: string;
  reference_code?: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'disbursed';
  reviewed_by: string | null;
  reviewed_at: string | null;
  approved_at?: string | null;
  rejected_at?: string | null;
  notes: string | null;
  created_at: string;
  agent_name?: string | null;
  agent_code?: string | null;
  agent_email?: string | null;
  agent_phone?: string | null;
  reviewer_name?: string | null;
  wallet_balance?: number | null;
  wallet_available_balance?: number | null;
  wallet_reserved_balance?: number | null;
}

export interface KycSubmission {
  id: string;
  user_id: string;
  document_type: 'passport' | 'national_id' | 'business_license' | 'proof_of_address';
  storage_path: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewer_id: string | null;
  review_notes: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface SupportTicket {
  id: string;
  ticket_number: string;
  user_id: string;
  assigned_to: string | null;
  category: 'wallet' | 'transfer' | 'kyc' | 'agent_float' | 'gateway' | 'dispute';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  subject: string;
  description: string;
  resolution_note: string | null;
  created_at: string;
}

export interface AgentHierarchyLink {
  id: string;
  agent_id: string;
  sub_agent_id: string;
  commission_rate: number;
  float_cap: number;
  status: 'active' | 'suspended';
  created_at: string;
  sub_agent?: Pick<UserProfile, 'id' | 'full_name' | 'email' | 'business_name'>;
}

export interface AuditLogEntry {
  id: string;
  actor_id: string | null;
  actor_role: string;
  action: string;
  target_table: string;
  target_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface AgentGateway {
  id: string;
  user_id: string;
  provider: 'bkash' | 'nagad' | 'rocket';
  account_mode: 'personal' | 'merchant' | 'agent';
  account_number: string;
  min_required_balance: number;
  activation_fee: number;
  is_active: boolean;
  activated_at: string;
}

export interface MfsPaymentRequest {
  id: string;
  reference_code: string;
  agent_id: string;
  agent_name?: string | null;
  agent_code?: string | null;
  request_type: 'payment_collection' | 'payment_payout';
  method: 'bkash' | 'nagad' | 'rocket';
  account_mode: 'personal' | 'merchant' | 'agent';
  agent_account_number: string;
  customer_account: string | null;
  amount: number;
  currency: string;
  commission_rate: number;
  commission_amount: number;
  trx_id: string | null;
  status: 'pending' | 'approved' | 'declined';
  created_by: string | null;
  processed_at: string | null;
  created_at: string;
}

export interface DepositMethodConfig {
  id: string;
  name: string;
  accountNumber: string;
  accountLabel?: string;
  enabled: boolean;
}

export interface CommissionRatesConfig {
  bkash: number;
  nagad: number;
  rocket: number;
}

export interface PartnerItemConfig {
  id: string;
  name: string;
  logoUrl?: string;
  description?: string;
  url?: string;
}

export interface SocialLinkConfig {
  id: 'facebook' | 'youtube' | 'telegram';
  name: string;
  url: string;
}

export interface GlobalNotificationItem {
  id: string;
  title: string;
  message: string;
  createdAt: string;
}

export interface PlatformConfigData {
  depositMethods: DepositMethodConfig[];
  commissionRates: CommissionRatesConfig;
  supportLinks: {
    telegram: string;
    whatsapp: string;
    affiliateManagerTelegram: string;
  };
  socialNetworks: SocialLinkConfig[];
  partners: PartnerItemConfig[];
  globalNotifications: GlobalNotificationItem[];
}

export interface UserNotificationItem {
  id: string;
  user_id: string;
  title: string;
  message: string;
  is_read: boolean;
  created_at: string;
  scope?: 'global' | 'personal';
}

export interface FeeMatrixConfig {
  p2pBps: number;
  gatewayBps: number;
  agentSplitPct: number;
  updatedAt?: string;
}

export type AppRoute =
  | '/'
  | '/login'
  | '/register'
  | '/policy'
  | '/dashboard/agent'
  | '/dashboard/super-admin'
  | '/dashboard/finance-admin'
  | '/dashboard/support-admin';

export const ROLE_TO_ROUTE: Record<UserRole, AppRoute> = {
  user: '/dashboard/agent',
  agent: '/dashboard/agent',
  sub_agent: '/dashboard/agent',
  super_admin: '/dashboard/super-admin',
  finance_admin: '/dashboard/finance-admin',
  support_admin: '/dashboard/support-admin',
};

export const ROLE_LABELS: Record<UserRole, string> = {
  user: 'Agent Portal',
  agent: 'Agent Portal',
  sub_agent: 'Agent Portal',
  super_admin: 'Super Admin',
  finance_admin: 'Finance Admin',
  support_admin: 'Support Admin',
};
