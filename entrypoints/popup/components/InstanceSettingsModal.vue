<script setup lang="ts">
import {
    Modal,
    PrimaryButton,
    SecondaryButton,
    TextInput,
    InputLabel,
} from "@solidtime/ui";
import { endpoint, clientId, waitForSettings } from "../../utils/oauth";
import {
    customIntegrationDomains,
    customIntegrationDomainsReady,
    saveCustomIntegrationDomains,
    type CustomIntegrationDomain,
} from "../../utils/customIntegrationDomains";
import { ref, watch, onUnmounted } from "vue";

const props = defineProps({
    show: {
        type: Boolean,
        default: false,
    },
    maxWidth: {
        type: String,
        default: "2xl",
    },
    closeable: {
        type: Boolean,
        default: true,
    },
});

const emit = defineEmits(["close"]);

const tempEndpoint = ref("");
const tempClientId = ref("");
const tempCustomDomains = ref("");
const customDomainsError = ref<string | null>(null);
const saving = ref(false);
const settingsLoaded = ref(false);
const settingsError = ref<string | null>(null);
let hydrationGeneration = 0;

watch(() => props.show, async (show) => {
    const generation = ++hydrationGeneration;
    settingsLoaded.value = false;
    settingsError.value = null;
    customDomainsError.value = null;
    tempEndpoint.value = "";
    tempClientId.value = "";
    tempCustomDomains.value = "";
    if (!show) return;

    try {
        await Promise.all([waitForSettings(), customIntegrationDomainsReady]);
        if (generation !== hydrationGeneration || !props.show) return;
        tempEndpoint.value = endpoint.value;
        tempClientId.value = clientId.value;
        tempCustomDomains.value = customIntegrationDomains.value
            .map(({ integration, hostname }) => `${integration}: ${hostname}`)
            .join("\n");
        settingsLoaded.value = true;
    } catch {
        if (generation !== hydrationGeneration || !props.show) return;
        settingsError.value = "Could not load instance settings or custom domains. Close and reopen this window to try again.";
    }
}, { immediate: true, flush: "sync" });

onUnmounted(() => { ++hydrationGeneration; });

const close = () => {
    if (saving.value) return;
    ++hydrationGeneration;
    settingsLoaded.value = false;
    emit("close");
};

