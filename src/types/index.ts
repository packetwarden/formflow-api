import { User } from '@supabase/supabase-js'

export interface Env {
    SUPABASE_URL: string;
    SUPABASE_ANON_KEY: string;
    SUPABASE_SERVICE_ROLE_KEY: string;
    TURNSTILE_SITE_KEY: string;
    TURNSTILE_SECRET_KEY: string;
    TURNSTILE_ALLOWED_HOSTNAMES?: string;
    FORM_ACCESS_TOKEN_SECRET: string;
    FORM_ACCESS_TOKEN_TTL_SECONDS?: string;
    FORM_PASSWORD_BCRYPT_COST?: string;
    STRIPE_SECRET_KEY: string;
    STRIPE_WEBHOOK_SIGNING_SECRET: string;
    STRIPE_BILLING_PORTAL_CONFIGURATION_ID?: string;
    STRIPE_INTERNAL_ADMIN_TOKEN?: string;
    CHECKOUT_SUCCESS_URL: string;
    CHECKOUT_CANCEL_URL: string;
    BILLING_PORTAL_RETURN_URL: string;
    CONTACT_SALES_URL: string;
    BILLING_GRACE_DAYS?: string;
    STRIPE_WEBHOOK_CLAIM_TTL_SECONDS?: string;
    STRIPE_WEBHOOK_MAX_BODY_BYTES?: string;
    STRIPE_RETRY_BATCH_SIZE?: string;
    STRIPE_GRACE_BATCH_SIZE?: string;
    STRIPE_CATALOG_SYNC_ENABLED?: string;
    STRIPE_CATALOG_SYNC_CRON?: string;
    STRIPE_CATALOG_ENV?: string;
    AUTH_WRITE_RATE_LIMITER: RateLimit;
    BUILD_WRITE_RATE_LIMITER: RateLimit;
    RUNNER_PASSWORD_RATE_LIMITER: RateLimit;
}

export interface Variables {
    user: User | null;
    accessToken: string;
}

export type WorkspacePlanSlug = 'free' | 'pro' | 'business' | 'enterprise'

export interface AuthBootstrapUser {
    id: string
    email: string
    full_name: string | null
    avatar_url: string | null
}

export interface AuthBootstrapWorkspace {
    id: string
    name: string
    slug: string
    description: string | null
    logo_url: string | null
    plan: WorkspacePlanSlug
    role: 'owner' | 'admin' | 'editor' | 'viewer'
    is_personal: boolean
    created_at: string
    updated_at: string
}

export interface AuthBootstrapResponse {
    user: AuthBootstrapUser
    current_workspace_id: string
    workspaces: AuthBootstrapWorkspace[]
}

export type WorkspaceRoleSummary = 'owner' | 'admin' | 'editor' | 'viewer'

export interface WorkspaceSettingsAboutV1 {
    tagline?: string | null
    website_url?: string | null
    support_email?: string | null
    support_url?: string | null
}

export interface WorkspaceSettingsBrandingV1 {
    primary_color?: string | null
    accent_color?: string | null
}

export interface WorkspaceSettingsPreferencesV1 {
    default_locale?: string | null
    default_timezone?: string | null
}

export interface WorkspaceSettingsV1 {
    about?: WorkspaceSettingsAboutV1
    branding?: WorkspaceSettingsBrandingV1
    preferences?: WorkspaceSettingsPreferencesV1
}

export interface WorkspaceOverviewWorkspace {
    id: string
    slug: string
    name: string
    description: string | null
    logo_url: string | null
    plan: WorkspacePlanSlug
    created_at: string
    updated_at: string
}

export interface WorkspaceOwnerSummary {
    id: string
    full_name: string | null
    avatar_url: string | null
}

export interface WorkspaceMembershipSummary {
    role: WorkspaceRoleSummary
    is_owner: boolean
    can_edit_settings: boolean
}

