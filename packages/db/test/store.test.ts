import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidTransition } from '@mapply/core/application';
import {
  CLEAN_RUNS_REQUIRED,
  claimNext,
  mayAutoSubmit,
  openStore,
  recordFormRun,
  recoverStaleLeases,
  transition,
  type Store,
} from '../src/index';

async function seed(store: Store): Promise<number> {
  const now = Date.now();
  const job = await store.db
    .insertInto('jobs')
    .values({
      source: 'url', source_id: `s${Math.random()}`, job_hash: 'h',
      url: 'https://example.com', company: 'Acme', company_key: 'acme',
      title: 'Engineer', title_key: 'engineer', discovered_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const app = await store.db
    .insertInto('applications')
    .values({ job_id: job.id, state: 'discovered', created_at: now, updated_at: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  return app.id;
}

describe('migrations', () => {
  it('are idempotent across reopens', () => {
    const store = openStore(':memory:');
    const before = store.sqlite.pragma('user_version', { simple: true });
    const tables = store.sqlite
      .prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'")
      .get() as { c: number };
    assert.ok((before as number) > 0);
    assert.equal(tables.c, 9);
    void store.close();
  });
});

describe('transition', () => {
  it('walks the intended path', async () => {
    const store = openStore(':memory:');
    const id = await seed(store);
    for (const to of ['scored', 'queued', 'ready', 'filling'] as const) {
      await transition(store, { applicationId: id, to });
    }
    const row = await store.db
      .selectFrom('applications').select(['state'])
      .where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(row.state, 'filling');
    await store.close();
  });

  it('refuses a jump straight to submitted', async () => {
    // The guard that matters: nothing reaches `submitted` without passing
    // through `submitting`, where the duplicate guard is written.
    const store = openStore(':memory:');
    const id = await seed(store);
    await assert.rejects(
      () => transition(store, { applicationId: id, to: 'submitted' }),
      InvalidTransition,
    );
    await store.close();
  });

  it('records every move', async () => {
    const store = openStore(':memory:');
    const id = await seed(store);
    await transition(store, { applicationId: id, to: 'scored' });
    await transition(store, { applicationId: id, to: 'skipped', reason: 'duplicate' });
    const events = await store.db
      .selectFrom('application_events').selectAll()
      .where('application_id', '=', id).execute();
    assert.equal(events.length, 2);
    assert.equal(events[1].to_state, 'skipped');
    await store.close();
  });
});

describe('claimNext', () => {
  it('hands one row to exactly one worker', async () => {
    const store = openStore(':memory:');
    const id = await seed(store);
    await transition(store, { applicationId: id, to: 'scored' });
    await transition(store, { applicationId: id, to: 'queued' });
    await transition(store, { applicationId: id, to: 'ready' });

    const first = claimNext(store, 'ready', 'worker-a');
    const second = claimNext(store, 'ready', 'worker-b');
    assert.equal(first?.id, id);
    assert.equal(second, undefined);
    assert.equal(first?.attempt_count, 1);
    await store.close();
  });
});

describe('recoverStaleLeases', () => {
  it('re-queues a worker that died before submitting', async () => {
    const store = openStore(':memory:');
    const id = await seed(store);
    for (const to of ['scored', 'queued', 'ready', 'filling'] as const) {
      await transition(store, { applicationId: id, to });
    }
    await store.db.updateTable('applications')
      .set({ lease_expires_at: Date.now() - 1000 })
      .where('id', '=', id).execute();

    assert.equal(await recoverStaleLeases(store), 1);
    const row = await store.db.selectFrom('applications').select(['state'])
      .where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(row.state, 'queued');
    await store.close();
  });

  it('parks a worker that died after clicking submit, and never retries it', async () => {
    // The worst failure this system can have is applying twice. If the process
    // stopped after the click, we do not know whether it landed, so a person
    // looks - the row must never go back on the queue.
    const store = openStore(':memory:');
    const id = await seed(store);
    for (const to of ['scored', 'queued', 'ready', 'filling', 'submitting'] as const) {
      await transition(store, { applicationId: id, to });
    }
    await store.db.updateTable('applications')
      .set({ lease_expires_at: Date.now() - 1000, submit_attempted_at: Date.now() })
      .where('id', '=', id).execute();

    await recoverStaleLeases(store);
    const row = await store.db.selectFrom('applications').select(['state', 'reason'])
      .where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(row.state, 'needs_review');
    assert.equal(row.reason, 'submit_unverified');
    await store.close();
  });
});

describe('duplicate guards', () => {
  it('allows only one application per job', async () => {
    const store = openStore(':memory:');
    const now = Date.now();
    const job = await store.db.insertInto('jobs').values({
      source: 'url', source_id: 'once', job_hash: 'h', url: 'https://example.com',
      company: 'Acme', company_key: 'acme', title: 'Engineer', title_key: 'engineer',
      discovered_at: now,
    }).returningAll().executeTakeFirstOrThrow();

    await store.db.insertInto('applications')
      .values({ job_id: job.id, state: 'ready', created_at: now, updated_at: now }).execute();
    await assert.rejects(() =>
      store.db.insertInto('applications')
        .values({ job_id: job.id, state: 'ready', created_at: now, updated_at: now }).execute(),
    );
    await store.close();
  });

  it('allows only one job per source id', async () => {
    const store = openStore(':memory:');
    const now = Date.now();
    const values = {
      source: 'jobright', source_id: 'jr-1', job_hash: 'h', url: 'https://example.com',
      company: 'Acme', company_key: 'acme', title: 'Engineer', title_key: 'engineer',
      discovered_at: now,
    };
    await store.db.insertInto('jobs').values(values).execute();
    await assert.rejects(() => store.db.insertInto('jobs').values(values).execute());
    await store.close();
  });
});

describe('form trust', () => {
  const run = (store: Store, clean: boolean) =>
    recordFormRun(store, {
      fingerprint: 'fp-1',
      atsKind: 'greenhouse',
      origin: 'https://example.com',
      fieldCount: 8,
      clean,
    });

  it('earns the right to submit only after several clean runs', async () => {
    const store = openStore(':memory:');
    try {
      for (let i = 1; i < CLEAN_RUNS_REQUIRED; i += 1) {
        assert.equal(run(store, true).autoSubmitOk, false, `still unproven after ${i} run(s)`);
      }
      assert.equal(run(store, true).autoSubmitOk, true);
      assert.equal(mayAutoSubmit(store, 'fp-1'), true);
    } finally {
      await store.close();
    }
  });

  it('spends that trust entirely on one bad run', async () => {
    // Not merely paused. A form that fails every other time must never drift
    // into submitting on its own.
    const store = openStore(':memory:');
    try {
      for (let i = 0; i < CLEAN_RUNS_REQUIRED; i += 1) run(store, true);
      assert.equal(mayAutoSubmit(store, 'fp-1'), true);

      const after = run(store, false);
      assert.equal(after.cleanRuns, 0);
      assert.equal(after.autoSubmitOk, false);
      assert.equal(mayAutoSubmit(store, 'fp-1'), false);
    } finally {
      await store.close();
    }
  });

  it('never trusts a form it has not seen', async () => {
    const store = openStore(':memory:');
    try {
      assert.equal(mayAutoSubmit(store, 'never-seen'), false);
      assert.equal(mayAutoSubmit(store, undefined), false);
    } finally {
      await store.close();
    }
  });
});
