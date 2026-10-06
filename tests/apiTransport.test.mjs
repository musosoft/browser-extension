import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { registerHooks } from 'node:module'
import { mock, test } from 'node:test'

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === '@solidtime/api') return nextResolve('@solidtime/api/dist/solidtime-api.js', context)
        if (specifier === './oauth' && context.parentURL?.includes('/entrypoints/utils/api.ts?')) {
            return nextResolve(`./oauth.ts?${new URL(context.parentURL).searchParams.toString()}`, context)
        }
        if (specifier.startsWith('./') && context.parentURL?.includes('/entrypoints/') && !specifier.endsWith('.ts')) {
            return nextResolve(`${specifier}.ts`, context)
        }
        return nextResolve(specifier, context)
    },
})

async function fixture(t, name, respond, { popup = false } = {}) {
    for (const key of ['browser', 'fetch', 'location', 'defineBackground']) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, key)
        t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key])
    }
    const state = {
        instance_endpoint: 'https://custom.example.test/solidtime/', instance_client_id: 'custom-client',
        access_token: 'old-access', refresh_token: 'old-refresh',
    }
    const requests = [], messages = [], listeners = []
    let listener
    const dispatchContext = new AsyncLocalStorage()
    globalThis.defineBackground = (initialize) => initialize()
    Object.defineProperty(globalThis, 'location', { configurable: true,
        value: { href: popup ? 'chrome-extension://solidtime/popup.html' : 'https://plane.example.test/issues/123',
            origin: popup ? 'chrome-extension://solidtime' : 'https://plane.example.test' } })
    globalThis.fetch = mock.fn(async (input, init) => {
        assert.ok(dispatchContext.getStore() === 'background' || popup, 'content script must never call page-origin fetch')
        const request = input instanceof Request ? input : new Request(input, init)
        const captured = { url: request.url, method: request.method, auth: request.headers.get('authorization'),
            body: await request.text(), headers: request.headers }
        requests.push(captured)
        return respond(captured, requests, state)
    })
    globalThis.browser = {
        runtime: {
            getManifest: () => ({ manifest_version: 3 }),
            id: 'solidtime', getURL: (path) => `chrome-extension://solidtime${path}`,
            onMessage: { addListener: (handler) => { listener = handler } },
            sendMessage: (message) => {
                messages.push(message)
                return new Promise((resolve, reject) => {
                    const accepted = dispatchContext.run('background', () => listener(message, { id: 'solidtime', url: location.href }, (reply) => {
                        // Round-trip JSON exactly as Chrome messaging does.
                        resolve(JSON.parse(JSON.stringify(reply)))
                    }))
                    if (accepted !== true) reject(new Error('message not accepted asynchronously'))
                })
            },
        },
        identity: { getRedirectURL: () => 'chrome-extension://solidtime/callback' },
        permissions: { contains: async () => true, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
        scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async () => {} },
        storage: {
            local: {
                get: async () => ({ ...state }),
                set: async (values) => {
                    Object.assign(state, values)
                    for (const callback of listeners) callback(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])), 'local')
                },
            },
            onChanged: { addListener: (callback) => listeners.push(callback) },
        },
    }
    await import(`../entrypoints/background.ts?${name}`)
    const { apiClient } = await import(`../entrypoints/utils/api.ts?${name}`)
    return { client: apiClient(), state, requests, messages, getListener: () => listener }
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'x-test': 'preserved' } })

test('Plane API uses only extension dispatch with configured host, query, auth, JSON body and response', async (t) => {
    const f = await fixture(t, 'plane-wire', () => json({ data: { id: 'mock' } }))
    const response = await f.client.axios.post('/v1/organizations/org/time-entries', { description: 'mock only' }, { params: { page: 2 } })
    assert.deepEqual(response.data, { data: { id: 'mock' } })
    assert.equal(response.headers.get('x-test'), 'preserved')
    assert.equal(f.requests.length, 1)
    assert.equal(f.requests[0].url, 'https://custom.example.test/solidtime/api/v1/organizations/org/time-entries?page=2')
    assert.equal(f.requests[0].auth, 'Bearer old-access')
    assert.equal(f.requests[0].method, 'POST')
    assert.deepEqual(JSON.parse(f.requests[0].body), { description: 'mock only' })
    assert.equal(f.messages[0].type, 'SOLIDTIME_API_REQUEST')
    assert.ok(!JSON.stringify(f.messages).includes('old-access'))
    f.state.instance_endpoint = 'https://changed.example.test'
    assert.deepEqual(await f.client.getMe(), { data: { id: 'mock' } })
    assert.equal(f.requests[1].url, 'https://changed.example.test/api/v1/users/me')
})

test('Plane preserves Axios HTTP errors/data and does not replay non-401 writes', async (t) => {
    const f = await fixture(t, 'plane-http-error', () => json({ message: 'Validation failed', errors: { description: ['invalid'] } }, 422))
    await assert.rejects(f.client.axios.patch('/v1/time-entries/mock', { description: 'mock' }), (error) => {
        assert.equal(error.isAxiosError, true)
        assert.equal(error.response.status, 422)
        assert.deepEqual(error.response.data.errors, { description: ['invalid'] })
        return true
    })
    assert.equal(f.requests.length, 1)
})

test('Plane network failure is secret-safe and never replays an unsafe write', async (t) => {
    const f = await fixture(t, 'plane-network-error', () => { throw new Error('private endpoint/token detail') })
    await assert.rejects(f.client.axios.post('/v1/time-entries', {}), (error) => {
        assert.equal(error.isAxiosError, true)
        assert.equal(error.code, 'ERR_NETWORK')
        assert.equal(error.message, 'Background API request failed')
        return true
    })
    assert.equal(f.requests.length, 1)
})

