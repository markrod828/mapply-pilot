/**
 * Origin handling for autofill. The manifest grants the ATS hosts ApplyPilot ships
 * adapters for; anything else is an optional permission the user grants per site.
 */

export interface PageOrigin {
  /** Match pattern suitable for chrome.permissions, e.g. "https://jobs.lever.co/*". */
  pattern: string;
  hostname: string;
}

/** Throws with a user-facing message when the page cannot be autofilled at all. */
export function originFor(pageUrl: string | undefined): PageOrigin {
  if (!pageUrl) throw new Error('No active page URL.');

  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    throw new Error('Cannot autofill this page.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Autofill only works on http(s) application pages.');
  }

  return { pattern: `${url.protocol}//${url.host}/*`, hostname: url.hostname };
}

export function hasHostAccess(origin: PageOrigin): Promise<boolean> {
  return chrome.permissions.contains({ origins: [origin.pattern] });
}

/**
 * Must be called from a user gesture (a click handler in the side panel), because
 * Chrome only shows the optional-permission prompt during one. The service worker
 * cannot do this, so it only ever checks.
 */
export async function requestHostAccess(pageUrl: string | undefined): Promise<void> {
  const origin = originFor(pageUrl);
  if (await hasHostAccess(origin)) return;

  const granted = await chrome.permissions.request({ origins: [origin.pattern] });
  if (!granted) {
    throw new Error(
      `ApplyPilot needs permission to access ${origin.hostname}. Allow it when Chrome prompts, then try again.`,
    );
  }
}
