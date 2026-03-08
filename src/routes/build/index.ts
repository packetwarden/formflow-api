import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { hash } from 'bcryptjs'
import type { Env, Variables } from '../../types'
import { getServiceRoleSupabaseClient } from '../../db/supabase'
import { requireAuth } from '../../middlewares/auth'
import { buildWriteRateLimit } from '../../middlewares/rate-limit'
import {
    AppContext,
    checkWorkspaceAccess,
    enforceWorkspaceRole,
    getAuthScopedSupabaseClient,
} from '../../utils/workspace-access'
import { parsePublishedContract } from '../../utils/form-contract'
import {
    buildParamSchema,
    buildSubmissionListQuerySchema,
    buildSubmissionParamSchema,
    createFormSchema,
    publishFormSchema,
    updateDraftSchema,
    updateFormAccessSchema,
    updateFormMetaSchema,
    workspaceParamSchema,
} from '../../utils/validation'

const buildRouter = new Hono<{ Bindings: Env; Variables: Variables }>()
type BuildContext = AppContext

type EntitlementRow = {
    feature_key: string
    is_enabled: boolean
    limit_value: number | null
}

type SubmissionListRow = Record<string, unknown> & {
    id: string
    created_at: string
}

type FormRow = Record<string, unknown> & {
    password_hash?: string | null
    captcha_enabled?: boolean | null
    captcha_provider?: string | null
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
    'captcha_enabled',
    'captcha_provider',
].join(', ')

const formSummaryWithAccessSelect = `${formSummarySelect}, password_hash`
const formDetailSelect = `${formSummarySelect}, schema`
const formDetailWithAccessSelect = `${formDetailSelect}, password_hash`

const submissionListSelect = [
    'id',
    'form_id',
    'form_version_id',
    'status',
    'data',
    'respondent_id',
    'started_at',
    'completed_at',
    'completion_time_ms',
    'created_at',
    'updated_at',
].join(', ')

const submissionDetailSelect = [
    submissionListSelect,
    'ip_address',
    'user_agent',
    'referrer',
    'geo_country',
    'geo_city',
    'spam_score',
].join(', ')

buildRouter.use('*', requireAuth)
buildRouter.use('*', buildWriteRateLimit)

const getScopedSupabaseClient = getAuthScopedSupabaseClient
const getServiceRoleSupabase = (c: BuildContext) =>
    getServiceRoleSupabaseClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY)

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

const ensureVisibleForm = async (c: BuildContext, workspaceId: string, formId: string) => {
    const supabase = getScopedSupabaseClient(c)

    const { data: form, error } = await supabase
        .from('forms')
        .select('id')
        .eq('id', formId)
        .eq('workspace_id', workspaceId)
        .is('deleted_at', null)
        .maybeSingle()

    if (error) {
        console.error('Build form visibility check error:', error)
        return { ok: false as const, response: c.json({ error: 'Failed to validate form access' }, 500) }
    }

    if (!form) {
        return { ok: false as const, response: c.json({ error: 'Form not found' }, 404) }
    }

    return { ok: true as const }
}

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

const toUnsupportedSchemaResponse = (c: BuildContext, issues: string[]) => {
    return c.json({
        error: 'Unsupported form schema',
        code: 'UNSUPPORTED_FORM_SCHEMA',
        issues,
    }, 422)
}

const validateDraftContract = (schema: unknown) => {
    const contractResult = parsePublishedContract(schema)
    return contractResult.ok ? null : contractResult.issues
}

const getPasswordHashCost = (env: Env) => {
    const parsed = Number(env.FORM_PASSWORD_BCRYPT_COST ?? 12)
    if (!Number.isFinite(parsed)) return 12
    return Math.min(14, Math.max(10, Math.floor(parsed)))
}

const sanitizeFormResponse = <T extends FormRow>(form: T) => {
    const { password_hash, ...safeForm } = form
    const captchaEnabled = form.captcha_enabled ?? false

    return {
        ...safeForm,
        captcha_enabled: captchaEnabled,
        captcha_provider: captchaEnabled ? form.captcha_provider ?? 'turnstile' : null,
        password_protected: Boolean(password_hash),
    }
}

const fetchFormForResponse = async (c: BuildContext, workspaceId: string, formId: string) => {
    const supabase = getServiceRoleSupabase(c)
    const { data: form, error } = await supabase
        .from('forms')
        .select(formDetailWithAccessSelect)
        .eq('id', formId)
        .eq('workspace_id', workspaceId)
        .is('deleted_at', null)
        .maybeSingle()

    if (error) {
        console.error('Build form response fetch error:', error)
        return { ok: false as const, response: c.json({ error: 'Failed to fetch form' }, 500) }
    }

    if (!form) {
        return { ok: false as const, response: c.json({ error: 'Form not found' }, 404) }
    }

    return { ok: true as const, form: sanitizeFormResponse(form as unknown as FormRow) }
}

