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
