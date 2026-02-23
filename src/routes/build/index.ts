import { Hono } from 'hono'
import type { Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import type { Env, Variables } from '../../types'
import { requireAuth } from '../../middlewares/auth'
import { getSupabaseClient } from '../../db/supabase'
import {
    buildParamSchema,
    publishFormSchema,
    updateDraftSchema,
    workspaceParamSchema,
} from '../../utils/validation'

const buildRouter = new Hono<{ Bindings: Env; Variables: Variables }>()
type BuildContext = Context<{ Bindings: Env; Variables: Variables }>

const formSummarySelect = [
    'id',
    'workspace_id',
    'title',
    'description',
    'slug',
    'status',
    'version',
    'published_at',
    'created_at',
    'updated_at',
    'current_submissions',
    'max_submissions',
    'accept_submissions',
].join(', ')

const formDetailSelect = `${formSummarySelect}, schema`

buildRouter.use('*', requireAuth)

const getScopedSupabaseClient = (c: BuildContext) => {
    return getSupabaseClient(
        c.env.SUPABASE_URL,
        c.env.SUPABASE_ANON_KEY,
        c.get('accessToken')
    )
}

const checkWorkspaceAccess = async (c: BuildContext, workspaceId: string) => {
    const supabase = getScopedSupabaseClient(c)

    const { data: workspace, error } = await supabase
        .from('workspaces')
        .select('id')
        .eq('id', workspaceId)
        .is('deleted_at', null)
        .maybeSingle()

    if (error) {
        console.error('Build workspace access check error:', error)
        return { ok: false as const, response: c.json({ error: 'Failed to verify workspace access' }, 500) }
    }

    if (!workspace) {
        return { ok: false as const, response: c.json({ error: 'Workspace not found' }, 404) }
    }

    return { ok: true as const }
}

/**
 * GET /api/v1/build/:workspaceId/forms
 * Returns forms for the workspace with summary metadata.
 */
buildRouter.get(
    '/:workspaceId/forms',
    zValidator('param', workspaceParamSchema),
    async (c) => {
        const { workspaceId } = c.req.valid('param')
        const access = await checkWorkspaceAccess(c, workspaceId)
        if (!access.ok) return access.response

        const supabase = getScopedSupabaseClient(c)
        const { data: forms, error } = await supabase
            .from('forms')
            .select(formSummarySelect)
            .eq('workspace_id', workspaceId)
            .is('deleted_at', null)
            .order('updated_at', { ascending: false })

        if (error) {
            console.error('Build forms list error:', error)
            return c.json({ error: 'Failed to fetch forms' }, 500)
        }

        return c.json({ forms: forms ?? [] }, 200)
    }
)

/**
 * GET /api/v1/build/:workspaceId/forms/:formId
 * Returns a single form including draft schema and version for builder hydration.
 */
buildRouter.get(
    '/:workspaceId/forms/:formId',
    zValidator('param', buildParamSchema),
    async (c) => {
        const { workspaceId, formId } = c.req.valid('param')
        const supabase = getScopedSupabaseClient(c)

        const { data: form, error } = await supabase
            .from('forms')
            .select(formDetailSelect)
            .eq('id', formId)
            .eq('workspace_id', workspaceId)
            .is('deleted_at', null)
            .maybeSingle()

        if (error) {
            console.error('Build form fetch error:', error)
            return c.json({ error: 'Failed to fetch form' }, 500)
        }

        if (!form) {
            return c.json({ error: 'Form not found' }, 404)
        }

        return c.json({ form }, 200)
    }
)

/**
 * PUT /api/v1/build/:workspaceId/forms/:formId
 * Saves draft schema with strict optimistic locking.
 */
buildRouter.put(
    '/:workspaceId/forms/:formId',
    zValidator('param', buildParamSchema),
    zValidator('json', updateDraftSchema),
    async (c) => {
        const { workspaceId, formId } = c.req.valid('param')
        const { schema, version } = c.req.valid('json')
        const supabase = getScopedSupabaseClient(c)

        const { data: updatedForm, error: updateError } = await supabase
            .from('forms')
            .update({
                schema,
                version: version + 1,
            })
            .eq('id', formId)
            .eq('workspace_id', workspaceId)
            .eq('version', version)
            .is('deleted_at', null)
            .select(formDetailSelect)
            .maybeSingle()

        if (updateError) {
            console.error('Build form update error:', updateError)
            return c.json({ error: 'Failed to update form' }, 500)
        }

        if (updatedForm) {
            return c.json({ form: updatedForm }, 200)
        }

        const { data: existingForm, error: checkError } = await supabase
            .from('forms')
            .select('id, version')
            .eq('id', formId)
            .eq('workspace_id', workspaceId)
            .is('deleted_at', null)
            .maybeSingle()

        if (checkError) {
            console.error('Build form stale-check error:', checkError)
            return c.json({ error: 'Failed to verify form state' }, 500)
        }

        if (!existingForm) {
            return c.json({ error: 'Form not found' }, 404)
        }

        return c.json({
            error: 'Version conflict',
            current_version: existingForm.version,
        }, 409)
    }
)

/**
 * POST /api/v1/build/:workspaceId/forms/:formId/publish
 * Publishes the current draft by calling the publish_form RPC.
 */
buildRouter.post(
    '/:workspaceId/forms/:formId/publish',
    zValidator('param', buildParamSchema),
    zValidator('json', publishFormSchema),
    async (c) => {
        const { workspaceId, formId } = c.req.valid('param')
        const { description } = c.req.valid('json')
        const user = c.get('user')

        if (!user?.id) {
            return c.json({ error: 'Unauthorized' }, 401)
        }

        const supabase = getScopedSupabaseClient(c)

        const { data: form, error: formCheckError } = await supabase
            .from('forms')
            .select('id')
            .eq('id', formId)
            .eq('workspace_id', workspaceId)
            .is('deleted_at', null)
            .maybeSingle()

        if (formCheckError) {
            console.error('Build publish pre-check error:', formCheckError)
            return c.json({ error: 'Failed to validate form access' }, 500)
        }

        if (!form) {
            return c.json({ error: 'Form not found' }, 404)
        }

        const { data: publishedVersion, error: publishError } = await supabase.rpc('publish_form', {
            p_form_id: formId,
            p_published_by: user.id,
            p_description: description ?? null,
        })

        if (publishError) {
            if (publishError.code === '42501') {
                return c.json({ error: 'Forbidden' }, 403)
            }

            console.error('Build publish error:', publishError)
            return c.json({ error: 'Failed to publish form' }, 500)
        }

        return c.json({ version: publishedVersion }, 200)
    }
)

export default buildRouter
