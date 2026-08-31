import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { questionKey } from '@mapply/filler';

/**
 * The queue, worked end to end against local fixtures.
 *
 * Fixtures rather than a live posting on purpose: this is testing the worker
 * loop - claim, drive, record, move on - and a real employer's form would make
 * the result depend on their uptime and their markup rather than on the code.
 */

// Relative to this file, not to the working directory: the test runner starts
// in the workspace package, so anything anchored on cwd points at the wrong tree.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = resolve(HERE, '../../../packages/filler/test/fixtures');
const fixtureUrl = (name: string) => pathToFileURL(resolve(FIXTURES, `${name}.html`)).href;

let dataDir: string;
let mod: typeof import('../src/run');
let jobsMod: typeof import('../src/jobs');
let db: typeof import('@mapply/db');

before(async () => {
  dataDir = mkdtempSync(resolve(tmpdir(), 'mapply-test-'));
  process.env.MAPPLY_DATA_DIR = dataDir;

  // Imported after the env var is set: the data directory is read once, at
  // module load, so importing earlier would bind the real one.
  db = await import('@mapply/db');
  mod = await import('../src/run');
  jobsMod = await import('../src/jobs');

  const identity = await import('../src/identity');
  const store = db.openStore(resolve(dataDir, 'mapply.db'));
  const resumePath = resolve(dataDir, 'resume.txt');
  writeFileSync(resumePath, 'Test Candidate. Backend engineer.');

  identity.importIdentity(store, {
    version: 1,
    profile: {
      firstName: 'Queue', middleName: '', lastName: 'Tester', pronouns: '',
      email: 'queue.tester@example.com', phone: '5125550188', preferredContact: 'Email',
      address: {
        line1: '1 Test St', line2: '', city: 'Austin',
        state: 'TX', postalCode: '78701', country: 'United States',
      },
      gender: '', ethnicity: '', veteranStatus: '', disabilityStatus: '',
      linkedin: '', github: '', portfolio: '',
      currentTitle: 'Engineer', yearsExperience: '8', workAuthorization: 'US Citizen',
      requiresSponsorship: 'no', salaryExpectation: '', noticePeriod: '',
      availableStartDate: '', willingToRelocate: 'no', workPreference: 'Remote',
      referralSource: '', previouslyEmployed: 'no', isOver18: 'yes',
      hasRelativesAtCompany: 'no', relativesDetail: 'N/A', agreeToTerms: 'yes',
      screeningAnswers: [],
    },
    resume: {
      fileName: 'resume.txt', mimeType: 'text/plain',
      text: 'Test Candidate. Backend engineer.', size: 32, updatedAt: Date.now(),
    },
    resumeFile: {
      name: 'resume.txt',
      mimeType: 'text/plain',
      base64: Buffer.from('Test Candidate. Backend engineer.').toString('base64'),
    },
  });
  await store.close();
});

after(() => {
  delete process.env.MAPPLY_DATA_DIR;
  // Retried, and never fatal. SQLite's write-ahead log lingers a moment after
  // close on Windows, and a temp directory that outlives the run is untidy
  // rather than a failure - failing the suite over it would hide real results.
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Left for the operating system to reclaim.
  }
});

// Awaited rather than fire-and-forget: an unclosed handle keeps the database
// locked, and on Windows that surfaces later as an unrelated EBUSY on cleanup.
async function seed(name: string, company: string): Promise<void> {
  const store = db.openStore(resolve(dataDir, 'mapply.db'));
  const job = jobsMod.upsertJob(store, {
    source: 'jobright',
    sourceId: `${name}-${company}`,
    url: fixtureUrl(name),
    applyUrl: fixtureUrl(name),
    atsKind: 'greenhouse',
    title: 'Senior Backend Engineer',
    company,
  });
  jobsMod.openApplication(store, job.id, { dryRun: true });
  await store.close();
}

