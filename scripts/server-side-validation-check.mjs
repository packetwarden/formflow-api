import { randomUUID } from 'node:crypto'

const env = process.env

const config = {
    baseUrl: normalizeBaseUrl(env.FORMSANDBOX_BASE_URL ?? env.BASE_URL),
    email: env.FORMSANDBOX_EMAIL ?? env.EMAIL ?? '',
    password: env.FORMSANDBOX_PASSWORD ?? env.PASSWORD ?? '',
    accessToken: env.FORMSANDBOX_ACCESS_TOKEN ?? env.ACCESS_TOKEN ?? '',
    workspaceId: env.FORMSANDBOX_WORKSPACE_ID ?? env.WORKSPACE_ID ?? '',
    keepArtifacts: env.FORMSANDBOX_KEEP_ARTIFACTS === '1',
    runProtectedFormChecks: env.FORMSANDBOX_RUN_PROTECTED_FORM_CHECKS === '1',
    runRequireAuthFormChecks:
        env.FORMSANDBOX_RUN_REQUIRE_AUTH_FORM_CHECKS === '1'
        || env.FORMSANDBOX_RUN_PROTECTED_FORM_CHECKS === '1',
    runPasswordProtectedFormChecks:
        env.FORMSANDBOX_RUN_PASSWORD_PROTECTED_FORM_CHECKS === '1'
        || env.FORMSANDBOX_RUN_PROTECTED_FORM_CHECKS === '1',
    runCaptchaFormChecks:
        env.FORMSANDBOX_RUN_CAPTCHA_FORM_CHECKS === '1'
        || env.FORMSANDBOX_RUN_PROTECTED_FORM_CHECKS === '1',
    requireAuthFormId: env.FORMSANDBOX_REQUIRE_AUTH_FORM_ID ?? '',
    passwordProtectedFormId: env.FORMSANDBOX_PASSWORD_PROTECTED_FORM_ID ?? '',
    captchaFormId: env.FORMSANDBOX_CAPTCHA_FORM_ID ?? '',
    requireAuthProbeFormId: env.FORMSANDBOX_REQUIRE_AUTH_PROBE_FORM_ID ?? '',
    tempFormPassword: env.FORMSANDBOX_TEMP_FORM_PASSWORD ?? 'TempFormPassword123!',
    runWorkspaceChecks: env.FORMSANDBOX_RUN_WORKSPACE_CHECKS === '1',
    viewerAccessToken: env.FORMSANDBOX_VIEWER_ACCESS_TOKEN ?? '',
    runStripeChecks: env.FORMSANDBOX_RUN_STRIPE_CHECKS === '1',
    stripeWorkspaceId: env.FORMSANDBOX_STRIPE_WORKSPACE_ID ?? '',
    internalAdminToken: env.FORMSANDBOX_INTERNAL_ADMIN_TOKEN ?? '',
}

function normalizeBaseUrl(value) {
    if (!value) return ''
    return value.replace(/\/+$/, '')
}

function assertConfig() {
    const missing = []

    if (!config.baseUrl) missing.push('FORMSANDBOX_BASE_URL')
    if (!config.accessToken) {
        if (!config.email) missing.push('FORMSANDBOX_EMAIL')
        if (!config.password) missing.push('FORMSANDBOX_PASSWORD')
    }
    if (!config.workspaceId) missing.push('FORMSANDBOX_WORKSPACE_ID')

    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
    }

    if (config.runRequireAuthFormChecks && !config.requireAuthFormId) {
        throw new Error('Require-auth checks require: FORMSANDBOX_REQUIRE_AUTH_FORM_ID')
    }

    if (config.runPasswordProtectedFormChecks && !config.passwordProtectedFormId) {
        throw new Error('Password-protected checks require: FORMSANDBOX_PASSWORD_PROTECTED_FORM_ID')
    }

    if (config.runCaptchaFormChecks && !config.captchaFormId) {
        throw new Error('Captcha checks require: FORMSANDBOX_CAPTCHA_FORM_ID')
    }

    if (config.runStripeChecks) {
        const stripeMissing = []
        if (!config.stripeWorkspaceId) stripeMissing.push('FORMSANDBOX_STRIPE_WORKSPACE_ID')
        if (!config.internalAdminToken) stripeMissing.push('FORMSANDBOX_INTERNAL_ADMIN_TOKEN')
        if (stripeMissing.length > 0) {
            throw new Error(`Stripe checks require: ${stripeMissing.join(', ')}`)
        }
    }
}

