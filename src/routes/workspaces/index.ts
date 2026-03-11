import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import type { Env, Variables } from '../../types'
import { requireAuth } from '../../middlewares/auth'
import { buildWriteRateLimit } from '../../middlewares/rate-limit'
import {
    getAuthScopedSupabaseClient,
    loadWorkspaceOverview,
    loadWorkspaceSettingsDocument,
    mergeWorkspaceSettings,
    parseWorkspaceSettings,
} from '../../utils/workspace-access'
import { updateWorkspaceSettingsSchema, workspaceParamSchema } from '../../utils/validation'

const workspacesRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

workspacesRouter.use('*', requireAuth)
workspacesRouter.use('*', buildWriteRateLimit)

workspacesRouter.get(
    '/:workspaceId/overview',
    zValidator('param', workspaceParamSchema),
    async (c) => {
        const { workspaceId } = c.req.valid('param')
        const overview = await loadWorkspaceOverview(c, workspaceId)
        if (!overview.ok) return overview.response

        return c.json(overview.overview, 200)
    }
)

workspacesRouter.get(
    '/:workspaceId/settings',
    zValidator('param', workspaceParamSchema),
    async (c) => {
        const { workspaceId } = c.req.valid('param')
        const settings = await loadWorkspaceSettingsDocument(c, workspaceId)
        if (!settings.ok) return settings.response

        return c.json(settings.settings, 200)
    }
)

workspacesRouter.patch(
    '/:workspaceId/settings',
    zValidator('param', workspaceParamSchema),
    zValidator('json', updateWorkspaceSettingsSchema),
    async (c) => {
        const { workspaceId } = c.req.valid('param')
        const { version, name, description, logo_url, settings: patchSettings } = c.req.valid('json')

        const settingsDocument = await loadWorkspaceSettingsDocument(c, workspaceId)
        if (!settingsDocument.ok) return settingsDocument.response

        const currentDocument = settingsDocument.settings
        const nextSettings = mergeWorkspaceSettings(currentDocument.settings, patchSettings)
        const parsedNextSettings = parseWorkspaceSettings(nextSettings)
        if (!parsedNextSettings.ok) {
            return c.json({
                error: 'Invalid workspace settings payload',
                issues: parsedNextSettings.error.issues.map((issue) => ({
                    path: issue.path.join('.'),
                    message: issue.message,
                })),
            }, 400)
        }

        const updates: Record<string, unknown> = {
            version: version + 1,
        }

        if (name !== undefined) updates.name = name
        if (description !== undefined) updates.description = description
        if (logo_url !== undefined) updates.logo_url = logo_url
        if (patchSettings !== undefined) updates.settings = parsedNextSettings.settings

        const supabase = getAuthScopedSupabaseClient(c)
        const { data: updatedWorkspace, error: updateError } = await supabase
            .from('workspaces')
            .update(updates)
            .eq('id', workspaceId)
            .eq('version', version)
            .is('deleted_at', null)
            .select('id')
            .maybeSingle()

        if (updateError) {
            console.error('Workspace settings update error:', updateError)
            return c.json({ error: 'Failed to update workspace settings' }, 500)
        }

        if (updatedWorkspace) {
            const refreshedSettings = await loadWorkspaceSettingsDocument(c, workspaceId)
            if (!refreshedSettings.ok) return refreshedSettings.response
            return c.json(refreshedSettings.settings, 200)
        }

        const { data: existingWorkspace, error: checkError } = await supabase
            .from('workspaces')
            .select('id, version')
            .eq('id', workspaceId)
            .is('deleted_at', null)
            .maybeSingle<{ id: string; version: number }>()

        if (checkError) {
            console.error('Workspace settings stale-check error:', checkError)
            return c.json({ error: 'Failed to verify workspace state' }, 500)
        }

        if (!existingWorkspace) {
            return c.json({ error: 'Workspace not found' }, 404)
        }

        return c.json({
            error: 'Version conflict',
            current_version: existingWorkspace.version,
        }, 409)
    }
)

export default workspacesRouter
