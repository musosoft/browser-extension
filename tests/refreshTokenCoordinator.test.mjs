import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier.startsWith('./') && context.parentURL?.includes('/entrypoints/utils/') && !specifier.endsWith('.ts')) {
            return nextResolve(`${specifier}.ts`, context)
        }
        return nextResolve(specifier, context)
    },
})
const { createRefreshTokenCoordinator } = await import('../entrypoints/utils/refreshTokenCoordinator.ts')

const oldPair = { access_token: 'old-access', refresh_token: 'old-refresh' }
const newPair = { access_token: 'new-access', refresh_token: 'new-refresh' }
const request = { endpoint: 'https://example.test', clientId: 'client', refreshToken: oldPair.refresh_token }

function fixture(timeoutMs) {
    const state = { ...oldPair }
    const writes = []
    const calls = []
    const posted = Promise.withResolvers()
    const response = Promise.withResolvers()
    const storage = {
        async get() { return { ...state } },
        async set(values) { writes.push({ ...values }); Object.assign(state, values) },
    }
    const fetch = async (...args) => {
        calls.push(args)
        assert.equal(state.oauth_refresh_in_progress, true, 'marker must be persisted before POST')
        posted.resolve()
        return response.promise
    }
    return { state, writes, calls, posted, response, storage, fetch,
        coordinator: createRefreshTokenCoordinator(storage, fetch, timeoutMs) }
}

test('concurrent same-token callers share one POST and receive the persisted rotated pair', async () => {
    const f = fixture()
    const first = f.coordinator.refresh(request)
    const second = f.coordinator.refresh({ ...request })
    await f.posted.promise
    assert.equal(f.calls.length, 1)
    const replies = [first, second].map(async (reply) => {
        const pair = await reply
        assert.deepEqual(pair, newPair)
        assert.deepEqual(f.state, { ...newPair, oauth_refresh_in_progress: false })
    })
    f.response.resolve(new Response(JSON.stringify(newPair)))
    await Promise.all(replies)
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.writes.at(-1), { ...newPair, oauth_refresh_in_progress: false })
    assert.deepEqual(await f.coordinator.refresh(request), newPair, 'stale caller receives latest pair')
    assert.equal(f.calls.length, 1, 'stale token must not be posted again')
})

test('only a definitive invalid_grant for the still-current token clears credentials', async () => {
    for (const status of [400, 401]) {
        const f = fixture()
        const result = f.coordinator.refresh(request)
        await f.posted.promise
        f.response.resolve(new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'secret' }), { status }))
        await assert.rejects(result, { message: `Failed to refresh token (HTTP ${status}; OAuth error: invalid_grant)` })
        assert.deepEqual(f.state, { access_token: '', refresh_token: '', oauth_refresh_in_progress: false })
    }
})

test('invalid_grant from an old request returns a newer stored pair instead of clearing it', async () => {
    const f = fixture()
    const result = f.coordinator.refresh(request)
    await f.posted.promise
    Object.assign(f.state, newPair, { oauth_refresh_in_progress: false })
    f.response.resolve(new Response('{"error":"invalid_grant"}', { status: 400 }))
    assert.deepEqual(await result, newPair)
    assert.deepEqual(f.state, { ...newPair, oauth_refresh_in_progress: false })
    assert.equal(f.writes.length, 1, 'no credential write after the rejection')
})

