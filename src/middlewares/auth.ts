import { Context, Next } from 'hono'
import { getSupabaseClient } from '../db/supabase'
import { Env, Variables } from '../types'

/**
 * requireAuth middleware ensures that a valid Bearer token is provided.
 * It uses the Supabase Edge Client to verify the token via auth.getUser().
 * If valid, it attaches the user object to the Hono context (c.set('user', user)).
 */
export const requireAuth = async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    const authHeader = c.req.header('Authorization')

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized: Missing or invalid Authorization header' }, 401)
    }

    const token = authHeader.split(' ')[1]?.trim()

    if (!token) {
        return c.json({ error: 'Unauthorized: Missing token' }, 401)
    }

    try {
        // We instantiate the client solely for verification.
        const supabase = getSupabaseClient(c.env.SUPABASE_URL, c.env.SUPABASE_ANON_KEY)

        // getUser() validates the JWT cryptographically against the Supabase project
        const { data: { user }, error } = await supabase.auth.getUser(token)

        if (error || !user) {
            console.error('Auth Middleware Error:', error?.message)
            return c.json({ error: 'Unauthorized: Invalid token' }, 401)
        }

        // Attach user to context for downstream route handlers
        c.set('user', user)
        c.set('accessToken', token)

        await next()
    } catch (err) {
        console.error('Auth Middleware Exception:', err)
        return c.json({ error: 'Internal Server Error during authentication' }, 500)
    }
}