const checkPasswordEntitlement = async (c: BuildContext, workspaceId: string) => {
    const supabase = getScopedSupabaseClient(c)

    const { data: entitlementData, error: entitlementError } = await supabase.rpc(
        'get_workspace_entitlements',
        {
            p_workspace_id: workspaceId,
        }
    )

    if (entitlementError) {
        console.error('Build password entitlement fetch error:', entitlementError)
        return { ok: false as const, response: c.json({ error: 'Failed to check workspace entitlements' }, 500) }
    }

    const passwordEntitlement = (entitlementData as EntitlementRow[] | null)?.find(
        (entry) => entry.feature_key === 'form_password'
    )

    if (passwordEntitlement?.is_enabled) {
        return { ok: true as const }
    }

    return {
        ok: false as const,
        response: c.json({
            error: 'Feature disabled for current plan',
            code: 'PLAN_FEATURE_DISABLED',
            feature: 'form_password',
            current: null,
            allowed: passwordEntitlement?.limit_value ?? null,
            upgrade_url: '/pricing',
        }, 403),
    }
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

        const supabase = getServiceRoleSupabase(c)
        const { data: forms, error } = await supabase
            .from('forms')
            .select(formSummaryWithAccessSelect)
            .eq('workspace_id', workspaceId)
            .is('deleted_at', null)
            .order('updated_at', { ascending: false })

        if (error) {
            console.error('Build forms list error:', error)
            return c.json({ error: 'Failed to fetch forms' }, 500)
        }

        return c.json({
            forms: (forms ?? []).map((form) => sanitizeFormResponse(form as unknown as FormRow)),
        }, 200)
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

        if (schema !== undefined) {
            const schemaIssues = validateDraftContract(schema)
            if (schemaIssues) return toUnsupportedSchemaResponse(c, schemaIssues)
        }

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
                .select('id')
                .maybeSingle()

            if (!createError && createdForm) {
                const formResponse = await fetchFormForResponse(c, workspaceId, createdForm.id)
                if (!formResponse.ok) return formResponse.response
                return c.json({ form: formResponse.form }, 201)
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
        const access = await checkWorkspaceAccess(c, workspaceId)
        if (!access.ok) return access.response

        const supabase = getServiceRoleSupabase(c)
        const { data: form, error } = await supabase
            .from('forms')
            .select(formDetailWithAccessSelect)
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

        return c.json({ form: sanitizeFormResponse(form as unknown as FormRow) }, 200)
    }
)

/**
 * GET /api/v1/build/:workspaceId/forms/:formId/submissions
 * Returns a bounded page of submissions for a single form.
 */
buildRouter.get(
    '/:workspaceId/forms/:formId/submissions',
    zValidator('param', buildParamSchema),
    zValidator('query', buildSubmissionListQuerySchema),
    async (c) => {
        const { workspaceId, formId } = c.req.valid('param')
        const { limit, cursor_created_at, cursor_submission_id } = c.req.valid('query')

        const access = await checkWorkspaceAccess(c, workspaceId)
        if (!access.ok) return access.response

        const formAccess = await ensureVisibleForm(c, workspaceId, formId)
        if (!formAccess.ok) return formAccess.response

        const supabase = getScopedSupabaseClient(c)
        let query = supabase
            .from('form_submissions')
            .select(submissionListSelect)
            .eq('form_id', formId)
            .is('deleted_at', null)
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .limit(limit + 1)

        if (cursor_created_at && cursor_submission_id) {
            query = query.or(
                `created_at.lt.${cursor_created_at},and(created_at.eq.${cursor_created_at},id.lt.${cursor_submission_id})`
            )
        }

        const { data: submissions, error } = await query

        if (error) {
            console.error('Build form submissions list error:', error)
            return c.json({ error: 'Failed to fetch form submissions' }, 500)
        }

        const page = (submissions ?? []) as unknown as SubmissionListRow[]
        const hasMore = page.length > limit
        const boundedPage = hasMore ? page.slice(0, limit) : page
        const lastSubmission = boundedPage[boundedPage.length - 1]

        return c.json({
            submissions: boundedPage,
            next_cursor: hasMore && lastSubmission
                ? {
                    created_at: lastSubmission.created_at,
                    submission_id: lastSubmission.id,
                }
                : null,
        }, 200)
    }
)

