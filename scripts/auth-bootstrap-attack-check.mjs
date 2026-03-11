const env = process.env

const config = {
    baseUrl: normalizeBaseUrl(env.FORMSANDBOX_BASE_URL ?? env.BASE_URL),
    email: env.FORMSANDBOX_EMAIL ?? env.EMAIL ?? '',
    password: env.FORMSANDBOX_PASSWORD ?? env.PASSWORD ?? '',
    accessToken: env.FORMSANDBOX_ACCESS_TOKEN ?? env.ACCESS_TOKEN ?? '',
    workspaceId: env.FORMSANDBOX_WORKSPACE_ID ?? env.WORKSPACE_ID ?? '',
    expectedUserId: env.FORMSANDBOX_USER_ID ?? env.USER_ID ?? '',
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

    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
    }
}

function logSection(title) {
    console.log(`\n== ${title} ==`)
}

function logPass(name, details = '') {
    console.log(`[PASS] ${name}${details ? ` - ${details}` : ''}`)
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

    const { response, body } = await request('/api/v1/auth/login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            email: config.email,
            password: config.password,
        }),
    })

    if (response.status !== 200 || typeof body?.session?.access_token !== 'string') {
        fail('Login', response, `expected 200 with session.access_token, body=${JSON.stringify(body)}`)
    }

    logPass('Login')
    return body.session.access_token
}

function unauthorizedLeak(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false

    return Object.prototype.hasOwnProperty.call(body, 'current_workspace_id')
        || Object.prototype.hasOwnProperty.call(body, 'workspaces')
        || Object.prototype.hasOwnProperty.call(body, 'user')
        || Object.prototype.hasOwnProperty.call(body, 'workspace')
        || Object.prototype.hasOwnProperty.call(body, 'membership')
        || Object.prototype.hasOwnProperty.call(body, 'summary')
        || Object.prototype.hasOwnProperty.call(body, 'settings')
}

function assertNoUnauthorizedLeak(name, result, allowedStatuses) {
    if (!allowedStatuses.includes(result.response.status)) {
        fail(
            name,
            result.response,
            `expected status in [${allowedStatuses.join(', ')}], got ${result.response.status}, body=${JSON.stringify(result.body)}`
        )
    }

    if (result.response.status !== 200 && unauthorizedLeak(result.body)) {
        fail(name, result.response, `unexpected bootstrap data leakage: ${JSON.stringify(result.body)}`)
    }
}

function assertBootstrapPayload(name, result) {
    if (result.response.status !== 200) {
        fail(name, result.response, `expected 200, body=${JSON.stringify(result.body)}`)
    }

    if (!result.body?.user?.id || !Array.isArray(result.body?.workspaces) || !result.body?.current_workspace_id) {
        fail(name, result.response, `bootstrap payload missing required fields: ${JSON.stringify(result.body)}`)
    }

    if (result.response.headers.get('cache-control') !== 'no-store') {
        fail(
            name,
            result.response,
            `expected Cache-Control=no-store, got ${result.response.headers.get('cache-control')}`
        )
    }

    if (config.expectedUserId && result.body.user.id !== config.expectedUserId) {
        fail(name, result.response, `expected user.id=${config.expectedUserId}, got ${result.body.user.id}`)
    }

    if (
        config.workspaceId
        && !result.body.workspaces.some((workspace) => workspace?.id === config.workspaceId)
    ) {
        fail(
            name,
            result.response,
            `expected configured workspace ${config.workspaceId} to be present in workspaces[]`
        )
    }
}

function assertWorkspaceOverviewPayload(name, result, expectedWorkspaceId) {
    if (result.response.status !== 200) {
        fail(name, result.response, `expected 200, body=${JSON.stringify(result.body)}`)
    }

    if (result.body?.workspace?.id !== expectedWorkspaceId) {
        fail(
            name,
            result.response,
            `expected workspace.id=${expectedWorkspaceId}, got ${result.body?.workspace?.id}`
        )
    }

    if (!result.body?.membership?.role || typeof result.body.summary?.member_count !== 'number') {
        fail(name, result.response, `overview payload missing membership or member_count: ${JSON.stringify(result.body)}`)
    }

    if (Object.prototype.hasOwnProperty.call(result.body, 'version')) {
        fail(name, result.response, 'overview payload unexpectedly exposed top-level version')
    }
}

