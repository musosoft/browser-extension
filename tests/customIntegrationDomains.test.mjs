import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
registerHooks({ resolve(specifier, context, next) {
    if (specifier.startsWith('./') && context.parentURL?.includes('/entrypoints/') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context)
    return next(specifier, context)
} })
const rules = await import('../entrypoints/utils/customIntegrationDomainRules.ts')
const { createCustomIntegrationDomains } = await import('../entrypoints/utils/customIntegrationDomains.ts')
const { createCustomIntegrationRegistration, CONTENT_BUNDLE, CUSTOM_SCRIPT_PREFIX } = await import('../entrypoints/utils/customIntegrationRegistration.ts')
const { CUSTOM_INTEGRATION_DOMAINS_KEY: key, CUSTOM_DOMAINS_RECONCILE: messageType, validateCustomIntegrationDomains: validate,
    integrationForHostname: route, createIntegrationRouter } = rules
const plane = { integration: 'plane', hostname: 'plane.example.test' }
const jira = { integration: 'jira', hostname: 'jira.example.test' }

function fixture(version = 3, domains = [plane, jira]) {
    const state = { [key]: domains }, calls = [], listeners = []
    let grants = true, response = { success: true }
    const scripts = new Map(), registrations = new Map()
    let tabs = [{ id: 1, url: 'https://plane.example.test/issue/1' }, { id: 2, url: 'https://jira.example.test/browse/KEY-1' },
        { id: 3, url: 'https://sub.plane.example.test/issue/1' }, { id: 4, url: 'https://plane.example.test.evil.test/issue/1' }]
    const api = {
        runtime: { getManifest: () => ({ manifest_version: version }), sendMessage: async message => { calls.push(['message', message]); return response } },
        storage: { local: { get: async () => ({ ...state }), set: async values => { calls.push(['save', values]); Object.assign(state, values); emit(values) } },
            onChanged: { addListener: listener => listeners.push(listener) } },
        permissions: { request: async value => { calls.push(['request', value]); return grants }, contains: async value => { calls.push(['contains', value]); return grants } },
        scripting: {
            getRegisteredContentScripts: async () => [...scripts.values()],
            registerContentScripts: async values => { calls.push(['register', values]); for (const value of values) { assert.ok(!scripts.has(value.id)); scripts.set(value.id, value) } },
            unregisterContentScripts: async ({ ids }) => { calls.push(['unregister', ids]); ids.forEach(id => scripts.delete(id)) },
            executeScript: async value => { calls.push(['inject', value]) },
        },
        contentScripts: { register: async value => { calls.push(['firefox-register', value]); const id = value.matches[0]; registrations.set(id, value);
            return { unregister: async () => { calls.push(['firefox-unregister', id]); registrations.delete(id) } } } },
        tabs: { query: async value => { calls.push(['query', value]); return tabs }, executeScript: async (id, value) => { calls.push(['firefox-inject', id, value]) } },
    }
    function emit(values, area = 'local') { listeners.forEach(listener => listener(Object.fromEntries(Object.entries(values).map(([k, newValue]) => [k, { newValue }])), area)) }
    return { api, state, calls, scripts, registrations, emit, setGrants: value => { grants = value }, setResponse: value => { response = value }, setTabs: value => { tabs = value } }
}

test('hostname validation canonicalizes, deduplicates, rejects ambiguity and built-in collisions', () => {
    assert.deepEqual(validate([{ ...plane, hostname: ' Plane.Example.Test ' }, plane, jira]), [jira, plane])
    for (const hostname of ['https://plane.example.test', 'plane.example.test/path', 'plane.example.test:443', '*.example.test',
        '127.0.0.1', '[::1]', '0x7f000001', '2130706433', 'localhost', 'foo.local', 'foo.localhost', '-foo.example.test',
        'foo-.example.test', 'foo..example.test', 'foo.example.test.', 'foo_bar.example.test', 'foo@bar.example.test',
        'foo%2ebar.example.test', 'foo example.test', 'linear.app', 'app.linear.app', 'atlassian.net', 'tenant.atlassian.net', 'app.plane.so']) {
        assert.throws(() => validate([{ ...plane, hostname }]), undefined, hostname)
    }
    assert.throws(() => validate([{ ...plane, integration: 'linear' }]))
    assert.throws(() => validate([plane, { ...plane, integration: 'jira' }]))
    assert.throws(() => validate([{ ...plane, hostname: `${'a'.repeat(64)}.example.test` }]))
    assert.throws(() => validate({}))
    assert.deepEqual(rules.readCustomIntegrationDomains([{ hostname: '*', integration: 'plane' }]), [])
})

