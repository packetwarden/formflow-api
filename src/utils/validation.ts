import { z } from 'zod'

const MAX_EMAIL_LENGTH = 320
const MAX_PASSWORD_LENGTH = 128
const MAX_DISPLAY_NAME_LENGTH = 120
const MAX_URL_LENGTH = 2048
const MAX_DESCRIPTION_LENGTH = 2000
const MAX_SUCCESS_MESSAGE_LENGTH = 1000
const MAX_PUBLISH_DESCRIPTION_LENGTH = 500
const MAX_USER_AGENT_LENGTH = 1024
const MAX_CAPTCHA_TOKEN_LENGTH = 4096
const MAX_FORM_ACCESS_TOKEN_LENGTH = 2048
const MAX_STARTED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000
const MAX_STARTED_AT_AGE_MS = 30 * 24 * 60 * 60 * 1000

const trimToUndefined = (value: unknown) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed.length === 0 ? undefined : trimmed
}

const trimToNull = (value: unknown) => {
    if (value === null) return null
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed.length === 0 ? null : trimmed
}

const parseAbsoluteHttpUrl = (value: string) => {
    try {
        const url = new URL(value)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return null
        }
        return url.toString()
    } catch {
        return null
    }
}

const extractBearerToken = (value: string) => {
    const normalized = value.trim()
    const match = /^Bearer\s+(\S+)$/i.exec(normalized)
    return match ? match[1] : null
}

export const normalizedEmailSchema = z
    .string()
    .trim()
    .min(1, 'email is required')
    .max(MAX_EMAIL_LENGTH, `email must be at most ${MAX_EMAIL_LENGTH} characters`)
    .email('Invalid email address')
    .transform((value) => value.toLowerCase())

export const passwordSchema = z
    .string()
    .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters long`)
    .refine((value) => value.trim().length > 0, {
        message: 'Password is required',
    })
    .refine((value) => value.length >= 8, {
        message: 'Password must be at least 8 characters long',
    })

export const loginPasswordSchema = z
    .string()
    .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters long`)
    .refine((value) => value.trim().length > 0, {
        message: 'Password is required',
    })

