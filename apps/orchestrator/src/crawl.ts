import { crawlJobright, NotLoggedIn } from '@mapply/discovery';
import { openStore, transition } from '@mapply/db';
import { launchBrowser } from './browser';
import { alreadyAppliedElsewhere, openApplication, upsertJob } from './jobs';
import { ensureDataDirs, paths } from './paths';

export interface CrawlOptions {
  limit?: number;
  /** Follow each posting's Apply link during the crawl. */
  resolveApply?: boolean;
  headless?: boolean;
  onProgress?: (message: string) => void;
}

export interface CrawlResult {
  seen: number;
  added: number;
  duplicates: number;
  queued: number;
}

/**
 * Fills the queue from jobright.
 *
 * Runs in its own persistent browser profile, because this is the one part of
 * the system that needs to stay signed in. Nothing about signing in is
 * automated: if the session has lapsed the crawl stops and says so, rather than
 * trying credentials at a site that is the only source of work there is.
 */
export async function crawl(options: CrawlOptions = {}): Promise<CrawlResult> {
  ensureDataDirs();
  const store = openStore(paths.database);
  const say = options.onProgress ?? (() => {});

  const known = new Set(
    (store.sqlite.prepare("SELECT source_id FROM jobs WHERE source = 'jobright'").all() as {
      source_id: string;
    }[]).map((row) => row.source_id),
  );
  say(`${known.size} posting(s) already known`);

  const browser = await launchBrowser({ headless: options.headless, profile: 'jobright' });
  const result: CrawlResult = { seen: 0, added: 0, duplicates: 0, queued: 0 };

  try {
    const leads = await crawlJobright(browser.context, {
      limit: options.limit ?? 25,
      known,
      resolveApply: options.resolveApply ?? true,
      onProgress: say,
    });

    for (const lead of leads) {
      result.seen += 1;
      const job = upsertJob(store, {
        source: 'jobright',
        sourceId: lead.sourceId,
        url: lead.url,
        applyUrl: lead.applyUrl,
        atsKind: lead.atsKind,
        title: lead.title,
        company: lead.company,
        location: lead.location,
        description: lead.description,
      });
      if (job.isNew) result.added += 1;

      // The same role relisted under a new id. Storing it is fine - it is a real
      // posting - but applying again is not.
      if (alreadyAppliedElsewhere(store, job.id)) {
        result.duplicates += 1;
        const application = openApplication(store, job.id, { dryRun: true, state: 'discovered' });
        await transition(store, {
          applicationId: application.id,
          to: 'skipped',
          reason: 'duplicate',
          reasonDetail: 'The same role has already been applied to under another listing.',
        });
        continue;
      }

      const application = openApplication(store, job.id, { dryRun: true });
      if (application.isNew) result.queued += 1;
    }
  } catch (error) {
    if (error instanceof NotLoggedIn) {
      say(error.message);
      throw error;
    }
    throw error;
  } finally {
    await browser.close().catch(() => {});
    await store.close();
  }

  return result;
}
