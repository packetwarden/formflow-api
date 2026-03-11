import type { Context } from 'hono'
import { getSupabaseClient } from '../db/supabase'
import type {
    AuthBootstrapResponse,
    AuthBootstrapUser,
    AuthBootstrapWorkspace,
    Env,
    Variables,
    WorkspaceMembershipSummary,
    WorkspaceOverviewResponse,
    WorkspaceOwnerSummary,
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

type OwnerProfileRow = WorkspaceOwnerSummary

const normalizeWorkspaceRole = (role: string): WorkspaceRole | null => {
    if (role === 'owner' || role === 'admin' || role === 'editor' || role === 'viewer') {
        return role
    }

    return null
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