export const formPasswordSchema = z
    .string()
    .trim()
    .min(10, 'Password must be at least 10 characters long')
    .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters long`)

export const captchaTokenSchema = z
    .string()
    .trim()
    .min(1, 'captcha_token is required')
    .max(MAX_CAPTCHA_TOKEN_LENGTH, `captcha_token must be at most ${MAX_CAPTCHA_TOKEN_LENGTH} characters`)

export const formAccessTokenSchema = z
    .string()
    .trim()
    .min(1, 'X-Form-Access-Token header is required')
    .max(
        MAX_FORM_ACCESS_TOKEN_LENGTH,
        `X-Form-Access-Token must be at most ${MAX_FORM_ACCESS_TOKEN_LENGTH} characters`
    )

export const optionalDisplayNameSchema = z.preprocess(
    trimToUndefined,
    z
        .string()
        .trim()
        .min(2, 'Name must be at least 2 characters long')
        .max(MAX_DISPLAY_NAME_LENGTH, `Name must be at most ${MAX_DISPLAY_NAME_LENGTH} characters long`)
        .optional()
)

export const clearableTextSchema = (maxLength: number, fieldName: string) =>
    z.preprocess(
        trimToNull,
        z.union([
            z.string().trim().max(maxLength, `${fieldName} must be at most ${maxLength} characters`),
            z.null(),
        ])
    )

export const absoluteHttpUrlSchema = z
    .string()
    .trim()
    .min(1, 'URL is required')
    .max(MAX_URL_LENGTH, `URL must be at most ${MAX_URL_LENGTH} characters`)
    .transform((value, ctx) => {
        const normalized = parseAbsoluteHttpUrl(value)
        if (!normalized) {
            ctx.addIssue({
                code: 'custom',
                message: 'URL must be a valid absolute http(s) URL',
            })
            return z.NEVER
        }
        return normalized
    })

export const clearableAbsoluteHttpUrlSchema = z.preprocess(
    trimToNull,
    z.union([absoluteHttpUrlSchema, z.null()])
)

const bearerTokenSchema = z
    .string()
    .trim()
    .min(1, 'Authorization header is required')
    .transform((value, ctx) => {
        const token = extractBearerToken(value)
        if (!token) {
            ctx.addIssue({
                code: 'custom',
                message: 'Authorization header must be a single Bearer token',
            })
            return z.NEVER
        }
        return token
    })

export const bearerAuthHeaderSchema = z
    .object({
        authorization: z.string().optional(),
    })
    .strict()
    .transform((headers, ctx) => {
        if (!headers.authorization) {
            ctx.addIssue({
                code: 'custom',
                message: 'Authorization header is required',
                path: ['authorization'],
            })
            return z.NEVER
        }

        const tokenResult = bearerTokenSchema.safeParse(headers.authorization)
        if (!tokenResult.success) {
            ctx.addIssue({
                code: 'custom',
                message: tokenResult.error.issues[0]?.message ?? 'Authorization header must be a single Bearer token',
                path: ['authorization'],
            })
            return z.NEVER
        }

        return {
            token: tokenResult.data,
        }
    })

export const internalAdminAuthHeaderSchema = z
    .object({
        authorization: z.string().optional(),
        'x-internal-admin-token': z.string().optional(),
    })
    .strict()
    .transform((headers, ctx) => {
        const headerToken = headers['x-internal-admin-token']?.trim() ?? null
        const bearerToken = headers.authorization
            ? extractBearerToken(headers.authorization)
            : null

        if (!headerToken && !headers.authorization) {
            ctx.addIssue({
                code: 'custom',
                message: 'Internal admin token is required',
            })
            return z.NEVER
        }

        if (headers.authorization && !bearerToken) {
            ctx.addIssue({
                code: 'custom',
                message: 'Authorization header must be a single Bearer token',
                path: ['authorization'],
            })
            return z.NEVER
        }

        if (headerToken && bearerToken && headerToken !== bearerToken) {
            ctx.addIssue({
                code: 'custom',
                message: 'Internal admin token headers must match',
            })
            return z.NEVER
        }

        const token = headerToken ?? bearerToken
        if (!token) {
            ctx.addIssue({
                code: 'custom',
                message: 'Internal admin token is required',
            })
            return z.NEVER
        }

        return { token }
    })

export const stripeSignatureHeaderSchema = z.object({
    'stripe-signature': z.string().trim().min(1, 'Stripe-Signature header is required'),
}).strict()

export const startedAtSchema = z
    .string()
    .datetime({ offset: true, message: 'started_at must be a valid ISO datetime string with offset' })
    .superRefine((value, ctx) => {
        const timestamp = Date.parse(value)
        if (Number.isNaN(timestamp)) {
            ctx.addIssue({
                code: 'custom',
                message: 'started_at must be a valid ISO datetime string with offset',
            })
            return
        }

        const now = Date.now()
        if (timestamp > now + MAX_STARTED_AT_FUTURE_SKEW_MS) {
            ctx.addIssue({
                code: 'custom',
                message: 'started_at cannot be more than 5 minutes in the future',
            })
        }

        if (timestamp < now - MAX_STARTED_AT_AGE_MS) {
            ctx.addIssue({
                code: 'custom',
                message: 'started_at cannot be older than 30 days',
            })
        }
    })

export const safeRefererSchema = z
    .string()
    .trim()
    .min(1, 'referer must not be blank')
    .max(MAX_URL_LENGTH, `referer must be at most ${MAX_URL_LENGTH} characters`)
    .transform((value, ctx) => {
        const normalized = parseAbsoluteHttpUrl(value)
        if (!normalized) {
            ctx.addIssue({
                code: 'custom',
                message: 'referer must be a valid absolute http(s) URL',
            })
            return z.NEVER
        }
        return normalized
    })

export const safeUserAgentSchema = z
    .string()
    .trim()
    .min(1, 'user-agent must not be blank')
    .max(MAX_USER_AGENT_LENGTH, `user-agent must be at most ${MAX_USER_AGENT_LENGTH} characters`)

export const signUpSchema = z.object({
    email: normalizedEmailSchema,
    password: passwordSchema,
    full_name: optionalDisplayNameSchema,
}).strict()

export const loginSchema = z.object({
    email: normalizedEmailSchema,
    password: loginPasswordSchema,
}).strict()

export const workspaceParamSchema = z.object({
    workspaceId: z.string().uuid('workspaceId must be a valid UUID'),
})

export const formParamSchema = z.object({
    formId: z.string().uuid('formId must be a valid UUID'),
})

export const submissionParamSchema = z.object({
    submissionId: z.string().uuid('submissionId must be a valid UUID'),
})

export const buildParamSchema = workspaceParamSchema.merge(formParamSchema)
export const buildSubmissionParamSchema = buildParamSchema.merge(submissionParamSchema)
export const runnerFormParamSchema = formParamSchema

const stripePlanSlugSchema = z.enum(['free', 'pro', 'business', 'enterprise'])
const stripeBillingIntervalSchema = z.enum(['monthly', 'yearly'])

export const stripeCheckoutSessionSchema = z.object({
    plan_slug: stripePlanSlugSchema,
    interval: stripeBillingIntervalSchema,
}).strict()

const idempotencyHeaderSchema = z.string().uuid('Idempotency-Key must be a valid UUID')

export const stripeCheckoutIdempotencyHeaderSchema = z.object({
    'idempotency-key': idempotencyHeaderSchema,
}).strict()

export const runnerSubmitBodySchema = z.object({
    data: z.record(z.string(), z.unknown()),
    started_at: startedAtSchema.optional(),
    captcha_token: captchaTokenSchema.optional(),
}).strict()

export const runnerIdempotencyHeaderSchema = z.object({
    'idempotency-key': idempotencyHeaderSchema,
}).strict()

export const runnerAccessBodySchema = z.object({
    password: formPasswordSchema,
    captcha_token: captchaTokenSchema.optional(),
}).strict()

export const runnerFormAccessHeaderSchema = z.object({
    'x-form-access-token': formAccessTokenSchema,
}).strict()

export const draftSchemaShape = z.object({
    layout: z.unknown(),
    theme: z.record(z.string(), z.unknown()),
    steps: z.array(z.unknown()),
    logic: z.array(z.unknown()),
    settings: z.record(z.string(), z.unknown()),
}).passthrough()

export const updateDraftSchema = z.object({
    schema: draftSchemaShape,
    version: z.number().int().min(1, 'version must be an integer >= 1'),
}).strict()

export const publishFormSchema = z.object({
    description: clearableTextSchema(MAX_PUBLISH_DESCRIPTION_LENGTH, 'description').optional(),
}).strict()

export const buildSubmissionListQuerySchema = z.object({
    limit: z
        .coerce
        .number()
        .int('limit must be an integer')
        .min(1, 'limit must be between 1 and 100')
        .max(100, 'limit must be between 1 and 100')
        .default(25),
    cursor_created_at: z
        .string()
        .datetime({ offset: true, message: 'cursor_created_at must be a valid ISO datetime string with offset' })
        .optional(),
    cursor_submission_id: z
        .string()
        .uuid('cursor_submission_id must be a valid UUID')
        .optional(),
})
    .strict()
    .refine(
        (value) =>
            (!value.cursor_created_at && !value.cursor_submission_id) ||
            (value.cursor_created_at !== undefined && value.cursor_submission_id !== undefined),
        {
            message: 'cursor_created_at and cursor_submission_id must be provided together',
            path: ['cursor_created_at'],
        }
    )

const formTitleSchema = z
    .string()
    .trim()
    .min(1, 'title is required')
    .max(200, 'title must be at most 200 characters')

const nullablePositiveIntegerSchema = z.union([
    z.number().int().positive('max_submissions must be greater than 0'),
    z.null(),
])

export const createFormSchema = z
    .object({
        title: formTitleSchema,
        description: clearableTextSchema(MAX_DESCRIPTION_LENGTH, 'description').optional(),
        schema: draftSchemaShape.optional(),
        max_submissions: nullablePositiveIntegerSchema.optional(),
        accept_submissions: z.boolean().optional(),
        success_message: clearableTextSchema(MAX_SUCCESS_MESSAGE_LENGTH, 'success_message').optional(),
        redirect_url: clearableAbsoluteHttpUrlSchema.optional(),
    })
    .strict()

export const updateFormMetaSchema = z
    .object({
        version: z.number().int().min(1, 'version must be an integer >= 1'),
        title: formTitleSchema.optional(),
        description: clearableTextSchema(MAX_DESCRIPTION_LENGTH, 'description').optional(),
        max_submissions: nullablePositiveIntegerSchema.optional(),
        accept_submissions: z.boolean().optional(),
        success_message: clearableTextSchema(MAX_SUCCESS_MESSAGE_LENGTH, 'success_message').optional(),
        redirect_url: clearableAbsoluteHttpUrlSchema.optional(),
    })
    .strict()
    .refine(
        (value) =>
            value.title !== undefined ||
            value.description !== undefined ||
            value.max_submissions !== undefined ||
            value.accept_submissions !== undefined ||
            value.success_message !== undefined ||
            value.redirect_url !== undefined,
        {
            message: 'At least one editable field must be provided',
        }
    )

export const updateFormAccessSchema = z
    .object({
        version: z.number().int().min(1, 'version must be an integer >= 1'),
        captcha_enabled: z.boolean().optional(),
        password: formPasswordSchema.optional(),
        clear_password: z.boolean().optional(),
    })
    .strict()
    .refine((value) => !(value.password !== undefined && value.clear_password === true), {
        message: 'password and clear_password cannot be provided together',
        path: ['clear_password'],
    })
    .refine(
        (value) =>
            value.captcha_enabled !== undefined ||
            value.password !== undefined ||
            value.clear_password !== undefined,
        {
            message: 'At least one editable field must be provided',
        }
    )

export const parseBearerAuthorizationHeader = (authorization: string | undefined) =>
    bearerAuthHeaderSchema.safeParse({ authorization })

export const parseInternalAdminAuthHeaders = (headers: {
    authorization?: string
    'x-internal-admin-token'?: string
}) => internalAdminAuthHeaderSchema.safeParse(headers)

export const parseRunnerFormAccessHeaders = (headers: {
    'x-form-access-token'?: string
}) => runnerFormAccessHeaderSchema.safeParse(headers)

export const isAbsoluteHttpUrl = (value: string | undefined | null) =>
    typeof value === 'string' && absoluteHttpUrlSchema.safeParse(value).success

export type SignUpInput = z.infer<typeof signUpSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type UpdateDraftInput = z.infer<typeof updateDraftSchema>
export type PublishFormInput = z.infer<typeof publishFormSchema>
export type CreateFormInput = z.infer<typeof createFormSchema>
export type UpdateFormMetaInput = z.infer<typeof updateFormMetaSchema>
export type UpdateFormAccessInput = z.infer<typeof updateFormAccessSchema>
export type BuildSubmissionListQueryInput = z.infer<typeof buildSubmissionListQuerySchema>
export type RunnerSubmitBodyInput = z.infer<typeof runnerSubmitBodySchema>
export type RunnerIdempotencyHeaderInput = z.infer<typeof runnerIdempotencyHeaderSchema>
export type RunnerAccessBodyInput = z.infer<typeof runnerAccessBodySchema>
export type RunnerFormAccessHeaderInput = z.infer<typeof runnerFormAccessHeaderSchema>
export type StripeCheckoutSessionInput = z.infer<typeof stripeCheckoutSessionSchema>
export type StripeCheckoutIdempotencyHeaderInput = z.infer<typeof stripeCheckoutIdempotencyHeaderSchema>
