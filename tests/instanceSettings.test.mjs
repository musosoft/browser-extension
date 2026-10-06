import assert from 'node:assert/strict'
import { test } from 'node:test'

const { createInstanceSettings } = await import('../entrypoints/utils/instanceSettings.ts')
const custom = { instance_endpoint: 'https://solidtime.example.test', instance_client_id: 'self-hosted-client' }

function fixture({ shared = {}, origin = 'https://extension.test', extensionURL = 'https://extension.test/', legacy = {}, deferred } = {}) {
    const state = { ...shared }
    const writes = []
    const legacyReads = []
    const listeners = new Set()
    const browser = {
        runtime: { getURL: () => extensionURL },
        storage: {
            local: {
                get: async () => deferred ? deferred.promise : { ...state },
                set: async (values) => { writes.push({ ...values }); Object.assign(state, values); emit(values) },
            },
            onChanged: { addListener: (listener) => listeners.add(listener) },
        },
    }
    function emit(values, area = 'local') {
        for (const listener of listeners) listener(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])), area)
    }
    const settings = createInstanceSettings(browser, {
        origin,
        readLegacy: (key) => { legacyReads.push(key); return legacy[key] ?? null },
    })
    return { state, writes, legacyReads, emit, settings, storage: browser.storage.local }
}

test('extension pages migrate JSON-serialized legacy custom settings without deleting legacy data', async () => {
    const legacy = Object.fromEntries(Object.entries(custom).map(([key, value]) => [key, JSON.stringify(value)]))
    const f = fixture({ legacy })
    await f.settings.settingsReady
    assert.equal(f.settings.endpoint.value, custom.instance_endpoint)
    assert.equal(f.settings.clientId.value, custom.instance_client_id)
    assert.deepEqual(f.state, custom)
    assert.deepEqual(f.writes, [custom])
    assert.equal(legacy.instance_endpoint, JSON.stringify(custom.instance_endpoint))
})

test('already shared settings win over legacy popup values and are not rewritten', async () => {
    const f = fixture({ shared: custom, legacy: { instance_endpoint: JSON.stringify('https://old.example.test') } })
    await f.settings.settingsReady
    assert.equal(f.settings.endpoint.value, custom.instance_endpoint)
    assert.deepEqual(f.writes, [])
})

test('content scripts use shared custom settings and never read page localStorage', async () => {
    const f = fixture({ shared: custom, origin: 'https://plane.example.test', legacy: { instance_endpoint: 'https://malicious.example.test' } })
    await f.settings.settingsReady
    assert.equal(f.settings.endpoint.value, custom.instance_endpoint)
    assert.equal(f.settings.clientId.value, custom.instance_client_id)
    assert.deepEqual(f.legacyReads, [])
    assert.deepEqual(f.writes, [])
    f.emit({ instance_endpoint: 'https://changed.example.test', instance_client_id: 'changed-client' })
    assert.equal(f.settings.endpoint.value, 'https://changed.example.test')
    assert.equal(f.settings.clientId.value, 'changed-client')
    assert.deepEqual(f.writes, [], 'storage events must not echo into writes')
})

test('a late initial read cannot overwrite newer setting events or migrate stale defaults', async () => {
    const deferred = Promise.withResolvers()
    const f = fixture({ deferred })
    f.emit(custom)
    deferred.resolve({})
    await f.settings.settingsReady
    assert.equal(f.settings.endpoint.value, custom.instance_endpoint)
    assert.equal(f.settings.clientId.value, custom.instance_client_id)
    assert.deepEqual(f.writes, [])
})

test('popup edits before hydration survive and persist only after initial shared load', async () => {
    const deferred = Promise.withResolvers()
    const f = fixture({ deferred })
    f.settings.endpoint.value = custom.instance_endpoint
    f.settings.clientId.value = custom.instance_client_id
    assert.deepEqual(f.writes, [])
    deferred.resolve({ instance_endpoint: 'https://older.example.test', instance_client_id: 'older-client' })
    await f.settings.persistSettings()
    assert.deepEqual(f.state, custom)
    assert.deepEqual(f.writes, [custom])
})

