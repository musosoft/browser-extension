import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
const key = 'custom_integration_domains_v1'
const plane = { integration: 'plane', hostname: 'plane.example.test' }
const jira = { integration: 'jira', hostname: 'jira.example.test' }
const mockModules = {
    './utils/plane': `export const initializePlaneTracking = () => { globalThis.integrationCalls.push('plane:start'); return () => globalThis.integrationCalls.push('plane:stop') };`,
    './utils/linear': `export const isLinearIssuePage = () => false;
        export const removeTimeTrackingSection = () => globalThis.integrationCalls.push('linear:remove');
        export const getLinearIssueInfo = () => null; export const getIssueTitleFromDOM = () => '';
        export const findPropertiesSidebar = () => null; export const waitForElement = async () => null;
        export const injectTimeTrackingSection = async () => {};`,
    './utils/jira': `export const isJiraIssuePage = () => false;
        export const removeJiraTimeTrackingButton = () => globalThis.integrationCalls.push('jira:remove');
        export const getJiraIssueInfo = () => null; export const getIssueTitleFromDOM = () => '';
        export const findJiraActionsWrapper = () => null; export const waitForElement = async () => null;
        export const observeJiraActionsWrapper = () => ({ disconnect() {} }); export const injectJiraTimeTrackingButton = async () => {};`,
}
registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.includes('/entrypoints/content.ts') && mockModules[specifier]) return { url: `data:text/javascript,${encodeURIComponent(mockModules[specifier])}`, shortCircuit: true }
    if (specifier.startsWith('./') && context.parentURL?.includes('/entrypoints/') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context)
    return next(specifier, context)
} })
function globals(t, values) {
    for (const [key, value] of Object.entries(values)) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, key)
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
        t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key])
    }
}

test('content entrypoint routes saved exact host, reacts to edit/removal, and removes listeners on WXT invalidation', async t => {
    const calls = [], storageListeners = new Set(), events = new Set(), pending = Promise.withResolvers()
    const contexts = []
    let definition
    globals(t, {
        integrationCalls: calls,
        defineContentScript: value => { definition = value; return value },
        browser: { storage: { local: { get: () => pending.promise }, onChanged: {
            addListener: listener => storageListeners.add(listener), removeListener: listener => storageListeners.delete(listener),
        } } },
        window: { location: { hostname: plane.hostname, href: `https://${plane.hostname}/issue/1` }, addEventListener: (_type, fn) => events.add(fn), removeEventListener: (_type, fn) => events.delete(fn) },
        document: { body: {}, getElementById: () => null },
        MutationObserver: class { observe() {} disconnect() { calls.push('observer:stop') } },
        fetch: () => { throw Error('No real network permitted') },
    })
    await import('../entrypoints/content.ts?custom-lifecycle')
    function context() {
        const callbacks = []
        const ctx = { isInvalid: false, get isValid() { return !this.isInvalid }, onInvalidated: fn => callbacks.push(fn),
            invalidate() { this.isInvalid = true; callbacks.forEach(fn => fn()) } }
        contexts.push(ctx)
        return ctx
    }
    const first = context(), initial = definition.main(first)
    assert.equal(storageListeners.size, 1)
    // An event arriving before initial read wins and initializes exactly once.
    storageListeners.forEach(listener => listener({ [key]: { newValue: [plane] } }, 'local'))
    pending.resolve({ [key]: [jira] })
    await initial
    assert.deepEqual(calls, ['plane:start'])
    storageListeners.forEach(listener => listener({ [key]: { newValue: [plane] } }, 'local'))
    assert.deepEqual(calls, ['plane:start'])
    storageListeners.forEach(listener => listener({ [key]: { newValue: [{ ...plane, integration: 'jira' }] } }, 'local'))
    assert.deepEqual(calls.slice(0, 3), ['plane:start', 'plane:stop', 'jira:remove'])
    assert.equal(events.size, 1)
    storageListeners.forEach(listener => listener({ [key]: { newValue: [] } }, 'local'))
    assert.equal(events.size, 0)
    first.invalidate()
    assert.equal(storageListeners.size, 0)
    // New/future document reads the saved mapping independently.
    browser.storage.local.get = async () => ({ [key]: [plane] })
    const second = context()
    await definition.main(second)
    assert.equal(calls.at(-1), 'plane:start')
    second.invalidate()
    assert.equal(calls.at(-1), 'plane:stop')
    assert.equal(storageListeners.size, 0)
})

test('background startup/storage/permission reconciliation restores registration and trusts extension pages only', async t => {
    const storageListeners = [], permissionListeners = [], registered = new Map(), state = { [key]: [plane] }
    let messageListener
    const api = {
        runtime: { id: 'test', getURL: path => `chrome-extension://test${path}`, getManifest: () => ({ manifest_version: 3 }),
            onMessage: { addListener: listener => { messageListener = listener } } },
        storage: { local: { get: async () => ({ ...state }), set: async values => Object.assign(state, values) }, onChanged: { addListener: listener => storageListeners.push(listener) } },
        permissions: { contains: async () => true, onAdded: { addListener: listener => permissionListeners.push(listener) }, onRemoved: { addListener: listener => permissionListeners.push(listener) } },
        scripting: { getRegisteredContentScripts: async () => [...registered.values()], registerContentScripts: async scripts => scripts.forEach(script => registered.set(script.id, script)),
            unregisterContentScripts: async ({ ids }) => ids.forEach(id => registered.delete(id)), executeScript: async () => {} },
        tabs: { query: async () => [] },
    }
    globals(t, { browser: api, defineBackground: initialize => initialize(), fetch: () => { throw Error('No real network permitted') } })
    await import('../entrypoints/background.ts?custom-lifecycle')
    const message = { type: 'CUSTOM_DOMAINS_RECONCILE' }
    function reconcile() { return new Promise(resolve => {
        assert.equal(messageListener(message, { id: 'test', url: 'chrome-extension://test/popup.html' }, resolve), true)
    }) }
    assert.deepEqual(await reconcile(), { success: true })
    assert.equal(registered.size, 1)
    assert.equal(messageListener(message, { id: 'test', url: 'https://plane.example.test/' }, () => assert.fail('untrusted callback')), false)
    assert.equal(messageListener(message, { id: 'other', url: 'chrome-extension://test/popup.html' }, () => assert.fail('untrusted callback')), false)
    state[key] = [jira]
    storageListeners.forEach(listener => listener({ [key]: { newValue: [jira] } }, 'local'))
    assert.deepEqual(await reconcile(), { success: true })
    assert.deepEqual([...registered.values()].flatMap(script => script.matches), ['*://jira.example.test/*'])
    api.permissions.contains = async () => false
    permissionListeners.forEach(listener => listener())
    assert.deepEqual(await reconcile(), { success: true })
    assert.equal(registered.size, 0)
})
