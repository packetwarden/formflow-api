import { createClient, SupabaseClient } from '@supabase/supabase-js'

const isNonJwtSupabaseApiKey = (supabaseKey: string) => {
    return supabaseKey.startsWith('sb_secret_') || supabaseKey.startsWith('sb_publishable_')
}

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
    const clientOptions: Parameters<typeof createClient>[2] = {
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

    const customFetch: typeof fetch = async (input, init) => {
        const requestHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))

        // Supabase hosted secret/publishable keys are not JWTs. Let apikey auth
        // reach the gateway without mirroring the key into Authorization.
        if (!accessToken && isNonJwtSupabaseApiKey(supabaseKey)) {
            const defaultAuthorization = `Bearer ${supabaseKey}`
            if (requestHeaders.get('Authorization') === defaultAuthorization) {
                requestHeaders.delete('Authorization')
            }
        }

        return fetch(input, {
            ...init,
            headers: requestHeaders,
        })
    }

    clientOptions.global = {
        fetch: customFetch,
    }

    if (Object.keys(headers).length > 0) {
        clientOptions.global.headers = headers
    }

    return createClient(supabaseUrl, supabaseKey, clientOptions)
}

export const getServiceRoleSupabaseClient = (
    supabaseUrl: string,
    serviceRoleKey: string
): SupabaseClient => {
    return getSupabaseClient(supabaseUrl, serviceRoleKey)
}
