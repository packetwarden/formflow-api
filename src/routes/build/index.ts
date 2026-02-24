import { Hono } from 'hono'
import type { Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import type { Env, Variables } from '../../types'
import { requireAuth } from '../../middlewares/auth'
import { buildWriteRateLimit } from '../../middlewares/rate-limit'
import { getSupabaseClient } from '../../db/supabase'
import {
    buildParamSchema,
    createFormSchema,
    publishFormSchema,
    updateDraftSchema,
    updateFormMetaSchema,
    workspaceParamSchema,
} from '../../utils/validation'

const buildRouter = new Hono<{ Bindings: Env; Variables: Variables }>()
type BuildContext = Context<{ Bindings: Env; Variables: Variables }>

type WorkspaceRole = 'owner' | 'admin' | 'editor' | 'viewer'
type RequiredWorkspaceRole = 'member' | 'editor' | 'admin'

type EntitlementRow = {
    feature_key: string
    is_enabled: boolean
    limit_value: number | null
}

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
    'success_message',
    'redirect_url',
].join(', ')

const formDetailSelect = `${formSummarySelect}, schema`

buildRouter.use('*', requireAuth)
buildRouter.use('*', buildWriteRateLimit)

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

const resolveWorkspaceRole = async (c: BuildContext, workspaceId: string) => {
    const user = c.get('user')

    if (!user?.id) {
        return { ok: false as const, response: c.json({ error: 'Unauthorized' }, 401) }
    }

    const supabase = getScopedSupabaseClient(c)

    const { data: workspace, error: workspaceError } = await supabase
        .from('workspaces')
        .select('id, owner_id')
        .eq('id', workspaceId)
        .is('deleted_at', null)
        .maybeSingle()

    if (workspaceError) {
        console.error('Build workspace role check error:', workspaceError)
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
        console.error('Build workspace membership check error:', memberError)
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

const hasRequiredWorkspaceRole = (role: WorkspaceRole, required: RequiredWorkspaceRole) => {
    if (required === 'member') return true
    if (required === 'editor') return role === 'owner' || role === 'admin' || role === 'editor'
    return role === 'owner' || role === 'admin'
}

const enforceWorkspaceRole = async (
    c: BuildContext,
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

const normalizeSlugBase = (title: string) => {
    const asciiTitle = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')

    let slug = asciiTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')

    if (!slug) slug = 'form'

    slug = slug.slice(0, 80).replace(/-+$/g, '')

    if (slug.length < 2) {
        slug = `${slug}form`.slice(0, 80)
    }

    slug = slug.replace(/^-+|-+$/g, '')
    if (!slug) slug = 'form'
    if (slug.length < 2) slug = 'fo'

    return slug
}

const buildSlugWithSuffix = (baseSlug: string, suffix: string) => {
    const maxBaseLength = Math.max(2, 80 - suffix.length - 1)
    let trimmedBase = baseSlug.slice(0, maxBaseLength).replace(/-+$/g, '')

    if (trimmedBase.length < 2) {
        trimmedBase = 'form'.slice(0, maxBaseLength)
        if (trimmedBase.length < 2) trimmedBase = 'fo'
    }

    return `${trimmedBase}-${suffix}`
}

const randomSlugSuffix = () => crypto.randomUUID().replace(/-/g, '').slice(0, 6)

const checkCreateFormEntitlement = async (c: BuildContext, workspaceId: string) => {
    const supabase = getScopedSupabaseClient(c)

    const { data: entitlementData, error: entitlementError } = await supabase.rpc(
        'get_workspace_entitlements',
        {
            p_workspace_id: workspaceId,
        }
    )

    if (entitlementError) {
        console.error('Build create entitlement fetch error:', entitlementError)
        return { ok: false as const, response: c.json({ error: 'Failed to check workspace entitlements' }, 500) }
    }

    const maxFormsEntitlement = (entitlementData as EntitlementRow[] | null)?.find(
        (entry) => entry.feature_key === 'max_forms'
    )

    if (!maxFormsEntitlement || !maxFormsEntitlement.is_enabled) {
        return {
            ok: false as const,
            response: c.json({
                error: 'Feature disabled for current plan',
                code: 'PLAN_FEATURE_DISABLED',
                feature: 'max_forms',
                current: null,
                allowed: maxFormsEntitlement?.limit_value ?? null,
                upgrade_url: '/pricing',
            }, 403),
        }
    }

    if (maxFormsEntitlement.limit_value === null || maxFormsEntitlement.limit_value < 0) {
        return { ok: true as const }
    }

    const { count, error: countError } = await supabase
        .from('forms')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .is('deleted_at', null)

    if (countError) {
        console.error('Build create form count error:', countError)
        return { ok: false as const, response: c.json({ error: 'Failed to validate form limit' }, 500) }
    }

    const currentCount = count ?? 0
    if (currentCount >= maxFormsEntitlement.limit_value) {
        return {
            ok: false as const,
            response: c.json({
                error: 'Form limit reached',
                code: 'PLAN_LIMIT_EXCEEDED',
                feature: 'max_forms',
                current: currentCount,
                allowed: maxFormsEntitlement.limit_value,
                upgrade_url: '/pricing',
            }, 403),
        }
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
 * POST /api/v1/build/:workspaceId/forms
 * Creates a form with server-managed slug generation.
 */
buildRouter.post(
    '/:workspaceId/forms',
    zValidator('param', workspaceParamSchema),
    zValidator('json', createFormSchema),
    async (c) => {
        const { workspaceId } = c.req.valid('param')
        const {
            title,
            description,
            schema,
            max_submissions,
            accept_submissions,
            success_message,
            redirect_url,
        } = c.req.valid('json')

        const workspaceRole = await enforceWorkspaceRole(c, workspaceId, 'editor')
        if (!workspaceRole.ok) return workspaceRole.response

        const entitlement = await checkCreateFormEntitlement(c, workspaceId)
        if (!entitlement.ok) return entitlement.response

        const supabase = getScopedSupabaseClient(c)
        const baseSlug = normalizeSlugBase(title)
        const maxSlugAttempts = 12

        for (let attempt = 0; attempt < maxSlugAttempts; attempt++) {
            const slug = attempt === 0 ? baseSlug : buildSlugWithSuffix(baseSlug, randomSlugSuffix())

            const createPayload: Record<string, unknown> = {
                workspace_id: workspaceId,
                title,
                slug,
            }

            if (description !== undefined) createPayload.description = description
            if (schema !== undefined) createPayload.schema = schema
            if (max_submissions !== undefined) createPayload.max_submissions = max_submissions
            if (accept_submissions !== undefined) createPayload.accept_submissions = accept_submissions
            if (success_message !== undefined) createPayload.success_message = success_message
            if (redirect_url !== undefined) createPayload.redirect_url = redirect_url

            const { data: createdForm, error: createError } = await supabase
                .from('forms')
                .insert(createPayload)
                .select(formDetailSelect)
                .maybeSingle()

            if (!createError && createdForm) {
                return c.json({ form: createdForm }, 201)
            }

            if (createError?.code === '23505') {
                continue
            }

            console.error('Build create form error:', createError)
            return c.json({ error: 'Failed to create form' }, 500)
        }

        return c.json({ error: 'Failed to generate unique form slug' }, 500)
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
 * PATCH /api/v1/build/:workspaceId/forms/:formId
 * Updates non-schema metadata with strict optimistic locking.
 */
buildRouter.patch(
    '/:workspaceId/forms/:formId',
    zValidator('param', buildParamSchema),
    zValidator('json', updateFormMetaSchema),
    async (c) => {
        const { workspaceId, formId } = c.req.valid('param')
        const {
            version,
            title,
            description,
            max_submissions,
            accept_submissions,
            success_message,
            redirect_url,
        } = c.req.valid('json')

        const workspaceRole = await enforceWorkspaceRole(c, workspaceId, 'editor')
        if (!workspaceRole.ok) return workspaceRole.response

        const updates: Record<string, unknown> = {
            version: version + 1,
        }

        if (title !== undefined) updates.title = title
        if (description !== undefined) updates.description = description
        if (max_submissions !== undefined) updates.max_submissions = max_submissions
        if (accept_submissions !== undefined) updates.accept_submissions = accept_submissions
        if (success_message !== undefined) updates.success_message = success_message
        if (redirect_url !== undefined) updates.redirect_url = redirect_url

        const supabase = getScopedSupabaseClient(c)

        const { data: updatedForm, error: updateError } = await supabase
            .from('forms')
            .update(updates)
            .eq('id', formId)
            .eq('workspace_id', workspaceId)
            .eq('version', version)
            .is('deleted_at', null)
            .select(formDetailSelect)
            .maybeSingle()

        if (updateError) {
            console.error('Build form metadata update error:', updateError)
            return c.json({ error: 'Failed to update form metadata' }, 500)
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
            console.error('Build form metadata stale-check error:', checkError)
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

        const workspaceRole = await enforceWorkspaceRole(c, workspaceId, 'editor')
        if (!workspaceRole.ok) return workspaceRole.response

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

/**
 * DELETE /api/v1/build/:workspaceId/forms/:formId
 * Soft deletes a form and marks status as archived.
 */
buildRouter.delete(
    '/:workspaceId/forms/:formId',
    zValidator('param', buildParamSchema),
    async (c) => {
        const { workspaceId, formId } = c.req.valid('param')

        const workspaceRole = await enforceWorkspaceRole(c, workspaceId, 'admin')
        if (!workspaceRole.ok) return workspaceRole.response

        const supabase = getScopedSupabaseClient(c)
        const deletedAt = new Date().toISOString()

        const { data: deletedForm, error: deleteError } = await supabase
            .from('forms')
            .update({
                deleted_at: deletedAt,
                status: 'archived',
            })
            .eq('id', formId)
            .eq('workspace_id', workspaceId)
            .is('deleted_at', null)
            .select('id, deleted_at')
            .maybeSingle()

        if (deleteError) {
            console.error('Build form delete error:', deleteError)
            return c.json({ error: 'Failed to delete form' }, 500)
        }

        if (!deletedForm) {
            return c.json({ error: 'Form not found' }, 404)
        }

        return c.json({
            form_id: deletedForm.id,
            deleted_at: deletedForm.deleted_at,
        }, 200)
    }
)

export default buildRouter
