import type { Context } from 'hono'
import { getSupabaseClient } from '../db/supabase'
import type {
    AuthBootstrapResponse,
    AuthBootstrapUser,
    AuthBootstrapWorkspace,
    Env,
    Variables,
    WorkspaceBillingActionSummary,
    WorkspaceBillingCheckoutOption,
    WorkspaceBillingResponse,
    WorkspaceBillingStatus,
    WorkspaceBillingSubscriptionSummary,
    WorkspaceMembershipSummary,
    WorkspaceOverviewResponse,
    WorkspaceOwnerSummary,
    WorkspacePlanSlug,
    WorkspaceRoleSummary,
    WorkspaceSettingsResponse,
    WorkspaceSettingsV1,
} from '../types'
import { workspaceSettingsSchema } from './validation'

export type WorkspaceRole = 'owner' | 'admin' | 'editor' | 'viewer'
export type RequiredWorkspaceRole = 'member' | 'editor' | 'admin' | 'owner'

export type AppContext = Context<{ Bindings: Env; Variables: Variables }>

export const getAuthScopedSupabaseClient = (c: AppContext) => {
    return getSupabaseClient(c.env.SUPABASE_URL, c.env.SUPABASE_ANON_KEY, c.get('accessToken'))
}

type BootstrapProfileRow = AuthBootstrapUser

type BootstrapWorkspaceRow = {
    id: string
    owner_id: string
    name: string
    slug: string
    description: string | null
    logo_url: string | null
    plan: AuthBootstrapWorkspace['plan']
    created_at: string
    updated_at: string
}

type BootstrapMembershipRow = {
    workspace_id: string
    role: string
}

type WorkspaceRecordRow = {
    id: string
    owner_id: string
    slug: string
    name: string
    description: string | null
    logo_url: string | null
    settings: unknown
    plan: AuthBootstrapWorkspace['plan']
    version: number
    created_at: string
    updated_at: string
}

type WorkspaceMemberCountRow = {
    workspace_id: string
}

type WorkspaceBillingPlanRow = {
    slug: string
    name: string
}

type WorkspaceBillingPlanWithSortRow = WorkspaceBillingPlanRow & {
    sort_order: number
}

type WorkspaceBillingVariantRow = {
    interval: string
    amount_cents: number
    currency: string
}

type WorkspaceBillingSubscriptionRow = {
    id: string
    status: string
    stripe_customer_id: string | null
    current_period_start: string
    current_period_end: string
    trial_start: string | null
    trial_end: string | null
    cancel_at_period_end: boolean
    grace_period_end: string | null
    created_at: string
    last_stripe_event_created_at: string | null
    plan: WorkspaceBillingPlanRow | WorkspaceBillingPlanRow[] | null
    variant: WorkspaceBillingVariantRow | WorkspaceBillingVariantRow[] | null
    downgrade_plan: Pick<WorkspaceBillingPlanRow, 'slug'> | Pick<WorkspaceBillingPlanRow, 'slug'>[] | null
}

type WorkspaceBillingCheckoutVariantRow = {
    interval: string
    amount_cents: number
    currency: string
    trial_period_days: number
    stripe_price_id: string | null
    plan: WorkspaceBillingPlanWithSortRow | WorkspaceBillingPlanWithSortRow[] | null
}

type NormalizedWorkspaceBillingSubscription = WorkspaceBillingSubscriptionSummary & {
    created_at: string
    last_stripe_event_created_at: string | null
    stripe_customer_id: string | null
}

type OwnerProfileRow = WorkspaceOwnerSummary

const ENTITLED_BILLING_STATUSES = new Set<WorkspaceBillingStatus>(['active', 'trialing', 'past_due'])

const normalizeWorkspaceRole = (role: string): WorkspaceRole | null => {
    if (role === 'owner' || role === 'admin' || role === 'editor' || role === 'viewer') {
        return role
    }

    return null
}