function logSection(title) {
    console.log(`\n== ${title} ==`)
}

function logPass(name, details = '') {
    console.log(`[PASS] ${name}${details ? ` - ${details}` : ''}`)
}

function logSkip(name, details = '') {
    console.log(`[SKIP] ${name}${details ? ` - ${details}` : ''}`)
}

function fail(name, response, message) {
    const error = new Error(`${name}: ${message}`)
    error.response = response
    throw error
}

async function parseJsonSafely(response) {
    const text = await response.text()
    if (!text) return null
    try {
        return JSON.parse(text)
    } catch {
        return text
    }
}

async function request(path, options = {}) {
    const response = await fetch(`${config.baseUrl}${path}`, options)
    const body = await parseJsonSafely(response)
    return { response, body }
}

async function expectStatus(name, path, expectedStatus, options = {}) {
    const { response, body } = await request(path, options)
    if (response.status !== expectedStatus) {
        fail(
            name,
            response,
            `expected ${expectedStatus}, got ${response.status}, body=${JSON.stringify(body)}`
        )
    }
    return body
}

function authHeaders(token) {
    return {
        Authorization: `Bearer ${token}`,
    }
}

function assertBootstrapPayload(body) {
    if (!body?.user?.id) {
        throw new Error('/auth/bootstrap did not return user.id')
    }

    if (typeof body.current_workspace_id !== 'string' || body.current_workspace_id.length === 0) {
        throw new Error('/auth/bootstrap did not return current_workspace_id')
    }

    if (!Array.isArray(body.workspaces) || body.workspaces.length === 0) {
        throw new Error('/auth/bootstrap did not return any workspaces')
    }

    const currentWorkspace = body.workspaces.find((workspace) => workspace?.id === body.current_workspace_id)
    if (!currentWorkspace) {
        throw new Error('/auth/bootstrap current_workspace_id was not present in workspaces[]')
    }

    for (const workspace of body.workspaces) {
        if (typeof workspace?.id !== 'string' || workspace.id.length === 0) {
            throw new Error('/auth/bootstrap returned workspace without id')
        }
        if (typeof workspace?.slug !== 'string' || workspace.slug.length === 0) {
            throw new Error(`/auth/bootstrap returned workspace ${workspace.id} without slug`)
        }
        if (typeof workspace?.role !== 'string' || workspace.role.length === 0) {
            throw new Error(`/auth/bootstrap returned workspace ${workspace.id} without role`)
        }
        if (typeof workspace?.is_personal !== 'boolean') {
            throw new Error(`/auth/bootstrap returned workspace ${workspace.id} without boolean is_personal`)
        }
        if (typeof workspace?.plan !== 'string' || workspace.plan.length === 0) {
            throw new Error(`/auth/bootstrap returned workspace ${workspace.id} without plan`)
        }
    }

    for (let index = 1; index < body.workspaces.length; index += 1) {
        const previous = body.workspaces[index - 1]
        const current = body.workspaces[index]
        const previousSortKey = [
            previous.is_personal ? '0' : '1',
            previous.created_at,
            previous.id,
        ].join('|')
        const currentSortKey = [
            current.is_personal ? '0' : '1',
            current.created_at,
            current.id,
        ].join('|')

        if (previousSortKey > currentSortKey) {
            throw new Error('/auth/bootstrap workspaces were not returned in deterministic order')
        }
    }
}

async function login() {
    if (config.accessToken) {
        logPass('Use existing access token')
        return config.accessToken
    }

    const body = await expectStatus('Login', '/api/v1/auth/login', 200, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            email: config.email,
            password: config.password,
        }),
    })

    const token = body?.session?.access_token
    if (typeof token !== 'string' || token.length === 0) {
        throw new Error('Login response did not include session.access_token')
    }
    logPass('Login')
    return token
}

