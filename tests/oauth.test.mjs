import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mock, test } from 'node:test'

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier.startsWith('./') && context.parentURL?.includes('/entrypoints/utils/') && !specifier.endsWith('.ts')) {
            return nextResolve(`${specifier}.ts`, context)
        }
        return nextResolve(specifier, context)
    },
})

test('late initial token snapshot cannot overwrite a newer storage token event', async (t) => {
    const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
    t.after(() => {
        if (previousBrowser) Object.defineProperty(globalThis, 'browser', previousBrowser)
        else delete globalThis.browser
    })

    const snapshot = Promise.withResolvers()
    const listeners = new Set()
    const get = mock.fn(() => snapshot.promise)
    globalThis.browser = {
        storage: {
            local: { get, set: mock.fn(async () => {}), remove: mock.fn(async () => {}) },
            onChanged: {
                addListener: (listener) => listeners.add(listener),
                removeListener: (listener) => listeners.delete(listener),
            },
        },
        runtime: { sendMessage: mock.fn(async () => ({})), lastError: undefined },
        identity: { getRedirectURL: mock.fn(() => 'https://extension.test/callback') },
    }

    const oauth = await import('../entrypoints/utils/oauth.ts?initial-token-race')
    assert.equal(get.mock.callCount(), 2)
    assert.ok(get.mock.calls.some((call) => JSON.stringify(call.arguments) === JSON.stringify([['access_token', 'refresh_token']])))
    assert.equal(listeners.size, 2)

    for (const listener of listeners) {
        listener({
            access_token: { newValue: 'fresh-access-token' },
            refresh_token: { newValue: 'fresh-refresh-token' },
        }, 'local')
    }

    const tokenState = () => ({
        isLoggedIn: oauth.isLoggedIn.value,
        accessToken: oauth.accessToken.value,
        refreshToken: oauth.refreshToken.value,
    })
    const expected = {
        isLoggedIn: true,
        accessToken: 'fresh-access-token',
        refreshToken: 'fresh-refresh-token',
    }
    assert.deepEqual(tokenState(), expected, 'new storage event logs the user in before the initial read completes')

    // loadTokens registered its await before this test: resolving the deferred
    // read runs its continuation before ours, without timers or polling.
    snapshot.resolve({})
    await snapshot.promise

    assert.deepEqual(tokenState(), expected, 'late empty initial snapshot must preserve the newer tokens and logged-in state')
})

async function callerFixture(t, suffix, initial = { access_token: 'old-access', refresh_token: 'old-refresh' }) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'browser')
    t.after(() => {
        if (previous) Object.defineProperty(globalThis, 'browser', previous)
        else delete globalThis.browser
    })
    const listeners = new Set()
    const local = { get: mock.fn(async () => ({
        ...initial,
        instance_endpoint: 'https://app.solidtime.io',
        instance_client_id: '019b27e8-a52a-71d8-8d67-071cff97f315',
    })), set: mock.fn(async () => {}), remove: mock.fn(async () => {}) }
    const sendMessage = mock.fn(async () => ({ success: true, data: { access_token: 'new-access', refresh_token: 'new-refresh' } }))
    globalThis.browser = {
        storage: { local, onChanged: { addListener: (listener) => listeners.add(listener) } },
        runtime: { sendMessage },
        identity: { getRedirectURL: () => 'https://extension.test/callback' },
    }
    const oauth = await import(`../entrypoints/utils/oauth.ts?${suffix}`)
    return { oauth, local, sendMessage, listeners }
}

test('refresh caller sends its observed token and updates only memory from the background reply', async (t) => {
    const f = await callerFixture(t, 'refresh-caller')
    await f.oauth.refreshAccessToken()
    assert.equal(f.sendMessage.mock.calls[0].arguments[0].payload.refreshToken, 'old-refresh')
    assert.equal(f.oauth.accessToken.value, 'new-access')
    assert.equal(f.oauth.refreshToken.value, 'new-refresh')
    assert.equal(f.local.set.mock.callCount(), 0)
    assert.equal(f.local.remove.mock.callCount(), 0)
})

test('refresh failures preserve caller credentials; only background storage events clear them', async (t) => {
    const f = await callerFixture(t, 'refresh-failure')
    f.sendMessage.mock.mockImplementation(async () => ({ success: false, error: 'Failed to refresh token (HTTP 503; OAuth error: server_rejected)' }))
    await assert.rejects(f.oauth.refreshAccessToken(), /HTTP 503/)
    assert.equal(f.oauth.accessToken.value, 'old-access')
    assert.equal(f.oauth.refreshToken.value, 'old-refresh')
    assert.equal(f.local.set.mock.callCount(), 0)
    assert.equal(f.local.remove.mock.callCount(), 0)
    for (const listener of f.listeners) listener({ access_token: { newValue: '' }, refresh_token: { newValue: '' } }, 'local')
    assert.equal(f.oauth.isLoggedIn.value, false)
})

test('missing refresh token does not cause a caller storage mutation', async (t) => {
    const f = await callerFixture(t, 'missing-refresh', {})
    await assert.rejects(f.oauth.refreshAccessToken(), /No refresh token/)
    assert.equal(f.sendMessage.mock.callCount(), 0)
    assert.equal(f.local.remove.mock.callCount(), 0)
})

test('logout delegates credential mutation to background', async (t) => {
    const f = await callerFixture(t, 'logout-caller')
    await f.oauth.logout()
    assert.deepEqual(f.sendMessage.mock.calls[0].arguments, [{ type: 'LOGOUT' }])
    assert.equal(f.oauth.isLoggedIn.value, false)
    assert.equal(f.local.remove.mock.callCount(), 0)
})

test('a delayed refresh reply cannot overwrite a newer login/logout storage event', async (t) => {
    const f = await callerFixture(t, 'refresh-reply-race')
    const reply = Promise.withResolvers()
    f.sendMessage.mock.mockImplementation(() => reply.promise)
    const pending = f.oauth.refreshAccessToken()
    for (const listener of f.listeners) listener({ access_token: { newValue: 'login-access' }, refresh_token: { newValue: 'login-refresh' } }, 'local')
    reply.resolve({ success: true, data: { access_token: 'stale-access', refresh_token: 'stale-refresh' } })
    await pending
    assert.equal(f.oauth.accessToken.value, 'login-access')
    assert.equal(f.oauth.refreshToken.value, 'login-refresh')
})