test('malformed legacy JSON falls back safely; raw legacy strings remain compatible', async () => {
    const invalid = fixture({ legacy: { instance_endpoint: '"unterminated', instance_client_id: '{"not":"a string"}' } })
    await invalid.settings.settingsReady
    assert.equal(invalid.settings.endpoint.value, 'https://app.solidtime.io')
    assert.equal(invalid.settings.clientId.value, '019b27e8-a52a-71d8-8d67-071cff97f315')
    const raw = fixture({ legacy: custom })
    await raw.settings.settingsReady
    assert.deepEqual(raw.state, custom)
})

test('missing shared settings in content fail closed without reading page settings or writing tokens', async () => {
    const f = fixture({ origin: 'https://plane.example.test' })
    await assert.rejects(f.settings.waitForSettings(), /open the extension popup/)
    assert.deepEqual(f.writes, [])
    assert.deepEqual(f.legacyReads, [])
})

test('initial revisions are per setting, so untouched settings still hydrate after a newer event', async () => {
    const deferred = Promise.withResolvers()
    const f = fixture({ deferred, origin: 'https://plane.example.test' })
    f.emit({ instance_endpoint: 'https://newer.example.test' })
    deferred.resolve(custom)
    await f.settings.waitForSettings()
    assert.equal(f.settings.endpoint.value, 'https://newer.example.test')
    assert.equal(f.settings.clientId.value, custom.instance_client_id)
    assert.deepEqual(f.writes, [])
})

test('popup storage events update refs without writing defaults or echoing changes', async () => {
    const f = fixture({ shared: custom })
    await f.settings.settingsReady
    f.emit({ instance_endpoint: 'https://updated.example.test', instance_client_id: 'updated-client' })
    await f.settings.persistSettings()
    assert.equal(f.settings.endpoint.value, 'https://updated.example.test')
    assert.equal(f.settings.clientId.value, 'updated-client')
    assert.deepEqual(f.writes, [])
})

test('Chrome and Firefox extension origins permit migration but page and null origins do not', async () => {
    for (const scheme of ['chrome-extension', 'moz-extension']) {
        const origin = `${scheme}://extension-id`
        const popup = fixture({ origin, extensionURL: `${origin}/popup.html`, legacy: custom })
        await popup.settings.waitForSettings()
        assert.deepEqual(popup.state, custom)
        const page = fixture({ origin: 'https://plane.example.test', extensionURL: `${origin}/popup.html`, shared: custom })
        await page.settings.waitForSettings()
        assert.deepEqual(page.legacyReads, [])
        const opaque = fixture({ origin: 'null', extensionURL: `${origin}/popup.html`, shared: custom })
        await opaque.settings.waitForSettings()
        assert.deepEqual(opaque.legacyReads, [])
    }
})

test('a pending popup write and its storage event cannot erase a newer popup edit', async () => {
    const f = fixture({ shared: custom })
    await f.settings.settingsReady
    const started = Promise.withResolvers()
    const finish = Promise.withResolvers()
    const set = f.storage.set
    let calls = 0
    f.storage.set = async (values) => {
        if (++calls === 1) { started.resolve(); await finish.promise }
        return set(values)
    }
    f.settings.endpoint.value = 'https://first.example.test'
    await started.promise
    f.settings.endpoint.value = 'https://latest.example.test'
    finish.resolve()
    await f.settings.persistSettings()
    assert.equal(f.settings.endpoint.value, 'https://latest.example.test')
    assert.equal(f.state.instance_endpoint, 'https://latest.example.test')
    assert.deepEqual(f.writes, [
        { instance_endpoint: 'https://first.example.test' },
        { instance_endpoint: 'https://latest.example.test' },
    ])
})