const normalizeWorkspacePlanSlug = (plan: string): WorkspacePlanSlug | null => {
    if (plan === 'free' || plan === 'pro' || plan === 'business' || plan === 'enterprise') {
        return plan
    }

    return null
}

const normalizeWorkspaceBillingStatus = (status: string): WorkspaceBillingStatus | null => {
    if (
        status === 'trialing'
        || status === 'active'
        || status === 'past_due'
        || status === 'canceled'
        || status === 'unpaid'
        || status === 'paused'
        || status === 'incomplete'
        || status === 'incomplete_expired'
    ) {
        return status
    }

    return null
}

const normalizeWorkspaceBillingInterval = (interval: string): 'monthly' | 'yearly' | null => {
    if (interval === 'monthly' || interval === 'yearly') {
        return interval
    }

    return null
}

const unwrapJoinedRow = <T>(value: T | T[] | null | undefined): T | null => {
    if (Array.isArray(value)) return value[0] ?? null
    return value ?? null
}

const sortBootstrapWorkspaces = (left: AuthBootstrapWorkspace, right: AuthBootstrapWorkspace) => {
    if (left.is_personal !== right.is_personal) {
        return left.is_personal ? -1 : 1
    }

    if (left.created_at !== right.created_at) {
        return left.created_at.localeCompare(right.created_at)
    }

    return left.id.localeCompare(right.id)
}

const compareIsoDesc = (left: string, right: string) => right.localeCompare(left)

const compareNullableIsoDesc = (left: string | null, right: string | null) => {
    if (left === right) return 0
    if (!left) return 1
    if (!right) return -1
    return right.localeCompare(left)
}

const compareWorkspaceBillingSubscriptionRows = (
    left: NormalizedWorkspaceBillingSubscription,
    right: NormalizedWorkspaceBillingSubscription
) => {
    const byEventCreatedAt = compareNullableIsoDesc(
        left.last_stripe_event_created_at,
        right.last_stripe_event_created_at
    )
    if (byEventCreatedAt !== 0) return byEventCreatedAt

    const byCreatedAt = compareIsoDesc(left.created_at, right.created_at)
    if (byCreatedAt !== 0) return byCreatedAt

    return right.id.localeCompare(left.id)
}

const mergeDefinedValues = <T extends object>(current: T | undefined, patch: T | undefined): T | undefined => {
    if (!current && !patch) return undefined
    return {
        ...(current ?? {}),
        ...(patch ?? {}),
    } as T
}

export const parseWorkspaceSettings = (settings: unknown) => {
    const parseResult = workspaceSettingsSchema.safeParse(settings ?? {})
    if (!parseResult.success) {
        return {
            ok: false as const,
            error: parseResult.error,
        }
    }

    return {
        ok: true as const,
        settings: parseResult.data as WorkspaceSettingsV1,
    }
}

export const mergeWorkspaceSettings = (
    current: WorkspaceSettingsV1,
    patch: WorkspaceSettingsV1 | undefined
): WorkspaceSettingsV1 => {
    if (!patch) return current

    return {
        about: mergeDefinedValues(current.about, patch.about),
        branding: mergeDefinedValues(current.branding, patch.branding),
        preferences: mergeDefinedValues(current.preferences, patch.preferences),
    }
}

const toWorkspaceMembershipSummary = (
    role: WorkspaceRoleSummary
): WorkspaceMembershipSummary => ({
    role,
    is_owner: role === 'owner',
    can_edit_settings: role === 'owner',
})

