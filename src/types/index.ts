import { User } from '@supabase/supabase-js'

export interface Env {
    SUPABASE_URL: string;
    SUPABASE_ANON_KEY: string;
    SUPABASE_SERVICE_ROLE_KEY: string;
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

export interface RunnerSubmitSuccessResponse {
    submission_id: string
    success_message: string | null
    redirect_url: string | null
}