export interface WorkspaceOverviewSettingsSummary extends WorkspaceSettingsV1 {}

export interface WorkspaceOverviewResponse {
    workspace: WorkspaceOverviewWorkspace
    owner: WorkspaceOwnerSummary
    membership: WorkspaceMembershipSummary
    summary: {
        member_count: number
        settings: WorkspaceOverviewSettingsSummary
    }
}

export interface WorkspaceSettingsEditableWorkspace {
    id: string
    slug: string
    name: string
    description: string | null
    logo_url: string | null
    version: number
    updated_at: string
}

export interface WorkspaceSettingsResponse {
    workspace: WorkspaceSettingsEditableWorkspace
    settings: WorkspaceSettingsV1
}

export type WorkspaceBillingStatus =
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'canceled'
    | 'unpaid'
    | 'paused'
    | 'incomplete'
    | 'incomplete_expired'

export type WorkspaceBillingInterval = 'monthly' | 'yearly'

export interface WorkspaceBillingSubscriptionSummary {
    id: string
    status: WorkspaceBillingStatus
    is_entitled: boolean
    plan_slug: WorkspacePlanSlug
    plan_name: string
    interval: WorkspaceBillingInterval
    amount_cents: number
    currency: string
    current_period_start: string
    current_period_end: string
    trial_start: string | null
    trial_end: string | null
    cancel_at_period_end: boolean
    grace_period_end: string | null
    downgrade_to_plan_slug: WorkspacePlanSlug | null
}

export interface WorkspaceBillingHistorySummary {
    provider: 'stripe_portal'
    available: boolean
}

export interface WorkspaceBillingCheckoutOption {
    plan_slug: 'pro' | 'business'
    plan_name: string
    interval: WorkspaceBillingInterval
    amount_cents: number
    currency: string
    trial_period_days: number
}

export interface WorkspaceBillingPortalAction {
    method: 'POST'
    path: string
}

export interface WorkspaceBillingCheckoutAction {
    method: 'POST'
    path: string
    requires_idempotency_key: true
    available_plans: WorkspaceBillingCheckoutOption[]
}

export interface WorkspaceBillingActionSummary {
    can_manage_billing: boolean
    portal_session: WorkspaceBillingPortalAction | null
    checkout_session: WorkspaceBillingCheckoutAction | null
}

export interface WorkspaceBillingResponse {
    workspace: {
        id: string
        role: WorkspaceRoleSummary
    }
    billing: {
        effective_plan: WorkspacePlanSlug
        subscription: WorkspaceBillingSubscriptionSummary | null
        history: WorkspaceBillingHistorySummary
        actions: WorkspaceBillingActionSummary
    }
}

export interface UpdateWorkspaceSettingsInput {
    version: number
    name?: string
    description?: string | null
    logo_url?: string | null
    settings?: WorkspaceSettingsV1
}

export type RunnerErrorCode =
    | 'UNSUPPORTED_FORM_SCHEMA'
    | 'FIELD_VALIDATION_FAILED'
    | 'PLAN_FEATURE_DISABLED'
    | 'PLAN_LIMIT_EXCEEDED'
    | 'RATE_LIMITED'
    | 'FORM_AUTH_REQUIRED'
    | 'FORM_PASSWORD_REQUIRED'
    | 'FORM_PASSWORD_INVALID'
    | 'FORM_ACCESS_TOKEN_INVALID'
    | 'CAPTCHA_REQUIRED'
    | 'CAPTCHA_VERIFICATION_FAILED'
    | 'RATE_LIMIT_CONTEXT_MISSING'
    | 'RATE_LIMIT_CHECK_FAILED'
    | 'RUNNER_BACKEND_AUTH_MISCONFIGURED'
    | 'RUNNER_INTERNAL_ERROR'

export type ValidationIssue = {
    field_id: string
    message: string
}

export interface RunnerSubmitSuccessResponse {
    submission_id: string
    success_message: string | null
    redirect_url: string | null
}