async function runAuthChecks(token) {
    logSection('Auth')

    await expectStatus('Health check', '/', 200)
    logPass('Health check')

    const me = await expectStatus('Auth me', '/api/v1/auth/me', 200, {
        headers: authHeaders(token),
    })
    if (!me?.user?.id) {
        throw new Error('/auth/me did not return user.id')
    }
    logPass('Auth me', `user_id=${me.user.id}`)

    const bootstrap = await expectStatus('Auth bootstrap', '/api/v1/auth/bootstrap', 200, {
        headers: authHeaders(token),
    })
    assertBootstrapPayload(bootstrap)

    const configuredWorkspace = bootstrap.workspaces.find((workspace) => workspace.id === config.workspaceId)
    if (!configuredWorkspace) {
        throw new Error(
            `/auth/bootstrap did not include configured workspace ${config.workspaceId} in workspaces[]`
        )
    }
    logPass(
        'Auth bootstrap',
        `current_workspace_id=${bootstrap.current_workspace_id}, configured_workspace_id=${config.workspaceId}`
    )

    const bootstrapCacheProbe = await request('/api/v1/auth/bootstrap', {
        headers: {
            ...authHeaders(token),
            Accept: 'text/html,application/xhtml+xml',
        },
    })

    if (bootstrapCacheProbe.response.status !== 200) {
        fail(
            'Auth bootstrap content negotiation',
            bootstrapCacheProbe.response,
            `expected 200, body=${JSON.stringify(bootstrapCacheProbe.body)}`
        )
    }
    if (bootstrapCacheProbe.response.headers.get('cache-control') !== 'no-store') {
        fail(
            'Auth bootstrap cache-control',
            bootstrapCacheProbe.response,
            `expected Cache-Control=no-store, got ${bootstrapCacheProbe.response.headers.get('cache-control')}`
        )
    }
    assertBootstrapPayload(bootstrapCacheProbe.body)
    logPass('Auth bootstrap cache-control')

    await expectStatus('Malformed auth header rejected', '/api/v1/auth/me', 401, {
        headers: {
            Authorization: 'Bearer bad token',
        },
    })
    logPass('Malformed auth header rejected')

    const malformedBootstrap = await request('/api/v1/auth/bootstrap', {
        headers: {
            Authorization: 'Bearer bad token',
        },
    })
    if (malformedBootstrap.response.status !== 401) {
        fail(
            'Malformed bootstrap auth header rejected',
            malformedBootstrap.response,
            `expected 401, body=${JSON.stringify(malformedBootstrap.body)}`
        )
    }
    logPass('Malformed bootstrap auth header rejected')
}

function buildValidRunnerSchema() {
    return {
        layout: 'flat',
        theme: {},
        steps: [
            {
                id: 'step_1',
                fields: [
                    {
                        id: 'email',
                        type: 'email',
                        required: true,
                    },
                    {
                        id: 'full_name',
                        type: 'text',
                        required: true,
                        minLength: 2,
                    },
                ],
            },
        ],
        logic: [],
        settings: {},
    }
}

function buildInvalidCreateSchema() {
    return {
        layout: 'flat',
        theme: {},
        steps: [
            {
                id: 'step_1',
                fields: [
                    {
                        id: 'bad_field',
                        type: 'matrix',
                    },
                ],
            },
        ],
        logic: [],
        settings: {},
    }
}

function buildInvalidPutSchema() {
    return {
        layout: 'flat',
        theme: {},
        steps: [
            {
                id: 'step_1',
                fields: [
                    {
                        id: 'email',
                        type: 'email',
                        required: true,
                    },
                    {
                        id: 'full_name',
                        type: 'text',
                    },
                ],
            },
        ],
        logic: [
            {
                if: {
                    field_id: 'full_name',
                    operator: 'eq',
                    value: 'x',
                },
                then: {
                    type: 'send_email',
                    target: 'email',
                },
            },
        ],
        settings: {},
    }
}

