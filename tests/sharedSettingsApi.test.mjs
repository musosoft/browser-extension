import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mock, test } from 'node:test'

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === '@solidtime/api') return nextResolve('@solidtime/api/dist/solidtime-api.js', context)
        if (specifier === './oauth' && context.parentURL?.includes('/entrypoints/utils/api.ts?')) {
            return nextResolve(`./oauth.ts?${new URL(context.parentURL).searchParams.toString()}`, context)
        }
        if (specifier.startsWith('./') && context.parentURL?.includes('/entrypoints/utils/') && !specifier.endsWith('.ts')) {
            return nextResolve(`${specifier}.ts`, context)
        }
        return nextResolve(specifier, context)
    },
})

const custom = { instance_endpoint: 'https://solidtime.example.test', instance_client_id: 'custom-client' }
async function fixture(t, name, { popup = false, deferred, shared = custom, legacy = {} } = {}) {
    for (const key of ['browser', 'location', 'localStorage']) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, key)
        t.after(() => {
            if (previous) Object.defineProperty(globalThis, key, previous)
            else delete globalThis[key]
        })
    }
    const state = { ...shared, access_token: 'current-access', refresh_token: 'current-refresh' }
    const listeners = new Set()
    const writes = []
    const sendMessage = mock.fn((message, callback) => {
        const reply = { success: true, data: { access_token: 'rotated-access', refresh_token: 'rotated-refresh' } }
        if (callback) callback(reply)
        else return Promise.resolve(reply)
    })
    const readLegacy = mock.fn((key) => legacy[key] ?? null)
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: popup ? 'https://extension.test' : 'https://plane.example.test' } })
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: readLegacy } })
    globalThis.browser = {
        runtime: { getURL: () => 'https://extension.test/', sendMessage },
        storage: {
            local: {
                get: async (keys) => keys.includes('instance_endpoint') && deferred ? deferred.promise : { ...state },
                set: async (values) => { writes.push({ ...values }); Object.assign(state, values); emit(values) },
                remove: mock.fn(async () => {}),
            },
            onChanged: { addListener: (listener) => listeners.add(listener) },
        },
        identity: { getRedirectURL: () => 'https://extension.test/callback' },
    }
    function emit(values) {
        for (const listener of listeners) listener(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])), 'local')
    }
    const oauth = await import(`../entrypoints/utils/oauth.ts?${name}`)
    const { apiClient } = await import(`../entrypoints/utils/api.ts?${name}`)
    const client = apiClient()
    const requests = []
    client.axios.defaults.adapter = async (config) => {
        requests.push(config)
        return { config, status: 200, statusText: 'OK', headers: {}, data: {} }
    }
    return { state, writes, requests, client, oauth, emit, sendMessage, readLegacy }
}

test('content API waits for shared settings and uses latest host and token at each dispatch', async (t) => {
    const deferred = Promise.withResolvers()
    const f = await fixture(t, 'dispatch', { deferred, legacy: { instance_endpoint: 'https://wrong-page.example.test' } })
    const first = f.client.axios.get('/me')
    await Promise.resolve()
    assert.equal(f.requests.length, 0)
    deferred.resolve(custom)
    await first
    assert.equal(f.requests[0].baseURL, 'https://solidtime.example.test/api')
    assert.equal(f.requests[0].headers.Authorization, 'Bearer current-access')
    assert.equal(f.readLegacy.mock.callCount(), 0)
    f.emit({ instance_endpoint: 'https://new.example.test', access_token: 'newer-access' })
    await f.client.axios.get('/me')
    assert.equal(f.requests[1].baseURL, 'https://new.example.test/api')
    assert.equal(f.requests[1].headers.Authorization, 'Bearer newer-access')
})

