import { createClient, SupabaseClient } from '@supabase/supabase-js'

/**
 * Creates a configured Supabase client suitable for Edge Runtimes.
 * It enforces auth.autoRefreshToken: false and auth.persistSession: false
 * to prevent memory leaks and shared states across Workers requests.
 * 
 * @param supabaseUrl The Supabase project URL
 * @param supabaseKey The Supabase Anon Key (for client auth) or Service Role Key (for admin tasks)
 * @param accessToken Optional JWT used to propagate request-scoped auth context for RLS
 * @param extraHeaders Optional additional headers forwarded to PostgREST (e.g. x-forwarded-for)
 * @returns An edge-ready Supabase Client
 */
export const getSupabaseClient = (
    supabaseUrl: string,
    supabaseKey: string,
    accessToken?: string,
    extraHeaders?: Record<string, string>
): SupabaseClient => {
    const options: Parameters<typeof createClient>[2] = {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
            detectSessionInUrl: false
        }
    }

    const headers: Record<string, string> = {}
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`

    if (extraHeaders) {
        for (const [key, value] of Object.entries(extraHeaders)) {
            if (value) headers[key] = value
        }
    }

    if (Object.keys(headers).length > 0) {
        options.global = {
            headers
        }
    }

    return createClient(supabaseUrl, supabaseKey, options)
}