async function createTempForm(token) {
    const payload = {
        title: `Validation Check ${Date.now()}`,
        description: 'Temporary form for automated validation coverage',
        schema: buildValidRunnerSchema(),
        accept_submissions: true,
    }

    const { response, body } = await request(`/api/v1/build/${config.workspaceId}/forms`, {
        method: 'POST',
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    })

    if (response.status !== 201) {
        fail('Create temp form', response, `expected 201, body=${JSON.stringify(body)}`)
    }

    if (!body?.form?.id) {
        throw new Error('Create form response missing form.id')
    }

    logPass('Create temp form', `form_id=${body.form.id}`)
    return {
        id: body.form.id,
        version: body.form.version,
    }
}

async function fetchBuildForm(token, formId) {
    const { response, body } = await request(`/api/v1/build/${config.workspaceId}/forms/${formId}`, {
        headers: authHeaders(token),
    })

    if (response.status !== 200 || !body?.form?.version) {
        fail('Fetch build form', response, `expected 200 with form.version, body=${JSON.stringify(body)}`)
    }

    return body.form
}

async function patchFormAccess(token, formId, payload) {
    const { response, body } = await request(`/api/v1/build/${config.workspaceId}/forms/${formId}/access`, {
        method: 'PATCH',
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    })

    if (response.status !== 200 || !body?.form?.version) {
        fail('Patch form access', response, `expected 200, body=${JSON.stringify(body)}`)
    }

    return body.form
}

