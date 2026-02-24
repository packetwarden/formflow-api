import type { Context } from 'hono'
import { getSupabaseClient } from '../db/supabase'
import type { Env, Variables } from '../types'

export type WorkspaceRole = 'owner' | 'admin' | 'editor' | 'viewer'
export type RequiredWorkspaceRole = 'member' | 'editor' | 'admin'

export type AppContext = Context<{ Bindings: Env; Variables: Variables }>

export const getAuthScopedSupabaseClient = (c: AppContext) => {
    return getSupabaseClient(c.env.SUPABASE_URL, c.env.SUPABASE_ANON_KEY, c.get('accessToken'))
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

    const role = member.role
    if (role === 'owner' || role === 'admin' || role === 'editor' || role === 'viewer') {
        return { ok: true as const, role }
    }

    return { ok: true as const, role: 'viewer' as WorkspaceRole }
}

export const hasRequiredWorkspaceRole = (role: WorkspaceRole, required: RequiredWorkspaceRole) => {
    if (required === 'member') return true
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
