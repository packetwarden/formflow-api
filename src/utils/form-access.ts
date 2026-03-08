import type { Env } from '../types'

const DEFAULT_FORM_ACCESS_TOKEN_TTL_SECONDS = 30 * 60
const MIN_FORM_ACCESS_TOKEN_TTL_SECONDS = 60
const MAX_FORM_ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60

type FormAccessScope = 'form_access'

type FormAccessTokenPayload = {
    fid: string
    ver: number
    exp: number
    jti: string
    scope: FormAccessScope
}

const encoder = new TextEncoder()

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const encodeBase64Url = (value: Uint8Array) =>
    btoa(String.fromCharCode(...value))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '')

const decodeBase64Url = (value: string) => {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
    const decoded = atob(padded)
    return Uint8Array.from(decoded, (char) => char.charCodeAt(0))
}

const getFormAccessTokenSecret = (env: Env) => {
    const secret = env.FORM_ACCESS_TOKEN_SECRET?.trim()
    if (!secret) {
        throw new Error('FORM_ACCESS_TOKEN_SECRET is required')
    }

    return secret
}

const getHmacKey = async (env: Env) => {
    return crypto.subtle.importKey(
        'raw',
        encoder.encode(getFormAccessTokenSecret(env)),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    )
}

const sha256 = async (value: Uint8Array) => {
    const digest = await crypto.subtle.digest('SHA-256', value)
    return new Uint8Array(digest)
}

const timingSafeEqual = async (left: Uint8Array, right: Uint8Array) => {
    const [leftDigest, rightDigest] = await Promise.all([sha256(left), sha256(right)])
    return crypto.subtle.timingSafeEqual(leftDigest, rightDigest)
}

export const getFormAccessTokenTtlSeconds = (env: Env) => {
    const parsed = Number(env.FORM_ACCESS_TOKEN_TTL_SECONDS ?? DEFAULT_FORM_ACCESS_TOKEN_TTL_SECONDS)
    if (!Number.isFinite(parsed)) return DEFAULT_FORM_ACCESS_TOKEN_TTL_SECONDS
    return clamp(Math.floor(parsed), MIN_FORM_ACCESS_TOKEN_TTL_SECONDS, MAX_FORM_ACCESS_TOKEN_TTL_SECONDS)
}

export const issueFormAccessToken = async (
    env: Env,
    formId: string,
    version: number
) => {
    const expiresAt = Math.floor(Date.now() / 1000) + getFormAccessTokenTtlSeconds(env)
    const payload: FormAccessTokenPayload = {
        fid: formId,
        ver: version,
        exp: expiresAt,
        jti: crypto.randomUUID(),
        scope: 'form_access',
    }

    const payloadBytes = encoder.encode(JSON.stringify(payload))
    const payloadSegment = encodeBase64Url(payloadBytes)
    const key = await getHmacKey(env)
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadSegment))

    return {
        token: `${payloadSegment}.${encodeBase64Url(new Uint8Array(signature))}`,
        expiresAt: new Date(expiresAt * 1000).toISOString(),
    }
}

export const verifyFormAccessToken = async (
    env: Env,
    token: string,
    formId: string,
    version: number
) => {
    const [payloadSegment, signatureSegment, ...rest] = token.split('.')
    if (!payloadSegment || !signatureSegment || rest.length > 0) {
        return { ok: false as const }
    }

    try {
        const key = await getHmacKey(env)
        const expectedSignature = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadSegment))
        const providedSignature = decodeBase64Url(signatureSegment)
        const signaturesMatch = await timingSafeEqual(new Uint8Array(expectedSignature), providedSignature)

        if (!signaturesMatch) {
            return { ok: false as const }
        }

        const payloadBytes = decodeBase64Url(payloadSegment)
        const parsedPayload = JSON.parse(new TextDecoder().decode(payloadBytes)) as Partial<FormAccessTokenPayload>

        if (
            parsedPayload.scope !== 'form_access' ||
            parsedPayload.fid !== formId ||
            parsedPayload.ver !== version ||
            typeof parsedPayload.exp !== 'number' ||
            parsedPayload.exp < Math.floor(Date.now() / 1000)
        ) {
            return { ok: false as const }
        }

        return { ok: true as const }
    } catch {
        return { ok: false as const }
    }
}
