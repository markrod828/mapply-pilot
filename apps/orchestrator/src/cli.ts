import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { listAnswers, openStore, putAnswer, recoverStaleLeases } from '@mapply/db';
import { questionKey } from '@mapply/filler';
import { describeIdentity, importIdentity, loadIdentity, type IdentityExport } from './identity';
import { ensureDataDirs, paths } from './paths';
import { crawl } from './crawl';
import { runApply, runQueue } from './run';

const USAGE = `mapply - automated job applications

  mapply import <file.json>        Load the profile and resume exported from the extension
  mapply whoami                    Show the imported identity
  mapply apply --url <url>         Fill an application. Dry run unless --submit is given
      --submit                     Actually click submit
      --headless                   Run without a visible window
      --keep-open                  Leave the browser open afterwards, to look around
  mapply crawl [--limit N]         Read new jobs from jobright into the queue
      --no-apply-links             Skip following each posting's Apply link (faster)
  mapply run [--limit N]           Work the queue. Dry run unless --submit is given
      --submit                     Actually click submit
      --budget <usd>               Stop scoring/tailoring once today has cost this much
  mapply status [--limit N]        Recent applications
  mapply recover                   Re-queue work a stopped run left behind
  mapply questions                 Questions that stopped an application, most common first
  mapply answer "<question>" "<answer>"
                                   Teach it an answer, reused everywhere after
  mapply bank                      What it has been taught
  mapply dashboard [--port N]      Open the review queue in a browser
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case 'import':
      return doImport(rest[0]);
    case 'whoami':
      return doWhoami();
    case 'apply':
      return doApply(rest);
    case 'crawl':
      return doCrawl(rest);
    case 'run':
      return doRun(rest);
    case 'status':
      return doStatus(rest);
    case 'recover':
      return doRecover();
    case 'questions':
      return doQuestions();
    case 'answer':
      return doAnswer(rest);
    case 'bank':
      return doBank();
    case 'dashboard':
      return doDashboard(rest);
    default:
      process.stdout.write(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

/**
 * Expands a leading `~` and makes the path absolute.
 *
 * PowerShell and cmd pass `~` through untouched, so a path that works in every
 * shell the docs might be read in arrives here as a literal directory name and
 * fails with a bewildering error about a folder called `~`.
 */
function resolvePath(input: string): string {
  const expanded = input.startsWith('~') ? input.replace(/^~/, homedir()) : input;
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

function doImport(file: string | undefined): void {
  if (!file) throw new Error('Usage: mapply import <file.json>');
  const path = resolvePath(file);
  ensureDataDirs();
  const store = openStore(paths.database);
  try {
    const exported = JSON.parse(readFileSync(path, 'utf8')) as IdentityExport;
    const identity = importIdentity(store, exported);
    console.log('Imported:');
    console.log(describeIdentity(identity));
  } finally {
    void store.close();
  }
}

function doWhoami(): void {
  const store = openStore(paths.database);
  try {
    console.log(describeIdentity(loadIdentity(store)));
  } finally {
    void store.close();
  }
}

async function doApply(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      submit: { type: 'boolean', default: false },
      headless: { type: 'boolean', default: false },
      'keep-open': { type: 'boolean', default: false },
    },
  });
  if (!values.url) throw new Error('Usage: mapply apply --url <url> [--submit]');

  if (values.submit) {
    console.log('SUBMIT mode: this will really send the application.\n');
  } else {
    console.log('Dry run: the form will be filled and photographed, not submitted.\n');
  }

  const result = await runApply({
    url: values.url,
    submit: values.submit,
    headless: values.headless,
    keepOpen: values['keep-open'],
  });

  console.log(`application  #${result.applicationId}`);
  console.log(`state        ${result.state}${result.reason ? ` (${result.reason})` : ''}`);
  console.log(`fields       ${result.verified}/${result.filled} verified`);
  if (result.delegated.length) {
    console.log(`delegated    ${result.delegated.length} container(s) the template did not claim`);
  }
  if (result.blocking.length) {
    console.log('blocking:');
    for (const item of result.blocking) console.log(`  - ${item}`);
  }
  if (result.waived.length) {
    console.log('waived (submitted without):');
    for (const item of result.waived) console.log(`  - ${item}`);
  }
  if (result.unanswered.length) {
    console.log('unanswered:');
    for (const q of result.unanswered) {
      console.log(`  - ${q.required ? '*' : ' '} "${q.label}" (${q.control})`);
    }
    console.log('  teach it one with: mapply answer "<question>" "<answer>"');
  }
  if (result.confirmation) {
    console.log(`confirmed    ${result.confirmation.signals.join(' + ')}`);
    if (result.confirmation.status) console.log(`http         ${result.confirmation.status}`);
    if (result.confirmation.text) console.log(`said         "${result.confirmation.text}"`);
  }
  console.log(`screenshot   ${result.screenshot}`);
}

