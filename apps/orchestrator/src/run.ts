import { resolve } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import {
  fillForm,
  collectValidationErrors,
  findTemplate,
  submitAndConfirm,
  waitForDomQuiet,
  type FillContext,
  type FillOutcome,
  type FormRoot,
  type FormTemplate,
} from '@mapply/filler';
import type { JobPosting } from '@mapply/core';
import {
  CLEAN_RUNS_REQUIRED,
  claimNext,
  getAnswer,
  mayAutoSubmit,
  openStore,
  recordEvent,
  recordFormRun,
  transition,
  type Store,
} from '@mapply/db';
import { launchBrowser } from './browser';
import { loadIdentity, type Identity } from './identity';
import { openApplication, upsertJob } from './jobs';
import { checkDomain, classifyFailure, handleFailure, noteOutcome, noteRequest } from './pacing';
import { ensureDataDirs, paths } from './paths';
import { prepare, settingsFromEnv, spendToday } from './tailoring';

export interface RunOptions {
  url: string;
  /** Off by default. Nothing submits until this is explicitly asked for. */
  submit?: boolean;
  headless?: boolean;
  keepOpen?: boolean;
}

export interface RunResult {
  applicationId: number;
  company?: string;
  title?: string;
  state: string;
  reason?: string;
  filled: number;
  verified: number;
  blocking: string[];
  delegated: string[];
  unanswered: { label: string; required: boolean; control: string }[];
  /** Filled nothing, submitted anyway - recorded so it is never invisible. */
  waived: string[];
  screenshot: string;
  confirmation?: { signals: string[]; status?: number; text?: string };
}

/**
 * Fills one application at a URL, end to end.
 *
 * Dry run is the default and has to be turned off deliberately. A form we have
 * not seen before is one we have not proved we understand, and the cheap way to
 * find that out is to fill it completely, photograph it and look - not to submit
 * and hope.
 */
export async function runApply(options: RunOptions): Promise<RunResult> {
  ensureDataDirs();
  const store = openStore(paths.database);
  const identity = loadIdentity(store);
  const browser = await launchBrowser({ headless: options.headless });

  try {
    const page = await browser.context.newPage();
    await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForDomQuiet(page);

    const details = await readPostingDetails(page);
    const job = upsertJob(store, {
      source: 'url',
      sourceId: sourceIdFor(options.url),
      url: options.url,
      applyUrl: page.url(),
      title: details.title,
      company: details.company,
      location: details.location,
      description: details.description,
    });

    const application = openApplication(store, job.id, { dryRun: !options.submit, state: 'ready' });
    await reopen(store, application.id, !options.submit);

    return await drive(store, page, application.id, job.posting, identity, options.submit ?? false);
  } finally {
    if (!options.keepOpen) await browser.close();
    await store.close();
  }
}

export interface QueueOptions {
  limit?: number;
  submit?: boolean;
  headless?: boolean;
  /** Stop spending once the day has cost this much. */
  budgetUsd?: number;
  onProgress?: (message: string) => void;
}

export interface QueueResult {
  prepared: number;
  attempted: number;
  submitted: number;
  parked: number;
  failed: number;
  retried: number;
  skipped: number;
  spentUsd: number;
  results: RunResult[];
}

/**
 * Works through the queue, one application at a time.
 *
 * Serial on purpose for now. The feed is under a hundred jobs a day, so the
 * browser is never the constraint, and a single worker means a failure has one
 * obvious cause rather than a race to reason about. The lease-based claim is
 * already in place for when that changes.
 */
