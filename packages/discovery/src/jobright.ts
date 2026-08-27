import type { BrowserContext, Page } from 'playwright';
import type { AtsKind } from '@mapply/core/application';
import { delay, jitter, waitForDomQuiet } from '@mapply/filler';
import { resolveApplyTarget } from './applyLink';
import { extractJobInPage, type ExtractedJob } from './browser/extract';

const ORIGIN = 'https://jobright.ai';
const JOB_PATH = /\/jobs\/info\/([^/?#]+)/i;

/** How long a posting's content must read the same before it is believed. */
const SETTLE_POLL_MS = 400;
const SETTLE_TIMEOUT_MS = 8000;

export interface JobLead {
  sourceId: string;
  url: string;
  title: string;
  company: string;
  location: string;
  description: string;
  applyUrl?: string;
  atsKind: AtsKind;
}

export interface CrawlOptions {
  /** Stop after this many new postings. The feed is finite; this is a safety rail. */
  limit?: number;
  /** Skip postings already known, so a re-crawl costs nothing. */
  known?: ReadonlySet<string>;
  /** Follow each posting's Apply link. Slower, but without it there is nothing to apply to. */
  resolveApply?: boolean;
  onProgress?: (message: string) => void;
}

export class NotLoggedIn extends Error {
  constructor() {
    super('Not signed in to jobright. Open it once in this profile and sign in, then re-run.');
  }
}

/**
 * Walks the jobright recommendations and reads each posting.
 *
 * Paced deliberately. This is one account and the only feed there is, so it is
 * treated as something to be careful with rather than something to hammer: one
 * page at a time, human-length pauses, and no attempt to log in automatically.
 */
export async function crawlJobright(
  context: BrowserContext,
  options: CrawlOptions = {},
): Promise<JobLead[]> {
  const limit = options.limit ?? 25;
  const known = options.known ?? new Set<string>();
  const say = options.onProgress ?? (() => {});

  const page = await context.newPage();
  try {
    await page.goto(`${ORIGIN}/jobs/recommend`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForDomQuiet(page);

    if (await looksLoggedOut(page)) throw new NotLoggedIn();

    const ids = await collectPostingLinks(page, limit, known, say);
    say(`${ids.length} posting(s) to read`);

    const leads: JobLead[] = [];
    for (const [index, id] of ids.entries()) {
      say(`reading ${index + 1}/${ids.length}: ${id}`);
      const lead = await readPosting(context, page, id, options.resolveApply ?? false);
      if (lead) leads.push(lead);
      // Unhurried on purpose: nothing here is worth risking the one feed for.
      await delay(jitter(4000, 1500));
    }
    return leads;
  } finally {
    await page.close().catch(() => {});
  }
}

async function looksLoggedOut(page: Page): Promise<boolean> {
  if (/\/(login|signin|sign-in)\b/i.test(page.url())) return true;
  const signIn = await page
    .getByRole('button', { name: /sign in|log in/i })
    .count()
    .catch(() => 0);
  const links = await page.locator('a[href*="/jobs/info/"]').count().catch(() => 0);
  return links === 0 && signIn > 0;
}

/**
 * Gathers posting ids from the recommendations list.
 *
 * By link rather than by any particular card markup: the hrefs are the one part
 * of a list page that has to stay stable, since they are what the site's own
 * navigation depends on.
 */
async function collectPostingLinks(
  page: Page,
  limit: number,
  known: ReadonlySet<string>,
  say: (message: string) => void,
): Promise<string[]> {
  const found = new Set<string>();
  let idle = 0;

  while (found.size < limit && idle < 3) {
    const before = found.size;

    for (const href of await page.locator('a[href*="/jobs/info/"]').evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLAnchorElement).href),
    )) {
      const id = href.match(JOB_PATH)?.[1];
      if (id && !known.has(id)) found.add(id);
      if (found.size >= limit) break;
    }

    if (found.size === before) idle += 1;
    else idle = 0;

    if (found.size < limit) {
      say(`${found.size} found, scrolling for more`);
      await page.mouse.wheel(0, 2000);
      await delay(jitter(1200, 400));
      await waitForDomQuiet(page, { quietMs: 400, timeoutMs: 4000 });
    }
  }
  return [...found].slice(0, limit);
}

async function readPosting(
  context: BrowserContext,
  page: Page,
  id: string,
  resolveApply: boolean,
): Promise<JobLead | null> {
  const url = `${ORIGIN}/jobs/info/${id}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
  await waitForDomQuiet(page);

  const job = await settled(page, url);
  if (!job) return null;

  const lead: JobLead = {
    sourceId: id,
    url,
    title: job.title,
    company: job.company,
    location: job.location,
    description: job.description,
    atsKind: 'unknown',
  };

  if (resolveApply) {
    const target = await resolveApplyTarget(context, page).catch(() => null);
    if (target) {
      lead.applyUrl = target.url;
      lead.atsKind = target.atsKind;
      if (target.opened) await target.page.close().catch(() => {});
    }
  }
  return lead;
}

/**
 * Reads the posting twice and only believes it when both reads agree.
 *
 * The reason is specific and easy to miss: jobright swaps the URL before it
 * swaps the content, so for a moment the previous posting is sitting under the
 * new address. A single read there captures the wrong job under the right id,
 * and every later step is confidently wrong.
 */
async function settled(page: Page, url: string): Promise<ExtractedJob | null> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let previous: string | null = null;

  while (Date.now() < deadline) {
    const job = await page.evaluate(extractJobInPage, url).catch(() => null);
    if (job && !job.stale) {
      if (job.fingerprint === previous) return job;
      previous = job.fingerprint;
    }
    await delay(SETTLE_POLL_MS);
  }
  return null;
}
