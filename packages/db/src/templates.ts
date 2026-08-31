import type { Store } from './index';

/** Clean dry runs a form's shape must accumulate before it may submit itself. */
export const CLEAN_RUNS_REQUIRED = 3;

export interface FormRun {
  fingerprint: string;
  atsKind: string;
  origin: string;
  fieldCount: number;
  /** True when the fill left nothing blocking. */
  clean: boolean;
  planJson?: string;
}

export interface FormStanding {
  cleanRuns: number;
  autoSubmitOk: boolean;
  hits: number;
  fails: number;
}

/**
 * Records how a form's shape behaved, and decides whether it has earned trust.
 *
 * This is the control that stops an ATS redesign submitting nonsense. A form is
 * only allowed to submit itself once its exact shape has been filled cleanly
 * several times running; a single park or failure sets that back to zero. So
 * when a vendor changes their markup the fingerprint changes with it, the new
 * shape starts from nothing, and the worst case is that applications queue up
 * for review rather than going out wrong.
 */
export function recordFormRun(store: Store, run: FormRun): FormStanding {
  const now = Date.now();

  store.sqlite
    .prepare(
      `INSERT INTO form_templates (fingerprint, ats_kind, origin, field_count, plan_json, created_at, last_used_at)
       VALUES (@fingerprint, @atsKind, @origin, @fieldCount, @plan, @now, @now)
       ON CONFLICT(fingerprint) DO UPDATE SET last_used_at = @now, field_count = @fieldCount`,
    )
    .run({
      fingerprint: run.fingerprint,
      atsKind: run.atsKind,
      origin: run.origin,
      fieldCount: run.fieldCount,
      plan: run.planJson ?? '{}',
      now,
    });

  if (run.clean) {
    store.sqlite
      .prepare(
        `UPDATE form_templates
            SET hits = hits + 1,
                clean_runs = clean_runs + 1,
                auto_submit_ok = CASE WHEN clean_runs + 1 >= @required THEN 1 ELSE auto_submit_ok END
          WHERE fingerprint = @fingerprint`,
      )
      .run({ fingerprint: run.fingerprint, required: CLEAN_RUNS_REQUIRED });
  } else {
    // Trust is not merely paused by a bad run, it is spent. Anything else would
    // let a form that fails every other time drift into submitting on its own.
    store.sqlite
      .prepare(
        `UPDATE form_templates
            SET fails = fails + 1, clean_runs = 0, auto_submit_ok = 0
          WHERE fingerprint = @fingerprint`,
      )
      .run({ fingerprint: run.fingerprint });
  }

  return standing(store, run.fingerprint);
}

export function standing(store: Store, fingerprint: string): FormStanding {
  const row = store.sqlite
    .prepare('SELECT clean_runs, auto_submit_ok, hits, fails FROM form_templates WHERE fingerprint = ?')
    .get(fingerprint) as
    | { clean_runs: number; auto_submit_ok: number; hits: number; fails: number }
    | undefined;

  return {
    cleanRuns: row?.clean_runs ?? 0,
    autoSubmitOk: row?.auto_submit_ok === 1,
    hits: row?.hits ?? 0,
    fails: row?.fails ?? 0,
  };
}

/**
 * Whether a form may be submitted without someone watching.
 *
 * An unknown fingerprint is never allowed. A form nobody has filled cleanly is
 * exactly the one most likely to be misunderstood.
 */
export function mayAutoSubmit(store: Store, fingerprint: string | undefined): boolean {
  if (!fingerprint) return false;
  return standing(store, fingerprint).autoSubmitOk;
}

export function listFormTemplates(store: Store, limit = 100): {
  fingerprint: string;
  ats_kind: string | null;
  origin: string | null;
  field_count: number;
  clean_runs: number;
  auto_submit_ok: number;
  hits: number;
  fails: number;
}[] {
  return store.sqlite
    .prepare(
      `SELECT fingerprint, ats_kind, origin, field_count, clean_runs, auto_submit_ok, hits, fails
         FROM form_templates ORDER BY last_used_at DESC LIMIT ?`,
    )
    .all(limit) as never;
}