const normalizeWorkspaceBillingSubscription = (
    row: WorkspaceBillingSubscriptionRow
): NormalizedWorkspaceBillingSubscription | null => {
    const status = normalizeWorkspaceBillingStatus(row.status)
    const plan = unwrapJoinedRow(row.plan)
    const variant = unwrapJoinedRow(row.variant)
    const downgradePlan = unwrapJoinedRow(row.downgrade_plan)
    const planSlug = plan ? normalizeWorkspacePlanSlug(plan.slug) : null
    const interval = variant ? normalizeWorkspaceBillingInterval(variant.interval) : null
    const downgradePlanSlug = downgradePlan ? normalizeWorkspacePlanSlug(downgradePlan.slug) : null

    if (!status || !plan || !variant || !planSlug || !interval) {
        return null
    }

    return {
        id: row.id,
        status,
        is_entitled: ENTITLED_BILLING_STATUSES.has(status),
        plan_slug: planSlug,
        plan_name: plan.name,
        interval,
        amount_cents: variant.amount_cents,
        currency: variant.currency,
        current_period_start: row.current_period_start,
        current_period_end: row.current_period_end,
        trial_start: row.trial_start,
        trial_end: row.trial_end,
        cancel_at_period_end: row.cancel_at_period_end,
        grace_period_end: row.grace_period_end,
        downgrade_to_plan_slug: downgradePlanSlug,
        created_at: row.created_at,
        last_stripe_event_created_at: row.last_stripe_event_created_at,
        stripe_customer_id: row.stripe_customer_id,
    }
}

const checkoutIntervalOrder = (interval: 'monthly' | 'yearly') => (interval === 'monthly' ? 0 : 1)

const loadWorkspaceRecord = async (c: AppContext, workspaceId: string) => {
    const supabase = getAuthScopedSupabaseClient(c)

    const { data, error } = await supabase
        .from('workspaces')
        .select('id, owner_id, slug, name, description, logo_url, settings, plan, version, created_at, updated_at')
        .eq('id', workspaceId)
        .is('deleted_at', null)
        .maybeSingle<WorkspaceRecordRow>()

    if (error) {
        console.error('Workspace load error:', error)
        return { ok: false as const, response: c.json({ error: 'Failed to load workspace' }, 500) }
    }

    if (!data) {
        return { ok: false as const, response: c.json({ error: 'Workspace not found' }, 404) }
    }

    return { ok: true as const, workspace: data }
}

export const loadWorkspaceOverview = async (c: AppContext, workspaceId: string) => {
    const roleResult = await resolveWorkspaceRole(c, workspaceId)
    if (!roleResult.ok) return roleResult

    const workspaceResult = await loadWorkspaceRecord(c, workspaceId)
    if (!workspaceResult.ok) return workspaceResult

    const settingsResult = parseWorkspaceSettings(workspaceResult.workspace.settings)
    if (!settingsResult.ok) {
        console.error('Workspace overview settings parse error:', {
            workspace_id: workspaceId,
            issues: settingsResult.error.issues,
        })
        return { ok: false as const, response: c.json({ error: 'Failed to load workspace overview' }, 500) }
    }

    const supabase = getAuthScopedSupabaseClient(c)
    const [
        { data: owner, error: ownerError },
        memberCountResult,
    ] = await Promise.all([
        supabase
            .from('profiles')
            .select('id, full_name, avatar_url')
            .eq('id', workspaceResult.workspace.owner_id)
            .is('deleted_at', null)
            .maybeSingle<OwnerProfileRow>(),
        supabase
            .from('workspace_members')
            .select('workspace_id', { count: 'exact', head: true })
            .eq('workspace_id', workspaceId)
            .returns<WorkspaceMemberCountRow[]>(),
    ])

    if (ownerError || memberCountResult.error) {
        console.error('Workspace overview related load error:', {
            workspace_id: workspaceId,
            owner_error: ownerError?.message ?? null,
            member_count_error: memberCountResult.error?.message ?? null,
        })
        return { ok: false as const, response: c.json({ error: 'Failed to load workspace overview' }, 500) }
    }

    if (!owner) {
        console.error('Workspace overview missing owner profile', {
            workspace_id: workspaceId,
            owner_id: workspaceResult.workspace.owner_id,
        })
        return { ok: false as const, response: c.json({ error: 'Failed to load workspace overview' }, 500) }
    }

    const response: WorkspaceOverviewResponse = {
        workspace: {
            id: workspaceResult.workspace.id,
            slug: workspaceResult.workspace.slug,
            name: workspaceResult.workspace.name,
            description: workspaceResult.workspace.description,
            logo_url: workspaceResult.workspace.logo_url,
            plan: workspaceResult.workspace.plan,
            created_at: workspaceResult.workspace.created_at,
            updated_at: workspaceResult.workspace.updated_at,
        },
        owner,
        membership: toWorkspaceMembershipSummary(roleResult.role),
        summary: {
            member_count: memberCountResult.count ?? 0,
            settings: settingsResult.settings,
        },
    }

    return { ok: true as const, overview: response }
}

