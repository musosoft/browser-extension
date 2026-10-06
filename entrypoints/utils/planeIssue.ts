export const PLANE_CARD_LINK = 'div[class~="group/kanban-block"] a[href*="/browse/"]';
export const PLANE_CARD_TITLE = '[data-testid="issue-title"], [class~="line-clamp-1"][class~="text-body-sm-medium"]';

export function planeRoute(pathname: string): "list" | "detail" | null {
  if (/^\/[^/]+\/browse\/[A-Z][A-Z0-9]*-\d+\/?$/.test(pathname)) return "detail";
  if (/^\/[^/]+\/projects\/[^/]+\/issues\/?$/.test(pathname)) return "list";
  return null;
}

export function planeIssueFromLink(href: string, title: string, pageUrl: string) {
  const page = new URL(pageUrl);
  const url = new URL(href, page);
  if (url.origin !== page.origin) return null;
  const match = url.pathname.match(/^\/([^/]+)\/browse\/([A-Z][A-Z0-9]*-\d+)\/?$/);
  if (!match || match[1] !== page.pathname.split("/")[1]) return null;
  const issueKey = match[2];
  const cleanTitle = title.replace(/\s+/g, " ").trim();
  if (!cleanTitle || cleanTitle === issueKey) return null;
  return { issueKey, title: cleanTitle, description: `${issueKey} ${cleanTitle}` };
}

export type PlaneIssue = NonNullable<ReturnType<typeof planeIssueFromLink>>;
export function planeIssueFromCard(anchor: HTMLAnchorElement, pageUrl: string) {
  return planeIssueFromLink(anchor.href, anchor.querySelector(PLANE_CARD_TITLE)?.textContent ?? "", pageUrl);
}

export type PlaneActiveEntry = {
  id: string;
  description?: string | null;
  organization_id: string;
  end?: string | null;
};

export function planeTimerState(entry: PlaneActiveEntry | null, issue: PlaneIssue) {
  if (!entry?.id || entry.end) return "idle";
  // Never stop an unrelated entry just because some timer is running.
  return entry.description === issue.description ? "tracking" : "blocked";
}

/** Fresh state must be read inside the shared lock, not from rendered button state. */
export async function changePlaneTimer(
  issue: PlaneIssue,
  intent: "start" | "stop",
  service: {
    read: () => Promise<PlaneActiveEntry | null>;
    start: (issue: PlaneIssue) => Promise<unknown>;
    stop: (entry: PlaneActiveEntry) => Promise<unknown>;
  },
) {
  const active = await service.read();
  const state = planeTimerState(active, issue);
  if (intent === "stop") {
    if (state !== "tracking" || !active) throw new Error("This issue is no longer being tracked. Refresh and try again.");
    await service.stop(active);
  } else {
    if (state !== "idle") throw new Error("A timer is already running. Stop it before starting this issue.");
    await service.start(issue);
  }
}
