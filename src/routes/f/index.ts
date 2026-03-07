import { Hono } from 'hono'
import type { Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { getSupabaseClient } from '../../db/supabase'
import type { Env, RunnerSubmitSuccessResponse } from '../../types'
import { parsePublishedContract, sanitizeAndValidateData } from '../../utils/form-contract'
import {
    runnerFormParamSchema,
    runnerIdempotencyHeaderSchema,
    runnerSubmitBodySchema,
    safeRefererSchema,
    safeUserAgentSchema,
} from '../../utils/validation'

const runnerRouter = new Hono<{ Bindings: Env }>()
type RunnerContext = Context<{ Bindings: Env }>

type PublishedFormRow = {
    form_id: string
    workspace_id: string
    title: string
    description: string | null
    published_schema: unknown
    success_message: string | null
    redirect_url: string | null
    meta_title: string | null
    meta_description: string | null
    meta_image_url: string | null
    captcha_enabled: boolean
    captcha_provider: string | null
    require_auth: boolean
    password_protected: boolean
}

type QuotaRow = {
    feature_key: string
    is_enabled: boolean
    limit_value: number | null
    current_usage: number
    workspace_id: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isValidIpv4 = (value: string) => {
    const parts = value.split('.')
    if (parts.length !== 4) return false

    for (const part of parts) {
        if (!/^\d+$/.test(part)) return false
        const numeric = Number(part)
        if (numeric < 0 || numeric > 255) return false
    }

    return true
}

const isLikelyIpv6 = (value: string) => /^[0-9a-fA-F:]+$/.test(value) && value.includes(':')

const extractClientIp = (c: RunnerContext) => {
    const raw = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')
    if (!raw) return null

    const candidate = raw.split(',')[0]?.trim()
    if (!candidate) return null
    if (isValidIpv4(candidate) || isLikelyIpv6(candidate)) return candidate
    return null
}

const getForwardedHeaders = (c: RunnerContext) => {
    const headers: Record<string, string> = {}
    const ip = extractClientIp(c)
    const userAgentResult = safeUserAgentSchema.safeParse(c.req.header('user-agent'))
    const refererResult = safeRefererSchema.safeParse(c.req.header('referer'))

    if (ip) headers['x-forwarded-for'] = ip
    if (userAgentResult.success) headers['user-agent'] = userAgentResult.data
    if (refererResult.success) headers.referer = refererResult.data

    return headers
}

const getRunnerSupabaseClient = (c: RunnerContext) => {
    return getSupabaseClient(
        c.env.SUPABASE_URL,
        c.env.SUPABASE_ANON_KEY,
        undefined,
        getForwardedHeaders(c)
    )
}

const getRunnerSubmitSupabaseClient = (c: RunnerContext) => {
    return getSupabaseClient(
        c.env.SUPABASE_URL,
        c.env.SUPABASE_SERVICE_ROLE_KEY
    )
}

const parseSubmissionRpcError = (error: { code: string | null; message: string }) => {
    if (error.code === 'P0002') return { status: 404 as const, payload: { error: 'Form not found' } }
    if (error.code === '42501') {
        return {
            status: 500 as const,
            payload: {
                error: 'Submission service misconfigured',
                code: 'RUNNER_BACKEND_AUTH_MISCONFIGURED' as const,
            },
        }
    }

    if (['P0003', 'P0004', 'P0005', 'P0006', 'P0007', 'P0008'].includes(error.code ?? '')) {
        return {
            status: 409 as const,
            payload: {
                error: 'Form state conflict',
                message: error.message,
            },
        }
    }

    return null
}

const parseStrictRateLimitError = (error: unknown) => {
    const errorRecord = isRecord(error) ? error : {}
    const rawMessage = typeof errorRecord.message === 'string' ? errorRecord.message : null
    const rawDetails = typeof errorRecord.details === 'string' ? errorRecord.details : null
    const rawCode = typeof errorRecord.code === 'string' ? errorRecord.code : null

    const parseJsonObject = (value: string | null) => {
        if (!value || !value.trim().startsWith('{')) return null

        try {
            const parsed = JSON.parse(value)
            return isRecord(parsed) ? parsed : null
        } catch {
            return null
        }
    }

    const parsedMessage = parseJsonObject(rawMessage)
    const parsedDetails = parseJsonObject(rawDetails)
    const parsedStatus =
        typeof parsedDetails?.status === 'number'
            ? parsedDetails.status
            : typeof parsedDetails?.status === 'string'
              ? Number(parsedDetails.status)
              : null

    if (parsedStatus === 429 || rawCode === '429') {
        return {
            status: 429 as const,
            payload: {
                error:
                    typeof parsedMessage?.message === 'string'
                        ? parsedMessage.message
                        : 'Too many submissions. Please wait 60 seconds and try again.',
                code:
                    typeof parsedMessage?.code === 'string'
                        ? parsedMessage.code
                        : 'RATE_LIMITED',
            },
            retryAfterSeconds: 60,
        }
    }

    if (parsedStatus === 400) {
        return {
            status: 400 as const,
            payload: {
                error:
                    typeof parsedMessage?.message === 'string'
                        ? parsedMessage.message
                        : 'Unable to evaluate rate limit.',
                code:
                    typeof parsedMessage?.code === 'string'
                        ? parsedMessage.code
                        : 'RATE_LIMIT_CONTEXT_MISSING',
            },
            retryAfterSeconds: null,
        }
    }

    return null
}

runnerRouter.get(
    '/:formId/schema',
    zValidator('param', runnerFormParamSchema),
    async (c) => {
        const { formId } = c.req.valid('param')
        const supabase = getRunnerSupabaseClient(c)

        const { data, error } = await supabase.rpc('get_published_form_by_id', {
            p_form_id: formId,
        })

        if (error) {
            console.error('Runner schema fetch error:', error)
            return c.json({ error: 'Failed to fetch form schema' }, 500)
        }

        const form = (Array.isArray(data) ? data[0] : null) as PublishedFormRow | null
        if (!form) {
            return c.json({ error: 'Form not found' }, 404)
        }

        return c.json({
            form: {
                id: form.form_id,
                title: form.title,
                description: form.description,
                published_schema: form.published_schema,
                success_message: form.success_message,
                redirect_url: form.redirect_url,
                meta_title: form.meta_title,
                meta_description: form.meta_description,
                meta_image_url: form.meta_image_url,
                captcha_enabled: form.captcha_enabled,
                captcha_provider: form.captcha_provider,
                require_auth: form.require_auth,
                password_protected: form.password_protected,
            },
        }, 200)
    }
)

runnerRouter.post(
    '/:formId/submit',
    zValidator('param', runnerFormParamSchema),
    zValidator('json', runnerSubmitBodySchema),
    async (c) => {
        try {
            const { formId } = c.req.valid('param')
            const { data, started_at } = c.req.valid('json')

            const headerValidation = runnerIdempotencyHeaderSchema.safeParse({
                'idempotency-key': c.req.header('idempotency-key') ?? c.req.header('Idempotency-Key'),
            })

            if (!headerValidation.success) {
                return c.json({
                    error: 'Invalid idempotency header',
                    code: 'FIELD_VALIDATION_FAILED',
                    issues: headerValidation.error.issues.map((issue) => ({
                        field_id: 'Idempotency-Key',
                        message: issue.message,
                    })),
                }, 400)
            }

            const idempotencyKey = headerValidation.data['idempotency-key']
            const clientIp = extractClientIp(c)
            if (!clientIp) {
                return c.json({
                    error: 'Unable to determine client IP for rate limit enforcement',
                    code: 'RATE_LIMIT_CONTEXT_MISSING',
                }, 400)
            }

            const supabase = getRunnerSupabaseClient(c)

            const { error: strictRateLimitError } = await supabase.rpc('check_request')
            if (strictRateLimitError) {
                const mappedRateLimit = parseStrictRateLimitError(strictRateLimitError)
                if (mappedRateLimit) {
                    if (mappedRateLimit.retryAfterSeconds !== null) {
                        c.header('Retry-After', String(mappedRateLimit.retryAfterSeconds))
                    }
                    return c.json(mappedRateLimit.payload, mappedRateLimit.status)
                }

                console.error('Runner strict rate-limit check error:', strictRateLimitError)
                return c.json({
                    error: 'Failed to evaluate submit rate limit',
                    code: 'RATE_LIMIT_CHECK_FAILED',
                }, 500)
            }

            const { data: formRows, error: formError } = await supabase.rpc('get_published_form_by_id', {
                p_form_id: formId,
            })

            if (formError) {
                console.error('Runner form lookup error:', formError)
                return c.json({ error: 'Failed to fetch form' }, 500)
            }

            const form = (Array.isArray(formRows) ? formRows[0] : null) as PublishedFormRow | null
            if (!form) {
                return c.json({ error: 'Form not found' }, 404)
            }

            if (form.require_auth) {
                return c.json({
                    error: 'Authentication is required for this form',
                    code: 'FORM_AUTH_REQUIRED',
                }, 403)
            }

            if (form.password_protected) {
                return c.json({
                    error: 'Password protection is enabled for this form',
                    code: 'FORM_PASSWORD_REQUIRED',
                }, 403)
            }

            if (form.captcha_enabled) {
                return c.json({
                    error: 'Captcha verification is required for this form',
                    code: 'CAPTCHA_REQUIRED_UNSUPPORTED',
                }, 403)
            }

            const contractResult = parsePublishedContract(form.published_schema)
            if (!contractResult.ok) {
                return c.json({
                    error: 'Unsupported form schema',
                    code: 'UNSUPPORTED_FORM_SCHEMA',
                    issues: contractResult.issues,
                }, 422)
            }

            const payloadResult = sanitizeAndValidateData(contractResult.contract, data)
            if (!payloadResult.ok) {
                return c.json(payloadResult.payload, 422)
            }

            const { data: quotaRows, error: quotaError } = await supabase.rpc('get_form_submission_quota', {
                p_form_id: formId,
            })

            if (quotaError) {
                if (quotaError.code === 'P0002') {
                    return c.json({ error: 'Form not found' }, 404)
                }

                console.error('Runner quota check error:', quotaError)
                return c.json({ error: 'Failed to evaluate submission quota' }, 500)
            }

            const quota = (Array.isArray(quotaRows) ? quotaRows[0] : null) as QuotaRow | null
            if (!quota) {
                console.error('Runner quota check returned no row')
                return c.json({ error: 'Failed to evaluate submission quota' }, 500)
            }

            const currentUsage = Number(quota.current_usage ?? 0)
            const limitValue = quota.limit_value

            if (!quota.is_enabled) {
                return c.json({
                    error: 'Feature disabled for current plan',
                    code: 'PLAN_FEATURE_DISABLED',
                    feature: 'max_submissions_monthly',
                    current: currentUsage,
                    allowed: limitValue,
                    upgrade_url: '/pricing',
                }, 403)
            }

            if (typeof limitValue === 'number' && limitValue >= 0 && currentUsage >= limitValue) {
                return c.json({
                    error: 'Submission quota exceeded',
                    code: 'PLAN_LIMIT_EXCEEDED',
                    feature: 'max_submissions_monthly',
                    current: currentUsage,
                    allowed: limitValue,
                    upgrade_url: '/pricing',
                }, 403)
            }

            const userAgentResult = safeUserAgentSchema.safeParse(c.req.header('user-agent'))
            const refererResult = safeRefererSchema.safeParse(c.req.header('referer'))
            const submitSupabase = getRunnerSubmitSupabaseClient(c)

            const { data: submissionId, error: submitError } = await submitSupabase.rpc('submit_form', {
                p_form_id: formId,
                p_data: payloadResult.sanitizedData,
                p_idempotency_key: idempotencyKey,
                p_ip_address: clientIp,
                p_user_agent: userAgentResult.success ? userAgentResult.data : null,
                p_referrer: refererResult.success ? refererResult.data : null,
                p_started_at: started_at ?? null,
            })

            if (submitError) {
                const mappedError = parseSubmissionRpcError(submitError)
                if (mappedError) {
                    if (submitError.code === '42501') {
                        console.error('Runner submit RPC auth/config error:', {
                            code: submitError.code,
                            message: submitError.message,
                            details: 'Trusted backend submit RPC rejected',
                        })
                    }
                    return c.json(mappedError.payload, mappedError.status)
                }

                console.error('Runner submission error:', submitError)
                return c.json({ error: 'Failed to submit form' }, 500)
            }

            if (!submissionId || typeof submissionId !== 'string') {
                return c.json({ error: 'Failed to resolve submission ID' }, 500)
            }

            const response: RunnerSubmitSuccessResponse = {
                submission_id: submissionId,
                success_message: form.success_message ?? null,
                redirect_url: form.redirect_url ?? null,
            }

            return c.json(response, 201)
        } catch (error) {
            console.error('Runner submit unhandled error:', error)
            return c.json({ error: 'Failed to submit form', code: 'RUNNER_INTERNAL_ERROR' }, 500)
        }
    }
)

export default runnerRouter
