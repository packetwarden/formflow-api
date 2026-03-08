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