test('concurrent Plane 401s reuse coordinator once, use custom OAuth endpoint, and retry each once', async (t) => {
    const f = await fixture(t, 'plane-refresh', (request) => {
        if (request.url.endsWith('/oauth/token')) return json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' })
        return request.auth === 'Bearer old-access' ? json({ message: 'Unauthenticated' }, 401) : json({ data: 'ok' })
    })
    const replies = await Promise.all([f.client.axios.get('/v1/users/me'), f.client.axios.get('/v1/users/me')])
    assert.ok(replies.every((response) => response.data.data === 'ok'))
    const refreshes = f.requests.filter((request) => request.url.endsWith('/oauth/token'))
    assert.equal(refreshes.length, 1)
    assert.equal(refreshes[0].url, 'https://custom.example.test/solidtime/oauth/token')
    assert.equal(new URLSearchParams(refreshes[0].body).get('client_id'), 'custom-client')
    assert.equal(f.requests.length, 5)
    assert.equal(f.messages.length, 2, 'no content-side REFRESH_TOKEN or retry message')
})

test('second 401 is terminal: one authenticated retry, no content-side refresh', async (t) => {
    const f = await fixture(t, 'plane-terminal-401', (request) => request.url.endsWith('/oauth/token')
        ? json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' }) : json({ message: 'Denied' }, 401))
    await assert.rejects(f.client.axios.post('/v1/time-entries', {}), (error) => error.response?.status === 401)
    assert.equal(f.requests.length, 3)
    assert.equal(f.messages.length, 1)
})

test('a delayed 401 reuses an already rotated background pair without refreshing it again', async (t) => {
    const f = await fixture(t, 'plane-delayed-401', (request, _calls, state) => {
        if (request.auth === 'Bearer old-access') {
            Object.assign(state, { access_token: 'rotated-access', refresh_token: 'rotated-refresh' })
            return json({}, 401)
        }
        return json({ data: 'ok' })
    })
    assert.deepEqual((await f.client.axios.get('/v1/users/me')).data, { data: 'ok' })
    assert.equal(f.requests.length, 2)
    assert.equal(f.requests[1].auth, 'Bearer rotated-access')
    assert.ok(f.requests.every((request) => !request.url.endsWith('/oauth/token')))
})

test('Plane preserves a successful empty 204 response without replay', async (t) => {
    const f = await fixture(t, 'plane-204', () => new Response(null, { status: 204 }))
    const response = await f.client.axios.delete('/v1/time-entries/mock')
    assert.equal(response.status, 204)
    assert.equal(response.data, '')
    assert.equal(f.requests.length, 1)
})

test('refresh invalid_grant propagates safe diagnostic and clears credentials without retrying the write', async (t) => {
    const f = await fixture(t, 'plane-refresh-error', (request) => request.url.endsWith('/oauth/token')
        ? json({ error: 'invalid_grant', error_description: 'secret' }, 400) : json({}, 401))
    await assert.rejects(f.client.axios.post('/v1/time-entries', {}), /HTTP 400; OAuth error: invalid_grant/)
    assert.equal(f.requests.length, 2)
    assert.equal(f.state.access_token, '')
    assert.equal(f.state.refresh_token, '')
})

test('logout or instance change during a 401 never retries against another account/host', async (t) => {
    for (const change of [{ access_token: '', refresh_token: '' }, { instance_endpoint: 'https://other.example.test' }]) {
        const f = await fixture(t, `plane-revision-${Object.keys(change)[0]}`, (_request, _calls, state) => {
            Object.assign(state, change)
            return json({}, 401)
        })
        await assert.rejects(f.client.axios.post('/v1/time-entries', {}), (error) => error.response?.status === 401)
        assert.equal(f.requests.length, 1)
    }
})

test('background rejects arbitrary hosts, traversal and untrusted sender without network', async (t) => {
    const f = await fixture(t, 'plane-security', () => { throw new Error('must not dispatch') })
    const { createBackgroundApiTransport } = await import('../entrypoints/utils/apiTransport.ts')
    const transport = createBackgroundApiTransport(browser.storage.local, () => { throw new Error('must not refresh') })
    for (const path of ['https://evil.example.test/', '//evil.example.test/', '/../oauth/token', '/%2e%2e/oauth/token', '/\\evil.example.test/']) {
        const reply = await transport({ path, method: 'get', headers: {}, timeout: 30_000 })
        assert.equal(reply.success, false, path)
    }
    assert.equal(f.getListener()({ type: 'SOLIDTIME_API_REQUEST' }, { id: 'other-extension' }, () => {}), false)
    assert.equal(f.requests.length, 0)
})

test('explicit logout queued during refresh prevents API replay and remains authoritative', async (t) => {
    let logout
    const f = await fixture(t, 'plane-session-revision', (request) => {
        if (request.url.endsWith('/oauth/token')) {
            logout = browser.runtime.sendMessage({ type: 'LOGOUT' })
            return json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' })
        }
        return json({}, 401)
    })
    await assert.rejects(f.client.axios.post('/v1/time-entries', {}), (error) => error.response?.status === 401)
    await logout
    assert.equal(f.requests.length, 2)
    assert.equal(f.state.access_token, '')
    assert.equal(f.state.refresh_token, '')
})

test('popup remains direct Axios with no transport messages', async (t) => {
    const f = await fixture(t, 'popup-direct', () => json({ data: 'popup' }), { popup: true })
    const response = await f.client.axios.get('/v1/users/me')
    assert.equal(response.data.data, 'popup')
    assert.equal(f.messages.length, 0)
    assert.equal(f.requests[0].auth, 'Bearer old-access')
})
