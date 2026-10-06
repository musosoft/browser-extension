import { apiClient } from "./api";
import { getCurrentTimeEntry } from "./timeEntries";
import { accessToken } from "./oauth";
import { dayjs } from "./dayjs";
import { watch } from "vue";
import { planeTimerDiagnostic, planeTimerActionError } from "./planeDiagnostics";
import {
  PLANE_CARD_LINK, planeRoute, planeIssueFromLink, planeIssueFromCard,
  planeTimerState, changePlaneTimer,
  type PlaneIssue, type PlaneActiveEntry,
} from "./planeIssue";

const CONTROL = "data-solidtime-plane-control";

export function findPlaneActionsWrapper(): HTMLElement | null {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === "Add relation",
  );
  return button?.closest<HTMLElement>(".flex.items-center.flex-wrap.gap-2") ?? null;
}

/** One lifecycle for cards and details, including detail overlays on the board URL. */
export function initializePlaneTracking() {
  let active: PlaneActiveEntry | null = null;
  let ready = false;
  let busy = false;
  let refreshPending: Promise<void> | null = null;
  let scheduled = false;
  let disposed = false;
  let errorMessage = "";
  let refreshDiagnostic = "";
  const controls = new Map<HTMLElement, { issue: PlaneIssue; button: HTMLButtonElement; status: HTMLElement }>();

  function setText(element: HTMLElement, text: string) {
    if (element.textContent !== text) element.textContent = text;
  }

  function render() {
    for (const { issue, button, status } of controls.values()) {
      const state = planeTimerState(active, issue);
      const label = !accessToken.value ? "Sign in to Solidtime" : !ready ? "Check timer" :
        state === "tracking" ? "■ Stop tracking" : state === "blocked" ? "Timer in use" : "▶ Track time";
      setText(button, busy ? "Updating…" : label);
      button.disabled = busy || (ready && state === "blocked" && !!accessToken.value);
      button.title = state === "blocked" ? "Stop the running timer in Solidtime before tracking this issue" : `Solidtime: ${issue.issueKey}`;
      button.setAttribute("aria-label", `${label} — ${issue.issueKey}`);
      button.setAttribute("aria-pressed", String(ready && state === "tracking"));
      setText(status, errorMessage || (!accessToken.value ? "Open the extension to sign in" :
        !ready ? `Timer status unavailable${refreshDiagnostic ? ` (${refreshDiagnostic})` : ""}` : state === "tracking" ? "Tracking in Solidtime" : state === "blocked" ? "Another timer is running" : "Solidtime"));
    }
  }

  async function readActive() {
    if (!accessToken.value) throw new Error("Open the Solidtime extension and sign in first.");
    return (await getCurrentTimeEntry()).data as PlaneActiveEntry | null;
  }

  function refresh() {
    if (refreshPending) return refreshPending;
    refreshPending = (async () => {
      try {
        active = await readActive();
        ready = true;
        refreshDiagnostic = "";
      } catch (error) {
        active = null;
        ready = false;
        refreshDiagnostic = planeTimerDiagnostic(error);
      } finally {
        refreshPending = null;
        if (!disposed) render();
      }
    })();
    return refreshPending;
  }

  async function toggle(issue: PlaneIssue) {
    if (busy) return;
    if (!accessToken.value) { errorMessage = "Open the Solidtime extension and sign in first."; render(); return; }
    if (!ready) { errorMessage = ""; await refresh(); return; }
    const intent = planeTimerState(active, issue) === "tracking" ? "stop" : "start";
    busy = true;
    errorMessage = "";
    render();
    try {
      // Web Locks serialize Plane writes across tabs on the same host in Chrome/Firefox.
      // Fail closed if unavailable rather than risk concurrent create requests.
      if (!navigator.locks) throw new Error("Safe tracking needs Web Locks support in this browser.");
      await navigator.locks.request("solidtime-plane-timer", async () => {
        await changePlaneTimer(issue, intent, {
          read: readActive,
          start: async (currentIssue) => {
            const storage = await browser.storage.local.get(["current_organization_id", "currentMembershipId"]);
            if (typeof storage.current_organization_id !== "string" || !storage.current_organization_id ||
                typeof storage.currentMembershipId !== "string" || !storage.currentMembershipId) {
              throw new Error("Select an organization in the Solidtime extension first.");
            }
            await apiClient().createTimeEntry({
              member_id: storage.currentMembershipId,
              description: currentIssue.description,
              start: dayjs.utc().format(),
              billable: false,
            }, { params: { organization: storage.current_organization_id } });
          },
          stop: async (entry) => {
            // Use the active entry's organization, not the currently selected one.
            await apiClient().updateTimeEntry({ end: dayjs.utc().format() }, {
              params: { organization: entry.organization_id, timeEntry: entry.id },
            });
          },
        });
      });
    } catch (error) {
      errorMessage = planeTimerActionError(error);
    } finally {
      // Let any older polling read finish before the authoritative post-write read.
      if (refreshPending) await refreshPending;
      await refresh();
      busy = false;
      render();
    }
  }

  function addControl(parent: HTMLElement, issue: PlaneIssue, detail = false) {
    const existing = [...parent.children].find((child) => child.hasAttribute(CONTROL)) as HTMLElement | undefined;
    if (existing) {
      const record = controls.get(existing);
      if (record) { record.issue = issue; return; }
      existing.remove();
    }
    const row = document.createElement("div");
    row.setAttribute(CONTROL, "");
    row.style.cssText = `display:flex;align-items:center;gap:8px;flex-wrap:wrap;${detail ? "" : "margin:0 4px 8px;padding:0 6px;"}`;
    const button = document.createElement("button");
    button.type = "button";
    if (detail) button.id = "solidtime-plane-tracking-btn";
    button.className = "rounded-md border border-strong bg-layer-2 px-2 py-1 text-body-xs-medium text-secondary hover:bg-layer-2-hover focus-visible:outline focus-visible:outline-2 disabled:opacity-50";
    button.style.cssText = "font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap;";
    const status = document.createElement("span");
    status.style.cssText = "font-size:11px;line-height:16px;";
    status.className = "text-tertiary";
    status.setAttribute("role", "status");
    row.append(button, status);
    const record = { issue, button, status };
    controls.set(row, record);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void toggle(record.issue);
    });
    // Do not activate the card's drag sensor or keyboard shortcuts from this button.
    for (const type of ["pointerdown", "mousedown", "keydown"]) {
      button.addEventListener(type, (event) => event.stopPropagation());
    }
    // Sibling of the card anchor, never an interactive child of that anchor.
    parent.appendChild(row);
  }

  function reconcile() {
    scheduled = false;
    if (disposed) return;
    const valid = new Set<HTMLElement>();
    if (planeRoute(location.pathname)) {
      for (const anchor of document.querySelectorAll<HTMLAnchorElement>(PLANE_CARD_LINK)) {
        const issue = planeIssueFromCard(anchor, location.href);
        const wrapper = anchor.closest<HTMLElement>('div[class~="group/kanban-block"]');
        if (issue && wrapper && !wrapper.closest("a")) {
          valid.add(wrapper);
          addControl(wrapper, issue);
        }
      }
      const title = document.querySelector<HTMLTextAreaElement>("#title-input")?.value;
      const actions = findPlaneActionsWrapper();
      if (title && actions) {
        const detailLink = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/browse/"]')]
          .find((anchor) => !anchor.closest('div[class~="group/kanban-block"]') &&
            planeIssueFromLink(anchor.href, title, location.href));
        // Retain the older full-page detail DOM as well as modern board overlays.
        const oldKey = document.querySelector('[class*="text-base"][class*="font-medium"][class*="cursor-pointer"]')?.textContent?.trim();
        const issue = planeIssueFromLink(location.href, title, location.href) ??
          (detailLink ? planeIssueFromLink(detailLink.href, title, location.href) : null) ??
          (oldKey ? planeIssueFromLink(`/${location.pathname.split("/")[1]}/browse/${oldKey}/`, title, location.href) : null);
        if (issue) { valid.add(actions); addControl(actions, issue, true); }
      }
    }
    for (const [row] of controls) {
      if (!row.isConnected || !valid.has(row.parentElement!)) {
        row.remove();
        controls.delete(row);
      }
    }
    render();
  }

  function schedule() {
    if (!scheduled && !disposed) { scheduled = true; requestAnimationFrame(reconcile); }
  }
  const observer = new MutationObserver((mutations) => {
    // Ignore our own status/text mutations; no self-triggering observer loop.
    if (mutations.some((mutation) => !(mutation.target instanceof Element ? mutation.target : mutation.target.parentElement)?.closest(`[${CONTROL}]`))) schedule();
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["href", "class"] });
  const onStorage = () => { errorMessage = ""; void refresh(); };
  const stopWatchingToken = watch(accessToken, () => {
    // Auth may finish loading after the first DOM scan, or change in another tab.
    ready = false;
    active = null;
    refreshDiagnostic = "";
    render();
    onStorage();
  });
  const onFocus = () => { schedule(); void refresh(); };
  browser.storage.onChanged.addListener(onStorage);
  window.addEventListener("focus", onFocus);
  window.addEventListener("popstate", schedule);
  document.addEventListener("input", schedule);
  const poll = setInterval(() => {
    if (document.visibilityState === "visible") { schedule(); if (!busy && controls.size) void refresh(); }
  }, 10000);
  reconcile();
  void refresh();
  return () => {
    disposed = true;
    observer.disconnect();
    stopWatchingToken();
    clearInterval(poll);
    browser.storage.onChanged.removeListener(onStorage);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("popstate", schedule);
    document.removeEventListener("input", schedule);
    for (const [row] of controls) row.remove();
    controls.clear();
  };
}
