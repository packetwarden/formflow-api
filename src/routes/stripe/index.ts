import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import Stripe from 'stripe'
import type { Env, Variables } from '../../types'
import { getServiceRoleSupabaseClient } from '../../db/supabase'
import { requireAuth } from '../../middlewares/auth'
import {
    workspaceParamSchema,
    stripeCheckoutSessionSchema,
    stripeCheckoutIdempotencyHeaderSchema,
} from '../../utils/validation'
import { enforceWorkspaceRole } from '../../utils/workspace-access'

const stripeRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

const STRIPE_API_VERSION = '2026-01-28.clover' as Stripe.LatestApiVersion
const WEBHOOK_RETRY_CRON = '*/5 * * * *'
const GRACE_DOWNGRADE_CRON = '0 * * * *'
const WEBHOOK_CLEANUP_CRON = '30 2 * * *'
const DEFAULT_CATALOG_SYNC_CRON = '*/15 * * * *'

const ENTITLED_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'] as const
const MANAGEABLE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due', 'unpaid', 'paused'] as const
const NON_ENTITLED_TERMINAL_STATUSES = ['canceled', 'unpaid', 'paused'] as const
const MAX_WEBHOOK_ATTEMPTS = 8
const DEFAULT_RETRY_BATCH_SIZE = 200
const DEFAULT_GRACE_BATCH_SIZE = 500
const DEFAULT_WEBHOOK_CLAIM_TTL_SECONDS = 300
const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 262_144
const DEFAULT_GRACE_DAYS = 7
const DEFAULT_WEBHOOK_RETENTION_DAYS = 30
const CHECKOUT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
const FREE_PLAN_SLUG = 'free'
const CATALOG_PLAN_SLUGS = ['pro', 'business'] as const
const CATALOG_INTERVALS = ['monthly', 'yearly'] as const
const CATALOG_CURRENCY = 'usd'

type MappedSubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused'
type PlanVariantRow = {
    id: string
    plan_id: string
    stripe_price_id: string | null
    trial_period_days: number
    interval: 'monthly' | 'yearly'
    currency: string
}
type ExistingSubscriptionRow = {
    id: string
    workspace_id: string
    plan_id: string
    plan_variant_id: string
}
type WebhookEventRow = {
    event_id: string
}
type ClaimedWebhookEventRow = {
    event_id: string
    payload: unknown
    attempts: number
    status: 'processing'
}
type CheckoutIdempotencyRow = {
    idempotency_key: string
    workspace_id: string
    plan_variant_id: string
    request_fingerprint: string
    stripe_idempotency_key: string
    stripe_checkout_session_id: string | null
    stripe_checkout_session_url: string | null
    status: 'in_progress' | 'completed' | 'failed'
    expires_at: string
}
type WorkspaceBillingCustomerRow = {
    workspace_id: string
    stripe_customer_id: string
}
type WorkspaceBillingCustomerEventType = 'validated' | 'invalidated' | 'recreated' | 'webhook_deleted'
type ResolveWorkspaceStripeCustomerOutcome = {
    customerId: string
    status: 'validated' | 'recreated'
}
type RequiredBillingEnvKey =
    | 'SUPABASE_URL'
    | 'SUPABASE_SERVICE_ROLE_KEY'
    | 'STRIPE_SECRET_KEY'
    | 'CHECKOUT_SUCCESS_URL'
    | 'CHECKOUT_CANCEL_URL'
    | 'BILLING_PORTAL_RETURN_URL'

type CatalogSyncResult = {
    enabled: boolean
    forced: boolean
    scanned_prices: number
    eligible_prices: number
    updated_variants: number
    missing_variants: string[]
}

type CatalogCandidate = {
    planSlug: 'pro' | 'business'
    interval: 'monthly' | 'yearly'
    currency: 'usd'
    stripePriceId: string
    amountCents: number
    created: number
}

class CatalogOutOfSyncError extends Error {
    code = 'CATALOG_OUT_OF_SYNC' as const
}

const stripeCryptoProvider = Stripe.createSubtleCryptoProvider()

const getStripeClient = (env: Env) => new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
})

const getServiceSupabase = (env: Env) => getServiceRoleSupabaseClient(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY
)

