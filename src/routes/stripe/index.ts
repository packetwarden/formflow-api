import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import Stripe from 'stripe'
import type { Env, Variables } from '../../types'
import { getServiceRoleSupabaseClient } from '../../db/supabase'
import { requireAuth } from '../../middlewares/auth'
import { workspaceParamSchema, stripeCheckoutSessionSchema } from '../../utils/validation'
import { enforceWorkspaceRole } from '../../utils/workspace-access'

const stripeRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

const STRIPE_API_VERSION = '2026-01-28.clover' as Stripe.LatestApiVersion
const WEBHOOK_RETRY_CRON = '*/5 * * * *'
const GRACE_DOWNGRADE_CRON = '0 * * * *'
const ACTIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due', 'unpaid', 'paused'] as const
const MAX_WEBHOOK_ATTEMPTS = 8
const WEBHOOK_RETRY_BATCH_SIZE = 25
const FREE_PLAN_SLUG = 'free'

type MappedSubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused'
type PlanVariantRow = {
    id: string
    plan_id: string
    stripe_price_id: string | null
    trial_period_days: number
}
type ExistingSubscriptionRow = {
    id: string
    workspace_id: string
    plan_id: string
    plan_variant_id: string
}
type WebhookEventRow = {
    event_id: string
    payload: unknown
    status: 'pending' | 'failed' | 'processing' | 'completed'
    attempts: number
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

const parseGraceDays = (env: Env) => {
    const parsed = Number.parseInt(env.BILLING_GRACE_DAYS ?? '', 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 7
}

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

const toIsoFromUnix = (timestamp: number | null | undefined) =>
    timestamp ? new Date(timestamp * 1000).toISOString() : null

const truncateError = (value: unknown, maxLength = 1000) => {
    const text = value instanceof Error
        ? value.message
        : typeof value === 'string'
            ? value
            : JSON.stringify(value)
    return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text
}

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

const refreshWorkspacePlanCache = async (env: Env, workspaceId: string) => {
    const supabase = getServiceSupabase(env)
    const { data: activeRows, error: activeError } = await supabase
        .from('subscriptions')
        .select('plans(slug)')
        .eq('workspace_id', workspaceId)
        .in('status', [...ACTIVE_SUBSCRIPTION_STATUSES])
        .order('created_at', { ascending: false })
        .limit(1)

    if (activeError) throw new Error(`Failed to resolve active plan: ${activeError.message}`)

    const plans = activeRows?.[0]?.plans as { slug: string } | { slug: string }[] | null | undefined
    const nextPlanSlug = Array.isArray(plans) ? plans[0]?.slug : plans?.slug

    const { error: workspaceError } = await supabase
        .from('workspaces')
        .update({ plan: nextPlanSlug ?? FREE_PLAN_SLUG })
        .eq('id', workspaceId)

    if (workspaceError) throw new Error(`Failed to update workspace plan cache: ${workspaceError.message}`)
}

const fetchFreePlanVariant = async (env: Env) => {
    const supabase = getServiceSupabase(env)

    const { data: plan, error: planError } = await supabase
        .from('plans')
        .select('id')
        .eq('slug', FREE_PLAN_SLUG)
        .eq('is_active', true)
        .maybeSingle()
    if (planError || !plan) throw new Error(`Failed to load free plan: ${planError?.message ?? 'missing plan'}`)

    const { data: variant, error: variantError } = await supabase
        .from('plan_variants')
        .select('id')
        .eq('plan_id', plan.id)
        .eq('interval', 'monthly')
        .eq('is_active', true)
        .maybeSingle()
    if (variantError || !variant) throw new Error(`Failed to load free plan variant: ${variantError?.message ?? 'missing variant'}`)

    return { planId: plan.id, variantId: variant.id }
}

const ensureFreeSubscriptionForWorkspace = async (env: Env, workspaceId: string) => {
    const supabase = getServiceSupabase(env)
    const { data: activeRows, error: activeError } = await supabase
        .from('subscriptions')
        .select('id')
        .eq('workspace_id', workspaceId)
        .in('status', [...ACTIVE_SUBSCRIPTION_STATUSES])
        .limit(1)

    if (activeError) throw new Error(`Failed to check active subscriptions: ${activeError.message}`)
    if ((activeRows ?? []).length > 0) return

    const { planId, variantId } = await fetchFreePlanVariant(env)
    const now = new Date()
    const hundredYears = new Date(now.getTime() + (100 * 365 * 24 * 60 * 60 * 1000))

    const { error: insertError } = await supabase
        .from('subscriptions')
        .insert({
            workspace_id: workspaceId,
            plan_id: planId,
            plan_variant_id: variantId,
            status: 'active',
            current_period_start: now.toISOString(),
            current_period_end: hundredYears.toISOString(),
            cancel_at_period_end: false,
            metadata: { source: 'grace-period-downgrade' },
        })

    if (insertError && insertError.code !== '23505') {
        throw new Error(`Failed to create free subscription: ${insertError.message}`)
    }
}

const findActivePaidSubscription = async (env: Env, workspaceId: string) => {
    const supabase = getServiceSupabase(env)
    const { data: rows, error } = await supabase
        .from('subscriptions')
        .select('id, stripe_customer_id, plans(slug)')
        .eq('workspace_id', workspaceId)
        .in('status', [...ACTIVE_SUBSCRIPTION_STATUSES])
        .order('created_at', { ascending: false })

    if (error) throw new Error(`Failed to check active subscription: ${error.message}`)

    return (rows ?? []).find((row) => {
        const plans = row.plans as { slug: string } | { slug: string }[] | null
        const slug = Array.isArray(plans) ? plans[0]?.slug : plans?.slug
        return slug !== FREE_PLAN_SLUG
    }) ?? null
}

const resolveCheckoutPlanVariant = async (env: Env, planSlug: string, interval: 'monthly' | 'yearly') => {
    const supabase = getServiceSupabase(env)
    const { data: plan, error: planError } = await supabase
        .from('plans')
        .select('id')
        .eq('slug', planSlug)
        .eq('is_active', true)
        .maybeSingle()
    if (planError || !plan) throw new Error(`Failed to resolve plan: ${planError?.message ?? 'missing plan'}`)

    const { data: variant, error: variantError } = await supabase
        .from('plan_variants')
        .select('id, plan_id, stripe_price_id, trial_period_days')
        .eq('plan_id', plan.id)
        .eq('interval', interval)
        .eq('is_active', true)
        .not('stripe_price_id', 'is', null)
        .maybeSingle()
    if (variantError || !variant) throw new Error(`Failed to resolve plan variant: ${variantError?.message ?? 'missing variant'}`)

    return variant as PlanVariantRow
}

const ensureWorkspaceStripeCustomerId = async (
    env: Env,
    workspaceId: string,
    user: Variables['user'],
    stripe: Stripe
) => {
    const supabase = getServiceSupabase(env)
    const { data: rows, error } = await supabase
        .from('subscriptions')
        .select('stripe_customer_id')
        .eq('workspace_id', workspaceId)
        .not('stripe_customer_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)

    if (error) throw new Error(`Failed to load customer mapping: ${error.message}`)

    const existingId = rows?.[0]?.stripe_customer_id
    if (existingId) return existingId

    const customer = await stripe.customers.create({
        email: user?.email ?? undefined,
        name: typeof user?.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : undefined,
        metadata: { workspace_id: workspaceId },
    })

    const { data: activeRows, error: activeUpdateError } = await supabase
        .from('subscriptions')
        .update({ stripe_customer_id: customer.id })
        .eq('workspace_id', workspaceId)
        .in('status', [...ACTIVE_SUBSCRIPTION_STATUSES])
        .is('stripe_customer_id', null)
        .select('id')

    if (activeUpdateError) throw new Error(`Failed to persist customer mapping: ${activeUpdateError.message}`)
    if ((activeRows ?? []).length > 0) return customer.id

    const { data: fallbackRow, error: fallbackSelectError } = await supabase
        .from('subscriptions')
        .select('id')
        .eq('workspace_id', workspaceId)
        .is('stripe_customer_id', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    if (fallbackSelectError) throw new Error(`Failed to locate fallback subscription for customer mapping: ${fallbackSelectError.message}`)

    if (fallbackRow?.id) {
        const { error: fallbackUpdateError } = await supabase
            .from('subscriptions')
            .update({ stripe_customer_id: customer.id })
            .eq('id', fallbackRow.id)
        if (fallbackUpdateError) throw new Error(`Failed to persist fallback customer mapping: ${fallbackUpdateError.message}`)
        return customer.id
    }

    await ensureFreeSubscriptionForWorkspace(env, workspaceId)
    const { error: freeUpdateError } = await supabase
        .from('subscriptions')
        .update({ stripe_customer_id: customer.id })
        .eq('workspace_id', workspaceId)
        .eq('status', 'active')
        .is('stripe_customer_id', null)

    if (freeUpdateError) throw new Error(`Failed to persist customer mapping after creating free subscription: ${freeUpdateError.message}`)
    return customer.id
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

const resolveWorkspaceIdForSubscription = async (env: Env, subscription: Stripe.Subscription, workspaceHint?: string | null) => {
    if (workspaceHint && isUuid(workspaceHint)) return workspaceHint

    const metadataWorkspace = subscription.metadata?.workspace_id
    if (typeof metadataWorkspace === 'string' && isUuid(metadataWorkspace)) return metadataWorkspace

    const existing = await fetchExistingSubscriptionByStripeId(env, subscription.id)
    if (existing?.workspace_id) return existing.workspace_id

    const customerId = resolveStripeCustomerId(subscription.customer)
    if (!customerId) return null

    const supabase = getServiceSupabase(env)
    const { data: rows, error } = await supabase
        .from('subscriptions')
        .select('workspace_id')
        .eq('stripe_customer_id', customerId)
        .order('created_at', { ascending: false })
        .limit(1)

    if (error) throw new Error(`Failed to resolve workspace from customer: ${error.message}`)
    return rows?.[0]?.workspace_id ?? null
}

const resolvePlanVariantFromSubscription = async (env: Env, subscription: Stripe.Subscription, existing: ExistingSubscriptionRow | null) => {
    const priceId = subscription.items.data[0]?.price?.id ?? null
    if (!priceId) {
        if (!existing) throw new Error('Subscription does not include a Stripe price')
        return { id: existing.plan_variant_id, plan_id: existing.plan_id }
    }

    const supabase = getServiceSupabase(env)
    const { data: variant, error } = await supabase
        .from('plan_variants')
        .select('id, plan_id')
        .eq('stripe_price_id', priceId)
        .eq('is_active', true)
        .maybeSingle()

    if (error || !variant) {
        if (!existing) throw new Error(`Failed to resolve variant for Stripe price "${priceId}"`)
        return { id: existing.plan_variant_id, plan_id: existing.plan_id }
    }

    return variant
}

const upsertWorkspaceSubscriptionState = async (env: Env, workspaceId: string, subscription: Stripe.Subscription) => {
    const supabase = getServiceSupabase(env)
    const existingByStripeId = await fetchExistingSubscriptionByStripeId(env, subscription.id)
    const planVariant = await resolvePlanVariantFromSubscription(env, subscription, existingByStripeId)
    const mappedStatus = mapStripeSubscriptionStatus(subscription.status)
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

    const { data: activeRows, error: activeError } = await supabase
        .from('subscriptions')
        .select('id')
        .eq('workspace_id', workspaceId)
        .in('status', [...ACTIVE_SUBSCRIPTION_STATUSES])
        .order('created_at', { ascending: false })
        .limit(1)
    if (activeError) throw new Error(`Failed to resolve active workspace subscription: ${activeError.message}`)

    const activeRowId = activeRows?.[0]?.id
    if (activeRowId) {
        const { error } = await supabase.from('subscriptions').update(payload).eq('id', activeRowId)
        if (error) throw new Error(`Failed to update active workspace subscription: ${error.message}`)
        return mappedStatus
    }

    const { error: insertError } = await supabase.from('subscriptions').insert(payload)
    if (insertError) throw new Error(`Failed to insert workspace subscription: ${insertError.message}`)
    return mappedStatus
}

const syncSubscriptionFromStripe = async (env: Env, subscription: Stripe.Subscription, workspaceHint?: string | null) => {
    const workspaceId = await resolveWorkspaceIdForSubscription(env, subscription, workspaceHint)
    if (!workspaceId) throw new Error(`Unable to resolve workspace for Stripe subscription "${subscription.id}"`)

    const mappedStatus = await upsertWorkspaceSubscriptionState(env, workspaceId, subscription)
    if (mappedStatus === 'canceled') await ensureFreeSubscriptionForWorkspace(env, workspaceId)
    await refreshWorkspacePlanCache(env, workspaceId)
    return workspaceId
}

const setGracePeriodForSubscription = async (
    env: Env,
    stripeSubscriptionId: string,
    nextStatus: 'past_due' | 'active',
    gracePeriodEnd: string | null
) => {
    const supabase = getServiceSupabase(env)
    const { data: rows, error } = await supabase
        .from('subscriptions')
        .update({ status: nextStatus, grace_period_end: gracePeriodEnd })
        .eq('stripe_subscription_id', stripeSubscriptionId)
        .select('workspace_id')

    if (error) throw new Error(`Failed to update subscription grace period: ${error.message}`)

    const workspaceId = rows?.[0]?.workspace_id
    if (workspaceId) await refreshWorkspacePlanCache(env, workspaceId)
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
        const ref = invoice.parent?.subscription_details?.subscription
        const subscriptionId = typeof ref === 'string' ? ref : ref?.id
        if (!subscriptionId) return

        const subscription = await stripe.subscriptions.retrieve(subscriptionId)
        await syncSubscriptionFromStripe(env, subscription)

        if (event.type === 'invoice.payment_failed') {
            const graceDays = parseGraceDays(env)
            const graceEnd = new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000).toISOString()
            await setGracePeriodForSubscription(env, subscriptionId, 'past_due', graceEnd)
        } else {
            await setGracePeriodForSubscription(env, subscriptionId, 'active', null)
        }
    }
}

const markWebhookEvent = async (env: Env, eventId: string, updates: Record<string, unknown>) => {
    const supabase = getServiceSupabase(env)
    const { error } = await supabase.from('stripe_webhook_events').update(updates).eq('event_id', eventId)
    if (error) console.error(`Failed to update webhook event ${eventId}:`, error)
}

const processNewWebhookEvent = async (env: Env, event: Stripe.Event) => {
    try {
        await markWebhookEvent(env, event.id, { status: 'processing', attempts: 1, last_error: null })
        await processStripeEvent(env, event)
        await markWebhookEvent(env, event.id, {
            status: 'completed',
            processed_at: new Date().toISOString(),
            last_error: null,
        })
    } catch (error) {
        await markWebhookEvent(env, event.id, { status: 'failed', last_error: truncateError(error) })
    }
}

const processStoredWebhookEvent = async (env: Env, row: WebhookEventRow) => {
    const supabase = getServiceSupabase(env)
    const { data: claimRows, error: claimError } = await supabase
        .from('stripe_webhook_events')
        .update({
            status: 'processing',
            attempts: (row.attempts ?? 0) + 1,
            last_error: null,
        })
        .eq('event_id', row.event_id)
        .eq('status', row.status)
        .select('event_id')
        .limit(1)

    if (claimError) throw new Error(`Failed to claim webhook event ${row.event_id}: ${claimError.message}`)
    if (!claimRows || claimRows.length === 0) return

    try {
        await processStripeEvent(env, row.payload as Stripe.Event)
        await markWebhookEvent(env, row.event_id, {
            status: 'completed',
            processed_at: new Date().toISOString(),
            last_error: null,
        })
    } catch (error) {
        await markWebhookEvent(env, row.event_id, { status: 'failed', last_error: truncateError(error) })
    }
}

const retryWebhookEvents = async (env: Env) => {
    const supabase = getServiceSupabase(env)
    const { data: rows, error } = await supabase
        .from('stripe_webhook_events')
        .select('event_id, payload, status, attempts')
        .in('status', ['pending', 'failed'])
        .lt('attempts', MAX_WEBHOOK_ATTEMPTS)
        .order('created_at', { ascending: true })
        .limit(WEBHOOK_RETRY_BATCH_SIZE)

    if (error) throw new Error(`Failed to fetch retryable webhook events: ${error.message}`)

    for (const row of (rows ?? []) as WebhookEventRow[]) {
        if (!row.payload || typeof row.payload !== 'object') {
            await markWebhookEvent(env, row.event_id, { status: 'failed', last_error: 'Stored payload is invalid for replay' })
            continue
        }
        await processStoredWebhookEvent(env, row)
    }
}

const enforceGracePeriodDowngrades = async (env: Env) => {
    const supabase = getServiceSupabase(env)
    const nowIso = new Date().toISOString()

    const { data: rows, error } = await supabase
        .from('subscriptions')
        .select('id, workspace_id')
        .eq('status', 'past_due')
        .not('grace_period_end', 'is', null)
        .lte('grace_period_end', nowIso)
        .limit(WEBHOOK_RETRY_BATCH_SIZE)

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
            console.error(`Failed to mark subscription ${row.id} canceled after grace period:`, markError)
            continue
        }

        try {
            await ensureFreeSubscriptionForWorkspace(env, row.workspace_id)
            await refreshWorkspacePlanCache(env, row.workspace_id)
        } catch (error) {
            console.error(`Failed to enforce grace-period downgrade for workspace ${row.workspace_id}:`, error)
        }
    }
}

export const runStripeScheduled = async (env: Env, cron?: string) => {
    if (cron === WEBHOOK_RETRY_CRON) {
        await retryWebhookEvents(env)
        return
    }

    if (cron === GRACE_DOWNGRADE_CRON) {
        await enforceGracePeriodDowngrades(env)
        return
    }

    await retryWebhookEvents(env)
    await enforceGracePeriodDowngrades(env)
}

stripeRouter.post(
    '/workspaces/:workspaceId/checkout-session',
    requireAuth,
    zValidator('param', workspaceParamSchema),
    zValidator('json', stripeCheckoutSessionSchema),
    async (c) => {
        const { workspaceId } = c.req.valid('param')
        const { plan_slug, interval } = c.req.valid('json')

        const roleCheck = await enforceWorkspaceRole(c, workspaceId, 'admin')
        if (!roleCheck.ok) return roleCheck.response

        if (plan_slug === 'enterprise') {
            return c.json({
                error: 'Enterprise plan is not available via self-serve checkout',
                code: 'CONTACT_SALES_REQUIRED',
                contact_sales_url: c.env.CONTACT_SALES_URL,
            }, 403)
        }

        if (plan_slug === 'free') {
            return c.json({
                error: 'Free plan cannot be purchased through checkout',
                code: 'INVALID_PLAN_FOR_CHECKOUT',
            }, 400)
        }

        try {
            const stripe = getStripeClient(c.env)
            const activePaid = await findActivePaidSubscription(c.env, workspaceId)
            const customerId = activePaid?.stripe_customer_id
                ?? await ensureWorkspaceStripeCustomerId(c.env, workspaceId, c.get('user'), stripe)

            if (activePaid) {
                const portalSession = await stripe.billingPortal.sessions.create({
                    customer: customerId,
                    return_url: c.env.BILLING_PORTAL_RETURN_URL,
                    configuration: c.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID || undefined,
                })

                return c.json({
                    url: portalSession.url,
                    destination: 'portal',
                    reason: 'ALREADY_SUBSCRIBED',
                }, 200)
            }

            const variant = await resolveCheckoutPlanVariant(c.env, plan_slug, interval)
            if (!variant.stripe_price_id) {
                return c.json({ error: 'Plan variant is not configured for Stripe checkout' }, 500)
            }

            const session = await stripe.checkout.sessions.create({
                mode: 'subscription',
                customer: customerId,
                line_items: [{ price: variant.stripe_price_id, quantity: 1 }],
                allow_promotion_codes: true,
                automatic_tax: { enabled: true },
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
            })

            if (!session.url) return c.json({ error: 'Stripe did not return a checkout URL' }, 500)

            return c.json({
                url: session.url,
                session_id: session.id,
                destination: 'checkout',
            }, 200)
        } catch (error) {
            console.error('Stripe checkout session error:', error)
            return c.json({ error: 'Failed to create Stripe checkout session' }, 500)
        }
    }
)

stripeRouter.post(
    '/workspaces/:workspaceId/portal-session',
    requireAuth,
    zValidator('param', workspaceParamSchema),
    async (c) => {
        const { workspaceId } = c.req.valid('param')
        const roleCheck = await enforceWorkspaceRole(c, workspaceId, 'admin')
        if (!roleCheck.ok) return roleCheck.response

        try {
            const stripe = getStripeClient(c.env)
            const customerId = await ensureWorkspaceStripeCustomerId(c.env, workspaceId, c.get('user'), stripe)
            const session = await stripe.billingPortal.sessions.create({
                customer: customerId,
                return_url: c.env.BILLING_PORTAL_RETURN_URL,
                configuration: c.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID || undefined,
            })

            return c.json({ url: session.url }, 200)
        } catch (error) {
            console.error('Stripe portal session error:', error)
            return c.json({ error: 'Failed to create Stripe billing portal session' }, 500)
        }
    }
)

stripeRouter.post('/webhook', async (c) => {
    const signature = c.req.header('stripe-signature')
    if (!signature) return c.json({ error: 'Missing Stripe signature' }, 400)

    const payload = await c.req.text()
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
        console.error('Stripe signature verification failed:', error)
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
        })

    if (insertError?.code === '23505') {
        return c.json({ received: true, duplicate: true }, 200)
    }

    if (insertError) {
        console.error('Stripe webhook insert failed:', insertError)
        return c.json({ error: 'Failed to persist webhook event' }, 500)
    }

    c.executionCtx.waitUntil(processNewWebhookEvent(c.env, event))
    return c.json({ received: true }, 200)
})

export default stripeRouter