export const loadWorkspaceSettingsDocument = async (c: AppContext, workspaceId: string) => {
    const ownerCheck = await enforceWorkspaceRole(c, workspaceId, 'owner')
    if (!ownerCheck.ok) return ownerCheck

    const workspaceResult = await loadWorkspaceRecord(c, workspaceId)
    if (!workspaceResult.ok) return workspaceResult

    const settingsResult = parseWorkspaceSettings(workspaceResult.workspace.settings)
    if (!settingsResult.ok) {
        console.error('Workspace settings parse error:', {
            workspace_id: workspaceId,
            issues: settingsResult.error.issues,
        })
        return { ok: false as const, response: c.json({ error: 'Failed to load workspace settings' }, 500) }
    }

    const response: WorkspaceSettingsResponse = {
        workspace: {
            id: workspaceResult.workspace.id,
            slug: workspaceResult.workspace.slug,
            name: workspaceResult.workspace.name,
            description: workspaceResult.workspace.description,
            logo_url: workspaceResult.workspace.logo_url,
            version: workspaceResult.workspace.version,
            updated_at: workspaceResult.workspace.updated_at,
        },
        settings: settingsResult.settings,
    }

    return { ok: true as const, settings: response }
}

export const loadWorkspaceBillingSummary = async (c: AppContext, workspaceId: string) => {
    const roleResult = await resolveWorkspaceRole(c, workspaceId)
    if (!roleResult.ok) return roleResult

    const supabase = getAuthScopedSupabaseClient(c)
    const { data: subscriptionRows, error: subscriptionError } = await supabase
        .from('subscriptions')
        .select(`
            id,
            status,
            stripe_customer_id,
            current_period_start,
            current_period_end,
            trial_start,
            trial_end,
            cancel_at_period_end,
            grace_period_end,
            created_at,
            last_stripe_event_created_at,
            plan:plans!subscriptions_plan_id_fkey(slug, name),
            variant:plan_variants!subscriptions_plan_variant_id_fkey(interval, amount_cents, currency),
            downgrade_plan:plans!subscriptions_downgrade_to_plan_id_fkey(slug)
        `)
        .eq('workspace_id', workspaceId)
        .returns<WorkspaceBillingSubscriptionRow[]>()

    if (subscriptionError) {
        console.error('Workspace billing subscription load error:', {
            workspace_id: workspaceId,
            error: subscriptionError,
        })
        return { ok: false as const, response: c.json({ error: 'Failed to load workspace billing' }, 500) }
    }

    const normalizedSubscriptions: NormalizedWorkspaceBillingSubscription[] = []
    for (const row of subscriptionRows ?? []) {
        const normalized = normalizeWorkspaceBillingSubscription(row)
        if (!normalized) {
            console.error('Workspace billing subscription row normalization failed:', {
                workspace_id: workspaceId,
                subscription_id: row.id,
            })
            return { ok: false as const, response: c.json({ error: 'Failed to load workspace billing' }, 500) }
        }

        normalizedSubscriptions.push(normalized)
    }

    const sortedSubscriptions = [...normalizedSubscriptions].sort(compareWorkspaceBillingSubscriptionRows)
    const entitledSubscription = sortedSubscriptions.find((row) => row.is_entitled) ?? null
    const relevantSubscription = entitledSubscription ?? sortedSubscriptions[0] ?? null
    const effectivePlan = entitledSubscription?.plan_slug ?? 'free'
    const historyAvailable = normalizedSubscriptions.some((row) => row.stripe_customer_id !== null)
    const canManageBilling = hasRequiredWorkspaceRole(roleResult.role, 'admin')

    let checkoutOptions: WorkspaceBillingCheckoutOption[] = []

    if (canManageBilling && effectivePlan === 'free') {
        const { data: checkoutVariantRows, error: checkoutVariantError } = await supabase
            .from('plan_variants')
            .select(`
                interval,
                amount_cents,
                currency,
                trial_period_days,
                stripe_price_id,
                plan:plans!plan_variants_plan_id_fkey(slug, name, sort_order)
            `)
            .eq('is_active', true)
            .not('stripe_price_id', 'is', null)
            .returns<WorkspaceBillingCheckoutVariantRow[]>()

        if (checkoutVariantError) {
            console.error('Workspace billing checkout options load error:', {
                workspace_id: workspaceId,
                error: checkoutVariantError,
            })
            return { ok: false as const, response: c.json({ error: 'Failed to load workspace billing' }, 500) }
        }

        const sortableCheckoutOptions: Array<WorkspaceBillingCheckoutOption & { sort_order: number }> = []

        for (const row of checkoutVariantRows ?? []) {
            const plan = unwrapJoinedRow(row.plan)
            const planSlug = plan ? normalizeWorkspacePlanSlug(plan.slug) : null
            const interval = normalizeWorkspaceBillingInterval(row.interval)

            if (planSlug !== 'pro' && planSlug !== 'business') {
                continue
            }

            if (!plan || !interval || !row.stripe_price_id) {
                console.error('Workspace billing checkout option normalization failed:', {
                    workspace_id: workspaceId,
                    plan_slug: plan?.slug ?? null,
                    interval: row.interval,
                })
                return { ok: false as const, response: c.json({ error: 'Failed to load workspace billing' }, 500) }
            }

            sortableCheckoutOptions.push({
                plan_slug: planSlug,
                plan_name: plan.name,
                interval,
                amount_cents: row.amount_cents,
                currency: row.currency,
                trial_period_days: row.trial_period_days,
                sort_order: plan.sort_order,
            })
        }

        checkoutOptions = sortableCheckoutOptions
            .sort((left, right) => {
                if (left.sort_order !== right.sort_order) return left.sort_order - right.sort_order
                return checkoutIntervalOrder(left.interval) - checkoutIntervalOrder(right.interval)
            })
            .map(({ sort_order: _sortOrder, ...option }) => option)
    }

    const actions: WorkspaceBillingActionSummary = {
        can_manage_billing: canManageBilling,
        portal_session: canManageBilling && historyAvailable
            ? {
                method: 'POST',
                path: `/api/v1/stripe/workspaces/${workspaceId}/portal-session`,
            }
            : null,
        checkout_session: canManageBilling && effectivePlan === 'free' && checkoutOptions.length > 0
            ? {
                method: 'POST',
                path: `/api/v1/stripe/workspaces/${workspaceId}/checkout-session`,
                requires_idempotency_key: true,
                available_plans: checkoutOptions,
            }
            : null,
    }

    const response: WorkspaceBillingResponse = {
        workspace: {
            id: workspaceId,
            role: roleResult.role,
        },
        billing: {
            effective_plan: effectivePlan,
            subscription: relevantSubscription
                ? {
                    id: relevantSubscription.id,
                    status: relevantSubscription.status,
                    is_entitled: relevantSubscription.is_entitled,
                    plan_slug: relevantSubscription.plan_slug,
                    plan_name: relevantSubscription.plan_name,
                    interval: relevantSubscription.interval,
                    amount_cents: relevantSubscription.amount_cents,
                    currency: relevantSubscription.currency,
                    current_period_start: relevantSubscription.current_period_start,
                    current_period_end: relevantSubscription.current_period_end,
                    trial_start: relevantSubscription.trial_start,
                    trial_end: relevantSubscription.trial_end,
                    cancel_at_period_end: relevantSubscription.cancel_at_period_end,
                    grace_period_end: relevantSubscription.grace_period_end,
                    downgrade_to_plan_slug: relevantSubscription.downgrade_to_plan_slug,
                }
                : null,
            history: {
                provider: 'stripe_portal',
                available: historyAvailable,
            },
            actions,
        },
    }

    return { ok: true as const, billing: response }
}