async function submit() {
    if (!props.show || !settingsLoaded.value || saving.value) return;
    customDomainsError.value = null;
    const domains: CustomIntegrationDomain[] = [];
    for (const [index, line] of tempCustomDomains.value.split(/\r?\n/).entries()) {
        if (!line.trim()) continue;
        const match = line.trim().match(/^(plane|jira):\s*([^\s:/?#*]+)$/);
        if (!match) {
            customDomainsError.value = `Line ${index + 1}: use plane: hostname or jira: hostname, without a URL, path or wildcard.`;
            return;
        }
        domains.push({ integration: match[1] as CustomIntegrationDomain["integration"], hostname: match[2] });
    }
    saving.value = true;
    try {
        // Call before the first await to preserve the Save user gesture for permissions.
        await saveCustomIntegrationDomains(domains);
    } catch {
        customDomainsError.value = "Could not save custom domains. Check hostname formatting and verify that the extension has access to these sites in your browser’s extension settings, then try again.";
        return;
    } finally {
        saving.value = false;
    }
    // remove last character if it is a slash
    if (tempEndpoint.value[tempEndpoint.value.length - 1] === "/") {
        tempEndpoint.value = tempEndpoint.value.slice(0, -1);
    }
    endpoint.value = tempEndpoint.value;
    clientId.value = tempClientId.value;
    close();
}
</script>

<template>
    <Modal
        :show="show"
        :maxWidth="maxWidth"
        :closeable="closeable && !saving"
        @close="close"
    >
        <div class="px-6 py-4">
            <div class="text-lg font-medium text-white" role="heading">
                Instance Settings
            </div>

            <div class="mt-4 text-sm text-muted">
                Configure your Solidtime instance endpoint and client ID. These
                settings are only needed if you're using a self-hosted instance.
            </div>
            <p v-if="settingsError" role="alert" class="mt-4 text-sm text-muted">{{ settingsError }}</p>
            <p v-else-if="!settingsLoaded" role="status" class="mt-4 text-sm text-muted">Loading instance settings…</p>

            <div class="mt-4 text-sm text-muted flex flex-col justify-center">
                <InputLabel
                    for="instanceEndpoint"
                    value="Solidtime Instance Endpoint"
                />
                <TextInput
                    id="instanceEndpoint"
                    v-model="tempEndpoint"
                    name="instanceEndpoint"
                    type="text"
                    class="mt-2 block w-full"
                    required
                    :disabled="!settingsLoaded || saving"
                    @keydown.enter="submit()"
                />
            </div>

            <div class="mt-4 text-sm text-muted flex flex-col justify-center">
                <InputLabel
                    for="clientId"
                    value="Solidtime Instance Client Id"
                />
                <TextInput
                    id="clientId"
                    v-model="tempClientId"
                    name="clientId"
                    type="text"
                    class="mt-2 block w-full"
                    required
                    :disabled="!settingsLoaded || saving"
                    @keydown.enter="submit()"
                />
            </div>

            <div class="mt-5 text-sm flex flex-col">
                <InputLabel for="customIntegrationDomains" value="Custom integration domains" />
                <p id="customDomainsHelp" class="mt-2 text-muted leading-relaxed">
                    Map one exact hostname per line to Plane or Jira. Repeat an integration for multiple hosts.
                    Use hostnames only—no URL, scheme, path or wildcards. Linear custom domains are not supported.
                </p>
                <textarea
                    id="customIntegrationDomains"
                    v-model="tempCustomDomains"
                    name="customIntegrationDomains"
                    rows="4"
                    spellcheck="false"
                    autocapitalize="none"
                    autocomplete="off"
                    :disabled="!settingsLoaded || saving"
                    :aria-invalid="Boolean(customDomainsError)"
                    :aria-describedby="customDomainsError ? 'customDomainsHelp customDomainsExample customDomainsError' : 'customDomainsHelp customDomainsExample'"
                    class="mt-3 block w-full resize-y rounded-lg border border-card-background-separator bg-default-background px-3 py-2.5 font-mono text-sm leading-relaxed text-white placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-white/50 disabled:opacity-50 disabled:cursor-not-allowed"
                    placeholder="plane: plane.example.com&#10;jira: jira.example.com"
                />
                <p id="customDomainsExample" class="mt-2 text-xs text-muted">
                    Example: <code>plane: plane.example.com</code> or <code>jira: jira.example.com</code>.
                    Chrome may ask you to allow access to these sites when saving. Check your browser’s extension settings if access is blocked.
                </p>
                <p v-if="customDomainsError" id="customDomainsError" role="alert" class="mt-2 text-sm text-red-400">
                    {{ customDomainsError }}
                </p>
            </div>

            <div class="flex justify-start mt-4">
                <button
                    type="button"
                    :disabled="!settingsLoaded || saving"
                    @click="
                        tempEndpoint = 'https://app.solidtime.io';
                        tempClientId = '9c994748-c593-4a6d-951b-6849c829bc4e';
                    "
                    class="text-sm text-muted hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    Reset to defaults
                </button>
            </div>
        </div>

        <div
            class="flex flex-row justify-end px-6 py-4 border-t space-x-2 border-card-background-separator bg-default-background rounded-b-2xl text-end"
        >
            <SecondaryButton :disabled="saving" @click="close">Cancel</SecondaryButton>
            <PrimaryButton :disabled="!settingsLoaded || saving" @click="submit">{{ saving ? 'Saving…' : 'Save' }}</PrimaryButton>
        </div>
    </Modal>
</template>
