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
    requireAuthFormId: env.FORMSANDBOX_REQUIRE_AUTH_FORM_ID ?? '',
    passwordProtectedFormId: env.FORMSANDBOX_PASSWORD_PROTECTED_FORM_ID ?? '',
    captchaFormId: env.FORMSANDBOX_CAPTCHA_FORM_ID ?? '',
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

    if (config.runProtectedFormChecks) {
        const protectedMissing = []
        if (!config.requireAuthFormId) protectedMissing.push('FORMSANDBOX_REQUIRE_AUTH_FORM_ID')
        if (!config.passwordProtectedFormId) protectedMissing.push('FORMSANDBOX_PASSWORD_PROTECTED_FORM_ID')
        if (!config.captchaFormId) protectedMissing.push('FORMSANDBOX_CAPTCHA_FORM_ID')
        if (protectedMissing.length > 0) {
            throw new Error(
                `Protected-form checks require: ${protectedMissing.join(', ')}`
            )
        }
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

    await expectStatus('Malformed auth header rejected', '/api/v1/auth/me', 401, {
        headers: {
            Authorization: 'Bearer bad token',
        },
    })
    logPass('Malformed auth header rejected')
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

    return form.id
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

async function runRunnerChecks(formId) {
    logSection('Runner')

    await expectStatus('Runner schema fetch', `/api/v1/f/${formId}/schema`, 200)
    logPass('Runner schema fetch', `form_id=${formId}`)

    const missingIdempotency = await submitRunnerForm(formId, {
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
    const invalidStartedAt = await submitRunnerForm(formId, {
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

    const validStartedAt = new Date(Date.now() - 60 * 1000).toISOString()
    const success = await submitRunnerForm(formId, {
        data: {
            email: 'qa.runner@example.com',
            full_name: 'Runner QA',
        },
        started_at: validStartedAt,
    }, {
        'Idempotency-Key': randomUUID(),
        Referer: 'not a url',
        'User-Agent': 'FormSandbox Validation Script/1.0',
    })
    if (success.response.status !== 201 || typeof success.body?.submission_id !== 'string') {
        fail('Runner success submit', success.response, `body=${JSON.stringify(success.body)}`)
    }
    logPass('Runner success submit', `submission_id=${success.body.submission_id}`)

    if (!config.runProtectedFormChecks) {
        logSkip('Protected-form checks', 'Set FORMSANDBOX_RUN_PROTECTED_FORM_CHECKS=1 to enable')
        return
    }

    await expectProtectedRunnerCode(
        'Runner require_auth blocked',
        config.requireAuthFormId,
        'FORM_AUTH_REQUIRED'
    )
    await expectProtectedRunnerCode(
        'Runner password-protected blocked',
        config.passwordProtectedFormId,
        'FORM_PASSWORD_REQUIRED'
    )
    await expectProtectedRunnerCode(
        'Runner captcha blocked',
        config.captchaFormId,
        'CAPTCHA_REQUIRED_UNSUPPORTED'
    )
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

async function main() {
    assertConfig()

    const token = await login()
    let tempFormId = ''

    try {
        await runAuthChecks(token)
        tempFormId = await runBuildChecks(token)
        await runRunnerChecks(tempFormId)

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
