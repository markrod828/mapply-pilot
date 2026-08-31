import {
  isRetryable,
  retryDelayMs,
  type FailureReason,
  type ReviewReason,
} from '@mapply/core/application';
import { transition, type Store } from '@mapply/db';

/** How long to leave between two applications to the same host, before jitter. */
const DEFAULT_INTERVAL_MS = 60_000;
/** Consecutive failures at one host before it is left alone for a while. */
const TRIP_AFTER = 5;
const COOLDOWN_MS = 2 * 60 * 60 * 1000;

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
}

/**
 * Reads what went wrong into a word the queue can act on.
 *
 * Three outcomes, not two. Some faults are worth retrying, some are final, and
 * some - a login wall, a CAPTCHA - are neither: the machine cannot get past
 * them and no amount of trying will change that, but a person sitting at this
 * browser can solve one in seconds. Those park rather than fail, because a
 * failed application is written off and a parked one is waiting for help.
 *
 * Anything unrecognised becomes a page error, which retries. A wrong guess
 * there costs one wasted attempt; treating a transient fault as final quietly
 * loses the application.
 */
export function classifyFailure(error: Error, pageText = ''): FailureReason | ReviewReason {
  const message = `${error.message} ${pageText}`.toLowerCase();

  if (/captcha|are you a robot|unusual traffic|cf-challenge/.test(message)) return 'captcha';
  if (/sign in|log in|session (has )?expired|unauthorized|401/.test(message)) return 'login_required';
  if (/no longer accepting|position (has been )?(closed|filled)|posting (is )?closed|404/.test(message)) {
    return 'posting_closed';
  }
  if (/already applied|duplicate application/.test(message)) return 'already_applied';
  if (/timeout|timed out|net::err_|econnreset|socket hang up/.test(message)) return 'nav_timeout';
  if (/no template matched|unsupported/.test(message)) return 'unsupported_ats';
  if (/locator|selector|element .* not found|strict mode violation/.test(message)) return 'selector_missing';
  if (/openai|rate limit|429/.test(message)) return 'llm_error';
  return 'page_error';
}

export interface DomainState {
  /** Milliseconds to wait before this host should be touched again. */
  waitMs: number;
  /** True when the host has failed enough that it is being left alone. */
  circuitOpen: boolean;
}

/**
 * How long to hold off before the next request to a host.
 *
 * Jittered rather than fixed. A fleet that paces itself exactly is more
 * recognisable than one that does not pace itself at all, and the point of
 * spacing requests is to look like somebody working through a list.
 */
export function checkDomain(store: Store, url: string): DomainState {
  const domain = domainOf(url);
  const now = Date.now();
  const row = store.sqlite
    .prepare('SELECT min_interval_ms, last_request_at, circuit_open_until FROM domain_limits WHERE domain = ?')
    .get(domain) as
    | { min_interval_ms: number; last_request_at: number | null; circuit_open_until: number | null }
    | undefined;

  if (!row) return { waitMs: 0, circuitOpen: false };
  if (row.circuit_open_until && row.circuit_open_until > now) {
    return { waitMs: row.circuit_open_until - now, circuitOpen: true };
  }

  const since = now - (row.last_request_at ?? 0);
  const interval = row.min_interval_ms * (0.75 + Math.random() * 0.5);
  return { waitMs: Math.max(0, interval - since), circuitOpen: false };
}

export function noteRequest(store: Store, url: string): void {
  store.sqlite
    .prepare(
      `INSERT INTO domain_limits (domain, min_interval_ms, last_request_at)
       VALUES (@domain, @interval, @now)
       ON CONFLICT(domain) DO UPDATE SET last_request_at = @now`,
    )
    .run({ domain: domainOf(url), interval: DEFAULT_INTERVAL_MS, now: Date.now() });
}

/**
 * Records how a host behaved, and stops going there if it keeps refusing.
 *
 * The breaker exists to make a bad situation quiet rather than loud: a host that
 * has rejected five attempts running is telling us something, and the useful
 * response is to stop asking for a while instead of working through the whole
 * queue against it and turning one problem into fifty.
 */
export function noteOutcome(store: Store, url: string, ok: boolean): void {
  const domain = domainOf(url);
  if (ok) {
    store.sqlite
      .prepare('UPDATE domain_limits SET consecutive_failures = 0, circuit_open_until = NULL WHERE domain = ?')
      .run(domain);
    return;
  }

  store.sqlite
    .prepare(
      `UPDATE domain_limits
          SET consecutive_failures = consecutive_failures + 1,
              circuit_open_until = CASE
                WHEN consecutive_failures + 1 >= @trip THEN @until ELSE circuit_open_until END
        WHERE domain = @domain`,
    )
    .run({ domain, trip: TRIP_AFTER, until: Date.now() + COOLDOWN_MS });
}

export type RetryDecision = 'retry' | 'dead' | 'parked';

/** Faults a person at this browser can clear, and a machine cannot. */
const FOR_A_PERSON: ReadonlySet<string> = new Set<ReviewReason>([
  'captcha',
  'login_required',
  'unexpected_step',
  'wizard_stuck',
]);

/**
 * Decides what happens to a failed application.
 *
 * Retries are scheduled rather than immediate, and only for failures that could
 * go differently next time. Anything that has run out of attempts stops for good
 * and stays visible - a queue that silently keeps retrying is one where nothing
 * ever gets looked at.
 */
export async function handleFailure(
  store: Store,
  applicationId: number,
  reason: FailureReason | ReviewReason,
  detail: string,
  attemptCount: number,
  maxAttempts: number,
): Promise<RetryDecision> {
  if (FOR_A_PERSON.has(reason)) {
    await transition(store, {
      applicationId,
      to: 'needs_review',
      reason,
      reasonDetail: detail.slice(0, 500),
    });
    return 'parked';
  }

  const canRetry = isRetryable(reason) && attemptCount < maxAttempts;

  if (!canRetry) {
    await transition(store, {
      applicationId,
      to: 'failed',
      reason,
      reasonDetail: detail.slice(0, 500),
    });
    return 'dead';
  }

  await transition(store, {
    applicationId,
    to: 'queued',
    reason,
    reasonDetail: `${detail.slice(0, 400)} (attempt ${attemptCount} of ${maxAttempts})`,
    patch: {
      next_attempt_at: Date.now() + retryDelayMs(attemptCount),
      lease_owner: null,
      lease_expires_at: null,
    },
  });
  return 'retry';
}
