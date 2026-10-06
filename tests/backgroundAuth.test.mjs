import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier.startsWith('./') && context.parentURL?.includes('/entrypoints/') && !specifier.endsWith('.ts')) {
            return nextResolve(`${specifier}.ts`, context)
        }
        return nextResolve(specifier, context)
    },
})

async function backgroundFixture(t, suffix) {
    for (const key of ['browser', 'fetch', 'defineBackground']) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, key)
        t.after(() => {
            if (previous) Object.defineProperty(globalThis, key, previous)
            else delete globalThis[key]
        })
    }
    const state = { access_token: 'old-access', refresh_token: 'old-refresh' }
    const calls = []
    const posted = Promise.withResolvers()
    const response = Promise.withResolvers()
    let listener
    globalThis.fetch = async (...args) => { calls.push(args); posted.resolve(); return response.promise }
    globalThis.defineBackground = (initialize) => initialize()
    globalThis.browser = {
        storage: { local: {
            get: async () => ({ ...state }),
            set: async (values) => { Object.assign(state, values) },
        }, onChanged: { addListener() {} } },
        permissions: { contains: async () => true, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
        scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async () => {} },
        runtime: { getManifest: () => ({ manifest_version: 3 }), onMessage: { addListener: (handler) => { listener = handler } } },
        identity: {
            getRedirectURL: () => 'https://extension.test/callback',
            launchWebAuthFlow: ({ url }, callback) => {
                const state = new URL(url).searchParams.get('state')
                callback(`https://extension.test/callback?code=mock-code&state=${state}`)
            },
        },
    }
    await import(`../entrypoints/background.ts?${suffix}`)
    function message(payload) {
        return new Promise((resolve, reject) => {
            const asyncReply = listener(payload, {}, (reply) => resolve({ reply, stored: { ...state } }))
            if (!asyncReply) reject(new Error('background did not accept message'))
        })
    }
    return { state, calls, posted, response, message }
}

test('background shares concurrent refresh messages and persists rotated tokens before either reply', async (t) => {
    const f = await backgroundFixture(t, 'refresh-messages')
    const message = { type: 'REFRESH_TOKEN', payload: { endpoint: 'https://example.test', clientId: 'client', refreshToken: 'old-refresh' } }
    const first = f.message(message)
    const second = f.message(message)
    await f.posted.promise
    assert.equal(f.calls.length, 1)
    assert.equal(f.state.oauth_refresh_in_progress, true)
    const pair = { access_token: 'new-access', refresh_token: 'new-refresh' }
    f.response.resolve(new Response(JSON.stringify(pair)))
    for (const result of await Promise.all([first, second])) {
        assert.deepEqual(result.reply, { success: true, data: pair })
        assert.deepEqual(result.stored, { ...pair, oauth_refresh_in_progress: false })
    }
    assert.deepEqual((await f.message(message)).reply, { success: true, data: pair })
    assert.equal(f.calls.length, 1)
})

test('background authorization-code success and explicit LOGOUT clear the refresh marker', async (t) => {
    const f = await backgroundFixture(t, 'login-logout-messages')
    f.state.oauth_refresh_in_progress = true
    const pair = { access_token: 'login-access', refresh_token: 'login-refresh' }
    f.response.resolve(new Response(JSON.stringify(pair)))
    const login = await f.message({ type: 'START_OAUTH_FLOW', payload: { endpoint: 'https://example.test', clientId: 'client' } })
    assert.deepEqual(login.reply, { success: true, data: pair })
    assert.deepEqual(login.stored, { ...pair, oauth_refresh_in_progress: false })
    f.state.oauth_refresh_in_progress = true
    const logout = await f.message({ type: 'LOGOUT' })
    assert.deepEqual(logout.reply, { success: true })
    assert.deepEqual(logout.stored, { access_token: '', refresh_token: '', oauth_refresh_in_progress: false })
})

test('background logs and replies with the same secret-safe HTTP diagnostic', async (t) => {
    const log = t.mock.method(console, 'error', () => {})
    const f = await backgroundFixture(t, 'refresh-diagnostic-message')
    const pending = f.message({ type: 'REFRESH_TOKEN', payload: { endpoint: 'https://example.test', clientId: 'client', refreshToken: 'old-refresh' } })
    await f.posted.promise
    f.response.resolve(new Response(JSON.stringify({ error: 'unsafe code?token=secret', error_description: 'secret raw body', refresh_token: 'secret-token' }), { status: 503 }))
    const result = await pending
    const diagnostic = 'Failed to refresh token (HTTP 503; OAuth error: server_rejected)'
    assert.deepEqual(result.reply, { success: false, error: diagnostic })
    assert.deepEqual(log.mock.calls[0].arguments, ['Token refresh error:', diagnostic])
    assert.deepEqual(result.stored, { access_token: 'old-access', refresh_token: 'old-refresh', oauth_refresh_in_progress: true })
})
