import { apiClient } from './api'
import type {
    CreateTimeEntryBody,
    TimeEntry,
    UpdateMultipleTimeEntriesChangeset,
} from '@solidtime/api'
import { QueryClient, useMutation, useQueryClient } from '@tanstack/vue-query'
import { useMyMemberships } from './myMemberships'

// The generated API type has a passthrough index signature, so Omit alone loses
// the required fields. Retain them explicitly for table-created entries.
export type CreateTableTimeEntryBody = Omit<CreateTimeEntryBody, 'member_id'> &
    Pick<CreateTimeEntryBody, 'start' | 'billable'>

/** Table writes must not apply the running timer's optimistic updates. */
export function createTimeEntryTableApi({
    queryClient,
    getOrganizationId,
    getClient = apiClient,
}: {
    queryClient: QueryClient
    getOrganizationId: () => string | null | undefined
    getClient?: typeof apiClient
}) {
    function organizationId() {
        const id = getOrganizationId()
        if (!id) throw new Error('No current organization id - mutate time entry')
        return id
    }

    async function refresh(organization: string) {
        // Capture the organization before the request: selection can change in flight.
        // Refresh inactive caches too, so reopening the table cannot show stale rows.
        await Promise.all([
            queryClient.invalidateQueries({
                queryKey: ['timeEntries', organization],
                refetchType: 'all',
            }),
            queryClient.invalidateQueries({ queryKey: ['currentTimeEntry'] }),
        ])
    }

    return {
        async createTimeEntry(entry: CreateTimeEntryBody) {
            const organization = organizationId()
            const response = await getClient().createTimeEntry(entry, {
                params: { organization },
            })
            await refresh(organization)
            return response
        },
        async updateTimeEntry(entry: TimeEntry) {
            const organization = organizationId()
            const response = await getClient().updateTimeEntry(entry, {
                params: { organization, timeEntry: entry.id },
            })
            await refresh(organization)
            return response
        },
        async updateTimeEntries(ids: string[], changes: UpdateMultipleTimeEntriesChangeset) {
            const organization = organizationId()
            const response = await getClient().updateMultipleTimeEntries(
                { ids, changes },
                { params: { organization } }
            )
            await refresh(organization)
            return response
        },
        async deleteTimeEntries(entries: TimeEntry[]) {
            const organization = organizationId()
            const client = getClient()
            for (const entry of entries) {
                // DELETE returns 204/void; do not inspect response.data.
                await client.deleteTimeEntry(undefined, {
                    params: { organization, timeEntry: entry.id },
                })
                // Also reconcile successful deletes if a later delete fails.
                await refresh(organization)
            }
        },
    }
}

export function useTimeEntryTableMutations() {
    const queryClient = useQueryClient()
    const { currentOrganizationId, currentMembership } = useMyMemberships()
    const api = createTimeEntryTableApi({
        queryClient,
        getOrganizationId: () => currentOrganizationId.value,
    })

    return {
        ...api,
        async createTimeEntry(entry: CreateTableTimeEntryBody) {
            const memberId = currentMembership.value?.id
            if (!memberId) throw new Error('No current membership id - create time entry')
            return api.createTimeEntry({ ...entry, member_id: memberId })
        },
    }
}

export const emptyTimeEntry = {
    id: '',
    description: null,
    user_id: '',
    start: '',
    end: null,
    duration: null,
    task_id: null,
    project_id: null,
    tags: [],
    billable: false,
    organization_id: '',
} as TimeEntry

const offlineUuidStore = {} as Record<string, string>

export async function getCurrentTimeEntry(client = apiClient()) {
    try {
        return await client.getMyActiveTimeEntry({})
    } catch (error) {
        // Solidtime returns 404 when the user has no active timer; that is the
        // normal idle state, not a failed status lookup.
        if (typeof error === 'object' && error !== null &&
            'response' in error &&
            (error as { response?: { status?: unknown } }).response?.status === 404) {
            // Preserve the generated client's response envelope; popup,
            // Linear, Jira, and Plane consumers read `.data`.
            return { data: null }
        }
        throw error
    }
}