export async function runQueue(options: QueueOptions = {}): Promise<QueueResult> {
  ensureDataDirs();
  const store = openStore(paths.database);
  const identity = loadIdentity(store);
  const say = options.onProgress ?? (() => {});
  const limit = options.limit ?? 10;
  const worker = `local-${process.pid}`;

  const result: QueueResult = {
    prepared: 0, attempted: 0, submitted: 0, parked: 0, failed: 0, retried: 0, skipped: 0,
    spentUsd: 0, results: [],
  };

  const tailoring = settingsFromEnv();
  if (tailoring) {
    await prepareQueued(store, identity, tailoring, limit, options.budgetUsd, say, result);
  } else {
    // No key, so no scoring and no rewrite: the base resume goes as it is. Said
    // out loud rather than silently degraded, because the difference between a
    // tailored application and a generic one is the whole point of the tool.
    const promoted = store.sqlite
      .prepare("UPDATE applications SET state = 'ready', updated_at = ? WHERE state = 'queued'")
      .run(Date.now());
    if (promoted.changes) {
      say(`${promoted.changes} made ready with the base resume (set OPENAI_API_KEY to score and tailor)`);
    }
  }

  const browser = await launchBrowser({ headless: options.headless });

  try {
    while (result.attempted < limit) {
      const claimed = claimNext(store, 'ready', worker);
      if (!claimed) break;

      const job = store.sqlite
        .prepare('SELECT * FROM jobs WHERE id = ?')
        .get(claimed.job_id) as Record<string, unknown>;
      const target = (job.apply_url as string) || (job.url as string);

      const domain = checkDomain(store, target);
      if (domain.circuitOpen) {
        // Left alone rather than hammered. Putting it back on the queue keeps it
        // in view without spending the run on a host that is refusing.
        say(`skipping ${job.company}: ${new URL(target).hostname} is in cooldown`);
        await transition(store, {
          applicationId: claimed.id,
          to: 'queued',
          reason: 'circuit_open',
          patch: { next_attempt_at: Date.now() + domain.waitMs, lease_owner: null, lease_expires_at: null },
        });
        continue;
      }
      if (domain.waitMs > 0) {
        say(`  pausing ${Math.round(domain.waitMs / 1000)}s before the next request to this host`);
        await new Promise((done) => setTimeout(done, domain.waitMs));
      }
      noteRequest(store, target);

      result.attempted += 1;
      say(`[${result.attempted}/${limit}] ${job.company} - ${job.title}`);

      const page = await browser.context.newPage();
      try {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await waitForDomQuiet(page);

        const posting: JobPosting = {
          jobKey: `${job.source}:${job.source_id}`,
          url: job.url as string,
          title: job.title as string,
          company: job.company as string,
          location: (job.location as string) ?? '',
          description: (job.description as string) ?? '',
          capturedAt: job.discovered_at as number,
        };

        const tailoredPath = store.sqlite
          .prepare('SELECT resume_path FROM applications WHERE id = ?')
          .get(claimed.id) as { resume_path: string | null };

        const outcome = await drive(
          store,
          page,
          claimed.id,
          posting,
          { ...identity, resumePath: tailoredPath.resume_path ?? identity.resumePath },
          options.submit ?? false,
        );
        outcome.company = posting.company;
        outcome.title = posting.title;
        result.results.push(outcome);

        if (outcome.state === 'submitted') result.submitted += 1;
        else if (outcome.state === 'failed') result.failed += 1;
        else result.parked += 1;
        // Parking is not a failure of the host - the page answered, we chose not
        // to send. Only a real failure counts against it.
        noteOutcome(store, target, outcome.state !== 'failed');
        say(`    -> ${outcome.state}${outcome.reason ? ` (${outcome.reason})` : ''}`);
      } catch (error) {
        const text = await page.locator('body').innerText().catch(() => '');
        const reason = classifyFailure(error as Error, text.slice(0, 2000));
        noteOutcome(store, target, false);

        const decision = await handleFailure(
          store,
          claimed.id,
          reason,
          (error as Error).message,
          claimed.attempt_count,
          3,
        ).catch(() => 'dead' as const);

        if (decision === 'retry') result.retried += 1;
        else if (decision === 'parked') result.parked += 1;
        else result.failed += 1;
        say(`    -> ${reason}${decision === 'retry' ? ', will try again later' : ''}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    result.spentUsd = spendToday(store);
    await browser.close().catch(() => {});
    await store.close();
  }
  return result;
}

/**
 * Scores and tailors everything waiting, before any browser opens.
 *
 * Done as its own pass rather than inline with the filling, so a run that is
 * going to be abandoned on budget is abandoned before it has opened a form, and
 * so the expensive part is not interleaved with the slow part.
 */
async function prepareQueued(
  store: Store,
  identity: Identity,
  settings: NonNullable<ReturnType<typeof settingsFromEnv>>,
  limit: number,
  budgetUsd: number | undefined,
  say: (message: string) => void,
  result: QueueResult,
): Promise<void> {
  const waiting = store.sqlite
    .prepare("SELECT id, job_id FROM applications WHERE state = 'queued' ORDER BY priority DESC, id LIMIT ?")
    .all(limit) as { id: number; job_id: number }[];

  for (const row of waiting) {
    if (budgetUsd !== undefined && spendToday(store) >= budgetUsd) {
      say(`daily budget of ${budgetUsd.toFixed(2)} reached; leaving the rest queued`);
      break;
    }

    const job = store.sqlite.prepare('SELECT * FROM jobs WHERE id = ?').get(row.job_id) as Record<string, unknown>;
    const posting: JobPosting = {
      jobKey: `${job.source}:${job.source_id}`,
      url: job.url as string,
      title: job.title as string,
      company: job.company as string,
      location: (job.location as string) ?? '',
      description: (job.description as string) ?? '',
      capturedAt: job.discovered_at as number,
    };

    await transition(store, { applicationId: row.id, to: 'tailoring' });
    try {
      const outcome = await prepare(store, row.id, row.job_id, posting, identity, settings);

      if (outcome.skip) {
        result.skipped += 1;
        say(`skip  ${posting.company} - ${posting.title}: ${outcome.skip}`);
        await transition(store, {
          applicationId: row.id, to: 'queued',
        });
        await transition(store, {
          applicationId: row.id, to: 'skipped', reason: 'below_gate', reasonDetail: outcome.skip,
        });
        continue;
      }

      result.prepared += 1;
      say(`ready ${posting.company} - ${posting.title} (${outcome.score?.overall ?? '?'}, ${outcome.tier})`);
      await transition(store, {
        applicationId: row.id, to: 'ready', patch: { tailor_tier: outcome.tier },
      });
    } catch (error) {
      // A failed rewrite is not a failed application: the base resume is still
      // perfectly sendable, so it goes on with what it has rather than stopping.
      say(`tailoring failed for ${posting.company}: ${(error as Error).message.slice(0, 90)}`);
      await transition(store, {
        applicationId: row.id, to: 'ready', reasonDetail: 'Tailoring failed; sending the base resume.',
      });
    }
  }
}

/**
 * The shared middle of both entry points: a loaded page becomes a decision.
 */
async function drive(
  store: Store,
  page: Page,
  applicationId: number,
  posting: JobPosting,
  identity: Identity,
  submit: boolean,
): Promise<RunResult> {
  const match = await findTemplate(page);

  if (!match) {
    await transition(store, {
      applicationId,
      to: 'failed',
      reason: 'unsupported_ats',
      reasonDetail: `No template matched ${page.url()}`,
    });
    return {
      applicationId, state: 'failed', reason: 'unsupported_ats',
      filled: 0, verified: 0, blocking: [], delegated: [], unanswered: [], waived: [],
      screenshot: await screenshot(page, applicationId, 'unsupported'),
    };
  }

  await transition(store, { applicationId, to: 'filling' });

  const ctx: FillContext = {
    profile: identity.profile,
    job: posting,
    resumeText: identity.resume.text,
    resumePath: identity.resumePath,
    // Scoped to the company as well as the general bank, so "why do you want to
    // work here" can have a different answer per employer.
    lookupAnswer: async (key) => getAnswer(store, key, `company:${posting.company.toLowerCase()}`),
  };

  // fillForm rather than a single pass: a one-page form is simply a wizard with
  // one step, and routing both through the same code means the multi-step path
  // is exercised every day rather than only on the forms that need it.
  const outcome = await fillForm(match.root, match.template, ctx);
  await recordEvent(store, applicationId, 'fill', outcome);

  // Whatever the form itself objects to is required, whatever its markup says -
  // except the complaints this template knows the form excuses.
  for (const message of await collectValidationErrors(match.root)) {
    const excused =
      match.template.waivableErrors?.test(message) ||
      // An unnamed "fill this in" with a waived field already recorded is that
      // field's own hidden required input complaining. Excused only because
      // something was waived; on its own it would be an unknown required box.
      (/^:\s/.test(message) && outcome.waived.length > 0);
    if (excused) outcome.waived.push(`form says: ${message}`);
    else outcome.blocking.push(`form says: ${message}`);
  }

  // The form's shape is recorded before anything is decided, so a run that is
  // about to be parked still counts against this shape's standing.
  const standing = outcome.fingerprint
    ? recordFormRun(store, {
        fingerprint: outcome.fingerprint,
        atsKind: match.template.atsKind,
        origin: originOf(page.url()),
        fieldCount: outcome.filled.length + outcome.unanswered.length,
        clean: outcome.blocking.length === 0,
        planJson: JSON.stringify(outcome),
      })
    : undefined;

  if (outcome.fingerprint) {
    store.sqlite
      .prepare('UPDATE applications SET form_fingerprint = ? WHERE id = ?')
      .run(outcome.fingerprint, applicationId);
  }

  const shot = await screenshot(page, applicationId, submit ? 'before-submit' : 'dry-run');
  const base = {
    applicationId,
    filled: outcome.filled.length,
    verified: outcome.filled.filter((field) => field.ok).length,
    blocking: outcome.blocking,
    delegated: outcome.delegated,
    unanswered: outcome.unanswered.map((q) => ({
      label: q.label,
      required: q.required,
      control: q.control,
    })),
    waived: outcome.waived,
    screenshot: shot,
  };

  if (outcome.blocking.length) {
    await transition(store, {
      applicationId,
      to: 'needs_review',
      reason: outcome.reason ?? 'low_confidence',
      reasonDetail: outcome.blocking.join('; ').slice(0, 2000),
      patch: { screenshot_path: shot, plan_json: JSON.stringify(outcome) },
    });
    return { ...base, state: 'needs_review', reason: outcome.reason ?? 'low_confidence' };
  }

  if (submit && !mayAutoSubmit(store, outcome.fingerprint)) {
    // A clean fill, but this shape has not yet earned the right to send itself.
    // Every field verified only proves the fields we knew to look for; filling
    // the same shape cleanly several times running is what shows we understood
    // the form rather than got lucky with it.
    const remaining = Math.max(0, CLEAN_RUNS_REQUIRED - (standing?.cleanRuns ?? 0));
    await transition(store, {
      applicationId,
      to: 'needs_review',
      reason: 'low_confidence',
      reasonDetail:
        `This form's shape has been filled cleanly ${standing?.cleanRuns ?? 0} time(s). ` +
        `${remaining} more clean run(s) and it may submit on its own. Review the ` +
        'screenshot, then run it again.',
      patch: { screenshot_path: shot, plan_json: JSON.stringify(outcome) },
    });
    return { ...base, state: 'needs_review', reason: 'unproven_form' };
  }

  if (!submit) {
    // A clean dry run. Parked rather than called done, because nobody has looked
    // at it yet and the whole point is that somebody does.
    await transition(store, {
      applicationId,
      to: 'needs_review',
      reason: 'low_confidence',
      reasonDetail:
        'Dry run completed with nothing blocking. ' +
        `This form's shape is ${standing?.cleanRuns ?? 0}/${CLEAN_RUNS_REQUIRED} of the way ` +
        'to being trusted to submit itself.',
      patch: { screenshot_path: shot, plan_json: JSON.stringify(outcome) },
    });
    return { ...base, state: 'needs_review', reason: 'dry_run' };
  }

  return {
    ...base,
    ...(await doSubmit(store, page, match.root, match.template, applicationId, outcome, shot)),
  };
}

async function doSubmit(
  store: Store,
  page: Page,
  root: FormRoot,
  template: FormTemplate,
  applicationId: number,
  outcome: FillOutcome,
  beforeShot: string,
): Promise<SubmitOutcome> {
  await transition(store, {
    applicationId,
    to: 'submitting',
    patch: { plan_json: JSON.stringify(outcome), screenshot_path: beforeShot },
  });

  const result = await submitAndConfirm(page, root, template, async () => {
    // Written before the click, deliberately. If this process dies now the row
    // already records that an attempt was made, and recovery parks it for a
    // person rather than trying again - a duplicate application reads as spam.
    store.sqlite
      .prepare('UPDATE applications SET submit_attempted_at = ?, updated_at = ? WHERE id = ?')
      .run(Date.now(), Date.now(), applicationId);
  });

  const shot = await screenshot(page, applicationId, 'submit');

  if (result.confirmed) {
    await transition(store, {
      applicationId,
      to: 'submitted',
      patch: {
        submitted_at: Date.now(),
        confirmation_kind: result.signals.join('+'),
        confirmation_text: result.confirmationText ?? null,
        submit_http_status: result.httpStatus ?? null,
        screenshot_path: shot,
      },
    });
    return {
      state: 'submitted',
      screenshot: shot,
      confirmation: {
        signals: result.signals,
        status: result.httpStatus,
        text: result.confirmationText,
      },
    };
  }

  await transition(store, {
    applicationId,
    to: 'needs_review',
    reason: 'submit_unverified',
    reasonDetail: `Clicked submit; only ${result.signals.length} confirmation signal(s): ${
      result.signals.join(', ') || 'none'
    }. Check whether the application arrived before doing anything else.`,
    patch: { screenshot_path: shot, submit_http_status: result.httpStatus ?? null },
  });
  return { state: 'needs_review', reason: 'submit_unverified', screenshot: shot };
}

interface SubmitOutcome {
  state: string;
  reason?: string;
  screenshot: string;
  confirmation?: RunResult['confirmation'];
}

/** Puts a re-run back at the start; the page is fresh, so old partial state means nothing. */
async function reopen(store: Store, applicationId: number, dryRun: boolean): Promise<void> {
  store.sqlite
    .prepare(
      `UPDATE applications
          SET state = 'ready', reason = NULL, reason_detail = NULL, dry_run = ?, updated_at = ?
        WHERE id = ? AND state != 'submitted'`,
    )
    .run(dryRun ? 1 : 0, Date.now(), applicationId);
}

async function screenshot(page: Page, applicationId: number, label: string): Promise<string> {
  const file = resolve(paths.forApplication(applicationId), `${label}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function sourceIdFor(url: string): string {
  let hash = 0;
  for (let index = 0; index < url.length; index += 1) {
    hash = Math.imul(hash ^ url.charCodeAt(index), 2654435761);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Reads what the posting says about itself.
 *
 * The company needs care on an ATS-hosted form. The hostname is the vendor's,
 * not the employer's - taking it gives every Greenhouse job the company name
 * "job-boards", which is wrong on the record and, worse, makes the answer
 * bank's per-company scope useless because every employer shares one key. The
 * employer is the first path segment on those hosts.
 */
/**
 * Reads what the posting says about itself.
 *
 * The company name needs care on an ATS-hosted form. The hostname belongs to the
 * vendor, not the employer, so taking it labels every Greenhouse job
 * "job-boards" - wrong on the record, and worse than cosmetic: the answer bank
 * scopes company-specific answers by that name, so one wrong key would make
 * every employer share an answer to "why do you want to work here". On those
 * hosts the employer is the first path segment.
 */
async function readPostingDetails(page: Page): Promise<{
  title: string;
  company: string;
  location: string;
  description: string;
}> {
  const read = await page.evaluate(() => {
    const meta = (property: string) =>
      document.querySelector<HTMLMetaElement>(
        `meta[property="${property}"], meta[name="${property}"]`,
      )?.content ?? '';
    const text = (selector: string) =>
      (document.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();

    return {
      title: text('h1') || meta('og:title') || document.title || 'Unknown role',
      siteName: meta('og:site_name'),
      companyText: text('[class*="company" i]'),
      location: text('[class*="location" i]'),
      description: (document.body.innerText ?? '').slice(0, 20_000),
    };
  });

  return {
    title: read.title,
    company: employerFrom(page.url()) || read.siteName || read.companyText || 'Unknown',
    location: read.location,
    description: read.description,
  };
}

/** Vendor hosts that put the employer's own slug first in the path. */
const EMPLOYER_IN_PATH =
  /^(job-boards|boards)\.greenhouse\.io$|^jobs\.lever\.co$|^jobs\.ashbyhq\.com$|^apply\.workable\.com$/i;

function employerFrom(url: string): string {
  try {
    const parsed = new URL(url);
    if (!EMPLOYER_IN_PATH.test(parsed.hostname)) return '';
    const slug = parsed.pathname.split('/').filter(Boolean)[0];
    if (!slug) return '';
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
      .trim();
  } catch {
    return '';
  }
}

export type { BrowserContext };