test('routing preserves static default rules and custom sites route to exactly the configured integration', () => {
    for (const host of ['linear.app', 'app.linear.app']) assert.equal(route(host, []), 'linear')
    assert.equal(route('tenant.atlassian.net', []), 'jira')
    assert.equal(route('app.plane.so', []), 'plane')
    assert.equal(route(plane.hostname, [plane]), 'plane')
    assert.equal(route(plane.hostname, [{ ...plane, integration: 'jira' }]), 'jira')
    for (const host of ['evil-linear.app', 'linear.app.evil.test', 'atlassian.net.evil.test', 'evil-atlassian.net', 'sub.plane.example.test']) assert.equal(route(host, [plane, jira]), undefined)
    assert.equal(route(plane.hostname, []), undefined, 'custom hosts require explicit saved configuration')
})

test('Save requests exact Chrome origins synchronously before hydration, then persists and reconciles', async () => {
    const f = fixture(), settings = createCustomIntegrationDomains(f.api)
    const saved = settings.saveCustomIntegrationDomains([plane])
    assert.deepEqual(f.calls[0], ['request', { origins: ['*://plane.example.test/*'] }])
    await saved
    assert.deepEqual(f.state[key], [plane])
    assert.deepEqual(f.calls.filter(call => ['save', 'message'].includes(call[0])).map(call => call[0]), ['save', 'message'])
    assert.deepEqual(f.calls.at(-1), ['message', { type: messageType }])
    assert.deepEqual(settings.customIntegrationDomains.value, [plane])
})

test('invalid input, denied permission and storage failures do not persist mappings or reconcile', async () => {
    const f = fixture(), settings = createCustomIntegrationDomains(f.api)
    await assert.rejects(settings.saveCustomIntegrationDomains([{ ...plane, hostname: '*.example.test' }]))
    assert.deepEqual(f.calls, [])
    f.setGrants(false)
    await assert.rejects(settings.saveCustomIntegrationDomains([plane]), /Site access is unavailable/)
    assert.ok(!f.calls.some(call => call[0] === 'save' || call[0] === 'message'))
    f.setGrants(true)
    f.api.storage.local.set = async () => { throw Error('storage failed') }
    await assert.rejects(settings.saveCustomIntegrationDomains([plane]), /storage failed/)
    assert.ok(!f.calls.some(call => call[0] === 'message'))
})

test('Firefox Save checks existing required host access without requesting undeclared optional access', async () => {
    const f = fixture(2), settings = createCustomIntegrationDomains(f.api)
    await settings.saveCustomIntegrationDomains([plane])
    assert.deepEqual(f.calls[0], ['contains', { origins: ['*://plane.example.test/*'] }])
    assert.ok(!f.calls.some(call => call[0] === 'request'))
    f.setGrants(false)
    await assert.rejects(settings.saveCustomIntegrationDomains([jira]), /extension settings/)
    assert.deepEqual(f.state[key], [plane])
})

test('failed Save restores prior mappings and reconciles them, including rejected messages', async () => {
    for (const rejectMessage of [false, true]) {
        const f = fixture(), settings = createCustomIntegrationDomains(f.api)
        let messages = 0
        f.api.runtime.sendMessage = async () => {
            if (++messages === 1) {
                if (rejectMessage) throw Error('background unavailable')
                return { success: false, error: 'registration unavailable' }
            }
            return { success: true }
        }
        await assert.rejects(settings.saveCustomIntegrationDomains([plane]), /unavailable/)
        assert.deepEqual(f.state[key], [jira, plane])
        assert.deepEqual(settings.customIntegrationDomains.value, [jira, plane])
        assert.equal(messages, 2)
    }
})

test('failed Save does not overwrite a concurrent newer mapping; rollback failure is explicit', async () => {
    const f = fixture(), settings = createCustomIntegrationDomains(f.api)
    f.api.runtime.sendMessage = async () => {
        await f.api.storage.local.set({ [key]: [jira] })
        throw Error('registration unavailable')
    }
    await assert.rejects(settings.saveCustomIntegrationDomains([plane]), /registration unavailable/)
    assert.deepEqual(f.state[key], [jira])
    assert.deepEqual(settings.customIntegrationDomains.value, [jira])

    const broken = fixture(), brokenSettings = createCustomIntegrationDomains(broken.api)
    broken.setResponse({ success: false })
    await assert.rejects(brokenSettings.saveCustomIntegrationDomains([plane]), /restoration could not be completed/)
})