describe('the queue', () => {
  it('works through what is waiting and records each outcome', async () => {
    await seed('greenhouse-basic', 'Northwind');
    await seed('greenhouse-required-question', 'Contoso');

    const result = await mod.runQueue({ limit: 5, headless: true });

    assert.equal(result.attempted, 2, 'both queued applications should be attempted');
    assert.equal(result.submitted, 0, 'a dry run must never submit');
    assert.equal(result.failed, 0);
    assert.equal(result.parked, 2, 'a dry run parks for review rather than completing');

    // The one with an unanswerable required question must say so, and the clean
    // one must not - otherwise "parked" would be a single undifferentiated heap.
    const reasons = result.results.map((r) => r.reason);
    assert.ok(reasons.includes('dry_run'), `expected a clean dry run, got ${reasons.join(', ')}`);
    assert.ok(
      result.results.some((r) => r.blocking.length > 0),
      'the fixture with a required question should report something blocking',
    );
  });

  it('fills radios, checkboxes and shadow-DOM fields', async () => {
    // The widgets a form engine most often cannot reach: a radio whose real
    // input is hidden behind its label, a consent checkbox, and inputs inside
    // open and closed shadow roots. This also guards the normalisation used to
    // compare option text - a lost backslash there once turned /\s+/ into /s+/,
    // which silently stripped every letter "s" and made "Yes" unmatchable.
    // Taught first, the way a person would: the profile says "US Citizen" and
    // the form offers Yes or No, which is exactly the gap the answer bank
    // exists to close. Without this the application parks, and rightly so.
    const bank = db.openStore(resolve(dataDir, 'mapply.db'));
    db.putAnswer(bank, {
      questionKey: questionKey('Are you legally authorized to work in the United States?'),
      questionText: 'Are you legally authorized to work in the United States?',
      answer: 'Yes',
      source: 'human',
      approved: true,
    });
    await bank.close();

    await seed('greenhouse-widgets', 'Contoso');
    const result = await mod.runQueue({ limit: 5, headless: true });

    const run = result.results.find((r) => r.company === 'Contoso');
    assert.ok(run, 'the widgets application should have been attempted');
    assert.deepEqual(run.blocking, [], `nothing should block: ${run.blocking.join('; ')}`);
    assert.equal(run.verified, run.filled, 'every field it wrote should verify');
    assert.ok(run.filled >= 7, `expected the widget fields to be filled, got ${run.filled}`);
  });

  it('leaves nothing claimable once it has worked the queue', async () => {
    const store = db.openStore(resolve(dataDir, 'mapply.db'));
    try {
      assert.equal(db.claimNext(store, 'ready', 'test-worker'), undefined);
    } finally {
      await store.close();
    }
  });

  it('refuses to open a second application for a submitted job', async () => {
    const store = db.openStore(resolve(dataDir, 'mapply.db'));
    try {
      const job = jobsMod.upsertJob(store, {
        source: 'url', sourceId: 'already-sent', url: 'https://example.com/x',
        title: 'Engineer', company: 'Acme',
      });
      const application = jobsMod.openApplication(store, job.id, { dryRun: false });
      store.sqlite
        .prepare("UPDATE applications SET state = 'submitted' WHERE id = ?")
        .run(application.id);

      assert.throws(
        () => jobsMod.openApplication(store, job.id, { dryRun: false }),
        /already submitted/i,
      );
    } finally {
      await store.close();
    }
  });

  it('spots the same role relisted under a new id', async () => {
    const store = db.openStore(resolve(dataDir, 'mapply.db'));
    try {
      // Same company and role, different listing id and a decorated title - which
      // is exactly how a relisting appears in a feed.
      const first = jobsMod.upsertJob(store, {
        source: 'jobright', sourceId: 'relist-1', url: 'https://example.com/1',
        title: 'Staff Engineer', company: 'Globex', location: 'Austin, TX',
      });
      const second = jobsMod.upsertJob(store, {
        source: 'jobright', sourceId: 'relist-2', url: 'https://example.com/2',
        title: 'Staff Engineer (Remote) #4821', company: 'Globex, Inc.', location: 'Austin, TX',
      });
      assert.notEqual(first.id, second.id, 'both listings are stored');

      const app = jobsMod.openApplication(store, first.id, { dryRun: false });
      store.sqlite.prepare("UPDATE applications SET state = 'submitted' WHERE id = ?").run(app.id);

      assert.ok(
        jobsMod.alreadyAppliedElsewhere(store, second.id),
        'the relisting must be recognised as already applied to',
      );
    } finally {
      await store.close();
    }
  });
});