export const loadWorkspaceBootstrap = async (c: AppContext) => {
    const user = c.get('user')

    if (!user?.id) {
        return { ok: false as const, response: c.json({ error: 'Unauthorized' }, 401) }
    }

    const supabase = getAuthScopedSupabaseClient(c)

    const [
        { data: profile, error: profileError },
        { data: workspaces, error: workspaceError },
    ] = await Promise.all([
        supabase
            .from('profiles')
            .select('id, email, full_name, avatar_url')
            .eq('id', user.id)
            .is('deleted_at', null)
            .maybeSingle<BootstrapProfileRow>(),
        supabase
            .from('workspaces')
            .select('id, owner_id, name, slug, description, logo_url, plan, created_at, updated_at')
            .is('deleted_at', null)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .returns<BootstrapWorkspaceRow[]>(),
    ])

    if (profileError || workspaceError) {
        console.error('Workspace bootstrap load failed', {
            user_id: user.id,
            profile_error: profileError?.message ?? null,
            workspace_error: workspaceError?.message ?? null,
        })
        return {
            ok: false as const,
            response: c.json({ error: 'Failed to load workspace bootstrap', code: 'BOOTSTRAP_LOAD_FAILED' }, 500),
        }
    }

    if (!profile) {
        console.error('Workspace bootstrap missing profile', { user_id: user.id })
        return {
            ok: false as const,
            response: c.json({ error: 'Failed to load workspace bootstrap', code: 'BOOTSTRAP_LOAD_FAILED' }, 500),
        }
    }

    const visibleWorkspaces = workspaces ?? []
    if (visibleWorkspaces.length === 0) {
        console.warn('Workspace bootstrap found no visible workspaces', { user_id: user.id })
        return {
            ok: false as const,
            response: c.json({ error: 'No visible workspaces found', code: 'WORKSPACE_BOOTSTRAP_EMPTY' }, 409),
        }
    }

    const workspaceIds = visibleWorkspaces.map((workspace) => workspace.id)
    const { data: memberships, error: membershipError } = await supabase
        .from('workspace_members')
        .select('workspace_id, role')
        .eq('user_id', user.id)
        .in('workspace_id', workspaceIds)
        .returns<BootstrapMembershipRow[]>()

    if (membershipError) {
        console.error('Workspace bootstrap membership load failed', {
            user_id: user.id,
            workspace_ids: workspaceIds,
            membership_error: membershipError.message,
        })
        return {
            ok: false as const,
            response: c.json({ error: 'Failed to load workspace bootstrap', code: 'BOOTSTRAP_LOAD_FAILED' }, 500),
        }
    }

    const membershipRoleByWorkspaceId = new Map<string, WorkspaceRole>()
    for (const membership of memberships ?? []) {
        const normalizedRole = normalizeWorkspaceRole(membership.role)
        if (!normalizedRole) {
            console.error('Workspace bootstrap encountered invalid membership role', {
                user_id: user.id,
                workspace_id: membership.workspace_id,
                role: membership.role,
            })
            return {
                ok: false as const,
                response: c.json({ error: 'Failed to load workspace bootstrap', code: 'BOOTSTRAP_LOAD_FAILED' }, 500),
            }
        }

        membershipRoleByWorkspaceId.set(membership.workspace_id, normalizedRole)
    }

    const hydratedWorkspaces: AuthBootstrapWorkspace[] = []

    for (const workspace of visibleWorkspaces) {
        const isPersonal = workspace.owner_id === user.id
        const resolvedRole = isPersonal ? 'owner' : membershipRoleByWorkspaceId.get(workspace.id)

        if (!resolvedRole) {
            console.error('Workspace bootstrap missing membership for visible workspace', {
                user_id: user.id,
                workspace_id: workspace.id,
                owner_id: workspace.owner_id,
            })
            return {
                ok: false as const,
                response: c.json({ error: 'Failed to load workspace bootstrap', code: 'BOOTSTRAP_LOAD_FAILED' }, 500),
            }
        }

        hydratedWorkspaces.push({
            id: workspace.id,
            name: workspace.name,
            slug: workspace.slug,
            description: workspace.description,
            logo_url: workspace.logo_url,
            plan: workspace.plan,
            role: resolvedRole,
            is_personal: isPersonal,
            created_at: workspace.created_at,
            updated_at: workspace.updated_at,
        })
    }

    hydratedWorkspaces.sort(sortBootstrapWorkspaces)

    const response: AuthBootstrapResponse = {
        user: profile,
        current_workspace_id: hydratedWorkspaces[0].id,
        workspaces: hydratedWorkspaces,
    }

    return { ok: true as const, data: response }
}