function assertWorkspaceSettingsPayload(name, result, expectedWorkspaceId) {
    if (result.response.status !== 200) {
        fail(name, result.response, `expected 200, body=${JSON.stringify(result.body)}`)
    }

    if (result.body?.workspace?.id !== expectedWorkspaceId) {
        fail(
            name,
            result.response,
            `expected workspace.id=${expectedWorkspaceId}, got ${result.body?.workspace?.id}`
        )
    }

    if (typeof result.body?.workspace?.version !== 'number' || !result.body?.settings || Array.isArray(result.body.settings)) {
        fail(name, result.response, `settings payload missing version/settings: ${JSON.stringify(result.body)}`)
    }
}

async function runUnauthorizedProbes() {
    logSection('Unauthorized Probes')

    const probes = [
        {
            name: 'No authorization header',
            path: '/api/v1/auth/bootstrap',
            options: {},
            statuses: [401],
        },
        {
            name: 'Basic auth header',
            path: '/api/v1/auth/bootstrap',
            options: {
                headers: {
                    Authorization: 'Basic Zm9vOmJhcg==',
                },
            },
            statuses: [401],
        },
        {
            name: 'Bearer token with whitespace payload',
            path: '/api/v1/auth/bootstrap',
            options: {
                headers: {
                    Authorization: 'Bearer    ',
                },
            },
            statuses: [401],
        },
        {
            name: 'Tampered bearer token',
            path: '/api/v1/auth/bootstrap',
            options: {
                headers: {
                    Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.fake.payload',
                },
            },
            statuses: [401],
        },
        {
            name: 'Header spoofing without auth',
            path: '/api/v1/auth/bootstrap',
            options: {
                headers: {
                    'X-User-Id': config.expectedUserId || '00000000-0000-0000-0000-000000000000',
                    'X-Workspace-Id': config.workspaceId || '00000000-0000-0000-0000-000000000000',
                    'X-Forwarded-For': '127.0.0.1',
                },
            },
            statuses: [401],
        },
        {
            name: 'POST to bootstrap route',
            path: '/api/v1/auth/bootstrap',
            options: {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    current_workspace_id: '00000000-0000-0000-0000-000000000000',
                    workspaces: [{ id: 'forged' }],
                }),
            },
            statuses: [404, 405],
        },
        {
            name: 'Path traversal style suffix',
            path: '/api/v1/auth/bootstrap/../me',
            options: {},
            statuses: [401, 404],
        },
        {
            name: 'Encoded path traversal suffix',
            path: '/api/v1/auth/bootstrap%2F..%2Fme',
            options: {},
            statuses: [401, 404],
        },
    ]

    for (const probe of probes) {
        const result = await request(probe.path, probe.options)
        assertNoUnauthorizedLeak(probe.name, result, probe.statuses)
        logPass(probe.name, `status=${result.response.status}`)
    }
}

async function runAuthorizedManipulationProbes(token) {
    logSection('Authorized Manipulation Probes')

    const baseline = await request('/api/v1/auth/bootstrap', {
        headers: authHeaders(token),
    })
    assertBootstrapPayload('Baseline bootstrap', baseline)
    logPass('Baseline bootstrap', `workspace_id=${baseline.body.current_workspace_id}`)

    const manipulations = [
        {
            name: 'Query string injection ignored',
            path: '/api/v1/auth/bootstrap?workspaceId=00000000-0000-0000-0000-000000000000&role=owner',
            options: {
                headers: authHeaders(token),
            },
        },
        {
            name: 'JSON accept header',
            path: '/api/v1/auth/bootstrap',
            options: {
                headers: {
                    ...authHeaders(token),
                    Accept: 'application/json',
                },
            },
        },
        {
            name: 'HTML accept header',
            path: '/api/v1/auth/bootstrap',
            options: {
                headers: {
                    ...authHeaders(token),
                    Accept: 'text/html,application/xhtml+xml',
                },
            },
        },
        {
            name: 'Irrelevant content-type on GET',
            path: '/api/v1/auth/bootstrap',
            options: {
                headers: {
                    ...authHeaders(token),
                    'Content-Type': 'application/json',
                },
            },
        },
        {
            name: 'Header spoofing with valid auth',
            path: '/api/v1/auth/bootstrap',
            options: {
                headers: {
                    ...authHeaders(token),
                    'X-User-Id': '00000000-0000-0000-0000-000000000000',
                    'X-Workspace-Id': '00000000-0000-0000-0000-000000000000',
                    'X-Forwarded-For': '203.0.113.9',
                },
            },
        },
        {
            name: 'Large benign query string',
            path: `/api/v1/auth/bootstrap?noise=${'x'.repeat(2048)}`,
            options: {
                headers: authHeaders(token),
            },
        },
    ]

    for (const probe of manipulations) {
        const result = await request(probe.path, probe.options)
        assertBootstrapPayload(probe.name, result)

        if (result.body.current_workspace_id !== baseline.body.current_workspace_id) {
            fail(
                probe.name,
                result.response,
                `current workspace drifted from ${baseline.body.current_workspace_id} to ${result.body.current_workspace_id}`
            )
        }

        if (JSON.stringify(result.body.workspaces) !== JSON.stringify(baseline.body.workspaces)) {
            fail(
                probe.name,
                result.response,
                'workspace list changed under non-semantic request manipulation'
            )
        }

        logPass(probe.name)
    }
}