test('successful Save does not overwrite newer reactive storage events', async () => {
    const f = fixture(), settings = createCustomIntegrationDomains(f.api)
    f.api.runtime.sendMessage = async () => {
        await f.api.storage.local.set({ [key]: [jira] })
        return { success: true }
    }
    await settings.saveCustomIntegrationDomains([plane])
    assert.deepEqual(settings.customIntegrationDomains.value, [jira])
})

test('reactive saved mappings hydrate without writing and late hydration cannot erase new storage events', async () => {
    const f = fixture(), pending = Promise.withResolvers()
    f.api.storage.local.get = () => pending.promise
    const settings = createCustomIntegrationDomains(f.api)
    f.emit({ [key]: [plane] })
    pending.resolve({ [key]: [jira] })
    await settings.customIntegrationDomainsReady
    assert.deepEqual(settings.customIntegrationDomains.value, [plane])
    f.emit({ [key]: [jira] }, 'sync')
    assert.deepEqual(settings.customIntegrationDomains.value, [plane])
    f.emit({ [key]: undefined })
    assert.deepEqual(settings.customIntegrationDomains.value, [])
    assert.deepEqual(f.calls, [])
})

test('Chrome registration is exact, persistent, idempotent, and injects only matching existing tabs', async () => {
    const f = fixture(), manager = createCustomIntegrationRegistration(f.api)
    await manager.reconcile()
    assert.equal(f.scripts.size, 2)
    for (const script of f.scripts.values()) {
        assert.equal(script.persistAcrossSessions, true)
        assert.equal(script.allFrames, false)
        assert.equal(script.runAt, 'document_idle')
        assert.deepEqual(script.js, [CONTENT_BUNDLE])
        assert.equal(script.matches.length, 1)
        assert.match(script.matches[0], /^\*:\/\/(plane|jira)\.example\.test\/\*$/)
    }
    assert.deepEqual(f.calls.filter(call => call[0] === 'inject').map(call => call[1].target.tabId), [1, 2])
    await Promise.all([manager.reconcile(), manager.reconcile()])
    assert.equal(f.calls.filter(call => call[0] === 'register').length, 1)
    assert.equal(f.calls.filter(call => call[0] === 'inject').length, 2, 'no duplicate runtime initialization on unchanged saves')
    await createCustomIntegrationRegistration(f.api).reconcile()
    assert.equal(f.calls.filter(call => call[0] === 'register').length, 1, 'restart adopts persistent Chrome registrations')
    assert.equal(f.calls.filter(call => call[0] === 'inject').length, 2, 'worker restart does not reinject persistent registrations')
})

test('Chrome reconciles stale owned registrations, changed mappings, removals, permission revocation and malformed storage', async () => {
    const f = fixture(), manager = createCustomIntegrationRegistration(f.api)
    f.scripts.set('unrelated', { id: 'unrelated', matches: ['https://unrelated.test/*'] })
    f.scripts.set(CUSTOM_SCRIPT_PREFIX + plane.hostname, { id: CUSTOM_SCRIPT_PREFIX + plane.hostname, matches: ['<all_urls>'] })
    await manager.reconcile()
    assert.ok(f.scripts.has('unrelated'))
    f.state[key] = [{ ...plane, integration: 'jira' }]
    await manager.reconcile()
    assert.equal(f.scripts.size, 2)
    assert.equal(f.calls.filter(call => call[0] === 'inject' && call[1].target.tabId === 1).length, 2, 'mapping changes affect open tabs')
    f.setGrants(false)
    await manager.reconcile()
    assert.deepEqual([...f.scripts.keys()], ['unrelated'])
    f.setGrants(true)
    f.state[key] = [{ ...plane, hostname: '*.example.test' }]
    await manager.reconcile()
    assert.deepEqual([...f.scripts.keys()], ['unrelated'])
})