const parsePositiveInt = (value: string | undefined, fallback: number) => {
    const parsed = Number.parseInt(value ?? '', 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const parseGraceDays = (env: Env) => parsePositiveInt(env.BILLING_GRACE_DAYS, DEFAULT_GRACE_DAYS)
const parseWebhookClaimTtlSeconds = (env: Env) => parsePositiveInt(env.STRIPE_WEBHOOK_CLAIM_TTL_SECONDS, DEFAULT_WEBHOOK_CLAIM_TTL_SECONDS)
const parseWebhookMaxBodyBytes = (env: Env) => parsePositiveInt(env.STRIPE_WEBHOOK_MAX_BODY_BYTES, DEFAULT_WEBHOOK_MAX_BODY_BYTES)
const parseRetryBatchSize = (env: Env) => parsePositiveInt(env.STRIPE_RETRY_BATCH_SIZE, DEFAULT_RETRY_BATCH_SIZE)
const parseGraceBatchSize = (env: Env) => parsePositiveInt(env.STRIPE_GRACE_BATCH_SIZE, DEFAULT_GRACE_BATCH_SIZE)
const parseCatalogSyncEnabled = (env: Env) => (env.STRIPE_CATALOG_SYNC_ENABLED ?? 'true').toLowerCase() !== 'false'
const getCatalogSyncCron = (env: Env) => env.STRIPE_CATALOG_SYNC_CRON || DEFAULT_CATALOG_SYNC_CRON

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const toIsoFromUnix = (timestamp: number | null | undefined) => (timestamp ? new Date(timestamp * 1000).toISOString() : null)
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const getMissingBillingEnv = (env: Env, requiredKeys: RequiredBillingEnvKey[]) => requiredKeys.filter((key) => !isNonEmptyString(env[key]))

const truncateError = (value: unknown, maxLength = 1000) => {
    const text = value instanceof Error
        ? value.message
        : typeof value === 'string'
            ? value
            : JSON.stringify(value)
    return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text
}

const createCorrelationId = () => crypto.randomUUID()

const logStripe = (
    level: 'info' | 'warn' | 'error',
    message: string,
    context: Record<string, unknown> = {}
) => {
    const payload = {
        ts: new Date().toISOString(),
        message,
        ...context,
    }
    if (level === 'error') {
        console.error('[stripe]', JSON.stringify(payload))
        return
    }
    if (level === 'warn') {
        console.warn('[stripe]', JSON.stringify(payload))
        return
    }
    console.log('[stripe]', JSON.stringify(payload))
}

const toCheckoutErrorResponse = (correlationId: string) => ({
    error: 'Failed to create Stripe checkout session',
    code: 'STRIPE_CHECKOUT_SESSION_FAILED',
    correlation_id: correlationId,
})

const toPortalErrorResponse = (correlationId: string) => ({
    error: 'Failed to create Stripe billing portal session',
    code: 'STRIPE_PORTAL_SESSION_FAILED',
    correlation_id: correlationId,
})

const resolveStripeCustomerId = (
    customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined
) => {
    if (!customer) return null
    return typeof customer === 'string' ? customer : customer.id
}

const mapStripeSubscriptionStatus = (status: Stripe.Subscription.Status): MappedSubscriptionStatus => {
    switch (status) {
        case 'trialing':
            return 'trialing'
        case 'active':
            return 'active'
        case 'past_due':
            return 'past_due'
        case 'unpaid':
            return 'unpaid'
        case 'paused':
            return 'paused'
        case 'incomplete':
            return 'past_due'
        case 'incomplete_expired':
        case 'canceled':
            return 'canceled'
        default:
            return 'past_due'
    }
}

const shouldEnsureFreeSubscription = (status: MappedSubscriptionStatus) =>
    (NON_ENTITLED_TERMINAL_STATUSES as readonly string[]).includes(status)

const isManageableSubscriptionStatus = (
    status: string
): status is (typeof MANAGEABLE_SUBSCRIPTION_STATUSES)[number] =>
    (MANAGEABLE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status)

const digestSha256Hex = async (value: string) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const buildCheckoutRequestFingerprint = async (workspaceId: string, planVariantId: string, userId: string | null) => {
    const payload = JSON.stringify({
        workspace_id: workspaceId,
        plan_variant_id: planVariantId,
        requested_by_user_id: userId ?? 'anonymous',
    })
    return digestSha256Hex(payload)
}

const buildStripeCheckoutIdempotencyKey = async (
    workspaceId: string,
    planVariantId: string,
    clientIdempotencyKey: string
) => {
    const raw = `checkout:v1:${workspaceId}:${planVariantId}:${clientIdempotencyKey}`
    if (raw.length <= 255) return raw
    const hash = await digestSha256Hex(raw)
    return `checkout:v1:${workspaceId}:${planVariantId}:${hash}`
}

const buildStripeCustomerCreateIdempotencyKey = async (
    workspaceId: string,
    requestScopeKey: string
) => {
    const raw = `customer:v2:${workspaceId}:${requestScopeKey}`
    if (raw.length <= 255) return raw
    const hash = await digestSha256Hex(raw)
    return `customer:v2:${workspaceId}:${hash}`
}

const isDeletedStripeCustomer = (
    customer: Stripe.Customer | Stripe.DeletedCustomer
): customer is Stripe.DeletedCustomer =>
    'deleted' in customer && customer.deleted === true

const isStripeCustomerMissingError = (
    error: unknown,
    customerId?: string | null
) => {
    if (!error || typeof error !== 'object') return false

    const stripeError = error as {
        type?: unknown
        code?: unknown
        param?: unknown
        message?: unknown
    }

    const type = typeof stripeError.type === 'string' ? stripeError.type : null
    const code = typeof stripeError.code === 'string' ? stripeError.code : null
    const param = typeof stripeError.param === 'string' ? stripeError.param : null
    const message = typeof stripeError.message === 'string' ? stripeError.message : ''

    if (type === 'invalid_request_error' && code === 'resource_missing' && param === 'customer') {
        return true
    }

    if (code === 'resource_missing' && message.includes('No such customer')) {
        return true
    }

    if (customerId && message.includes(customerId) && message.includes('No such customer')) {
        return true
    }

    return false
}

const getStripeRequestIdFromError = (error: unknown) => {
    if (!error || typeof error !== 'object') return null
    const requestId = (error as { requestId?: unknown }).requestId
    return typeof requestId === 'string' ? requestId : null
}

const isExpiredIso = (value: string) => {
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) && timestamp <= Date.now()
}

const parseLookupKey = (lookupKey: string | null | undefined) => {
    if (!lookupKey) return null
    const parts = lookupKey.split(':')
    if (parts.length !== 5 || parts[0] !== 'formsandbox') return null

    const [, envSlug, planSlugRaw, intervalRaw, currencyRaw] = parts
    if (planSlugRaw !== 'pro' && planSlugRaw !== 'business') return null
    if (intervalRaw !== 'monthly' && intervalRaw !== 'yearly') return null
    if (currencyRaw !== CATALOG_CURRENCY) return null

    return {
        envSlug,
        planSlug: planSlugRaw as 'pro' | 'business',
        interval: intervalRaw as 'monthly' | 'yearly',
        currency: currencyRaw as 'usd',
    }
}

const normalizeBooleanString = (value: string | undefined) => {
    if (!value) return null
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
    return null
}

const extractCatalogCandidate = (
    price: Stripe.Price,
    catalogEnv: string | undefined
): CatalogCandidate | null => {
    if (!price.active || price.currency !== CATALOG_CURRENCY) return null
    if (!price.recurring || price.unit_amount === null || price.unit_amount < 0) return null

    const interval = price.recurring.interval === 'month'
        ? 'monthly'
        : price.recurring.interval === 'year'
            ? 'yearly'
            : null
    if (!interval) return null

    const metadata = price.metadata ?? {}
    const metadataPlan = metadata.plan_slug === 'pro' || metadata.plan_slug === 'business'
        ? metadata.plan_slug
        : null
    const metadataInterval = metadata.interval === 'monthly' || metadata.interval === 'yearly'
        ? metadata.interval
        : null
    const metadataSelfServe = normalizeBooleanString(metadata.self_serve)
    const lookup = parseLookupKey(price.lookup_key)

    if (lookup && catalogEnv && lookup.envSlug !== catalogEnv) return null

    const planSlug = metadataPlan ?? lookup?.planSlug ?? null
    const normalizedInterval = metadataInterval ?? lookup?.interval ?? interval
    if (!planSlug || !normalizedInterval) return null
    if (metadataSelfServe === false) return null
    if (metadataSelfServe !== true && !lookup) return null

    return {
        planSlug,
        interval: normalizedInterval,
        currency: CATALOG_CURRENCY,
        stripePriceId: price.id,
        amountCents: price.unit_amount,
        created: price.created ?? 0,
    }
}

const refreshWorkspacePlanCache = async (env: Env, workspaceId: string) => {
    const supabase = getServiceSupabase(env)
    const { data: activeRows, error: activeError } = await supabase
        .from('subscriptions')
        .select('plan:plans!subscriptions_plan_id_fkey(slug)')
        .eq('workspace_id', workspaceId)
        .in('status', [...ENTITLED_SUBSCRIPTION_STATUSES])
        .order('created_at', { ascending: false })
        .limit(1)

    if (activeError) throw new Error(`Failed to resolve entitled plan: ${activeError.message}`)

    const plan = activeRows?.[0]?.plan as { slug: string } | { slug: string }[] | null | undefined
    const nextPlanSlug = Array.isArray(plan) ? plan[0]?.slug : plan?.slug

    const { error: workspaceError } = await supabase
        .from('workspaces')
        .update({ plan: nextPlanSlug ?? FREE_PLAN_SLUG })
        .eq('id', workspaceId)

    if (workspaceError) throw new Error(`Failed to update workspace plan cache: ${workspaceError.message}`)
}

const ensureFreeSubscriptionForWorkspace = async (
    env: Env,
    workspaceId: string,
    source: string
) => {
    const supabase = getServiceSupabase(env)
    const { data, error } = await supabase.rpc('ensure_free_subscription_for_workspace', {
        p_workspace_id: workspaceId,
        p_source: source,
    })

    if (error) throw new Error(`Failed to ensure free subscription: ${error.message}`)
    const result = Array.isArray(data) ? data[0] : data
    logStripe('info', 'Ensured free subscription row', {
        workspace_id: workspaceId,
        source,
        created: result?.created ?? null,
        subscription_id: result?.subscription_id ?? null,
    })
    return result
}

const findEntitledPaidSubscription = async (env: Env, workspaceId: string) => {
    const supabase = getServiceSupabase(env)
    const { data: rows, error } = await supabase
        .from('subscriptions')
        .select('id, stripe_customer_id, plan:plans!subscriptions_plan_id_fkey(slug)')
        .eq('workspace_id', workspaceId)
        .in('status', [...ENTITLED_SUBSCRIPTION_STATUSES])
        .order('created_at', { ascending: false })

    if (error) throw new Error(`Failed to check entitled subscription: ${error.message}`)

    return (rows ?? []).find((row) => {
        const plan = (row as { plan?: { slug: string } | { slug: string }[] | null }).plan
        const slug = Array.isArray(plan) ? plan[0]?.slug : plan?.slug
        return slug !== FREE_PLAN_SLUG
    }) ?? null
}

const getCheckoutIdempotencyRow = async (
    env: Env,
    workspaceId: string,
    idempotencyKey: string
) => {
    const supabase = getServiceSupabase(env)
    const { data, error } = await supabase
        .from('stripe_checkout_idempotency')
        .select('idempotency_key, workspace_id, plan_variant_id, request_fingerprint, stripe_idempotency_key, stripe_checkout_session_id, stripe_checkout_session_url, status, expires_at')
        .eq('workspace_id', workspaceId)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle()

    if (error && error.code !== 'PGRST116') {
        throw new Error(`Failed to load checkout idempotency row: ${error.message}`)
    }

    return (data ?? null) as CheckoutIdempotencyRow | null
}

const syncStripeCatalog = async (
    env: Env,
    options?: { forced?: boolean; reason?: string }
): Promise<CatalogSyncResult> => {
    const forced = options?.forced ?? false
    const enabled = parseCatalogSyncEnabled(env)
    if (!enabled && !forced) {
        return {
            enabled: false,
            forced,
            scanned_prices: 0,
            eligible_prices: 0,
            updated_variants: 0,
            missing_variants: [],
        }
    }

    const stripe = getStripeClient(env)
    const supabase = getServiceSupabase(env)
    const catalogEnv = env.STRIPE_CATALOG_ENV
    let scannedPrices = 0
    let eligiblePrices = 0
    const bestByVariantKey = new Map<string, CatalogCandidate>()

    let startingAfter: string | undefined
    for (;;) {
        const page = await stripe.prices.list({
            active: true,
            type: 'recurring',
            limit: 100,
            starting_after: startingAfter,
        })

        for (const price of page.data) {
            scannedPrices += 1
            const candidate = extractCatalogCandidate(price, catalogEnv)
            if (!candidate) continue
            eligiblePrices += 1

            const key = `${candidate.planSlug}:${candidate.interval}:${candidate.currency}`
            const existing = bestByVariantKey.get(key)
            if (!existing || candidate.created > existing.created) {
                bestByVariantKey.set(key, candidate)
            }
        }

        if (!page.has_more || page.data.length === 0) break
        startingAfter = page.data[page.data.length - 1]?.id
    }

    const { data: plans, error: planError } = await supabase
        .from('plans')
        .select('id, slug')
        .in('slug', [...CATALOG_PLAN_SLUGS])
        .eq('is_active', true)

    if (planError) throw new Error(`Failed to load plans for catalog sync: ${planError.message}`)

    const planIdBySlug = new Map<string, string>((plans ?? []).map((row) => [row.slug, row.id]))
    const planIds = Array.from(planIdBySlug.values())
    if (planIds.length === 0) {
        return {
            enabled: true,
            forced,
            scanned_prices: scannedPrices,
            eligible_prices: eligiblePrices,
            updated_variants: 0,
            missing_variants: Array.from(bestByVariantKey.keys()),
        }
    }

    const { data: variants, error: variantError } = await supabase
        .from('plan_variants')
        .select('id, plan_id, interval, currency, stripe_price_id, amount_cents')
        .in('plan_id', planIds)
        .in('interval', [...CATALOG_INTERVALS])
        .eq('currency', CATALOG_CURRENCY)
        .eq('is_active', true)

    if (variantError) throw new Error(`Failed to load plan variants for catalog sync: ${variantError.message}`)

    const variantByKey = new Map<string, {
        id: string
        plan_id: string
        interval: 'monthly' | 'yearly'
        currency: string
        stripe_price_id: string | null
        amount_cents: number
    }>()

    for (const variant of variants ?? []) {
        const slug = Array.from(planIdBySlug.entries()).find((entry) => entry[1] === variant.plan_id)?.[0]
        if (!slug) continue
        variantByKey.set(`${slug}:${variant.interval}:${variant.currency}`, variant as {
            id: string
            plan_id: string
            interval: 'monthly' | 'yearly'
            currency: string
            stripe_price_id: string | null
            amount_cents: number
        })
    }

    let updatedVariants = 0
    const missingVariants: string[] = []

    for (const [key, candidate] of bestByVariantKey.entries()) {
        const variant = variantByKey.get(key)
        if (!variant) {
            missingVariants.push(key)
            continue
        }

        const needsUpdate = variant.stripe_price_id !== candidate.stripePriceId
            || variant.amount_cents !== candidate.amountCents
            || variant.currency !== candidate.currency

        if (!needsUpdate) continue

        const { error: updateError } = await supabase
            .from('plan_variants')
            .update({
                stripe_price_id: candidate.stripePriceId,
                amount_cents: candidate.amountCents,
                currency: candidate.currency,
                is_active: true,
            })
            .eq('id', variant.id)

        if (updateError) throw new Error(`Failed to update plan variant during catalog sync: ${updateError.message}`)
        updatedVariants += 1
    }

    logStripe('info', 'Stripe catalog sync completed', {
        forced,
        reason: options?.reason ?? null,
        scanned_prices: scannedPrices,
        eligible_prices: eligiblePrices,
        updated_variants: updatedVariants,
        missing_variants: missingVariants,
    })

    return {
        enabled: true,
        forced,
        scanned_prices: scannedPrices,
        eligible_prices: eligiblePrices,
        updated_variants: updatedVariants,
        missing_variants: missingVariants,
    }
}

const resolveCheckoutPlanVariant = async (
    env: Env,
    planSlug: string,
    interval: 'monthly' | 'yearly'
) => {
    const supabase = getServiceSupabase(env)
    const queryVariant = async () => {
        const { data: plan, error: planError } = await supabase
            .from('plans')
            .select('id')
            .eq('slug', planSlug)
            .eq('is_active', true)
            .maybeSingle()
        if (planError || !plan) throw new Error(`Failed to resolve plan: ${planError?.message ?? 'missing plan'}`)

        const { data: variant, error: variantError } = await supabase
            .from('plan_variants')
            .select('id, plan_id, stripe_price_id, trial_period_days, interval, currency')
            .eq('plan_id', plan.id)
            .eq('interval', interval)
            .eq('currency', CATALOG_CURRENCY)
            .eq('is_active', true)
            .not('stripe_price_id', 'is', null)
            .maybeSingle()

        if (variantError) throw new Error(`Failed to resolve plan variant: ${variantError.message}`)
        return (variant ?? null) as PlanVariantRow | null
    }

    const first = await queryVariant()
    if (first) return first

    await syncStripeCatalog(env, { forced: true, reason: 'checkout-missing-variant' })
    const second = await queryVariant()
    if (second) return second

    throw new CatalogOutOfSyncError(`Plan variant "${planSlug}:${interval}" is out of sync with Stripe`)
}

const recordWorkspaceBillingCustomerEvent = async (
    env: Env,
    event: {
        workspaceId: string
        eventType: WorkspaceBillingCustomerEventType
        oldStripeCustomerId?: string | null
        newStripeCustomerId?: string | null
        reason?: string | null
        stripeEventId?: string | null
    }
) => {
    const supabase = getServiceSupabase(env)
    const { error } = await supabase
        .from('workspace_billing_customer_events')
        .insert({
            workspace_id: event.workspaceId,
            event_type: event.eventType,
            old_stripe_customer_id: event.oldStripeCustomerId ?? null,
            new_stripe_customer_id: event.newStripeCustomerId ?? null,
            reason: event.reason ?? null,
            stripe_event_id: event.stripeEventId ?? null,
        })

    if (error) {
        logStripe('warn', 'Failed to persist workspace billing customer event', {
            workspace_id: event.workspaceId,
            event_type: event.eventType,
            old_stripe_customer_id: event.oldStripeCustomerId ?? null,
            new_stripe_customer_id: event.newStripeCustomerId ?? null,
            reason: event.reason ?? null,
            stripe_event_id: event.stripeEventId ?? null,
            error: error.message,
        })
    }
}

const getWorkspaceBillingCustomerMapping = async (
    env: Env,
    workspaceId: string
) => {
    const supabase = getServiceSupabase(env)
    const { data, error } = await supabase
        .from('workspace_billing_customers')
        .select('workspace_id, stripe_customer_id')
        .eq('workspace_id', workspaceId)
        .maybeSingle()

    if (error && error.code !== 'PGRST116') {
        throw new Error(`Failed to load workspace billing customer mapping: ${error.message}`)
    }

    return (data ?? null) as WorkspaceBillingCustomerRow | null
}

const persistWorkspaceStripeCustomerMapping = async (
    env: Env,
    workspaceId: string,
    stripeCustomerId: string
) => {
    const supabase = getServiceSupabase(env)
    const { error } = await supabase
        .from('workspace_billing_customers')
        .upsert({
            workspace_id: workspaceId,
            stripe_customer_id: stripeCustomerId,
        }, {
            onConflict: 'workspace_id',
        })

    if (error) {
        throw new Error(`Failed to persist workspace billing customer mapping: ${error.message}`)
    }
}

const invalidateWorkspaceStripeCustomerMapping = async (
    env: Env,
    workspaceId: string,
    stripeCustomerId: string,
    reason: string
) => {
    const supabase = getServiceSupabase(env)
    const { data, error } = await supabase
        .from('workspace_billing_customers')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('stripe_customer_id', stripeCustomerId)
        .select('workspace_id, stripe_customer_id')

    if (error) {
        throw new Error(`Failed to invalidate workspace billing customer mapping: ${error.message}`)
    }

    const deletedRows = (data ?? []) as WorkspaceBillingCustomerRow[]
    if (deletedRows.length > 0) {
        await recordWorkspaceBillingCustomerEvent(env, {
            workspaceId,
            eventType: 'invalidated',
            oldStripeCustomerId: stripeCustomerId,
            reason,
        })
        return true
    }

    return false
}

const createWorkspaceStripeCustomerMapping = async (
    env: Env,
    workspaceId: string,
    user: Variables['user'],
    stripe: Stripe,
    requestScopeKey: string
) => {
    const supabase = getServiceSupabase(env)
    const customerCreateIdempotencyKey = await buildStripeCustomerCreateIdempotencyKey(
        workspaceId,
        requestScopeKey
    )

    const customer = await stripe.customers.create({
        email: user?.email ?? undefined,
        name: typeof user?.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : undefined,
        metadata: { workspace_id: workspaceId },
    }, {
        idempotencyKey: customerCreateIdempotencyKey,
    })

    const { error: insertMappingError } = await supabase
        .from('workspace_billing_customers')
        .insert({
            workspace_id: workspaceId,
            stripe_customer_id: customer.id,
        })

    if (insertMappingError && insertMappingError.code !== '23505') {
        throw new Error(`Failed to persist workspace billing customer mapping: ${insertMappingError.message}`)
    }

    let customerId = customer.id
    if (insertMappingError?.code === '23505') {
        const { data: raceWinner, error: raceWinnerError } = await supabase
            .from('workspace_billing_customers')
            .select('stripe_customer_id')
            .eq('workspace_id', workspaceId)
            .maybeSingle()
        if (raceWinnerError || !raceWinner?.stripe_customer_id) {
            throw new Error(`Failed to resolve raced customer mapping: ${raceWinnerError?.message ?? 'missing mapping'}`)
        }
        customerId = raceWinner.stripe_customer_id
    }

    const { error: syncCustomerError } = await supabase
        .from('subscriptions')
        .update({ stripe_customer_id: customerId })
        .eq('workspace_id', workspaceId)
        .is('stripe_customer_id', null)

    if (syncCustomerError) {
        throw new Error(`Failed to sync stripe_customer_id into subscriptions: ${syncCustomerError.message}`)
    }

    return customerId
}

const resolveOrCreateWorkspaceStripeCustomerId = async (
    env: Env,
    workspaceId: string,
    user: Variables['user'],
    stripe: Stripe,
    requestScopeKey: string
): Promise<ResolveWorkspaceStripeCustomerOutcome> => {
    const mapping = await getWorkspaceBillingCustomerMapping(env, workspaceId)

    if (mapping?.stripe_customer_id) {
        try {
            const stripeCustomer = await stripe.customers.retrieve(mapping.stripe_customer_id)
            if (!isDeletedStripeCustomer(stripeCustomer)) {
                await recordWorkspaceBillingCustomerEvent(env, {
                    workspaceId,
                    eventType: 'validated',
                    oldStripeCustomerId: mapping.stripe_customer_id,
                    newStripeCustomerId: mapping.stripe_customer_id,
                    reason: 'stripe-retrieve-ok',
                })
                return {
                    customerId: mapping.stripe_customer_id,
                    status: 'validated',
                }
            }

            await invalidateWorkspaceStripeCustomerMapping(
                env,
                workspaceId,
                mapping.stripe_customer_id,
                'stripe-retrieve-deleted-customer'
            )
        } catch (error) {
            if (!isStripeCustomerMissingError(error, mapping.stripe_customer_id)) {
                throw error
            }

            logStripe('warn', 'Workspace billing customer mapping points to missing Stripe customer', {
                workspace_id: workspaceId,
                stripe_customer_id: mapping.stripe_customer_id,
                stripe_request_id: getStripeRequestIdFromError(error),
                error: truncateError(error),
            })

            await invalidateWorkspaceStripeCustomerMapping(
                env,
                workspaceId,
                mapping.stripe_customer_id,
                'stripe-resource-missing-customer'
            )
        }
    }

    const customerId = await createWorkspaceStripeCustomerMapping(
        env,
        workspaceId,
        user,
        stripe,
        requestScopeKey
    )

    await recordWorkspaceBillingCustomerEvent(env, {
        workspaceId,
        eventType: 'recreated',
        oldStripeCustomerId: mapping?.stripe_customer_id ?? null,
        newStripeCustomerId: customerId,
        reason: mapping?.stripe_customer_id
            ? 'stale-mapping-recovery'
            : 'missing-mapping-create',
    })

    return {
        customerId,
        status: 'recreated',
    }
}

const withRecoveredWorkspaceStripeCustomer = async <T>(
    env: Env,
    workspaceId: string,
    user: Variables['user'],
    stripe: Stripe,
    options: {
        requestScopeKey: string
        correlationId: string
        operation: 'checkout-session' | 'portal-session'
        preferredCustomerId?: string | null
    },
    execute: (customerId: string) => Promise<T>
) => {
    // Validate once before execution and retry once if Stripe rejects the customer reference.
    let firstResolution: ResolveWorkspaceStripeCustomerOutcome | null = null
    if (options.preferredCustomerId) {
        try {
            const preferred = await stripe.customers.retrieve(options.preferredCustomerId)
            if (isDeletedStripeCustomer(preferred)) {
                await invalidateWorkspaceStripeCustomerMapping(
                    env,
                    workspaceId,
                    options.preferredCustomerId,
                    `${options.operation}-preferred-customer-deleted`
                )
            } else {
                await persistWorkspaceStripeCustomerMapping(
                    env,
                    workspaceId,
                    options.preferredCustomerId
                )
                await recordWorkspaceBillingCustomerEvent(env, {
                    workspaceId,
                    eventType: 'validated',
                    oldStripeCustomerId: options.preferredCustomerId,
                    newStripeCustomerId: options.preferredCustomerId,
                    reason: `${options.operation}-preferred-customer-valid`,
                })
                firstResolution = {
                    customerId: options.preferredCustomerId,
                    status: 'validated',
                }
            }
        } catch (error) {
            if (!isStripeCustomerMissingError(error, options.preferredCustomerId)) {
                throw error
            }

            logStripe('warn', 'Preferred Stripe customer is missing; falling back to workspace mapping recovery', {
                workspace_id: workspaceId,
                operation: options.operation,
                stripe_customer_id: options.preferredCustomerId,
                stripe_request_id: getStripeRequestIdFromError(error),
                correlation_id: options.correlationId,
                error: truncateError(error),
            })

            await invalidateWorkspaceStripeCustomerMapping(
                env,
                workspaceId,
                options.preferredCustomerId,
                `${options.operation}-preferred-customer-missing`
            )
        }
    }

    if (!firstResolution) {
        firstResolution = await resolveOrCreateWorkspaceStripeCustomerId(
            env,
            workspaceId,
            user,
            stripe,
            options.requestScopeKey
        )
    }

    try {
        return await execute(firstResolution.customerId)
    } catch (error) {
        if (!isStripeCustomerMissingError(error, firstResolution.customerId)) {
            throw error
        }

        logStripe('warn', 'Stripe session operation failed due to missing customer; retrying with remapped customer', {
            workspace_id: workspaceId,
            operation: options.operation,
            stripe_customer_id: firstResolution.customerId,
            stripe_request_id: getStripeRequestIdFromError(error),
            correlation_id: options.correlationId,
            error: truncateError(error),
        })

        await invalidateWorkspaceStripeCustomerMapping(
            env,
            workspaceId,
            firstResolution.customerId,
            `${options.operation}-missing-customer-retry`
        )

        const retryRequestScopeKey = `${options.requestScopeKey}:retry:${options.correlationId}`
        const retryResolution = await resolveOrCreateWorkspaceStripeCustomerId(
            env,
            workspaceId,
            user,
            stripe,
            retryRequestScopeKey
        )

        return execute(retryResolution.customerId)
    }
}

const fetchExistingSubscriptionByStripeId = async (env: Env, stripeSubscriptionId: string) => {
    const supabase = getServiceSupabase(env)
    const { data, error } = await supabase
        .from('subscriptions')
        .select('id, workspace_id, plan_id, plan_variant_id')
        .eq('stripe_subscription_id', stripeSubscriptionId)
        .maybeSingle()

    if (error && error.code !== 'PGRST116') {
        throw new Error(`Failed to load existing Stripe subscription mapping: ${error.message}`)
    }

    return (data ?? null) as ExistingSubscriptionRow | null
}

const resolveWorkspaceIdForSubscription = async (
    env: Env,
    subscription: Stripe.Subscription,
    workspaceHint?: string | null
) => {
    if (workspaceHint && isUuid(workspaceHint)) return workspaceHint

    const metadataWorkspace = subscription.metadata?.workspace_id
    if (typeof metadataWorkspace === 'string' && isUuid(metadataWorkspace)) return metadataWorkspace

    const existing = await fetchExistingSubscriptionByStripeId(env, subscription.id)
    if (existing?.workspace_id) return existing.workspace_id

    const customerId = resolveStripeCustomerId(subscription.customer)
    if (!customerId) return null

    const supabase = getServiceSupabase(env)
    const { data: mapping, error: mappingError } = await supabase
        .from('workspace_billing_customers')
        .select('workspace_id')
        .eq('stripe_customer_id', customerId)
        .limit(1)
        .maybeSingle()

    if (mappingError && mappingError.code !== 'PGRST116') {
        throw new Error(`Failed to resolve workspace from billing customer mapping: ${mappingError.message}`)
    }
    if (mapping?.workspace_id) return mapping.workspace_id

    const { data: fallbackRows, error: fallbackError } = await supabase
        .from('subscriptions')
        .select('workspace_id')
        .eq('stripe_customer_id', customerId)
        .order('created_at', { ascending: false })
        .limit(1)

    if (fallbackError) throw new Error(`Failed to resolve workspace from subscription fallback: ${fallbackError.message}`)
    return fallbackRows?.[0]?.workspace_id ?? null
}

const findPlanVariantByPriceId = async (env: Env, priceId: string) => {
    const supabase = getServiceSupabase(env)
    const { data, error } = await supabase
        .from('plan_variants')
        .select('id, plan_id')
        .eq('stripe_price_id', priceId)
        .eq('is_active', true)
        .maybeSingle()

    if (error && error.code !== 'PGRST116') {
        throw new Error(`Failed to resolve plan variant by price ID: ${error.message}`)
    }

    return data ?? null
}

const resolvePlanVariantFromSubscription = async (
    env: Env,
    subscription: Stripe.Subscription,
    existing: ExistingSubscriptionRow | null
) => {
    const priceId = subscription.items.data[0]?.price?.id ?? null
    if (!priceId) {
        if (!existing) throw new Error('Subscription does not include a Stripe price')
        return { id: existing.plan_variant_id, plan_id: existing.plan_id }
    }

    let variant = await findPlanVariantByPriceId(env, priceId)
    if (!variant) {
        await syncStripeCatalog(env, { forced: true, reason: 'webhook-unknown-price' })
        variant = await findPlanVariantByPriceId(env, priceId)
    }

    if (!variant) {
        if (!existing) throw new CatalogOutOfSyncError(`Failed to resolve variant for Stripe price "${priceId}"`)
        return { id: existing.plan_variant_id, plan_id: existing.plan_id }
    }

    return variant
}

const upsertWorkspaceSubscriptionState = async (
    env: Env,
    workspaceId: string,
    subscription: Stripe.Subscription
) => {
    const supabase = getServiceSupabase(env)
    const existingByStripeId = await fetchExistingSubscriptionByStripeId(env, subscription.id)
    const planVariant = await resolvePlanVariantFromSubscription(env, subscription, existingByStripeId)
    const mappedStatus = mapStripeSubscriptionStatus(subscription.status)
    if (!isManageableSubscriptionStatus(mappedStatus) && mappedStatus !== 'canceled') {
        throw new Error(`Unsupported mapped subscription status "${mappedStatus}"`)
    }
    const nowIso = new Date().toISOString()

    const currentPeriodStart = subscription.items.data[0]?.current_period_start
    const currentPeriodEnd = subscription.items.data[0]?.current_period_end

    const payload = {
        workspace_id: workspaceId,
        plan_id: planVariant.plan_id,
        plan_variant_id: planVariant.id,
        status: mappedStatus,
        stripe_subscription_id: subscription.id,
        stripe_customer_id: resolveStripeCustomerId(subscription.customer),
        current_period_start: toIsoFromUnix(currentPeriodStart) ?? nowIso,
        current_period_end: toIsoFromUnix(currentPeriodEnd) ?? nowIso,
        trial_start: toIsoFromUnix(subscription.trial_start),
        trial_end: toIsoFromUnix(subscription.trial_end),
        cancel_at_period_end: subscription.cancel_at_period_end ?? false,
        canceled_at: toIsoFromUnix(subscription.canceled_at),
        ended_at: toIsoFromUnix(subscription.ended_at),
        metadata: {
            stripe_status: subscription.status,
            stripe_price_id: subscription.items.data[0]?.price?.id ?? null,
            source: 'stripe-webhook',
        },
    }

    if (existingByStripeId) {
        const { error } = await supabase.from('subscriptions').update(payload).eq('id', existingByStripeId.id)
        if (error) throw new Error(`Failed to update subscription by Stripe ID: ${error.message}`)
        return mappedStatus
    }

    if ((ENTITLED_SUBSCRIPTION_STATUSES as readonly string[]).includes(mappedStatus)) {
        const { data: entitledRows, error: entitledError } = await supabase
            .from('subscriptions')
            .select('id')
            .eq('workspace_id', workspaceId)
            .in('status', [...ENTITLED_SUBSCRIPTION_STATUSES])
            .order('created_at', { ascending: false })
            .limit(1)
        if (entitledError) throw new Error(`Failed to resolve entitled workspace subscription: ${entitledError.message}`)

        const entitledRowId = entitledRows?.[0]?.id
        if (entitledRowId) {
            const { error } = await supabase.from('subscriptions').update(payload).eq('id', entitledRowId)
            if (error) throw new Error(`Failed to update entitled workspace subscription: ${error.message}`)
            return mappedStatus
        }
    }

    const { error: insertError } = await supabase.from('subscriptions').insert(payload)
    if (insertError) throw new Error(`Failed to insert workspace subscription: ${insertError.message}`)
    return mappedStatus
}

const syncSubscriptionFromStripe = async (
    env: Env,
    subscription: Stripe.Subscription,
    workspaceHint?: string | null
) => {
    const workspaceId = await resolveWorkspaceIdForSubscription(env, subscription, workspaceHint)
    if (!workspaceId) throw new Error(`Unable to resolve workspace for Stripe subscription "${subscription.id}"`)

    const mappedStatus = await upsertWorkspaceSubscriptionState(env, workspaceId, subscription)
    if (shouldEnsureFreeSubscription(mappedStatus)) {
        await ensureFreeSubscriptionForWorkspace(env, workspaceId, 'stripe-terminal-status')
    }
    await refreshWorkspacePlanCache(env, workspaceId)
    return workspaceId
}

const setGracePeriodForSubscription = async (
    env: Env,
    stripeSubscriptionId: string,
    gracePeriodEnd: string | null
) => {
    const supabase = getServiceSupabase(env)
    const { data: rows, error } = await supabase
        .from('subscriptions')
        .update({ grace_period_end: gracePeriodEnd })
        .eq('stripe_subscription_id', stripeSubscriptionId)
        .select('workspace_id')

    if (error) throw new Error(`Failed to update subscription grace period: ${error.message}`)

    const workspaceId = rows?.[0]?.workspace_id
    if (workspaceId) await refreshWorkspacePlanCache(env, workspaceId)
}

const getInvoiceSubscriptionId = (invoice: Stripe.Invoice) => {
    const modern = invoice.parent?.subscription_details?.subscription
    if (typeof modern === 'string') return modern
    if (modern && typeof modern === 'object' && typeof modern.id === 'string') return modern.id

    const legacy = (invoice as Stripe.Invoice & {
        subscription?: string | Stripe.Subscription | null
    }).subscription

    if (typeof legacy === 'string') return legacy
    if (legacy && typeof legacy === 'object' && typeof legacy.id === 'string') return legacy.id
    return null
}

const cancelWorkspaceSubscriptionsForDeletedCustomer = async (
    env: Env,
    workspaceId: string,
    stripeCustomerId: string,
    stripeEventId: string
) => {
    const supabase = getServiceSupabase(env)
    const nowIso = new Date().toISOString()
    const cancellableStatuses = [...MANAGEABLE_SUBSCRIPTION_STATUSES]
    const { data: rows, error: rowsError } = await supabase
        .from('subscriptions')
        .select('id, metadata')
        .eq('workspace_id', workspaceId)
        .eq('stripe_customer_id', stripeCustomerId)
        .in('status', cancellableStatuses)

    if (rowsError) {
        throw new Error(`Failed to load subscriptions for deleted customer handling: ${rowsError.message}`)
    }

    for (const row of rows ?? []) {
        const existingMetadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
            ? row.metadata as Record<string, unknown>
            : {}

        const { error: updateError } = await supabase
            .from('subscriptions')
            .update({
                status: 'canceled',
                canceled_at: nowIso,
                ended_at: nowIso,
                cancel_at_period_end: false,
                metadata: {
                    ...existingMetadata,
                    source: 'stripe-webhook',
                    reason: 'customer_deleted_event',
                    stripe_event_id: stripeEventId,
                    stripe_event_type: 'customer.deleted',
                },
            })
            .eq('id', row.id)

        if (updateError) {
            throw new Error(`Failed to cancel subscription for deleted customer: ${updateError.message}`)
        }
    }
}

const handleDeletedStripeCustomer = async (
    env: Env,
    customerId: string,
    stripeEventId: string
) => {
    const supabase = getServiceSupabase(env)
    const workspaceIds = new Set<string>()

    const { data: removedMappings, error: removeMappingError } = await supabase
        .from('workspace_billing_customers')
        .delete()
        .eq('stripe_customer_id', customerId)
        .select('workspace_id, stripe_customer_id')

    if (removeMappingError) {
        throw new Error(`Failed to remove workspace billing mapping for deleted customer: ${removeMappingError.message}`)
    }

    for (const row of (removedMappings ?? []) as WorkspaceBillingCustomerRow[]) {
        workspaceIds.add(row.workspace_id)
    }

    const { data: subscriptionRows, error: subscriptionRowsError } = await supabase
        .from('subscriptions')
        .select('workspace_id')
        .eq('stripe_customer_id', customerId)

    if (subscriptionRowsError) {
        throw new Error(`Failed to resolve workspaces for deleted Stripe customer: ${subscriptionRowsError.message}`)
    }

    for (const row of subscriptionRows ?? []) {
        if (typeof row.workspace_id === 'string') workspaceIds.add(row.workspace_id)
    }

    for (const workspaceId of workspaceIds) {
        await recordWorkspaceBillingCustomerEvent(env, {
            workspaceId,
            eventType: 'webhook_deleted',
            oldStripeCustomerId: customerId,
            reason: 'stripe-customer-deleted-webhook',
            stripeEventId,
        })

        await cancelWorkspaceSubscriptionsForDeletedCustomer(
            env,
            workspaceId,
            customerId,
            stripeEventId
        )

        await ensureFreeSubscriptionForWorkspace(env, workspaceId, 'stripe-customer-deleted-webhook')
        await refreshWorkspacePlanCache(env, workspaceId)
    }
}

const processStripeEvent = async (env: Env, event: Stripe.Event) => {
    const stripe = getStripeClient(env)

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object as Stripe.Checkout.Session
        if (session.mode !== 'subscription') return

        const ref = session.subscription
        const subscriptionId = typeof ref === 'string' ? ref : ref?.id
        if (!subscriptionId) return

        const subscription = await stripe.subscriptions.retrieve(subscriptionId)
        await syncSubscriptionFromStripe(
            env,
            subscription,
            typeof session.metadata?.workspace_id === 'string' ? session.metadata.workspace_id : null
        )
        return
    }

    if (event.type === 'customer.deleted') {
        const customer = event.data.object as Stripe.Customer | Stripe.DeletedCustomer
        const customerId = resolveStripeCustomerId(customer)
        if (customerId) {
            await handleDeletedStripeCustomer(env, customerId, event.id)
        }
        return
    }

    if (
        event.type === 'customer.subscription.created'
        || event.type === 'customer.subscription.updated'
        || event.type === 'customer.subscription.deleted'
    ) {
        await syncSubscriptionFromStripe(env, event.data.object as Stripe.Subscription)
        return
    }

    if (event.type === 'invoice.payment_failed' || event.type === 'invoice.paid') {
        const invoice = event.data.object as Stripe.Invoice
        const subscriptionId = getInvoiceSubscriptionId(invoice)
        if (!subscriptionId) return

        const subscription = await stripe.subscriptions.retrieve(subscriptionId)
        await syncSubscriptionFromStripe(env, subscription)

        if (event.type === 'invoice.payment_failed') {
            const graceDays = parseGraceDays(env)
            const graceEnd = new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000).toISOString()
            await setGracePeriodForSubscription(env, subscriptionId, graceEnd)
        } else {
            await setGracePeriodForSubscription(env, subscriptionId, null)
        }
    }
}