async function runWorkspaceRouteProbes(token) {
    if (!config.workspaceId) {
        logSection('Workspace Route Probes')
        logPass('Workspace route probes skipped', 'Set FORMSANDBOX_WORKSPACE_ID to enable')
        return
    }

    logSection('Workspace Route Probes')

    const overviewBaseline = await request(`/api/v1/workspaces/${config.workspaceId}/overview`, {
        headers: authHeaders(token),
    })
    assertWorkspaceOverviewPayload('Workspace overview baseline', overviewBaseline, config.workspaceId)
    logPass('Workspace overview baseline')

    const overviewManipulations = [
        {
            name: 'Workspace overview query injection ignored',
            path: `/api/v1/workspaces/${config.workspaceId}/overview?role=owner&workspaceId=00000000-0000-0000-0000-000000000000`,
            options: { headers: authHeaders(token) },
        },
        {
            name: 'Workspace overview spoofed headers ignored',
            path: `/api/v1/workspaces/${config.workspaceId}/overview`,
            options: {
                headers: {
                    ...authHeaders(token),
                    'X-User-Id': '00000000-0000-0000-0000-000000000000',
                    'X-Workspace-Id': '00000000-0000-0000-0000-000000000000',
                },
            },
        },
    ]

    for (const probe of overviewManipulations) {
        const result = await request(probe.path, probe.options)
        assertWorkspaceOverviewPayload(probe.name, result, config.workspaceId)
        logPass(probe.name)
    }

    const overviewUnauthorized = await request(`/api/v1/workspaces/${config.workspaceId}/overview`)
    assertNoUnauthorizedLeak('Workspace overview without auth', overviewUnauthorized, [401])
    logPass('Workspace overview without auth', `status=${overviewUnauthorized.response.status}`)

    const settingsBaseline = await request(`/api/v1/workspaces/${config.workspaceId}/settings`, {
        headers: authHeaders(token),
    })
    assertWorkspaceSettingsPayload('Workspace settings baseline', settingsBaseline, config.workspaceId)
    logPass('Workspace settings baseline', `version=${settingsBaseline.body.workspace.version}`)

    const settingsManipulations = [
        {
            name: 'Workspace settings query injection ignored',
            path: `/api/v1/workspaces/${config.workspaceId}/settings?version=0&name=forged`,
            options: { headers: authHeaders(token) },
        },
        {
            name: 'Workspace settings spoofed headers ignored',
            path: `/api/v1/workspaces/${config.workspaceId}/settings`,
            options: {
                headers: {
                    ...authHeaders(token),
                    'X-User-Id': '00000000-0000-0000-0000-000000000000',
                    'X-Workspace-Role': 'owner',
                },
            },
        },
    ]

    for (const probe of settingsManipulations) {
        const result = await request(probe.path, probe.options)
        assertWorkspaceSettingsPayload(probe.name, result, config.workspaceId)
        logPass(probe.name)
    }

    const forbiddenMutation = await request(`/api/v1/workspaces/${config.workspaceId}/settings`, {
        method: 'PATCH',
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            version: settingsBaseline.body.workspace.version,
            settings: {
                about: {
                    injected: 'x',
                },
            },
        }),
    })

    if (forbiddenMutation.response.status !== 400) {
        fail(
            'Workspace settings unknown-key injection',
            forbiddenMutation.response,
            `expected 400, body=${JSON.stringify(forbiddenMutation.body)}`
        )
    }
    logPass('Workspace settings unknown-key injection', `status=${forbiddenMutation.response.status}`)

    const staleReplay = await request(`/api/v1/workspaces/${config.workspaceId}/settings`, {
        method: 'PATCH',
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            version: settingsBaseline.body.workspace.version - 1,
            settings: {
                about: {
                    tagline: 'stale replay attempt',
                },
            },
        }),
    })

    if (![400, 409].includes(staleReplay.response.status)) {
        fail(
            'Workspace settings stale replay',
            staleReplay.response,
            `expected 400 or 409, body=${JSON.stringify(staleReplay.body)}`
        )
    }
    logPass('Workspace settings stale replay', `status=${staleReplay.response.status}`)

    const settingsUnauthorized = await request(`/api/v1/workspaces/${config.workspaceId}/settings`)
    assertNoUnauthorizedLeak('Workspace settings without auth', settingsUnauthorized, [401])
    logPass('Workspace settings without auth', `status=${settingsUnauthorized.response.status}`)
}