test('content refresh waits for shared custom endpoint and client ID', async (t) => {
    const deferred = Promise.withResolvers()
    const f = await fixture(t, 'refresh-settings', { deferred })
    const refreshed = f.oauth.refreshAccessToken()
    assert.equal(f.sendMessage.mock.callCount(), 0)
    deferred.resolve(custom)
    await refreshed
    assert.deepEqual(f.sendMessage.mock.calls[0].arguments[0], {
        type: 'REFRESH_TOKEN', payload: { endpoint: custom.instance_endpoint, clientId: custom.instance_client_id, refreshToken: 'current-refresh' },
    })
    assert.deepEqual(f.writes, [])
})

test('OAuth start persists current popup settings before sending the background message', async (t) => {
    const f = await fixture(t, 'start-settings', { popup: true, shared: {}, legacy: {
        instance_endpoint: JSON.stringify(custom.instance_endpoint), instance_client_id: JSON.stringify(custom.instance_client_id),
    } })
    f.oauth.endpoint.value = 'https://edited.example.test'
    f.oauth.clientId.value = 'edited-client'
    f.sendMessage.mock.mockImplementation((message, callback) => {
        assert.equal(f.state.instance_endpoint, 'https://edited.example.test')
        assert.equal(f.state.instance_client_id, 'edited-client')
        assert.deepEqual(message.payload, { endpoint: f.state.instance_endpoint, clientId: f.state.instance_client_id })
        callback({ success: true, data: { access_token: 'login-access', refresh_token: 'login-refresh' } })
    })
    await f.oauth.startOAuthFlow()
    assert.equal(f.sendMessage.mock.calls[0].arguments[0].type, 'START_OAUTH_FLOW')
    assert.ok(f.writes.every((write) => !('access_token' in write) && !('refresh_token' in write)))
})

test('missing shared configuration blocks API and refresh without logging out', async (t) => {
    const f = await fixture(t, 'missing-settings', { shared: {} })
    await assert.rejects(f.client.axios.get('/me'), /open the extension popup/)
    await assert.rejects(f.oauth.refreshAccessToken(), /open the extension popup/)
    assert.equal(f.requests.length, 0)
    assert.equal(f.sendMessage.mock.callCount(), 0)
    assert.equal(f.oauth.accessToken.value, 'current-access')
    assert.equal(f.oauth.refreshToken.value, 'current-refresh')
    assert.deepEqual(f.writes, [])
    f.emit(custom)
    await f.client.axios.get('/me')
    assert.equal(f.requests[0].baseURL, 'https://solidtime.example.test/api')
})

test('popup 401 retry refreshes against the shared host and dispatches with the rotated auth header', async (t) => {
    const f = await fixture(t, 'retry-settings', { popup: true })
    f.client.axios.defaults.adapter = async (config) => {
        f.requests.push(config)
        if (!config._retry) throw { config, response: { status: 401 } }
        return { config, status: 200, statusText: 'OK', headers: {}, data: {} }
    }
    await f.client.axios.get('/me')
    assert.equal(f.requests.length, 2)
    assert.equal(f.requests[1].baseURL, 'https://solidtime.example.test/api')
    assert.equal(f.requests[1].headers.Authorization, 'Bearer rotated-access')
    assert.equal(f.sendMessage.mock.calls[0].arguments[0].payload.endpoint, custom.instance_endpoint)
    assert.equal(f.sendMessage.mock.calls[0].arguments[0].payload.clientId, custom.instance_client_id)
    assert.deepEqual(f.writes, [])
})

test('shared-settings read failure blocks dispatch without clearing credentials or exposing storage errors', async (t) => {
    const deferred = Promise.withResolvers()
    const f = await fixture(t, 'failed-settings-read', { deferred })
    const request = f.client.axios.get('/me')
    deferred.reject(new Error('private storage details'))
    await assert.rejects(request, { message: 'Unable to load instance settings' })
    assert.equal(f.requests.length, 0)
    assert.equal(f.sendMessage.mock.callCount(), 0)
    assert.equal(f.oauth.accessToken.value, 'current-access')
    assert.equal(f.oauth.refreshToken.value, 'current-refresh')
    assert.deepEqual(f.writes, [])
})