const claimWebhookEvent = async (env: Env, eventId: string, processorId: string) => {
    const supabase = getServiceSupabase(env)
    const { data, error } = await supabase.rpc('claim_stripe_webhook_event', {
        p_event_id: eventId,
        p_processor_id: processorId,
        p_ttl_seconds: parseWebhookClaimTtlSeconds(env),
        p_max_attempts: MAX_WEBHOOK_ATTEMPTS,
    })

    if (error) throw new Error(`Failed to claim webhook event ${eventId}: ${error.message}`)
    const row = (Array.isArray(data) ? data[0] : data) as ClaimedWebhookEventRow | null | undefined
    return row ?? null
}

const computeRetryBackoffSeconds = (attempts: number) => {
    const exponent = Math.max(0, Math.min(attempts, 10))
    return Math.min(3600, 15 * (2 ** exponent))
}

const markWebhookEvent = async (
    env: Env,
    eventId: string,
    updates: Record<string, unknown>
) => {
    const supabase = getServiceSupabase(env)
    const { error } = await supabase.from('stripe_webhook_events').update(updates).eq('event_id', eventId)
    if (error) {
        logStripe('error', 'Failed to update webhook event state', {
            event_id: eventId,
            update_error: error.message,
        })
    }
}

const processWebhookEventById = async (env: Env, eventId: string) => {
    const processorId = createCorrelationId()
    const claim = await claimWebhookEvent(env, eventId, processorId)
    if (!claim) return

    if (!claim.payload || typeof claim.payload !== 'object') {
        await markWebhookEvent(env, eventId, {
            status: 'failed',
            last_error: 'Stored payload is invalid for replay',
            processor_id: null,
            processing_started_at: null,
            claim_expires_at: null,
            next_attempt_at: new Date(Date.now() + computeRetryBackoffSeconds(claim.attempts) * 1000).toISOString(),
        })
        return
    }

    try {
        await processStripeEvent(env, claim.payload as Stripe.Event)
        await markWebhookEvent(env, eventId, {
            status: 'completed',
            processed_at: new Date().toISOString(),
            last_error: null,
            processor_id: null,
            processing_started_at: null,
            claim_expires_at: null,
            next_attempt_at: null,
        })
    } catch (error) {
        const retryAfterSeconds = computeRetryBackoffSeconds(claim.attempts)
        await markWebhookEvent(env, eventId, {
            status: 'failed',
            last_error: truncateError(error),
            processor_id: null,
            processing_started_at: null,
            claim_expires_at: null,
            next_attempt_at: new Date(Date.now() + retryAfterSeconds * 1000).toISOString(),
        })

        logStripe('error', 'Stripe webhook processing failed', {
            event_id: eventId,
            processor_id: processorId,
            attempts: claim.attempts,
            retry_after_seconds: retryAfterSeconds,
            error: truncateError(error),
        })
    }
}

