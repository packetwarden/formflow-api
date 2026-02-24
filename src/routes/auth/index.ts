import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { Env, Variables } from '../../types'
import { getSupabaseClient } from '../../db/supabase'
import { signUpSchema, loginSchema } from '../../utils/validation'
import { requireAuth } from '../../middlewares/auth'
import { authPublicWriteRateLimit, authUserWriteRateLimit } from '../../middlewares/rate-limit'

const authRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

/**
 * POST /api/v1/auth/signup
 * Registers a new user via Supabase Auth.
 */
authRouter.post('/signup', authPublicWriteRateLimit, zValidator('json', signUpSchema), async (c) => {
    const { email, password, full_name } = c.req.valid('json')
    const supabase = getSupabaseClient(c.env.SUPABASE_URL, c.env.SUPABASE_ANON_KEY)

    const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
            data: {
                full_name,
            },
        },
    })

    if (error) {
        return c.json({ error: error.message }, 400)
    }

    return c.json({ message: 'User created successfully', user: data.user }, 201)
})

/**
 * POST /api/v1/auth/login
 * Authenticates a user and returns their session (access token + refresh token).
 */
authRouter.post('/login', authPublicWriteRateLimit, zValidator('json', loginSchema), async (c) => {
    const { email, password } = c.req.valid('json')
    const supabase = getSupabaseClient(c.env.SUPABASE_URL, c.env.SUPABASE_ANON_KEY)

    const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
    })

    if (error) {
        return c.json({ error: error.message }, 401)
    }

    return c.json({ message: 'Login successful', session: data.session, user: data.user }, 200)
})

/**
 * POST /api/v1/auth/logout
 * Logs out the user and invalidates the session globally.
 * Requires Authentication.
 */
authRouter.post('/logout', requireAuth, authUserWriteRateLimit, async (c) => {
    const authHeader = c.req.header('Authorization')
    const token = authHeader?.split(' ')[1]

    if (!token) return c.json({ error: 'Token missing' }, 400)

    const supabase = getSupabaseClient(c.env.SUPABASE_URL, c.env.SUPABASE_ANON_KEY)
    const { error } = await supabase.auth.admin.signOut(token, 'global')

    if (error) {
        console.error('Auth logout error:', error)
        const status =
            error.status === 401 || error.status === 403 || error.status === 404
                ? error.status
                : 500

        return c.json({
            error: 'Logout failed',
            code: 'LOGOUT_FAILED',
            message: error.message,
        }, status)
    }

    return c.json({ message: 'Logout successful', scope: 'global' }, 200)
})

/**
 * GET /api/v1/auth/me
 * Retrieves the currently authenticated user's profile.
 * Requires Authentication.
 */
authRouter.get('/me', requireAuth, async (c) => {
    const user = c.get('user')
    return c.json({ user }, 200)
})

export default authRouter
