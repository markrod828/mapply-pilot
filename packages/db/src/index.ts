import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import SqliteDatabase from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import {
  InvalidTransition,
  canTransition,
  type ApplicationState,
} from '@mapply/core/application';
import { MIGRATIONS } from './migrations';
import type { Database } from './schema';

export type { Database } from './schema';
export * from './schema';
export * from './answers';
export * from './templates';

export interface Store {
  db: Kysely<Database>;
  /** The raw handle, for the few statements Kysely cannot express. */
  sqlite: SqliteDatabase.Database;
  close(): Promise<void>;
}

export function openStore(file: string): Store {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

  const sqlite = new SqliteDatabase(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // NORMAL trades a vanishingly small crash window for a large write speedup,
  // and every transition here is re-derivable from the page anyway.
  sqlite.pragma('synchronous = NORMAL');

  migrate(sqlite);

  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  return {
    db,
    sqlite,
    async close() {
      await db.destroy();
    },
  };
}

/**
 * Applies any migrations this database has not seen.
 *
 * Version lives in SQLite's own `user_version` rather than a table, so the very
 * first migration needs no bootstrapping and an empty file is simply version 0.
 */
function migrate(sqlite: SqliteDatabase.Database): void {
  const current = sqlite.pragma('user_version', { simple: true }) as number;
  if (current >= MIGRATIONS.length) return;

  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const statement = MIGRATIONS[version];
    sqlite.transaction(() => {
      sqlite.exec(statement);
      // Interpolated because PRAGMA takes no bound parameters. The value is a
      // loop index over a compile-time constant array, never user input.
      sqlite.pragma(`user_version = ${version + 1}`);
    })();
  }
}

export interface TransitionInput {
  applicationId: number;
  to: ApplicationState;
  reason?: string | null;
  reasonDetail?: string | null;
  /** Columns to write in the same statement, so state and evidence land together. */
  patch?: Partial<Record<string, unknown>>;
}

/**
 * Moves an application to a new state, refusing an illegal move and recording
 * what happened.
 *
 * The write and its event go in one transaction: a state with no explanation is
 * how a stuck queue becomes unexplainable a week later.
 */
export async function transition(store: Store, input: TransitionInput): Promise<void> {
  const now = Date.now();
  const row = await store.db
    .selectFrom('applications')
    .select(['state'])
    .where('id', '=', input.applicationId)
    .executeTakeFirst();

  if (!row) throw new Error(`No application ${input.applicationId}.`);
  const from = row.state as ApplicationState;
  if (from !== input.to && !canTransition(from, input.to)) {
    throw new InvalidTransition(from, input.to);
  }

  await store.db.transaction().execute(async (trx) => {
    await trx
      .updateTable('applications')
      .set({
        state: input.to,
        reason: input.reason ?? null,
        reason_detail: input.reasonDetail ?? null,
        updated_at: now,
        ...(input.patch as Record<string, never>),
      })
      .where('id', '=', input.applicationId)
      .execute();

    await trx
      .insertInto('application_events')
      .values({
        application_id: input.applicationId,
        at: now,
        from_state: from,
        to_state: input.to,
        kind: 'transition',
        detail_json: input.reason ? JSON.stringify({ reason: input.reason }) : null,
      })
      .execute();
  });
}

/** Appends a non-transition event: a field written, a screenshot, an error. */
export async function recordEvent(
  store: Store,
  applicationId: number,
  kind: string,
  detail?: unknown,
): Promise<void> {
  await store.db
    .insertInto('application_events')
    .values({
      application_id: applicationId,
      at: Date.now(),
      from_state: null,
      to_state: null,
      kind,
      detail_json: detail === undefined ? null : JSON.stringify(detail),
    })
    .execute();
}

export interface ClaimedApplication {
  id: number;
  job_id: number;
  attempt_count: number;
  dry_run: number;
}

/**
 * Takes the next application in `state`, atomically.
 *
 * One statement, so two workers cannot pick the same row: the lease is part of
 * the same UPDATE that selects it. `lease_expires_at` is what lets a worker that
 * dies mid-application have its work recovered rather than stranded.
 */
export function claimNext(
  store: Store,
  state: ApplicationState,
  worker: string,
  leaseMs = 600_000,
): ClaimedApplication | undefined {
  const now = Date.now();
  return store.sqlite
    .prepare(
      `UPDATE applications
          SET state = @nextState,
              lease_owner = @worker,
              lease_expires_at = @now + @leaseMs,
              attempt_count = attempt_count + 1,
              updated_at = @now
        WHERE id = (
          SELECT id FROM applications
           WHERE state = @state
             AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
             AND (lease_expires_at IS NULL OR lease_expires_at < @now)
           ORDER BY priority DESC, id
           LIMIT 1
        )
    RETURNING id, job_id, attempt_count, dry_run`,
    )
    .get({ state, nextState: nextStateFor(state), worker, now, leaseMs }) as
    | ClaimedApplication
    | undefined;
}

function nextStateFor(state: ApplicationState): ApplicationState {
  if (state === 'ready') return 'filling';
  if (state === 'queued') return 'tailoring';
  return state;
}

/**
 * Re-queues work a dead worker left behind.
 *
 * `submitting` rows that already recorded a submit attempt are the exception:
 * we do not know whether the click landed, and asking again risks a duplicate
 * application, so a person looks at those instead.
 */
export async function recoverStaleLeases(store: Store): Promise<number> {
  const now = Date.now();
  const stale = await store.db
    .selectFrom('applications')
    .select(['id', 'state', 'submit_attempted_at'])
    .where('lease_expires_at', '<', now)
    .where('state', 'in', ['tailoring', 'filling', 'submitting'])
    .execute();

  for (const row of stale) {
    const unverifiedSubmit = row.state === 'submitting' && row.submit_attempted_at !== null;
    await transition(store, {
      applicationId: row.id,
      to: unverifiedSubmit ? 'needs_review' : 'queued',
      reason: unverifiedSubmit ? 'submit_unverified' : null,
      reasonDetail: unverifiedSubmit
        ? 'The worker stopped after clicking submit. Check whether the application arrived.'
        : 'Recovered from an expired lease.',
      patch: { lease_owner: null, lease_expires_at: null },
    });
  }
  return stale.length;
}

export { sql };