const retryWebhookEvents = async (env: Env) => {
    const supabase = getServiceSupabase(env)
    const nowIso = new Date().toISOString()
    const batchSize = parseRetryBatchSize(env)

    const { data: dueRows, error: dueError } = await supabase
        .from('stripe_webhook_events')
        .select('event_id')
        .in('status', ['pending', 'failed'])
        .lt('attempts', MAX_WEBHOOK_ATTEMPTS)
        .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
        .order('created_at', { ascending: true })
        .limit(batchSize)

    if (dueError) throw new Error(`Failed to fetch retryable webhook events: ${dueError.message}`)

    const remaining = Math.max(0, batchSize - (dueRows?.length ?? 0))
    let staleRows: WebhookEventRow[] = []
    if (remaining > 0) {
        const { data: staleData, error: staleError } = await supabase
            .from('stripe_webhook_events')
            .select('event_id')
            .eq('status', 'processing')
            .lt('attempts', MAX_WEBHOOK_ATTEMPTS)
            .or(`claim_expires_at.is.null,claim_expires_at.lt.${nowIso}`)
            .order('created_at', { ascending: true })
            .limit(remaining)

        if (staleError) throw new Error(`Failed to fetch stale processing webhook events: ${staleError.message}`)
        staleRows = (staleData ?? []) as WebhookEventRow[]
    }

    const ids = new Set<string>()
    for (const row of (dueRows ?? []) as WebhookEventRow[]) ids.add(row.event_id)
    for (const row of staleRows) ids.add(row.event_id)

    for (const eventId of ids) {
        await processWebhookEventById(env, eventId)
    }
}