/**
 * GET /api/v1/build/:workspaceId/forms/:formId/submissions/:submissionId
 * Returns one submission for a single form without exposing internal idempotency fields.
 */
buildRouter.get(
    '/:workspaceId/forms/:formId/submissions/:submissionId',
    zValidator('param', buildSubmissionParamSchema),
    async (c) => {
        const { workspaceId, formId, submissionId } = c.req.valid('param')

        const access = await checkWorkspaceAccess(c, workspaceId)
        if (!access.ok) return access.response

        const formAccess = await ensureVisibleForm(c, workspaceId, formId)
        if (!formAccess.ok) return formAccess.response

        const supabase = getScopedSupabaseClient(c)
        const { data: submission, error } = await supabase
            .from('form_submissions')
            .select(submissionDetailSelect)
            .eq('id', submissionId)
            .eq('form_id', formId)
            .is('deleted_at', null)
            .maybeSingle()

        if (error) {
            console.error('Build form submission fetch error:', error)
            return c.json({ error: 'Failed to fetch form submission' }, 500)
        }

        if (!submission) {
            return c.json({ error: 'Submission not found' }, 404)
        }

        return c.json({ submission }, 200)
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
            .select('id')
            .maybeSingle()

        if (updateError) {
            console.error('Build form metadata update error:', updateError)
            return c.json({ error: 'Failed to update form metadata' }, 500)
        }

        if (updatedForm) {
            const formResponse = await fetchFormForResponse(c, workspaceId, formId)
            if (!formResponse.ok) return formResponse.response
            return c.json({ form: formResponse.form }, 200)
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

        const schemaIssues = validateDraftContract(schema)
        if (schemaIssues) return toUnsupportedSchemaResponse(c, schemaIssues)

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
            .select('id')
            .maybeSingle()

        if (updateError) {
            console.error('Build form update error:', updateError)
            return c.json({ error: 'Failed to update form' }, 500)
        }

        if (updatedForm) {
            const formResponse = await fetchFormForResponse(c, workspaceId, formId)
            if (!formResponse.ok) return formResponse.response
            return c.json({ form: formResponse.form }, 200)
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
 * PATCH /api/v1/build/:workspaceId/forms/:formId/access
 * Updates form access controls with optimistic locking.
 */
buildRouter.patch(
    '/:workspaceId/forms/:formId/access',
    zValidator('param', buildParamSchema),
    zValidator('json', updateFormAccessSchema),
    async (c) => {
        const { workspaceId, formId } = c.req.valid('param')
        const { version, captcha_enabled, password, clear_password } = c.req.valid('json')

        const workspaceRole = await enforceWorkspaceRole(c, workspaceId, 'editor')
        if (!workspaceRole.ok) return workspaceRole.response

        if (password !== undefined) {
            const entitlement = await checkPasswordEntitlement(c, workspaceId)
            if (!entitlement.ok) return entitlement.response
        }

        const updates: Record<string, unknown> = {
            version: version + 1,
        }

        if (captcha_enabled !== undefined) {
            updates.captcha_enabled = captcha_enabled
            updates.captcha_provider = captcha_enabled ? 'turnstile' : null
        }

        if (password !== undefined) {
            updates.password_hash = await hash(password, getPasswordHashCost(c.env))
        }

        if (clear_password === true) {
            updates.password_hash = null
        }

        const supabase = getServiceRoleSupabase(c)
        const { data: updatedForm, error: updateError } = await supabase
            .from('forms')
            .update(updates)
            .eq('id', formId)
            .eq('workspace_id', workspaceId)
            .eq('version', version)
            .is('deleted_at', null)
            .select('id')
            .maybeSingle()

        if (updateError) {
            console.error('Build form access update error:', updateError)
            return c.json({ error: 'Failed to update form access' }, 500)
        }

        if (updatedForm) {
            const formResponse = await fetchFormForResponse(c, workspaceId, formId)
            if (!formResponse.ok) return formResponse.response
            return c.json({ form: formResponse.form }, 200)
        }

        const scopedSupabase = getScopedSupabaseClient(c)
        const { data: existingForm, error: checkError } = await scopedSupabase
            .from('forms')
            .select('id, version')
            .eq('id', formId)
            .eq('workspace_id', workspaceId)
            .is('deleted_at', null)
            .maybeSingle()

        if (checkError) {
            console.error('Build form access stale-check error:', checkError)
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
            .select('id, schema')
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

        const schemaIssues = validateDraftContract(form.schema)
        if (schemaIssues) return toUnsupportedSchemaResponse(c, schemaIssues)

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