async function doStatus(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { limit: { type: 'string' } } });
  const limit = Number(values.limit ?? 20);
  const store = openStore(paths.database);
  try {
    const rows = await store.db
      .selectFrom('applications')
      .innerJoin('jobs', 'jobs.id', 'applications.job_id')
      .select([
        'applications.id', 'applications.state', 'applications.reason',
        'applications.dry_run', 'jobs.company', 'jobs.title',
      ])
      .orderBy('applications.updated_at', 'desc')
      .limit(limit)
      .execute();

    if (!rows.length) return console.log('Nothing applied to yet.');
    for (const row of rows) {
      const mode = row.dry_run ? ' [dry]' : '';
      const why = row.reason ? ` (${row.reason})` : '';
      console.log(
        `#${String(row.id).padEnd(4)} ${row.state.padEnd(13)}${mode.padEnd(6)} ${row.company} - ${row.title}${why}`,
      );
    }
  } finally {
    await store.close();
  }
}

async function doRecover(): Promise<void> {
  const store = openStore(paths.database);
  try {
    const count = await recoverStaleLeases(store);
    console.log(count ? `Re-queued or parked ${count} application(s).` : 'Nothing to recover.');
  } finally {
    await store.close();
  }
}


/**
 * The questions that have stopped applications, commonest first.
 *
 * Read back out of what each run recorded rather than kept in a separate table:
 * the point is to work the real backlog, and the commonest question is the one
 * whose answer buys the most.
 */
async function doQuestions(): Promise<void> {
  const store = openStore(paths.database);
  try {
    const rows = await store.db
      .selectFrom('applications')
      .select(['plan_json'])
      .where('plan_json', 'is not', null)
      .execute();

    const counts = new Map<string, { label: string; required: boolean; control: string; n: number }>();
    for (const row of rows) {
      const plan = JSON.parse(row.plan_json as string) as {
        unanswered?: { label: string; required: boolean; control: string }[];
      };
      for (const q of plan.unanswered ?? []) {
        const key = questionKey(q.label);
        const seen = counts.get(key);
        if (seen) seen.n += 1;
        else counts.set(key, { ...q, n: 1 });
      }
    }

    if (!counts.size) return console.log('Nothing outstanding.');
    for (const q of [...counts.values()].sort((a, b) => b.n - a.n)) {
      console.log(`${String(q.n).padStart(3)}x  ${q.required ? '*' : ' '} ${q.label}  (${q.control})`);
    }
    console.log('');
    console.log('Teach one with: mapply answer "<question>" "<answer>"');
  } finally {
    await store.close();
  }
}

function doAnswer(argv: string[]): void {
  const [question, answer] = argv;
  if (!question || !answer) {
    throw new Error('Usage: mapply answer "<question>" "<answer>"');
  }
  const store = openStore(paths.database);
  try {
    putAnswer(store, {
      questionKey: questionKey(question),
      questionText: question,
      answer,
      source: 'human',
      approved: true,
    });
    console.log(`Learned: "${question}" -> "${answer}"`);
  } finally {
    void store.close();
  }
}

function doBank(): void {
  const store = openStore(paths.database);
  try {
    const rows = listAnswers(store);
    if (!rows.length) return console.log('Nothing learned yet.');
    for (const row of rows) {
      console.log(`${String(row.times_used).padStart(3)}x  ${row.question_text}
        -> ${row.answer_text}  [${row.source}]`);
    }
  } finally {
    void store.close();
  }
}

async function doCrawl(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { limit: { type: 'string' }, 'no-apply-links': { type: 'boolean', default: false } },
  });

  const result = await crawl({
    limit: Number(values.limit ?? 25),
    resolveApply: !values['no-apply-links'],
    onProgress: (message) => console.log(`  ${message}`),
  });

  console.log('');
  console.log(`read     ${result.seen}`);
  console.log(`new      ${result.added}`);
  console.log(`queued   ${result.queued}`);
  if (result.duplicates) console.log(`skipped  ${result.duplicates} (same role already applied to)`);
}

async function doRun(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      limit: { type: 'string' },
      submit: { type: 'boolean', default: false },
      headless: { type: 'boolean', default: false },
      budget: { type: 'string' },
    },
  });

  console.log(
    values.submit
      ? 'SUBMIT mode: applications in the queue will really be sent.'
      : 'Dry run: the queue will be filled and photographed, not submitted.',
  );

  const result = await runQueue({
    limit: Number(values.limit ?? 10),
    submit: values.submit,
    headless: values.headless,
    budgetUsd: values.budget === undefined ? undefined : Number(values.budget),
    onProgress: (message) => console.log(message),
  });

  console.log('');
  console.log(`prepared   ${result.prepared}`);
  console.log(`attempted  ${result.attempted}`);
  console.log(`submitted  ${result.submitted}`);
  console.log(`parked     ${result.parked}`);
  console.log(`failed     ${result.failed}`);
  if (result.retried) console.log(`retrying   ${result.retried} (queued again with a delay)`);
  if (result.skipped) console.log(`skipped    ${result.skipped} (scored below the floor)`);
  if (result.spentUsd) console.log(`spent      ${result.spentUsd.toFixed(3)} today`);
  if (result.parked) console.log('See what stopped them with: mapply questions');
}

async function doDashboard(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { port: { type: 'string' } } });
  const { start } = await import('@mapply/dashboard/server');
  await start(Number(values.port ?? 4600));
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