test('ambiguous failures preserve credentials and marker; a restarted worker cannot replay', async () => {
    const scenarios = [
        { network: true, message: 'Token refresh request failed' },
        { status: 503, body: '{"error":"invalid_grant"}', message: 'Failed to refresh token (HTTP 503; OAuth error: invalid_grant)' },
        { status: 429, body: '{"error":"temporarily_unavailable"}', message: 'Failed to refresh token (HTTP 429; OAuth error: temporarily_unavailable)' },
        { status: 400, body: '{"error":"invalid_client"}', message: 'Failed to refresh token (HTTP 400; OAuth error: invalid_client)' },
        { status: 400, body: 'secret raw body', message: 'Failed to refresh token (HTTP 400; OAuth error: server_rejected)' },
        { status: 200, body: 'secret malformed JSON', message: 'Invalid token refresh response' },
        { status: 200, body: '{"access_token":"secret-partial-token"}', message: 'Invalid token refresh response' },
    ]
    for (const scenario of scenarios) {
        const f = fixture()
        const result = f.coordinator.refresh(request)
        await f.posted.promise
        if (scenario.network) f.response.reject(new Error('secret request URL https://private.example?token=secret'))
        else f.response.resolve(new Response(scenario.body, { status: scenario.status }))
        await assert.rejects(result, { message: scenario.message })
        assert.deepEqual(f.state, { ...oldPair, oauth_refresh_in_progress: true })
        const restarted = createRefreshTokenCoordinator(f.storage, f.fetch)
        await assert.rejects(restarted.refresh(request), { message: 'Token refresh outcome unknown; sign in again' })
        await assert.rejects(f.coordinator.refresh(request), { message: 'Token refresh outcome unknown; sign in again' })
        assert.equal(f.calls.length, 1)
        assert.deepEqual(f.state, { ...oldPair, oauth_refresh_in_progress: true })
    }
})

test('a marker surviving worker termination before the reply blocks replay', async () => {
    const f = fixture()
    f.state.oauth_refresh_in_progress = true
    await assert.rejects(f.coordinator.refresh(request), { message: 'Token refresh outcome unknown; sign in again' })
    assert.equal(f.calls.length, 0)
    Object.assign(f.state, newPair)
    assert.deepEqual(await f.coordinator.refresh(request), newPair, 'stale caller gets the latest pair even with a marker')
    assert.equal(f.calls.length, 0)
})

test('fresh OAuth login and explicit logout atomically clear an unresolved marker', async () => {
    const f = fixture()
    f.state.oauth_refresh_in_progress = true
    await f.coordinator.login(newPair)
    assert.deepEqual(f.state, { ...newPair, oauth_refresh_in_progress: false })
    assert.deepEqual(f.writes.at(-1), { ...newPair, oauth_refresh_in_progress: false })
    f.state.oauth_refresh_in_progress = true
    await f.coordinator.logout()
    assert.deepEqual(f.state, { access_token: '', refresh_token: '', oauth_refresh_in_progress: false })
    assert.equal(f.calls.length, 0)
})

test('logout and fresh login cannot be overwritten by an earlier in-flight refresh', async () => {
    for (const operation of ['logout', 'login']) {
        const f = fixture()
        const refreshed = f.coordinator.refresh(request)
        await f.posted.promise
        const loginPair = { access_token: 'login-access', refresh_token: 'login-refresh' }
        const mutated = operation === 'logout' ? f.coordinator.logout() : f.coordinator.login(loginPair)
        f.response.resolve(new Response(JSON.stringify(newPair)))
        await Promise.all([refreshed, mutated])
        assert.deepEqual(f.state, { ...(operation === 'logout' ? { access_token: '', refresh_token: '' } : loginPair), oauth_refresh_in_progress: false })
    }
})

test('storage failures never expose raw details and never POST without a persisted marker', async () => {
    const f = fixture()
    f.storage.set = async () => { throw new Error('secret storage detail') }
    await assert.rejects(f.coordinator.refresh(request), { message: 'Token storage operation failed' })
    assert.equal(f.calls.length, 0)
    assert.deepEqual(f.state, oldPair)
})

test('failed rotated-pair persistence retains the marker and blocks another POST', async () => {
    const f = fixture()
    const set = f.storage.set
    f.storage.set = async (values) => {
        if (values.access_token) throw new Error('secret storage detail')
        return set(values)
    }
    const result = f.coordinator.refresh(request)
    await f.posted.promise
    f.response.resolve(new Response(JSON.stringify(newPair)))
    await assert.rejects(result, { message: 'Token storage operation failed' })
    assert.deepEqual(f.state, { ...oldPair, oauth_refresh_in_progress: true })
    await assert.rejects(f.coordinator.refresh(request), /outcome unknown/)
    assert.equal(f.calls.length, 1)
})