export const checkWorkspaceAccess = async (c: AppContext, workspaceId: string) => {
    const supabase = getAuthScopedSupabaseClient(c)

    const { data: workspace, error } = await supabase
        .from('workspaces')
        .select('id')
        .eq('id', workspaceId)
        .is('deleted_at', null)
        .maybeSingle()

    if (error) {
        console.error('Workspace access check error:', error)
        return { ok: false as const, response: c.json({ error: 'Failed to verify workspace access' }, 500) }
    }

    if (!workspace) {
        return { ok: false as const, response: c.json({ error: 'Workspace not found' }, 404) }
    }

    return { ok: true as const }
}

export const resolveWorkspaceRole = async (c: AppContext, workspaceId: string) => {
    const user = c.get('user')

    if (!user?.id) {
        return { ok: false as const, response: c.json({ error: 'Unauthorized' }, 401) }
    }

    const supabase = getAuthScopedSupabaseClient(c)

    const { data: workspace, error: workspaceError } = await supabase
        .from('workspaces')
        .select('id, owner_id')
        .eq('id', workspaceId)
        .is('deleted_at', null)
        .maybeSingle()

    if (workspaceError) {
        console.error('Workspace role check error:', workspaceError)
        return { ok: false as const, response: c.json({ error: 'Failed to verify workspace access' }, 500) }
    }

    if (!workspace) {
        return { ok: false as const, response: c.json({ error: 'Workspace not found' }, 404) }
    }

    if (workspace.owner_id === user.id) {
        return { ok: true as const, role: 'owner' as WorkspaceRole }
    }

    const { data: member, error: memberError } = await supabase
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', workspaceId)
        .eq('user_id', user.id)
        .maybeSingle()

    if (memberError) {
        console.error('Workspace membership check error:', memberError)
        return { ok: false as const, response: c.json({ error: 'Failed to verify workspace role' }, 500) }
    }

    if (!member) {
        return { ok: false as const, response: c.json({ error: 'Forbidden' }, 403) }
    }

    const role = normalizeWorkspaceRole(member.role)
    if (role) {
        return { ok: true as const, role }
    }

    return { ok: true as const, role: 'viewer' as WorkspaceRole }
}

export const hasRequiredWorkspaceRole = (role: WorkspaceRole, required: RequiredWorkspaceRole) => {
    if (required === 'member') return true
    if (required === 'owner') return role === 'owner'
    if (required === 'editor') return role === 'owner' || role === 'admin' || role === 'editor'
    return role === 'owner' || role === 'admin'
}

export const enforceWorkspaceRole = async (
    c: AppContext,
    workspaceId: string,
    requiredRole: RequiredWorkspaceRole
) => {
    const resolvedRole = await resolveWorkspaceRole(c, workspaceId)
    if (!resolvedRole.ok) return resolvedRole

    if (!hasRequiredWorkspaceRole(resolvedRole.role, requiredRole)) {
        return { ok: false as const, response: c.json({ error: 'Forbidden' }, 403) }
    }

    return { ok: true as const, role: resolvedRole.role }
}
