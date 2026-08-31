import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openStore, type Store } from '@mapply/db';
import { checkDomain, classifyFailure, handleFailure, noteOutcome, noteRequest } from '../src/pacing';

async function withApplication(run: (store: Store, id: number) => Promise<void>): Promise<void> {
  const store = openStore(':memory:');
  try {
    const now = Date.now();
    const job = store.sqlite
      .prepare(
        `INSERT INTO jobs (source, source_id, job_hash, url, company, company_key, title, title_key, discovered_at)
         VALUES ('url', 's1', 'h', 'https://example.com', 'Acme', 'acme', 'Engineer', 'engineer', ?)
         RETURNING id`,
      )
      .get(now) as { id: number };
    const app = store.sqlite
      .prepare(
        `INSERT INTO applications (job_id, state, created_at, updated_at)
         VALUES (?, 'filling', ?, ?) RETURNING id`,
      )
      .get(job.id, now, now) as { id: number };
    await run(store, app.id);
  } finally {
    await store.close();
  }
}

describe('classifyFailure', () => {
  it('recognises the faults only a person can clear', () => {
    // These must not be treated as failures. A failed application is written
    // off; a parked one is waiting for somebody who can solve it in seconds.
    assert.equal(classifyFailure(new Error('nav'), 'Please complete the CAPTCHA'), 'captcha');
    assert.equal(classifyFailure(new Error('401 Unauthorized')), 'login_required');
  });

  it('recognises what is final', () => {
    assert.equal(classifyFailure(new Error('x'), 'This role is no longer accepting applications'), 'posting_closed');
    assert.equal(classifyFailure(new Error('You have already applied')), 'already_applied');
  });

  it('recognises what is worth another go', () => {
    assert.equal(classifyFailure(new Error('Timeout 30000ms exceeded')), 'nav_timeout');
    assert.equal(classifyFailure(new Error('net::ERR_CONNECTION_RESET')), 'nav_timeout');
  });

  it('treats the unrecognised as retryable', () => {
    // A wrong guess costs one wasted attempt; calling a transient fault final
    // quietly loses the application.
    assert.equal(classifyFailure(new Error('something nobody predicted')), 'page_error');
  });
});

describe('handleFailure', () => {
  it('parks what a person can solve, without retrying it', async () => {
    await withApplication(async (store, id) => {
      assert.equal(await handleFailure(store, id, 'captcha', 'a challenge appeared', 1, 3), 'parked');
      const row = store.sqlite.prepare('SELECT state, reason, next_attempt_at FROM applications WHERE id = ?').get(id) as
        { state: string; reason: string; next_attempt_at: number | null };
      assert.equal(row.state, 'needs_review');
      assert.equal(row.reason, 'captcha');
      assert.equal(row.next_attempt_at, null, 'a parked application must not be scheduled to retry');
    });
  });

  it('schedules a retry for a transient fault, in the future', async () => {
    await withApplication(async (store, id) => {
      assert.equal(await handleFailure(store, id, 'nav_timeout', 'timed out', 1, 3), 'retry');
      const row = store.sqlite.prepare('SELECT state, next_attempt_at, lease_owner FROM applications WHERE id = ?').get(id) as
        { state: string; next_attempt_at: number; lease_owner: string | null };
      assert.equal(row.state, 'queued');
      assert.ok(row.next_attempt_at > Date.now(), 'the retry must be held off, not immediate');
      assert.equal(row.lease_owner, null, 'the lease must be released so another worker can take it');
    });
  });

  it('gives up once the attempts are spent', async () => {
    await withApplication(async (store, id) => {
      assert.equal(await handleFailure(store, id, 'nav_timeout', 'timed out', 3, 3), 'dead');
      const row = store.sqlite.prepare('SELECT state FROM applications WHERE id = ?').get(id) as { state: string };
      assert.equal(row.state, 'failed');
    });
  });

  it('never retries a closed posting', async () => {
    await withApplication(async (store, id) => {
      assert.equal(await handleFailure(store, id, 'posting_closed', 'gone', 1, 3), 'dead');
    });
  });
});

describe('domain pacing', () => {
  it('asks for a pause between requests to one host', async () => {
    const store = openStore(':memory:');
    try {
      assert.equal(checkDomain(store, 'https://boards.greenhouse.io/a').waitMs, 0, 'an unseen host is not held up');
      noteRequest(store, 'https://boards.greenhouse.io/a');
      assert.ok(
        checkDomain(store, 'https://boards.greenhouse.io/b').waitMs > 0,
        'a second request to the same host should be paced',
      );
      assert.equal(
        checkDomain(store, 'https://jobs.lever.co/x').waitMs,
        0,
        'a different host is unaffected',
      );
    } finally {
      await store.close();
    }
  });

  it('stops going to a host that keeps refusing, and forgives it on success', async () => {
    const store = openStore(':memory:');
    try {
      const url = 'https://flaky.example.com/apply';
      noteRequest(store, url);
      for (let i = 0; i < 5; i += 1) noteOutcome(store, url, false);
      assert.equal(checkDomain(store, url).circuitOpen, true);

      noteOutcome(store, url, true);
      assert.equal(checkDomain(store, url).circuitOpen, false, 'one success should reopen it');
    } finally {
      await store.close();
    }
  });
});