const enforceGracePeriodDowngrades = async (env: Env) => {
    const supabase = getServiceSupabase(env)
    const nowIso = new Date().toISOString()
    const batchSize = parseGraceBatchSize(env)

    const { data: rows, error } = await supabase
        .from('subscriptions')
        .select('id, workspace_id')
        .eq('status', 'past_due')
        .not('grace_period_end', 'is', null)
        .lte('grace_period_end', nowIso)
        .limit(batchSize)

    if (error) throw new Error(`Failed to fetch expired grace-period subscriptions: ${error.message}`)

    for (const row of rows ?? []) {
        const { error: markError } = await supabase
            .from('subscriptions')
            .update({
                status: 'canceled',
                canceled_at: nowIso,
                ended_at: nowIso,
                cancel_at_period_end: false,
            })
            .eq('id', row.id)

        if (markError) {
            logStripe('error', 'Failed to cancel subscription after grace period expiry', {
                subscription_id: row.id,
                error: markError.message,
            })
            continue
        }

        try {
            await ensureFreeSubscriptionForWorkspace(env, row.workspace_id, 'grace-period-expired')
            await refreshWorkspacePlanCache(env, row.workspace_id)
        } catch (downgradeError) {
            logStripe('error', 'Failed to ensure free subscription after grace expiry', {
                workspace_id: row.workspace_id,
                error: truncateError(downgradeError),
            })
        }
    }
}

