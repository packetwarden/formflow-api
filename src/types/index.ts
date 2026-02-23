import { User } from '@supabase/supabase-js'

export interface Env {
    SUPABASE_URL: string;
    SUPABASE_SERVICE_ROLE_KEY: string;
    SUPABASE_ANON_KEY: string;
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