export function useTimeEntryStopMutation() {
    const queryClient = useQueryClient()
    const { currentOrganizationId } = useMyMemberships()

    return useMutation({
        scope: {
            id: 'timeEntry',
        },
        mutationFn: (timeEntry: TimeEntry) => {
            if (currentOrganizationId.value === null) {
                throw new Error('No current organization id - create time entry')
            }
            if (timeEntry.id === '') {
                throw new Error('No time entry id - stop time entry')
            }
            if (timeEntry.id in offlineUuidStore) {
                timeEntry.id = offlineUuidStore[timeEntry.id]
            }
            const client = apiClient()
            return client.updateTimeEntry(
                { ...timeEntry },
                {
                    params: {
                        organization: currentOrganizationId.value,
                        timeEntry: timeEntry.id,
                    },
                }
            )
        },
        onMutate: async (timeEntry: TimeEntry) => {
            await queryClient.cancelQueries({ queryKey: ['timeEntries', currentOrganizationId] })
            await queryClient.cancelQueries({ queryKey: ['currentTimeEntry'] })

            queryClient.setQueryData(['currentTimeEntry'], () => emptyTimeEntry)

            return { timeEntry }
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['timeEntries', currentOrganizationId] })
            queryClient.invalidateQueries({ queryKey: ['currentTimeEntry'] })
        },
    })
}

export function useCurrentTimeEntryUpdateMutation() {
    const queryClient = useQueryClient()
    const { currentOrganizationId } = useMyMemberships()

    return useMutation({
        scope: {
            id: 'timeEntry',
        },
        mutationFn: (timeEntry: TimeEntry) => {
            if (currentOrganizationId.value === null) {
                throw new Error('No current organization id - update time entry')
            }
            if (timeEntry.id === '') {
                throw new Error('No time entry id - update time entry')
            }
            if (offlineUuidStore[timeEntry.id]) {
                timeEntry.id = offlineUuidStore[timeEntry.id]
            }
            const client = apiClient()
            return client.updateTimeEntry(timeEntry, {
                params: {
                    organization: currentOrganizationId.value,
                    timeEntry: timeEntry.id,
                },
            })
        },
        onMutate: async (variables) => {
            await queryClient.cancelQueries({ queryKey: ['currentTimeEntry'] })
            const optimisticTimeEntry = { data: { ...variables } }
            queryClient.setQueryData(['currentTimeEntry'], () => optimisticTimeEntry)
            return { optimisticTimeEntry }
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['timeEntries', currentOrganizationId] })
            queryClient.invalidateQueries({ queryKey: ['currentTimeEntry'] })
        },
    })
}

export function useTimeEntryCreateMutation() {
    const queryClient = useQueryClient()
    const { currentOrganizationId } = useMyMemberships()

    return useMutation({
        scope: {
            id: 'timeEntry',
        },
        mutationFn: (timeEntry: CreateTimeEntryBody) => {
            if (currentOrganizationId.value === null) {
                throw new Error('No current organization id - create time entry')
            }
            const client = apiClient()
            return client.createTimeEntry(timeEntry, {
                params: {
                    organization: currentOrganizationId.value,
                },
            })
        },
        onMutate: async (variables) => {
            await queryClient.cancelQueries({ queryKey: ['currentTimeEntry'] })
            const optimisticTimeEntry = {
                data: {
                    ...variables,
                    organization_id: currentOrganizationId.value,
                    id: self.crypto.randomUUID(),
                },
            }
            queryClient.setQueryData(['currentTimeEntry'], () => optimisticTimeEntry)
            return { optimisticTimeEntry }
        },
        onSuccess: (data, _, context) => {
            offlineUuidStore[context.optimisticTimeEntry.data.id] = data.data.id
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['timeEntries', currentOrganizationId] })
            queryClient.invalidateQueries({ queryKey: ['currentTimeEntry'] })
        },
    })
}
