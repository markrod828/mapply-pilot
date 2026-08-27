import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { getAnswer, listAnswers, openStore, putAnswer, transition, type Store } from '@mapply/db';
import { questionKey } from '@mapply/filler';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MAPPLY_DATA_DIR
  ? resolve(process.env.MAPPLY_DATA_DIR)
  : resolve(process.cwd(), 'data');
const DB = resolve(DATA_DIR, 'mapply.db');

interface ParkedRow {
  id: number;
  state: string;
  reason: string | null;
  reason_detail: string | null;
  updated_at: number;
  screenshot_path: string | null;
  plan_json: string | null;
  company: string;
  title: string;
  url: string;
  apply_url: string | null;
}

interface Question {
  label: string;
  control: string;
  required: boolean;
  options?: string[];
  /** A suggestion carried over from a question already answered, never applied on its own. */
  suggestion?: string;
}

/**
 * The review queue, served locally.
 *
 * Deliberately small: one process, one page, no build step. This is a tool for
 * one person on one machine, and a front-end toolchain would be more of it to
 * maintain than the thing it displays.
 */
export function buildServer(store: Store) {
  const app = Fastify({ logger: false });

  void app.register(fastifyStatic, { root: resolve(HERE, '../public'), prefix: '/' });

  app.get('/api/stats', async () => {
    const counts = store.sqlite
      .prepare('SELECT state, COUNT(*) AS n FROM applications GROUP BY state')
      .all() as { state: string; n: number }[];
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const spend = store.sqlite
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_calls WHERE at >= ?')
      .get(midnight.getTime()) as { total: number };
    const learned = store.sqlite.prepare('SELECT COUNT(*) AS n FROM answers').get() as { n: number };

    return {
      states: Object.fromEntries(counts.map((row) => [row.state, row.n])),
      spentToday: spend.total,
      learned: learned.n,
    };
  });

  app.get('/api/review', async () => {
    const rows = store.sqlite
      .prepare(
        `SELECT a.id, a.state, a.reason, a.reason_detail, a.updated_at, a.screenshot_path,
                a.plan_json, j.company, j.title, j.url, j.apply_url
           FROM applications a JOIN jobs j ON j.id = a.job_id
          WHERE a.state = 'needs_review'
          ORDER BY a.updated_at DESC`,
      )
      .all() as ParkedRow[];

    return rows.map((row) => {
      const plan = row.plan_json ? (JSON.parse(row.plan_json) as Record<string, unknown>) : {};
      const questions = ((plan.unanswered ?? []) as Question[]).map((question) => ({
        ...question,
        // Offered, not applied. A near-identical wording can mean the opposite -
        // "authorised to work" and "requires sponsorship" are the standing
        // example - so a person confirms before it is ever reused.
        suggestion: getAnswer(store, questionKey(question.label))?.answer,
      }));

      return {
        id: row.id,
        company: row.company,
        title: row.title,
        url: row.apply_url ?? row.url,
        reason: row.reason,
        detail: row.reason_detail,
        updatedAt: row.updated_at,
        hasScreenshot: Boolean(row.screenshot_path && existsSync(row.screenshot_path)),
        blocking: (plan.blocking ?? []) as string[],
        waived: (plan.waived ?? []) as string[],
        questions,
      };
    });
  });

  app.get<{ Params: { id: string } }>('/api/screenshot/:id', async (request, reply) => {
    const row = store.sqlite
      .prepare('SELECT screenshot_path FROM applications WHERE id = ?')
      .get(Number(request.params.id)) as { screenshot_path: string | null } | undefined;

    if (!row?.screenshot_path || !existsSync(row.screenshot_path)) {
      return reply.code(404).send({ error: 'No screenshot for that application.' });
    }
    return reply.type('image/png').send((await import('node:fs')).createReadStream(row.screenshot_path));
  });

  app.post<{ Body: { question: string; answer: string; scope?: string } }>(
    '/api/answer',
    async (request, reply) => {
      const { question, answer, scope } = request.body ?? {};
      if (!question?.trim() || !answer?.trim()) {
        return reply.code(400).send({ error: 'A question and an answer are both required.' });
      }
      putAnswer(store, {
        questionKey: questionKey(question),
        questionText: question,
        answer,
        scope,
        source: 'human',
        approved: true,
      });
      return { ok: true };
    },
  );

  // Re-queueing rather than retrying in place: the page is fetched fresh, so any
  // partial state from the last attempt is meaningless and better discarded.
  app.post<{ Params: { id: string } }>('/api/requeue/:id', async (request) => {
    await transition(store, { applicationId: Number(request.params.id), to: 'queued' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/skip/:id', async (request) => {
    await transition(store, {
      applicationId: Number(request.params.id),
      to: 'skipped',
      reason: 'company_blocklist',
      reasonDetail: 'Dismissed from the review queue.',
    });
    return { ok: true };
  });

  app.get('/api/applications', async () => {
    return store.sqlite
      .prepare(
        `SELECT a.id, a.state, a.reason, a.dry_run, a.submitted_at, a.confirmation_kind,
                j.company, j.title, j.ats_score
           FROM applications a JOIN jobs j ON j.id = a.job_id
          ORDER BY a.updated_at DESC LIMIT 200`,
      )
      .all();
  });

  app.get('/api/bank', async () => listAnswers(store, 500));

  return app;
}

export async function start(port = 4600): Promise<void> {
  if (!existsSync(DB)) {
    throw new Error(`No database at ${DB}. Run a crawl or an application first.`);
  }
  const store = openStore(DB);
  const app = buildServer(store);
  await app.listen({ port, host: '127.0.0.1' });
  console.log(`Review queue: http://127.0.0.1:${port}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  await start(Number(process.env.PORT ?? 4600));
}