const cleanupWebhookHistory = async (env: Env) => {
    const supabase = getServiceSupabase(env)
    const cutoffIso = new Date(Date.now() - DEFAULT_WEBHOOK_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const { error } = await supabase
        .from('stripe_webhook_events')
        .delete()
        .eq('status', 'completed')
        .lt('processed_at', cutoffIso)

    if (error) throw new Error(`Failed to cleanup webhook history: ${error.message}`)
}

const ensureInternalCatalogSyncAuth = (env: Env, token: string | undefined) => {
    if (!isNonEmptyString(env.STRIPE_INTERNAL_ADMIN_TOKEN)) return false
    if (!isNonEmptyString(token)) return false
    return token === env.STRIPE_INTERNAL_ADMIN_TOKEN
}

export const runStripeScheduled = async (env: Env, cron?: string) => {
    const catalogSyncCron = getCatalogSyncCron(env)

    if (cron === WEBHOOK_RETRY_CRON) {
        await retryWebhookEvents(env)
        return
    }

    if (cron === GRACE_DOWNGRADE_CRON) {
        await enforceGracePeriodDowngrades(env)
        return
    }

    if (cron === catalogSyncCron) {
        await syncStripeCatalog(env, { reason: 'scheduled-catalog-sync' })
        return
    }

    if (cron === WEBHOOK_CLEANUP_CRON) {
        await cleanupWebhookHistory(env)
        return
    }

    await retryWebhookEvents(env)
    await enforceGracePeriodDowngrades(env)
    await syncStripeCatalog(env, { reason: 'fallback-scheduled-catalog-sync' })
    await cleanupWebhookHistory(env)
}

stripeRouter.post(
    '/workspaces/:workspaceId/checkout-session',
    requireAuth,
    zValidator('param', workspaceParamSchema),
    zValidator('json', stripeCheckoutSessionSchema),
    async (c) => {
        const { workspaceId } = c.req.valid('param')
        const { plan_slug, interval } = c.req.valid('json')
        const correlationId = createCorrelationId()

        const headerValidation = stripeCheckoutIdempotencyHeaderSchema.safeParse({
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
        const clientIdempotencyKey = headerValidation.data['idempotency-key']

        const roleCheck = await enforceWorkspaceRole(c, workspaceId, 'admin')
        if (!roleCheck.ok) return roleCheck.response

        if (plan_slug === 'enterprise') {
            return c.json({
                error: 'Enterprise plan is not available via self-serve checkout',
                code: 'CONTACT_SALES_REQUIRED',
                contact_sales_url: c.env.CONTACT_SALES_URL || null,
            }, 403)
        }

        if (plan_slug === 'free') {
            return c.json({
                error: 'Free plan cannot be purchased through checkout',
                code: 'INVALID_PLAN_FOR_CHECKOUT',
            }, 400)
        }

        const missingEnv = getMissingBillingEnv(c.env, [
            'SUPABASE_URL',
            'SUPABASE_SERVICE_ROLE_KEY',
            'STRIPE_SECRET_KEY',
            'CHECKOUT_SUCCESS_URL',
            'CHECKOUT_CANCEL_URL',
            'BILLING_PORTAL_RETURN_URL',
        ])
        if (missingEnv.length > 0) {
            return c.json({
                error: 'Stripe billing configuration is incomplete',
                code: 'BILLING_CONFIG_MISSING',
                missing: missingEnv,
            }, 500)
        }

        try {
            const stripe = getStripeClient(c.env)
            const activePaid = await findEntitledPaidSubscription(c.env, workspaceId)

            if (activePaid) {
                const portalSession = await withRecoveredWorkspaceStripeCustomer(
                    c.env,
                    workspaceId,
                    c.get('user'),
                    stripe,
                    {
                        requestScopeKey: clientIdempotencyKey,
                        correlationId,
                        operation: 'checkout-session',
                        preferredCustomerId: activePaid.stripe_customer_id ?? null,
                    },
                    async (customerId) => stripe.billingPortal.sessions.create({
                        customer: customerId,
                        return_url: c.env.BILLING_PORTAL_RETURN_URL,
                        configuration: c.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID || undefined,
                    })
                )

                return c.json({
                    url: portalSession.url,
                    destination: 'portal',
                    reason: 'ALREADY_SUBSCRIBED',
                }, 200)
            }

            const variant = await resolveCheckoutPlanVariant(c.env, plan_slug, interval)
            if (!variant.stripe_price_id) {
                return c.json({
                    error: 'Catalog is out of sync with Stripe',
                    code: 'CATALOG_OUT_OF_SYNC',
                    correlation_id: correlationId,
                }, 409)
            }
            const stripePriceId = variant.stripe_price_id

            const requestFingerprint = await buildCheckoutRequestFingerprint(
                workspaceId,
                variant.id,
                c.get('user')?.id ?? null
            )
            const stripeIdempotencyKey = await buildStripeCheckoutIdempotencyKey(
                workspaceId,
                variant.id,
                clientIdempotencyKey
            )
            const supabase = getServiceSupabase(c.env)

            const resolveExistingIdempotencyRow = async (
                existingRow: CheckoutIdempotencyRow | null
            ): Promise<Response | null> => {
                if (!existingRow) return null

                if (existingRow.request_fingerprint !== requestFingerprint) {
                    return c.json({
                        error: 'Idempotency key was reused with a different request payload',
                        code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
                        correlation_id: correlationId,
                    }, 409)
                }

                if (isExpiredIso(existingRow.expires_at)) {
                    return c.json({
                        error: 'Idempotency key is expired. Generate a new key and retry.',
                        code: 'IDEMPOTENCY_KEY_EXPIRED',
                        correlation_id: correlationId,
                    }, 409)
                }

                if (existingRow.status === 'completed' && existingRow.stripe_checkout_session_id) {
                    const cachedUrl = existingRow.stripe_checkout_session_url
                    if (cachedUrl) {
                        return c.json({
                            url: cachedUrl,
                            session_id: existingRow.stripe_checkout_session_id,
                            destination: 'checkout',
                            idempotent_replay: true,
                        }, 200)
                    }

                    const existingSession = await stripe.checkout.sessions.retrieve(existingRow.stripe_checkout_session_id)
                    if (!existingSession.url) {
                        throw new Error(`Stripe checkout session ${existingRow.stripe_checkout_session_id} is unavailable`)
                    }

                    await supabase
                        .from('stripe_checkout_idempotency')
                        .update({ stripe_checkout_session_url: existingSession.url })
                        .eq('workspace_id', workspaceId)
                        .eq('idempotency_key', clientIdempotencyKey)

                    return c.json({
                        url: existingSession.url,
                        session_id: existingSession.id,
                        destination: 'checkout',
                        idempotent_replay: true,
                    }, 200)
                }

                if (existingRow.status === 'in_progress') {
                    return c.json({
                        error: 'Checkout creation is already in progress for this idempotency key',
                        code: 'CHECKOUT_IN_PROGRESS',
                        correlation_id: correlationId,
                    }, 409)
                }

                return null
            }

            let existing = await getCheckoutIdempotencyRow(c.env, workspaceId, clientIdempotencyKey)
            let insertedFreshIdempotencyRow = false

            const existingResponse = await resolveExistingIdempotencyRow(existing)
            if (existingResponse) return existingResponse

            if (!existing) {
                const { error: insertIdempotencyError } = await supabase
                    .from('stripe_checkout_idempotency')
                    .insert({
                        workspace_id: workspaceId,
                        idempotency_key: clientIdempotencyKey,
                        plan_variant_id: variant.id,
                        request_fingerprint: requestFingerprint,
                        stripe_idempotency_key: stripeIdempotencyKey,
                        status: 'in_progress',
                        expires_at: new Date(Date.now() + CHECKOUT_IDEMPOTENCY_TTL_MS).toISOString(),
                    })

                if (insertIdempotencyError && insertIdempotencyError.code !== '23505') {
                    throw new Error(`Failed to create checkout idempotency row: ${insertIdempotencyError.message}`)
                }

                if (insertIdempotencyError?.code === '23505') {
                    existing = await getCheckoutIdempotencyRow(c.env, workspaceId, clientIdempotencyKey)
                    const racedExistingResponse = await resolveExistingIdempotencyRow(existing)
                    if (racedExistingResponse) return racedExistingResponse
                    if (!existing) {
                        throw new Error('Checkout idempotency row conflicted but could not be reloaded')
                    }
                } else {
                    insertedFreshIdempotencyRow = true
                }
            }

            if (!insertedFreshIdempotencyRow) {
                const nowIso = new Date().toISOString()
                const { data: transitionedRow, error: markInProgressError } = await supabase
                    .from('stripe_checkout_idempotency')
                    .update({
                        status: 'in_progress',
                        last_error: null,
                    })
                    .eq('workspace_id', workspaceId)
                    .eq('idempotency_key', clientIdempotencyKey)
                    .eq('request_fingerprint', requestFingerprint)
                    .neq('status', 'completed')
                    .gt('expires_at', nowIso)
                    .select('status')
                    .maybeSingle()

                if (markInProgressError) {
                    throw new Error(`Failed to mark checkout idempotency row in_progress: ${markInProgressError.message}`)
                }

                if (!transitionedRow) {
                    existing = await getCheckoutIdempotencyRow(c.env, workspaceId, clientIdempotencyKey)
                    const postTransitionResponse = await resolveExistingIdempotencyRow(existing)
                    if (postTransitionResponse) return postTransitionResponse
                    throw new Error('Checkout idempotency row could not be transitioned to in_progress')
                }
            }

            const session = await withRecoveredWorkspaceStripeCustomer(
                c.env,
                workspaceId,
                c.get('user'),
                stripe,
                {
                    requestScopeKey: clientIdempotencyKey,
                    correlationId,
                    operation: 'checkout-session',
                },
                async (customerId) => stripe.checkout.sessions.create({
                    mode: 'subscription',
                    customer: customerId,
                    line_items: [{ price: stripePriceId, quantity: 1 }],
                    allow_promotion_codes: true,
                    automatic_tax: { enabled: false },
                    success_url: c.env.CHECKOUT_SUCCESS_URL,
                    cancel_url: c.env.CHECKOUT_CANCEL_URL,
                    metadata: {
                        workspace_id: workspaceId,
                        plan_variant_id: variant.id,
                        requested_by_user_id: c.get('user')?.id ?? '',
                    },
                    client_reference_id: workspaceId,
                    subscription_data: {
                        metadata: {
                            workspace_id: workspaceId,
                            plan_variant_id: variant.id,
                            requested_by_user_id: c.get('user')?.id ?? '',
                        },
                        trial_period_days: variant.trial_period_days > 0 ? variant.trial_period_days : undefined,
                    },
                }, {
                    idempotencyKey: stripeIdempotencyKey,
                })
            )

            if (!session.url) throw new Error('Stripe did not return a checkout URL')

            const { error: completeRowError } = await supabase
                .from('stripe_checkout_idempotency')
                .update({
                    status: 'completed',
                    stripe_checkout_session_id: session.id,
                    stripe_checkout_session_url: session.url,
                    last_error: null,
                })
                .eq('workspace_id', workspaceId)
                .eq('idempotency_key', clientIdempotencyKey)

            if (completeRowError) {
                throw new Error(`Failed to persist checkout completion in idempotency ledger: ${completeRowError.message}`)
            }

            return c.json({
                url: session.url,
                session_id: session.id,
                destination: 'checkout',
            }, 200)
        } catch (error) {
            logStripe('error', 'Stripe checkout session error', {
                correlation_id: correlationId,
                workspace_id: workspaceId,
                error: truncateError(error),
            })

            const supabase = getServiceSupabase(c.env)
            await supabase
                .from('stripe_checkout_idempotency')
                .update({
                    status: 'failed',
                    last_error: truncateError(error),
                })
                .eq('workspace_id', workspaceId)
                .eq('idempotency_key', clientIdempotencyKey)
                .neq('status', 'completed')

            if (error instanceof CatalogOutOfSyncError) {
                return c.json({
                    error: 'Catalog is out of sync with Stripe',
                    code: error.code,
                    correlation_id: correlationId,
                }, 409)
            }

            return c.json(toCheckoutErrorResponse(correlationId), 500)
        }
    }
)

stripeRouter.post(
    '/workspaces/:workspaceId/portal-session',
    requireAuth,
    zValidator('param', workspaceParamSchema),
    async (c) => {
        const { workspaceId } = c.req.valid('param')
        const correlationId = createCorrelationId()
        const roleCheck = await enforceWorkspaceRole(c, workspaceId, 'admin')
        if (!roleCheck.ok) return roleCheck.response

        const missingEnv = getMissingBillingEnv(c.env, [
            'SUPABASE_URL',
            'SUPABASE_SERVICE_ROLE_KEY',
            'STRIPE_SECRET_KEY',
            'BILLING_PORTAL_RETURN_URL',
        ])
        if (missingEnv.length > 0) {
            return c.json({
                error: 'Stripe billing configuration is incomplete',
                code: 'BILLING_CONFIG_MISSING',
                missing: missingEnv,
            }, 500)
        }

        try {
            const stripe = getStripeClient(c.env)
            const session = await withRecoveredWorkspaceStripeCustomer(
                c.env,
                workspaceId,
                c.get('user'),
                stripe,
                {
                    requestScopeKey: correlationId,
                    correlationId,
                    operation: 'portal-session',
                },
                async (customerId) => stripe.billingPortal.sessions.create({
                    customer: customerId,
                    return_url: c.env.BILLING_PORTAL_RETURN_URL,
                    configuration: c.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID || undefined,
                })
            )

            return c.json({ url: session.url }, 200)
        } catch (error) {
            logStripe('error', 'Stripe portal session error', {
                correlation_id: correlationId,
                workspace_id: workspaceId,
                error: truncateError(error),
            })
            return c.json(toPortalErrorResponse(correlationId), 500)
        }
    }
)

stripeRouter.post('/catalog/sync', async (c) => {
    const adminToken = c.req.header('x-internal-admin-token') ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    if (!ensureInternalCatalogSyncAuth(c.env, adminToken)) {
        return c.json({ error: 'Forbidden' }, 403)
    }

    try {
        const result = await syncStripeCatalog(c.env, { forced: true, reason: 'manual-api' })
        return c.json({
            success: true,
            result,
        }, 200)
    } catch (error) {
        const correlationId = createCorrelationId()
        logStripe('error', 'Manual catalog sync failed', {
            correlation_id: correlationId,
            error: truncateError(error),
        })
        return c.json({
            error: 'Failed to sync Stripe catalog',
            code: 'CATALOG_SYNC_FAILED',
            correlation_id: correlationId,
        }, 500)
    }
})

stripeRouter.post('/webhook', async (c) => {
    const signature = c.req.header('stripe-signature')
    if (!signature) return c.json({ error: 'Missing Stripe signature' }, 400)

    const maxBytes = parseWebhookMaxBodyBytes(c.env)
    const contentLengthHeader = c.req.header('content-length')
    const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : null
    if (contentLength !== null && Number.isFinite(contentLength) && contentLength > maxBytes) {
        logStripe('warn', 'Webhook rejected due to content-length guard', {
            content_length: contentLength,
            max_bytes: maxBytes,
        })
        return c.json({ error: 'Webhook payload too large' }, 413)
    }

    const payload = await c.req.text()
    const payloadBytes = new TextEncoder().encode(payload).byteLength
    if (payloadBytes > maxBytes) {
        logStripe('warn', 'Webhook rejected due to payload byte-size guard', {
            payload_bytes: payloadBytes,
            max_bytes: maxBytes,
        })
        return c.json({ error: 'Webhook payload too large' }, 413)
    }

    const stripe = getStripeClient(c.env)
    let event: Stripe.Event

    try {
        event = await stripe.webhooks.constructEventAsync(
            payload,
            signature,
            c.env.STRIPE_WEBHOOK_SIGNING_SECRET,
            undefined,
            stripeCryptoProvider
        )
    } catch (error) {
        logStripe('warn', 'Stripe signature verification failed', {
            error: truncateError(error),
        })
        return c.json({ error: 'Invalid Stripe signature' }, 400)
    }

    const supabase = getServiceSupabase(c.env)
    const { error: insertError } = await supabase
        .from('stripe_webhook_events')
        .insert({
            event_id: event.id,
            event_type: event.type,
            payload: event,
            status: 'pending',
            attempts: 0,
            next_attempt_at: null,
        })

    if (insertError?.code === '23505') {
        return c.json({ received: true, duplicate: true }, 200)
    }

    if (insertError) {
        logStripe('error', 'Stripe webhook insert failed', {
            event_id: event.id,
            event_type: event.type,
            error: insertError.message,
        })
        return c.json({ error: 'Failed to persist webhook event' }, 500)
    }

    c.executionCtx.waitUntil(processWebhookEventById(c.env, event.id))
    return c.json({ received: true }, 200)
})

export default stripeRouter
