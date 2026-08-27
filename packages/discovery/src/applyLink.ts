import type { BrowserContext, Page } from 'playwright';
import type { AtsKind } from '@mapply/core/application';
import { waitForDomQuiet } from '@mapply/filler';

export interface ApplyTarget {
  page: Page;
  url: string;
  atsKind: AtsKind;
  /** True when a new tab was opened and the caller should close it when done. */
  opened: boolean;
}

const BY_URL: [RegExp, AtsKind][] = [
  [/(^|\.)(job-)?boards\.greenhouse\.io|greenhouse\.io\/(embed|jobs)/i, 'greenhouse'],
  [/jobs\.lever\.co|(^|\.)lever\.co\/.+/i, 'lever'],
  [/jobs\.ashbyhq\.com|ashbyhq\.com\/.+\/application/i, 'ashby'],
  [/apply\.workable\.com|workable\.com\/j\//i, 'workable'],
  [/myworkdayjobs\.com/i, 'workday'],
];

export function atsFromUrl(url: string): AtsKind {
  for (const [pattern, kind] of BY_URL) if (pattern.test(url)) return kind;
  return 'unknown';
}

/**
 * Follows a posting's Apply link to wherever the form actually lives.
 *
 * Worth its own step rather than assuming the job URL is the form. An aggregator
 * links out, the link may open a new tab or replace the current one, and a large
 * share of company careers pages are a thin wrapper that puts the real ATS in an
 * iframe - so the destination URL alone is not enough to say what this is.
 */
export async function resolveApplyTarget(
  context: BrowserContext,
  page: Page,
  applySelector = 'a:has-text("Apply"), button:has-text("Apply")',
): Promise<ApplyTarget | null> {
  const before = page.url();
  const trigger = page.locator(applySelector).first();
  if ((await trigger.count()) === 0) return null;

  // A new tab and a same-tab navigation are both normal here, so wait for either
  // rather than committing to one and timing out on the other.
  const popup = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
  await trigger.click({ timeout: 10_000 }).catch(() => {});
  const opened = await popup;

  const target = opened ?? page;
  await target.waitForLoadState('domcontentloaded').catch(() => {});
  await waitForDomQuiet(target);

  if (!opened && target.url() === before) return null;

  const url = target.url();
  return {
    page: target,
    url,
    atsKind: atsFromUrl(url) === 'unknown' ? await sniffAtsFromDom(target) : atsFromUrl(url),
    opened: Boolean(opened),
  };
}

/**
 * Works out which ATS a page is running when its URL does not say.
 *
 * This is the embedded case, and it is common: the company serves the careers
 * page from their own domain and the application form arrives in an iframe or
 * through a vendor script. The frame's own URL, the form's action and the embed
 * script are each enough to identify it.
 */
export async function sniffAtsFromDom(page: Page): Promise<AtsKind> {
  // Frames first - if the form is embedded, the frame URL names the vendor outright.
  for (const frame of page.frames()) {
    const kind = atsFromUrl(frame.url());
    if (kind !== 'unknown') return kind;
  }

  const markers = await page
    .evaluate(() => {
      const out: string[] = [];
      for (const node of Array.from(document.querySelectorAll('iframe[src], script[src], form[action]'))) {
        const value =
          node.getAttribute('src') ?? node.getAttribute('action') ?? '';
        if (value) out.push(value);
      }
      return out;
    })
    .catch(() => [] as string[]);

  for (const marker of markers) {
    const kind = atsFromUrl(marker);
    if (kind !== 'unknown') return kind;
  }
  return 'unknown';
}