test('unreadable rejection bodies are sanitized and retain credentials and marker', async () => {
    const f = fixture()
    const result = f.coordinator.refresh(request)
    await f.posted.promise
    f.response.resolve({ ok: false, status: 400, text: async () => { throw new Error('secret body detail') } })
    await assert.rejects(result, { message: 'Failed to refresh token (HTTP 400; OAuth error: server_rejected)' })
    assert.deepEqual(f.state, { ...oldPair, oauth_refresh_in_progress: true })
})

test('missing credentials and malformed fresh login do not POST or mutate credentials', async () => {
    const f = fixture()
    Object.assign(f.state, { access_token: '', refresh_token: '', oauth_refresh_in_progress: true })
    await assert.rejects(f.coordinator.refresh(request), /No refresh token/)
    await assert.rejects(f.coordinator.login({ access_token: 'partial' }), /Invalid OAuth token response/)
    assert.equal(f.calls.length, 0)
    assert.equal(f.writes.length, 0)
    assert.deepEqual(f.state, { access_token: '', refresh_token: '', oauth_refresh_in_progress: true })
})

test('timeout aborts a hung refresh, retains the marker, and prevents retry or late persistence', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const f = fixture(25)
    const result = f.coordinator.refresh(request)
    const rejected = assert.rejects(result, { message: 'Token refresh request timed out' })
    await f.posted.promise
    const signal = f.calls[0][1].signal
    assert.equal(signal?.aborted, false)
    t.mock.timers.tick(25)
    await rejected
    assert.equal(signal.aborted, true)
    assert.deepEqual(f.state, { ...oldPair, oauth_refresh_in_progress: true })
    await assert.rejects(f.coordinator.refresh(request), /outcome unknown/)
    const restarted = createRefreshTokenCoordinator(f.storage, f.fetch, 25)
    await assert.rejects(restarted.refresh(request), /outcome unknown/)
    assert.equal(f.calls.length, 1)
    await f.coordinator.login(newPair)
    f.response.resolve(new Response(JSON.stringify(oldPair)))
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(f.state, { ...newPair, oauth_refresh_in_progress: false })
    assert.equal(f.writes.length, 2, 'a fetch ignoring abort cannot persist a late response')
})

test('timeout releases queued explicit login and logout even when fetch ignores abort', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    for (const operation of ['login', 'logout']) {
        const f = fixture(25)
        const rejected = assert.rejects(f.coordinator.refresh(request), /request timed out/)
        await f.posted.promise
        const queued = operation === 'login' ? f.coordinator.login(newPair) : f.coordinator.logout()
        assert.deepEqual(f.state, { ...oldPair, oauth_refresh_in_progress: true })
        t.mock.timers.tick(25)
        await rejected
        await queued
        assert.deepEqual(f.state, { ...(operation === 'login' ? newPair : { access_token: '', refresh_token: '' }), oauth_refresh_in_progress: false })
        assert.equal(f.calls.length, 1)
    }
})

test('timeout also bounds a hung response-body read and cannot later clear credentials', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const f = fixture(25)
    const bodyStarted = Promise.withResolvers()
    const body = Promise.withResolvers()
    const rejected = assert.rejects(f.coordinator.refresh(request), /request timed out/)
    await f.posted.promise
    f.response.resolve({ ok: false, status: 400, text: () => { bodyStarted.resolve(); return body.promise } })
    await bodyStarted.promise
    t.mock.timers.tick(25)
    await rejected
    assert.deepEqual(f.state, { ...oldPair, oauth_refresh_in_progress: true })
    await f.coordinator.login(newPair)
    body.resolve('{"error":"invalid_grant"}')
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(f.state, { ...newPair, oauth_refresh_in_progress: false })
    assert.equal(f.writes.length, 2)
})