async function deleteForm(token, formId) {
    const { response, body } = await request(`/api/v1/build/${config.workspaceId}/forms/${formId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
    })

    if (response.status !== 200) {
        fail('Delete temp form', response, `expected 200, body=${JSON.stringify(body)}`)
    }

    logPass('Delete temp form', `form_id=${formId}`)
}

async function runBuildChecks(token) {
    logSection('Build')

    await expectStatus('List forms', `/api/v1/build/${config.workspaceId}/forms`, 200, {
        headers: authHeaders(token),
    })
    logPass('List forms')

    const invalidCreate = await request(`/api/v1/build/${config.workspaceId}/forms`, {
        method: 'POST',
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            title: 'Invalid Schema Create',
            schema: buildInvalidCreateSchema(),
        }),
    })

    if (invalidCreate.response.status !== 422 || invalidCreate.body?.code !== 'UNSUPPORTED_FORM_SCHEMA') {
        fail(
            'Create invalid schema rejected',
            invalidCreate.response,
            `expected 422 UNSUPPORTED_FORM_SCHEMA, body=${JSON.stringify(invalidCreate.body)}`
        )
    }
    logPass('Create invalid schema rejected')

    const form = await createTempForm(token)

    const invalidRedirect = await request(`/api/v1/build/${config.workspaceId}/forms/${form.id}`, {
        method: 'PATCH',
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            version: form.version,
            redirect_url: 'javascript:alert(1)',
        }),
    })

    if (invalidRedirect.response.status !== 400) {
        fail(
            'Patch invalid redirect rejected',
            invalidRedirect.response,
            `expected 400, body=${JSON.stringify(invalidRedirect.body)}`
        )
    }
    logPass('Patch invalid redirect rejected')

    const invalidPut = await request(`/api/v1/build/${config.workspaceId}/forms/${form.id}`, {
        method: 'PUT',
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            version: form.version,
            schema: buildInvalidPutSchema(),
        }),
    })

    if (invalidPut.response.status !== 422 || invalidPut.body?.code !== 'UNSUPPORTED_FORM_SCHEMA') {
        fail(
            'PUT invalid schema rejected',
            invalidPut.response,
            `expected 422 UNSUPPORTED_FORM_SCHEMA, body=${JSON.stringify(invalidPut.body)}`
        )
    }
    logPass('PUT invalid schema rejected')

    const validPut = await request(`/api/v1/build/${config.workspaceId}/forms/${form.id}`, {
        method: 'PUT',
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            version: form.version,
            schema: buildValidRunnerSchema(),
        }),
    })

    if (validPut.response.status !== 200 || !validPut.body?.form?.version) {
        fail('PUT valid schema saved', validPut.response, `body=${JSON.stringify(validPut.body)}`)
    }
    logPass('PUT valid schema saved', `version=${validPut.body.form.version}`)

    const publish = await request(`/api/v1/build/${config.workspaceId}/forms/${form.id}/publish`, {
        method: 'POST',
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            description: 'Automated validation publish',
        }),
    })

    if (publish.response.status !== 200) {
        fail('Publish temp form', publish.response, `body=${JSON.stringify(publish.body)}`)
    }
    logPass('Publish temp form')

    return {
        id: form.id,
        version: validPut.body.form.version,
    }
}

async function submitRunnerForm(formId, payload, headers = {}) {
    return request(`/api/v1/f/${formId}/submit`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...headers,
        },
        body: JSON.stringify(payload),
    })
}

async function requestRunnerFormAccess(formId, payload) {
    return request(`/api/v1/f/${formId}/access`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    })
}

async function fetchRunnerSchema(formId, headers = {}) {
    return request(`/api/v1/f/${formId}/schema`, {
        headers,
    })
}

async function runRunnerChecks(token, form) {
    logSection('Runner')

    const schema = await fetchRunnerSchema(form.id)
    if (schema.response.status !== 200) {
        fail('Runner schema fetch', schema.response, `expected 200, body=${JSON.stringify(schema.body)}`)
    }
    logPass('Runner schema fetch', `form_id=${form.id}`)

    const missingIdempotency = await submitRunnerForm(form.id, {
        data: {
            email: 'qa.runner@example.com',
            full_name: 'Runner QA',
        },
    })
    if (missingIdempotency.response.status !== 400) {
        fail(
            'Runner missing idempotency rejected',
            missingIdempotency.response,
            `expected 400, body=${JSON.stringify(missingIdempotency.body)}`
        )
    }
    logPass('Runner missing idempotency rejected')

    const futureStartedAt = new Date(Date.now() + (10 * 60 * 1000)).toISOString()
    const invalidStartedAt = await submitRunnerForm(form.id, {
        data: {
            email: 'qa.runner@example.com',
            full_name: 'Runner QA',
        },
        started_at: futureStartedAt,
    }, {
        'Idempotency-Key': randomUUID(),
    })
    if (invalidStartedAt.response.status !== 400) {
        fail(
            'Runner future started_at rejected',
            invalidStartedAt.response,
            `expected 400, body=${JSON.stringify(invalidStartedAt.body)}`
        )
    }
    logPass('Runner future started_at rejected')

    let currentVersion = form.version

    const protectedForm = await patchFormAccess(token, form.id, {
        version: currentVersion,
        password: config.tempFormPassword,
    })
    currentVersion = protectedForm.version
    logPass('Builder set form password', `version=${currentVersion}`)

    const lockedSchema = await fetchRunnerSchema(form.id)
    if (lockedSchema.response.status !== 403 || lockedSchema.body?.code !== 'FORM_PASSWORD_REQUIRED') {
        fail('Runner locked schema', lockedSchema.response, `body=${JSON.stringify(lockedSchema.body)}`)
    }
    if (lockedSchema.body?.form?.published_schema !== undefined) {
        throw new Error('Locked schema response exposed published_schema')
    }
    logPass('Runner locked schema')

    const missingCaptcha = await requestRunnerFormAccess(form.id, {
        password: config.tempFormPassword,
    })
    if (missingCaptcha.response.status !== 403 || missingCaptcha.body?.code !== 'CAPTCHA_REQUIRED') {
        fail('Runner access missing captcha rejected', missingCaptcha.response, `body=${JSON.stringify(missingCaptcha.body)}`)
    }
    logPass('Runner access missing captcha rejected')

    const captchaDisabledForm = await patchFormAccess(token, form.id, {
        version: currentVersion,
        captcha_enabled: false,
    })
    currentVersion = captchaDisabledForm.version
    logPass('Builder disabled captcha for temp form', `version=${currentVersion}`)

    const wrongPassword = await requestRunnerFormAccess(form.id, {
        password: `${config.tempFormPassword}-wrong`,
    })
    if (wrongPassword.response.status !== 403 || wrongPassword.body?.code !== 'FORM_PASSWORD_INVALID') {
        fail('Runner access wrong password rejected', wrongPassword.response, `body=${JSON.stringify(wrongPassword.body)}`)
    }
    logPass('Runner access wrong password rejected')

    const accessGrant = await requestRunnerFormAccess(form.id, {
        password: config.tempFormPassword,
    })
    if (accessGrant.response.status !== 200 || typeof accessGrant.body?.access_token !== 'string') {
        fail('Runner access success', accessGrant.response, `body=${JSON.stringify(accessGrant.body)}`)
    }
    const formAccessToken = accessGrant.body.access_token
    logPass('Runner access success')

    const unlockedSchema = await fetchRunnerSchema(form.id, {
        'X-Form-Access-Token': formAccessToken,
    })
    if (unlockedSchema.response.status !== 200 || !unlockedSchema.body?.form?.published_schema) {
        fail('Runner unlocked schema', unlockedSchema.response, `body=${JSON.stringify(unlockedSchema.body)}`)
    }
    logPass('Runner unlocked schema')

    const validStartedAt = new Date(Date.now() - 60 * 1000).toISOString()
    const success = await submitRunnerForm(form.id, {
        data: {
            email: 'qa.runner@example.com',
            full_name: 'Runner QA',
        },
        started_at: validStartedAt,
    }, {
        'Idempotency-Key': randomUUID(),
        'X-Form-Access-Token': formAccessToken,
        Referer: 'not a url',
        'User-Agent': 'FormSandbox Validation Script/1.0',
    })
    if (success.response.status !== 201 || typeof success.body?.submission_id !== 'string') {
        fail('Runner protected success submit', success.response, `body=${JSON.stringify(success.body)}`)
    }
    logPass('Runner protected success submit', `submission_id=${success.body.submission_id}`)

    if (config.runRequireAuthFormChecks) {
        await expectProtectedRunnerCode(
            'Runner require_auth blocked',
            config.requireAuthFormId,
            'FORM_AUTH_REQUIRED'
        )
    } else {
        logSkip(
            'Require-auth form checks',
            'Set FORMSANDBOX_RUN_REQUIRE_AUTH_FORM_CHECKS=1 and FORMSANDBOX_REQUIRE_AUTH_FORM_ID to enable'
        )
    }

    if (config.runPasswordProtectedFormChecks) {
        await expectProtectedRunnerCode(
            'Runner password-protected blocked',
            config.passwordProtectedFormId,
            'FORM_ACCESS_TOKEN_INVALID'
        )
    } else {
        logSkip(
            'Password-protected form checks',
            'Set FORMSANDBOX_RUN_PASSWORD_PROTECTED_FORM_CHECKS=1 and FORMSANDBOX_PASSWORD_PROTECTED_FORM_ID to enable'
        )
    }

    if (config.runCaptchaFormChecks) {
        await expectProtectedRunnerCode(
            'Runner captcha blocked',
            config.captchaFormId,
            'CAPTCHA_REQUIRED'
        )
    } else {
        logSkip(
            'Captcha form checks',
            'Set FORMSANDBOX_RUN_CAPTCHA_FORM_CHECKS=1 and FORMSANDBOX_CAPTCHA_FORM_ID to enable'
        )
    }

    if (config.requireAuthProbeFormId) {
        await runRequireAuthCapabilityProbe(token, config.requireAuthProbeFormId)
    } else {
        logSkip(
            'Require-auth capability probe',
            'Set FORMSANDBOX_REQUIRE_AUTH_PROBE_FORM_ID to probe builder access support'
        )
    }
}

async function expectProtectedRunnerCode(name, formId, expectedCode) {
    const result = await submitRunnerForm(formId, {
        data: {},
    }, {
        'Idempotency-Key': randomUUID(),
    })

    if (result.response.status !== 403 || result.body?.code !== expectedCode) {
        fail(name, result.response, `expected 403 ${expectedCode}, body=${JSON.stringify(result.body)}`)
    }
    logPass(name)
}

async function runRequireAuthCapabilityProbe(token, formId) {
    const buildForm = await fetchBuildForm(token, formId)

    const probe = await request(`/api/v1/build/${config.workspaceId}/forms/${formId}/access`, {
        method: 'PATCH',
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            version: buildForm.version,
            require_auth: true,
        }),
    })

    if (probe.response.status === 200) {
        logPass('Require-auth capability probe', 'builder access route accepted require_auth')
        return
    }

    if (
        probe.response.status === 400
        && JSON.stringify(probe.body).includes('require_auth')
        && JSON.stringify(probe.body).includes('unrecognized')
    ) {
        logPass('Require-auth capability probe', 'builder access route currently rejects require_auth as unsupported')
        return
    }

    fail(
        'Require-auth capability probe',
        probe.response,
        `expected 200 or 400 unsupported-key response, body=${JSON.stringify(probe.body)}`
    )
}

async function runStripeChecks(token) {
    logSection('Stripe')

    const checkoutMissingIdempotency = await request(
        `/api/v1/stripe/workspaces/${config.stripeWorkspaceId}/checkout-session`,
        {
            method: 'POST',
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                plan_slug: 'pro',
                interval: 'monthly',
            }),
        }
    )

    if (checkoutMissingIdempotency.response.status !== 400) {
        fail(
            'Stripe checkout missing idempotency rejected',
            checkoutMissingIdempotency.response,
            `expected 400, body=${JSON.stringify(checkoutMissingIdempotency.body)}`
        )
    }
    logPass('Stripe checkout missing idempotency rejected')

    const mismatchedInternalAuth = await request('/api/v1/stripe/catalog/sync', {
        method: 'POST',
        headers: {
            'x-internal-admin-token': `${config.internalAdminToken}-x`,
            Authorization: `Bearer ${config.internalAdminToken}`,
        },
    })

    if (mismatchedInternalAuth.response.status !== 403) {
        fail(
            'Stripe catalog sync mismatched tokens rejected',
            mismatchedInternalAuth.response,
            `expected 403, body=${JSON.stringify(mismatchedInternalAuth.body)}`
        )
    }
    logPass('Stripe catalog sync mismatched tokens rejected')

    const webhookContentType = await request('/api/v1/stripe/webhook', {
        method: 'POST',
        headers: {
            'stripe-signature': 't=0,v1=test',
            'content-type': 'text/plain',
        },
        body: 'not-json',
    })

    if (webhookContentType.response.status !== 400) {
        fail(
            'Stripe webhook non-json content type rejected',
            webhookContentType.response,
            `expected 400, body=${JSON.stringify(webhookContentType.body)}`
        )
    }
    logPass('Stripe webhook non-json content type rejected')
}

async function fetchWorkspaceOverview(token) {
    return request(`/api/v1/workspaces/${config.workspaceId}/overview`, {
        headers: authHeaders(token),
    })
}

async function fetchWorkspaceSettings(token) {
    return request(`/api/v1/workspaces/${config.workspaceId}/settings`, {
        headers: authHeaders(token),
    })
}

async function patchWorkspaceSettings(token, payload) {
    return request(`/api/v1/workspaces/${config.workspaceId}/settings`, {
        method: 'PATCH',
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    })
}

function assertWorkspaceOverview(body) {
    if (!body?.workspace?.id || body.workspace.id !== config.workspaceId) {
        throw new Error('Workspace overview did not return the configured workspace.id')
    }
    if (!body?.owner?.id) {
        throw new Error('Workspace overview did not include owner.id')
    }
    if (!body?.membership?.role) {
        throw new Error('Workspace overview did not include membership.role')
    }
    if (typeof body?.summary?.member_count !== 'number') {
        throw new Error('Workspace overview did not include summary.member_count')
    }
    if ('settings' in (body.workspace ?? {})) {
        throw new Error('Workspace overview exposed raw workspace.settings')
    }
    if ('version' in (body.workspace ?? {})) {
        throw new Error('Workspace overview exposed workspace.version')
    }
    if ('retention_days' in (body.workspace ?? {})) {
        throw new Error('Workspace overview exposed workspace.retention_days')
    }
}

async function runWorkspaceChecks(token) {
    logSection('Workspaces')

    const overview = await fetchWorkspaceOverview(token)
    if (overview.response.status !== 200) {
        fail('Workspace overview', overview.response, `expected 200, body=${JSON.stringify(overview.body)}`)
    }
    assertWorkspaceOverview(overview.body)
    logPass('Workspace overview', `role=${overview.body.membership.role}`)

    const settings = await fetchWorkspaceSettings(token)
    if (settings.response.status !== 200 || !settings.body?.workspace?.version) {
        fail('Workspace settings read', settings.response, `expected 200, body=${JSON.stringify(settings.body)}`)
    }
    logPass('Workspace settings read', `version=${settings.body.workspace.version}`)

    const baseline = settings.body
    const originalVersion = baseline.workspace.version
    const originalSettings = baseline.settings ?? {}
    const originalTagline = originalSettings?.about?.tagline ?? null
    const updatedTagline = `Validation ${Date.now()}`

    const updateResult = await patchWorkspaceSettings(token, {
        version: originalVersion,
        settings: {
            about: {
                tagline: updatedTagline,
            },
        },
    })

    if (updateResult.response.status !== 200 || updateResult.body?.settings?.about?.tagline !== updatedTagline) {
        fail('Workspace settings patch', updateResult.response, `expected 200, body=${JSON.stringify(updateResult.body)}`)
    }
    logPass('Workspace settings patch', `version=${updateResult.body.workspace.version}`)

    const conflictResult = await patchWorkspaceSettings(token, {
        version: originalVersion,
        settings: {
            about: {
                tagline: `${updatedTagline}-stale`,
            },
        },
    })

    if (conflictResult.response.status !== 409 || typeof conflictResult.body?.current_version !== 'number') {
        fail('Workspace settings version conflict', conflictResult.response, `expected 409, body=${JSON.stringify(conflictResult.body)}`)
    }
    logPass('Workspace settings version conflict')

    const invalidResult = await patchWorkspaceSettings(token, {
        version: updateResult.body.workspace.version,
        settings: {
            about: {
                unknown_field: 'x',
            },
        },
    })

    if (invalidResult.response.status !== 400) {
        fail('Workspace settings invalid nested key rejected', invalidResult.response, `expected 400, body=${JSON.stringify(invalidResult.body)}`)
    }
    logPass('Workspace settings invalid nested key rejected')

    if (config.viewerAccessToken) {
        const viewerSettings = await fetchWorkspaceSettings(config.viewerAccessToken)
        if (viewerSettings.response.status !== 403) {
            fail('Workspace settings non-owner denied', viewerSettings.response, `expected 403, body=${JSON.stringify(viewerSettings.body)}`)
        }
        logPass('Workspace settings non-owner denied')
    } else {
        logSkip('Workspace settings non-owner denied', 'Set FORMSANDBOX_VIEWER_ACCESS_TOKEN to enable')
    }

    const restoreResult = await patchWorkspaceSettings(token, {
        version: updateResult.body.workspace.version,
        settings: {
            about: {
                tagline: originalTagline,
            },
        },
    })

    if (restoreResult.response.status !== 200) {
        fail('Workspace settings restore', restoreResult.response, `expected 200, body=${JSON.stringify(restoreResult.body)}`)
    }
    logPass('Workspace settings restore', `version=${restoreResult.body.workspace.version}`)
}

async function main() {
    assertConfig()

    const token = await login()
    let tempFormId = ''

    try {
        await runAuthChecks(token)
        const tempForm = await runBuildChecks(token)
        tempFormId = tempForm.id
        await runRunnerChecks(token, tempForm)

        if (config.runWorkspaceChecks) {
            await runWorkspaceChecks(token)
        } else {
            logSkip('Workspace checks', 'Set FORMSANDBOX_RUN_WORKSPACE_CHECKS=1 to enable')
        }

        if (config.runStripeChecks) {
            await runStripeChecks(token)
        } else {
            logSkip('Stripe checks', 'Set FORMSANDBOX_RUN_STRIPE_CHECKS=1 to enable')
        }

        console.log('\nValidation integration check completed successfully.')
    } finally {
        if (tempFormId && !config.keepArtifacts) {
            try {
                await deleteForm(token, tempFormId)
            } catch (error) {
                console.error(`Cleanup failed for form ${tempFormId}:`, error.message)
            }
        } else if (tempFormId) {
            logSkip('Cleanup', `Temporary form kept: ${tempFormId}`)
        }
    }
}

main().catch((error) => {
    console.error('\nValidation integration check failed.')
    console.error(error.message)
    process.exitCode = 1
})
