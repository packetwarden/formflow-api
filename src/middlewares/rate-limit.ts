import type { Context, MiddlewareHandler } from 'hono'
import { routePath } from 'hono/route'
import type { Env } from '../types'

type RateLimiterBindingName =
    | 'AUTH_WRITE_RATE_LIMITER'
    | 'BUILD_WRITE_RATE_LIMITER'

type ActorMode = 'anon' | 'user-or-anon'

type GroupRateLimitConfig = {
    bindingName: RateLimiterBindingName
    group: 'auth' | 'build'
    actorMode: ActorMode
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const RETRY_AFTER_SECONDS = 60

const isWriteMethod = (method: string) => WRITE_METHODS.has(method.toUpperCase())

const extractClientIp = (c: Context) => {
    const rawIp = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')
    if (!rawIp) return null

    const candidate = rawIp.split(',')[0]?.trim()
    return candidate && candidate.length > 0 ? candidate : null
}

const getRouteTemplate = (c: Context) => {
    try {
        const matchedRoute = routePath(c, -1)
        if (matchedRoute && matchedRoute !== '*') return matchedRoute
    } catch {
        // Ignore helper failures and fall back to request metadata.
    }

    const reqRoutePath = c.req.routePath
    if (reqRoutePath && reqRoutePath !== '*') return reqRoutePath
    return c.req.path
}

const getUserId = (c: Context) => {
    const maybeGet = c.get as unknown as ((key: string) => unknown) | undefined
    if (!maybeGet) return null

    const maybeUser = maybeGet('user')
    if (!maybeUser || typeof maybeUser !== 'object') return null

    const userId = (maybeUser as { id?: unknown }).id
    return typeof userId === 'string' && userId.length > 0 ? userId : null
}

const getActorKey = (c: Context, actorMode: ActorMode) => {
    if (actorMode === 'user-or-anon') {
        const userId = getUserId(c)
        if (userId) return `user:${userId}`
    }

    const ip = extractClientIp(c)
    return `anon:${ip ?? 'unknown'}`
}

const buildRateLimitKey = (c: Context, config: GroupRateLimitConfig) => {
    const method = c.req.method.toUpperCase()
    const routeTemplate = getRouteTemplate(c)
    const actorKey = getActorKey(c, config.actorMode)
    return `${config.group}|${actorKey}|${method}|${routeTemplate}`
}

const createGroupRateLimitMiddleware = (
    config: GroupRateLimitConfig
): MiddlewareHandler<{ Bindings: Env }> => {
    return async (c, next) => {
        if (!isWriteMethod(c.req.method)) {
            await next()
            return
        }

        const limiter = c.env[config.bindingName]
        if (!limiter || typeof limiter.limit !== 'function') {
            console.warn(
                `[rate-limit] Missing ${config.bindingName} binding; allowing request (fail-open).`
            )
            await next()
            return
        }

        const key = buildRateLimitKey(c, config)

        try {
            const { success } = await limiter.limit({ key })
            if (!success) {
                c.header('Retry-After', String(RETRY_AFTER_SECONDS))
                return c.json(
                    {
                        error: 'Too many requests. Please try again later.',
                        code: 'RATE_LIMITED',
                    },
                    429
                )
            }
        } catch (error) {
            console.warn(
                `[rate-limit] ${config.bindingName}.limit() failed for key="${key}"; allowing request (fail-open).`,
                error
            )
        }

        await next()
    }
}

export const authPublicWriteRateLimit = createGroupRateLimitMiddleware({
    bindingName: 'AUTH_WRITE_RATE_LIMITER',
    group: 'auth',
    actorMode: 'anon',
})

export const authUserWriteRateLimit = createGroupRateLimitMiddleware({
    bindingName: 'AUTH_WRITE_RATE_LIMITER',
    group: 'auth',
    actorMode: 'user-or-anon',
})

export const buildWriteRateLimit = createGroupRateLimitMiddleware({
    bindingName: 'BUILD_WRITE_RATE_LIMITER',
    group: 'build',
    actorMode: 'user-or-anon',
})
