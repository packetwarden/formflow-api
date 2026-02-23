import { createClient, SupabaseClient } from '@supabase/supabase-js'

/**
 * Creates a configured Supabase client suitable for Edge Runtimes.
 * It enforces auth.autoRefreshToken: false and auth.persistSession: false
 * to prevent memory leaks and shared states across Workers requests.
 * 
 * @param supabaseUrl The Supabase project URL
 * @param supabaseKey The Supabase Anon Key (for client auth) or Service Role Key (for admin tasks)
 * @param accessToken Optional JWT used to propagate request-scoped auth context for RLS
 * @returns An edge-ready Supabase Client
 */
export const getSupabaseClient = (supabaseUrl: string, supabaseKey: string, accessToken?: string): SupabaseClient => {
    const options: Parameters<typeof createClient>[2] = {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
            detectSessionInUrl: false
        }
    }

    if (accessToken) {
        options.global = {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        }
    }

    return createClient(supabaseUrl, supabaseKey, options)
}