test('Firefox MV2 registers packaged files, unregisters removals and restores registration after restart', async () => {
    const f = fixture(2), manager = createCustomIntegrationRegistration(f.api)
    await manager.reconcile()
    assert.equal(f.registrations.size, 2)
    for (const value of f.registrations.values()) {
        assert.deepEqual(value.js, [{ file: '/' + CONTENT_BUNDLE }])
        assert.equal(value.runAt, 'document_idle')
        assert.equal(value.allFrames, false)
    }
    assert.deepEqual(f.calls.filter(call => call[0] === 'firefox-inject').map(call => call[1]), [1, 2])
    await manager.reconcile()
    assert.equal(f.calls.filter(call => call[0] === 'firefox-register').length, 2)
    f.state[key] = [plane]
    await manager.reconcile()
    assert.equal(f.registrations.size, 1)
    await createCustomIntegrationRegistration(f.api).reconcile()
    assert.equal(f.calls.filter(call => call[0] === 'firefox-register').length, 3, 'persistent background restores registrations from saved mapping')
})

test('failed registration rejects reconciliation but queued later reconciliation can recover; disappearing tabs are harmless', async () => {
    const f = fixture(), manager = createCustomIntegrationRegistration(f.api)
    const register = f.api.scripting.registerContentScripts
    f.api.scripting.registerContentScripts = async () => { throw Error('blocked') }
    await assert.rejects(manager.reconcile(), /blocked/)
    f.api.scripting.registerContentScripts = register
    f.api.scripting.executeScript = async () => { throw Error('tab closed') }
    await manager.reconcile()
    assert.equal(f.scripts.size, 2)
})

test('document router initializes once, responds to mapping changes/removal, and starts on future page loads', () => {
    const calls = []
    const start = integration => { calls.push(['start', integration]); return () => calls.push(['stop', integration]) }
    const router = createIntegrationRouter(start)
    router.update(plane.hostname, [plane]); router.update(plane.hostname, [plane])
    router.update(plane.hostname, [{ ...plane, integration: 'jira' }])
    router.update(plane.hostname, [])
    router.stop()
    assert.deepEqual(calls, [['start', 'plane'], ['stop', 'plane'], ['start', 'jira'], ['stop', 'jira']])
    const futureDocument = createIntegrationRouter(start)
    futureDocument.update(plane.hostname, [plane])
    futureDocument.stop()
    assert.deepEqual(calls.slice(-2), [['start', 'plane'], ['stop', 'plane']])
})

test('production Chrome and Firefox artifacts retain static defaults, exact bundle, and only necessary new permissions', async t => {
    const expected = ['*://linear.app/*', '*://app.linear.app/*', '*://*.atlassian.net/*', '*://app.plane.so/*'].sort()
    // Deliberately compose the obsolete hostname so this regression test is not
    // itself a hardcoded source-host exception.
    const obsolete = ['plane', 'musosoft', 'com'].join('.')
    for (const [target, version] of [['chrome-mv3', 3], ['firefox-mv2', 2]]) {
        const dir = new URL(`../.output/${target}/`, import.meta.url)
        let manifest
        try { manifest = JSON.parse(await readFile(new URL('manifest.json', dir), 'utf8')) }
        catch (error) { if (error.code === 'ENOENT') { t.skip('Run both production builds before artifact audit'); return } throw error }
        assert.equal(manifest.manifest_version, version)
        assert.deepEqual(manifest.content_scripts.flatMap(script => script.matches).sort(), expected)
        assert.deepEqual(manifest.content_scripts.flatMap(script => script.js), [CONTENT_BUNDLE])
        assert.deepEqual([...manifest.permissions].sort(), (version === 3 ? ['storage', 'identity', 'scripting'] : ['storage', 'identity', '<all_urls>']).sort())
        if (version === 3) assert.deepEqual(manifest.host_permissions, ['<all_urls>'])
        assert.equal(manifest.optional_host_permissions, undefined, 'no widened or redundant optional host access')
        assert.equal(manifest.optional_permissions, undefined)
        if (version === 2) assert.notEqual(manifest.background.persistent, false, 'legacy Firefox registration must belong to persistent background')
        for (const path of ['manifest.json', 'background.js', CONTENT_BUNDLE]) assert.ok(!(await readFile(new URL(path, dir), 'utf8')).includes(obsolete), path)
    }
    async function audit(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
            if (entry.isDirectory()) await audit(path)
            else if (/\.(?:ts|vue|mjs|json)$/.test(entry.name)) assert.ok(!(await readFile(path, 'utf8')).includes(obsolete), path.href)
        }
    }
    await audit(new URL('../entrypoints/', import.meta.url))
    await audit(new URL('./', import.meta.url))
})
