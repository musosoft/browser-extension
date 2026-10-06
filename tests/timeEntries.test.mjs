import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { QueryClient } from '@tanstack/vue-query'

// Node 24 strips TypeScript natively; resolve the app's extensionless TS imports.
registerHooks({
    resolve(specifier, context, nextResolve) {
        // Match the ESM entry Vite uses for this package's legacy main/module map.
        if (specifier === '@solidtime/api') {
            return nextResolve('@solidtime/api/dist/solidtime-api.js', context)
        }
        if (specifier.startsWith('./') && context.parentURL?.includes('/entrypoints/utils/') && !specifier.endsWith('.ts')) {
            return nextResolve(`${specifier}.ts`, context)
        }
        return nextResolve(specifier, context)
    },
})

// OAuth installs a storage listener when the real helper module loads.
globalThis.browser = {
    storage: {
        local: { get: async () => ({}) },
        onChanged: { addListener() {} },
    },
}
const { createTimeEntryTableApi, getCurrentTimeEntry } = await import('../entrypoints/utils/timeEntries.ts')
const { createApiClient } = await import('@solidtime/api')

function fixture() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let rows = []
    let organization = 'org-a'
    let failure
    const requests = []
    const client = createApiClient('https://example.test/api', {
        validate: 'none',
        axiosConfig: {
            adapter: async (config) => {
                requests.push(config)
                const error = typeof failure === 'function' ? failure(config) : failure
                if (error) throw error
                const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
                let data
                if (config.method === 'post') {
                    const entry = { ...body, id: 'entry-1', organization_id: 'org-a' }
                    rows = [...rows, entry]
                    data = { data: entry }
                } else if (config.method === 'put') {
                    rows = rows.map((entry) => entry.id === body.id ? { ...entry, ...body } : entry)
                    data = { data: rows[0] }
                } else if (config.method === 'patch') {
                    rows = rows.map((entry) => body.ids.includes(entry.id) ? { ...entry, ...body.changes } : entry)
                    data = { success: 'OK', error: '' }
                } else if (config.method === 'delete') {
                    rows = rows.filter((entry) => !config.url.endsWith(`/${entry.id}`))
                    data = undefined // Real 204 response has no body.
                } else {
                    data = { data: structuredClone(rows) }
                }
                return { data, status: config.method === 'delete' ? 204 : 200, statusText: 'OK', headers: {}, config }
            },
        },
    })
    const key = ['timeEntries', 'org-a']
    const api = createTimeEntryTableApi({ queryClient, getOrganizationId: () => organization, getClient: () => client })
    const load = () => queryClient.fetchQuery({
        queryKey: key,
        queryFn: () => client.getTimeEntries({ params: { organization: 'org-a' } }),
        staleTime: Infinity,
    })
    return { queryClient, key, api, load, requests, setOrganization: (value) => { organization = value }, fail: (error) => { failure = error } }
}

const body = { member_id: 'member-1', start: '2026-10-06T09:00:00Z', end: '2026-10-06T10:00:00Z', description: 'original', billable: false, tags: [] }

test('active timer 404 is treated as the normal idle state; other failures still propagate', async () => {
    const notFound = Object.assign(new Error('Not found'), { response: { status: 404 } })
    const idleClient = { getMyActiveTimeEntry: async () => { throw notFound } }
    assert.deepEqual(await getCurrentTimeEntry(idleClient), { data: null })

    const unauthorized = Object.assign(new Error('Unauthorized'), { response: { status: 401 } })
    const failedClient = { getMyActiveTimeEntry: async () => { throw unauthorized } }
    await assert.rejects(() => getCurrentTimeEntry(failedClient), (error) => error === unauthorized)
})

test('CRUD refreshes the real organization cache after each successful API request (including 204)', async () => {
    const f = fixture()
    try {
        await f.load()
        f.queryClient.setQueryData(['timeEntries', 'org-b'], { data: ['untouched'] })
        const operations = [
            () => f.api.createTimeEntry(body),
            () => f.api.updateTimeEntry({ ...f.queryClient.getQueryData(f.key).data[0], description: 'updated' }),
            () => f.api.updateTimeEntries(['entry-1'], { billable: true }),
            () => f.api.deleteTimeEntries(f.queryClient.getQueryData(f.key).data),
        ]
        for (const [index, operation] of operations.entries()) {
            f.queryClient.setQueryData(['currentTimeEntry'], { data: { id: 'entry-1' } })
            await operation()
            const rows = f.queryClient.getQueryData(f.key).data
            assert.equal(f.queryClient.getQueryState(f.key).isInvalidated, false)
            assert.equal(f.queryClient.getQueryState(['currentTimeEntry']).isInvalidated, true)
            assert.deepEqual(f.queryClient.getQueryData(['timeEntries', 'org-b']), { data: ['untouched'] })
            if (index === 0) assert.equal(rows[0].description, 'original')
            if (index === 1) assert.equal(rows[0].description, 'updated')
            if (index === 2) assert.equal(rows[0].billable, true)
            if (index === 3) assert.deepEqual(rows, [])
        }
        assert.deepEqual(f.requests.map((request) => request.method), ['get', 'post', 'get', 'put', 'get', 'patch', 'get', 'delete', 'get'])
    } finally { f.queryClient.clear() }
})

test('each CRUD failure propagates unchanged without marking caches successful', async () => {
    const f = fixture()
    try {
        await f.load()
        f.queryClient.setQueryData(['currentTimeEntry'], { data: null })
        const error = new Error('server rejected mutation')
        f.fail(error)
        for (const operation of [
            () => f.api.createTimeEntry(body),
            () => f.api.updateTimeEntry({ ...body, id: 'entry-1' }),
            () => f.api.updateTimeEntries(['entry-1'], { billable: true }),
            () => f.api.deleteTimeEntries([{ id: 'entry-1' }]),
        ]) {
            await assert.rejects(operation, (actual) => actual === error)
            assert.deepEqual(f.queryClient.getQueryData(f.key), { data: [] })
            assert.equal(f.queryClient.getQueryState(f.key).isInvalidated, false)
            assert.equal(f.queryClient.getQueryState(['currentTimeEntry']).isInvalidated, false)
        }
        assert.equal(f.requests.filter((request) => request.method === 'get').length, 1)
    } finally { f.queryClient.clear() }
})

test('a selection change in flight still refreshes the mutation organization', async () => {
    const f = fixture()
    try {
        await f.load()
        const mutation = f.api.createTimeEntry(body)
        f.setOrganization('org-b')
        await mutation
        assert.equal(f.queryClient.getQueryData(f.key).data.length, 1)
        assert.ok(f.requests.every((request) => request.url.includes('/organizations/org-a/')))
    } finally { f.queryClient.clear() }
})

test('partial deletion refreshes completed writes and propagates the later failure', async () => {
    const f = fixture()
    try {
        await f.load()
        await f.api.createTimeEntry(body)
        const error = new Error('second delete rejected')
        f.fail((config) => config.url.endsWith('/entry-2') ? error : undefined)
        await assert.rejects(
            () => f.api.deleteTimeEntries([{ id: 'entry-1' }, { id: 'entry-2' }]),
            (actual) => actual === error,
        )
        assert.deepEqual(f.queryClient.getQueryData(f.key), { data: [] })
    } finally { f.queryClient.clear() }
})

test('missing organization rejects before issuing an API request', async () => {
    const f = fixture()
    try {
        f.setOrganization(null)
        await assert.rejects(() => f.api.createTimeEntry(body), /No current organization id/)
        assert.equal(f.requests.length, 0)
    } finally { f.queryClient.clear() }
})
