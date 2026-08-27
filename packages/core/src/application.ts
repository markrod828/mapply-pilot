/**
 * The lifecycle of one application, and the vocabulary for why one stopped.
 *
 * Lives in core because three things need to agree on it: the orchestrator that
 * drives the transitions, the database that stores them, and the dashboard that
 * explains them to a person.
 */

export const APPLICATION_STATES = [
  'discovered',
  'scored',
  'queued',
  'tailoring',
  'ready',
  'filling',
  'needs_review',
  'submitting',
  'submitted',
  'failed',
  'skipped',
] as const;

export type ApplicationState = (typeof APPLICATION_STATES)[number];

/**
 * Which moves are legal. Enforced on every write rather than trusted, because a
 * bad transition is how an application gets submitted twice or silently stalls.
 */
export const TRANSITIONS: Record<ApplicationState, readonly ApplicationState[]> = {
  discovered: ['scored', 'skipped', 'failed'],
  scored: ['queued', 'skipped'],
  queued: ['tailoring', 'ready', 'skipped', 'failed'],
  tailoring: ['ready', 'queued', 'failed'],
  ready: ['filling', 'queued', 'failed'],
  // 'queued' is how a worker that died mid-fill is recovered: nothing was
  // submitted, the page is gone, and starting over is both safe and correct.
  filling: ['needs_review', 'submitting', 'failed', 'queued'],
  needs_review: ['ready', 'queued', 'skipped', 'failed'],
  submitting: ['submitted', 'needs_review', 'failed'],
  submitted: [],
  // Both of these are re-entered only by a person, from the dashboard.
  failed: ['queued'],
  skipped: ['queued'],
};

export function canTransition(from: ApplicationState, to: ApplicationState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransition extends Error {
  constructor(from: ApplicationState, to: ApplicationState) {
    super(`An application cannot go from ${from} to ${to}.`);
  }
}

/** Why an application is parked. Every one of these is recoverable by a person. */
export const REVIEW_REASONS = [
  'unknown_question',
  'low_confidence',
  'ambiguous_choice',
  'verification_failed',
  'captcha',
  'login_required',
  'unexpected_step',
  'wizard_stuck',
  /** The submit click landed but nothing confirmed it. Never retried automatically. */
  'submit_unverified',
] as const;

/** Why an application stopped for good, unless replayed by hand. */
export const FAILURE_REASONS = [
  'posting_closed',
  'already_applied',
  'nav_timeout',
  'page_error',
  'selector_missing',
  'upload_failed',
  'submit_no_confirmation',
  'llm_error',
  'circuit_open',
  /** The apply link led somewhere no template and no generic pass could read. */
  'unsupported_ats',
] as const;

/** Why an application was never attempted. */
export const SKIP_REASONS = [
  'duplicate',
  'stale_posting',
  'company_blocklist',
  'recently_applied_company',
  'below_gate',
] as const;

export type ReviewReason = (typeof REVIEW_REASONS)[number];
export type FailureReason = (typeof FAILURE_REASONS)[number];
export type SkipReason = (typeof SKIP_REASONS)[number];
export type ApplicationReason = ReviewReason | FailureReason | SkipReason;

/**
 * Failures worth another go, and those that would fail identically forever.
 * A closed posting will still be closed in five minutes; a navigation timeout
 * may not be.
 */
const RETRYABLE: ReadonlySet<string> = new Set<FailureReason>([
  'nav_timeout',
  'page_error',
  'selector_missing',
  'llm_error',
  'circuit_open',
]);

export function isRetryable(reason: string | null | undefined): boolean {
  return reason ? RETRYABLE.has(reason) : false;
}

/** Backoff for attempt n (1-based), jittered so retries do not bunch up. */
export function retryDelayMs(attempt: number): number {
  const base = [60_000, 300_000, 1_800_000][Math.min(attempt, 2)] ?? 1_800_000;
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/** Which ATS a form belongs to. `unknown` still gets the generic engine. */
export const ATS_KINDS = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'workday',
  'unknown',
] as const;

export type AtsKind = (typeof ATS_KINDS)[number];
