import type { Env, RunnerErrorCode } from '../types'

type TurnstileAction = 'form_access' | 'form_submit'

type VerifyTurnstileParams = {
    env: Env
    token: string | undefined
    action: TurnstileAction
    remoteIp: string | null
    idempotencyKey?: string | null
}

type TurnstileSiteVerifyResponse = {
    success: boolean
    'error-codes'?: string[]
    hostname?: string
    action?: string
}

type TurnstileFailure = {
    error: string
    code: Extract<RunnerErrorCode, 'CAPTCHA_REQUIRED' | 'CAPTCHA_VERIFICATION_FAILED'>
}

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

const parseAllowedHostnames = (value: string | undefined) => {
    return new Set(
        (value ?? '')
            .split(',')
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean)
    )
}

export const verifyTurnstileToken = async ({
    env,
    token,
    action,
    remoteIp,
    idempotencyKey,
}: VerifyTurnstileParams): Promise<{ ok: true } | { ok: false; payload: TurnstileFailure }> => {
    const normalizedToken = token?.trim()
    if (!normalizedToken) {
        return {
            ok: false,
            payload: {
                error: 'Captcha verification is required for this form',
                code: 'CAPTCHA_REQUIRED',
            },
        }
    }

    const body = new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: normalizedToken,
    })

    if (remoteIp) body.set('remoteip', remoteIp)
    if (idempotencyKey) body.set('idempotency_key', idempotencyKey)

    const response = await fetch(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
        },
        body,
    })

    if (!response.ok) {
        return {
            ok: false,
            payload: {
                error: 'Captcha verification failed',
                code: 'CAPTCHA_VERIFICATION_FAILED',
            },
        }
    }

    const verification = (await response.json()) as TurnstileSiteVerifyResponse
    const allowedHostnames = parseAllowedHostnames(env.TURNSTILE_ALLOWED_HOSTNAMES)
    const normalizedHostname = verification.hostname?.toLowerCase() ?? null

    const hostnameAllowed =
        allowedHostnames.size === 0 ||
        (normalizedHostname !== null && allowedHostnames.has(normalizedHostname))

    if (!verification.success || verification.action !== action || !hostnameAllowed) {
        return {
            ok: false,
            payload: {
                error: 'Captcha verification failed',
                code: 'CAPTCHA_VERIFICATION_FAILED',
            },
        }
    }

    return { ok: true }
}