async function runConcurrencyProbe(token) {
    logSection('Concurrency Probe')

    const concurrentRequests = 12
    const responses = await Promise.all(
        Array.from({ length: concurrentRequests }, () => request('/api/v1/auth/bootstrap', {
            headers: authHeaders(token),
        }))
    )

    const first = responses[0]
    assertBootstrapPayload('Concurrent baseline bootstrap', first)

    for (const [index, result] of responses.entries()) {
        assertBootstrapPayload(`Concurrent bootstrap #${index + 1}`, result)

        if (result.body.current_workspace_id !== first.body.current_workspace_id) {
            fail(
                `Concurrent bootstrap #${index + 1}`,
                result.response,
                `current workspace drifted from ${first.body.current_workspace_id} to ${result.body.current_workspace_id}`
            )
        }

        if (JSON.stringify(result.body.workspaces) !== JSON.stringify(first.body.workspaces)) {
            fail(
                `Concurrent bootstrap #${index + 1}`,
                result.response,
                'workspace list changed across concurrent requests'
            )
        }
    }

    logPass('Concurrent bootstrap stability', `requests=${concurrentRequests}`)
}

async function runMethodProbe(token) {
    logSection('Method and CORS Probes')

    const headResult = await request('/api/v1/auth/bootstrap', {
        method: 'HEAD',
        headers: authHeaders(token),
    })

    if (![200, 404, 405].includes(headResult.response.status)) {
        fail(
            'HEAD bootstrap probe',
            headResult.response,
            `unexpected status ${headResult.response.status}, body=${JSON.stringify(headResult.body)}`
        )
    }
    if (headResult.response.status !== 200 && unauthorizedLeak(headResult.body)) {
        fail('HEAD bootstrap probe', headResult.response, 'unexpected data leakage on HEAD response')
    }
    logPass('HEAD bootstrap probe', `status=${headResult.response.status}`)

    const optionsResult = await request('/api/v1/auth/bootstrap', {
        method: 'OPTIONS',
        headers: {
            Origin: 'https://attacker.example',
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'authorization',
        },
    })

    if (![200, 204].includes(optionsResult.response.status)) {
        fail(
            'OPTIONS bootstrap probe',
            optionsResult.response,
            `expected 200/204, got ${optionsResult.response.status}, body=${JSON.stringify(optionsResult.body)}`
        )
    }
    if (unauthorizedLeak(optionsResult.body)) {
        fail('OPTIONS bootstrap probe', optionsResult.response, 'unexpected data leakage on CORS preflight')
    }
    logPass('OPTIONS bootstrap probe', `status=${optionsResult.response.status}`)
}

async function main() {
    assertConfig()

    const token = await login()

    await runUnauthorizedProbes()
    await runAuthorizedManipulationProbes(token)
    await runWorkspaceRouteProbes(token)
    await runConcurrencyProbe(token)
    await runMethodProbe(token)

    console.log('\nAuth bootstrap and workspace-route attack simulation completed successfully.')
}

main().catch((error) => {
    console.error('\nAuth bootstrap and workspace-route attack simulation failed.')
    console.error(error.message)
    process.exitCode = 1
})
