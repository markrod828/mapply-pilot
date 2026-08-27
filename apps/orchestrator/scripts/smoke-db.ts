import { openStore, transition, claimNext, recoverStaleLeases } from '@mapply/db';
import { InvalidTransition } from '@mapply/core/application';

const store = openStore(':memory:');
const now = Date.now();

const job = await store.db.insertInto('jobs').values({
  jobright_id: 'jr-1', job_hash: 'h1', jobright_url: 'https://jobright.ai/jobs/info/jr-1',
  company: 'Acme', company_key: 'acme', title: 'Backend Engineer', title_key: 'backend engineer',
  discovered_at: now,
}).returningAll().executeTakeFirstOrThrow();

const app = await store.db.insertInto('applications').values({
  job_id: job.id, state: 'discovered', created_at: now, updated_at: now,
}).returningAll().executeTakeFirstOrThrow();

// Legal path
await transition(store, { applicationId: app.id, to: 'scored' });
await transition(store, { applicationId: app.id, to: 'queued' });
await transition(store, { applicationId: app.id, to: 'ready' });

// Illegal path must be refused
let refused = false;
try {
  await transition(store, { applicationId: app.id, to: 'submitted' });
} catch (e) { refused = e instanceof InvalidTransition; }
console.log('illegal transition refused:', refused);

// Atomic claim: two workers, one row
const a = claimNext(store, 'ready', 'worker-a');
const b = claimNext(store, 'ready', 'worker-b');
console.log('worker-a claimed:', a?.id, '| worker-b claimed:', b?.id ?? 'nothing');
console.log('attempt_count incremented:', a?.attempt_count);

// A worker that died after clicking submit must be parked, not retried
await transition(store, { applicationId: app.id, to: 'submitting',
  patch: { submit_attempted_at: now, lease_expires_at: now - 1000 } });
const recovered = await recoverStaleLeases(store);
const after = await store.db.selectFrom('applications')
  .select(['state', 'reason']).where('id', '=', app.id).executeTakeFirstOrThrow();
console.log('recovered:', recovered, '-> state:', after.state, '| reason:', after.reason);

const events = await store.db.selectFrom('application_events')
  .select(['from_state', 'to_state']).where('application_id', '=', app.id).execute();
console.log('events logged:', events.length);
console.log('tables:', store.sqlite.prepare(
  "SELECT count(*) c FROM sqlite_master WHERE type='table'").get());
await store.close();
