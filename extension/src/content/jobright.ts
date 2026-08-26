import type { AtsScore, JobPosting } from '../lib/types';
import { extractJob, jobInfoIdFromUrl } from './extract';
import { mountOverlay, type OverlayHandle } from './overlay';

/** Only score when the SPA is on an individual job page: /jobs/info/{id} */
const JOB_INFO_PATH = /^\/jobs\/info\/[^/]+\/?$/i;

/** How long to keep re-reading the DOM before accepting the description as final. */
const SETTLE_POLL_MS = 500;
const SETTLE_TIMEOUT_MS = 8000;
/** Quiet period after the page finishes loading, before the first read. */
const INITIAL_SCAN_DELAY_MS = 1000;
/** Backstop for pages whose `load` event never arrives. */
const LOAD_FALLBACK_MS = 10000;

let overlay: OverlayHandle | null = null;
/** Job info id we last started loading (`/jobs/info/{id}`). */
let activeJobId: string | null = null;
/** Job info id already sent to the background; later DOM churn for it is ignored. */
let capturedJobId: string | null = null;
/** Description fingerprint from the previous scan, used to spot the SPA settling. */
let pendingFingerprint = '';
/** When to stop waiting for the description to settle and score what we have. */
let settleDeadline = 0;
let scanTimer: number | undefined;
let clearInFlight = false;
/** Nothing reads the page until the load has settled - see startScanningAfterLoad. */
let ready = false;

export function startJobright(): void {
  overlay = mountOverlay(() => {
    void chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' });
  });

  watchNavigation();
  startScanningAfterLoad();

  chrome.runtime.onMessage.addListener((message: { type: string; score?: AtsScore }) => {
    if (message.type === 'SCORE_READY' && message.score && isJobInfoPage()) {
      renderScore(message.score);
    }
    if (message.type === 'RESCAN') {
      capturedJobId = null;
      pendingFingerprint = '';
      settleDeadline = Date.now() + SETTLE_TIMEOUT_MS;
      scheduleScan(0, true);
    }
  });
}

function isJobInfoPage(): boolean {
  return JOB_INFO_PATH.test(location.pathname);
}

function renderScore(score: AtsScore) {
  const note = score.mustHaveGaps.length
    ? `ATS score · ${score.mustHaveGaps.length} must-have gap(s)`
    : 'ATS score · click to tailor';
  overlay?.setScore(score.overall, note);
}

/**
 * Throttles rather than debounces: a busy SPA mutates constantly, and resetting
 * the timer on every mutation would starve the scan entirely.
 */
/**
 * Hold every read until one second after the page has finished loading.
 *
 * Content scripts run at document_idle, which Chrome fires at whichever comes first:
 * the load event, or 200ms after DOMContentLoaded. So this cannot assume loading is
 * done - it waits for `load` when the document is still going.
 */
function startScanningAfterLoad(): void {
  let started = false;

  const begin = () => {
    if (started) return;
    started = true;
    window.setTimeout(() => {
      ready = true;
      scheduleScan(0, true);
    }, INITIAL_SCAN_DELAY_MS);
  };

  if (document.readyState === 'complete') {
    begin();
    return;
  }

  window.addEventListener('load', begin, { once: true });
  // A page that keeps a resource open may never fire `load`; do not starve scoring.
  window.setTimeout(begin, LOAD_FALLBACK_MS);
}

function scheduleScan(delay: number, force = false) {
  // Mutations start arriving long before the page has settled; ignore them until then.
  if (!ready) return;

  if (force) {
    window.clearTimeout(scanTimer);
    scanTimer = undefined;
  } else if (scanTimer !== undefined) {
    return;
  }

  scanTimer = window.setTimeout(() => {
    scanTimer = undefined;
    void scan();
  }, delay);
}

async function clearActiveJob(status: string) {
  capturedJobId = null;
  pendingFingerprint = '';
  overlay?.setStatus(status);

  if (clearInFlight) return;
  clearInFlight = true;
  try {
    await chrome.runtime.sendMessage({ type: 'JOB_CLEARED' });
  } catch {
    // Extension reloaded.
  } finally {
    clearInFlight = false;
  }
}

async function scan() {
  // Leaving /jobs/info/* keeps the last job on the board — only a new id clears it.
  if (!isJobInfoPage()) {
    overlay?.setStatus('Open a job posting to score it');
    return;
  }

  const jobId = jobInfoIdFromUrl(location.href);
  if (!jobId) {
    overlay?.setStatus('Waiting for job details…');
    return;
  }

  // Entering a different /jobs/info/{id} → clear active job and reload from scratch.
  if (jobId !== activeJobId) {
    activeJobId = jobId;
    settleDeadline = Date.now() + SETTLE_TIMEOUT_MS;
    await clearActiveJob('Loading job…');
  }

  // This posting has already been captured. The in-page tabs (Overview, Company)
  // swap the whole content block without touching the URL, so re-reading here would
  // capture the wrong text and throw away the score and draft for the same posting.
  if (capturedJobId === jobId) return;

  const job = extractJob();
  if (!job) {
    overlay?.setStatus('Waiting for job details…');
    // Keep looking: the next scan is otherwise only driven by DOM mutations, which
    // stop once the shell has rendered but before the description arrives.
    if (Date.now() < settleDeadline) scheduleScan(SETTLE_POLL_MS, true);
    return;
  }

  // Jobright renders the previous posting's DOM under the new URL for a moment, and
  // the job key comes from the URL, so it cannot tell us the body is stale. Wait for
  // two identical reads instead: scoring once, late, beats scoring twice.
  //
  // The header fields are part of this, not just the description: the title, company
  // and location render separately from the body, and leaving them out let a read
  // taken before they arrived count as settled and get locked in.
  const fingerprint = [
    job.title,
    job.company,
    job.location,
    job.description.length,
    job.description.slice(0, 400),
  ].join('\n');
  if (fingerprint !== pendingFingerprint && Date.now() < settleDeadline) {
    pendingFingerprint = fingerprint;
    overlay?.setStatus('Reading job…');
    scheduleScan(SETTLE_POLL_MS, true);
    return;
  }

  capturedJobId = jobId;
  overlay?.setScore(null, 'Scoring your resume…');
  await requestScore(job);
}

async function requestScore(job: JobPosting) {
  const jobId = jobInfoIdFromUrl(location.href);
  if (!jobId || jobId !== activeJobId) return;

  try {
    const response = (await chrome.runtime.sendMessage({ type: 'JOB_CAPTURED', job })) as {
      ok: boolean;
      error?: string;
      score?: AtsScore;
    };
    if (jobInfoIdFromUrl(location.href) !== activeJobId) return;

    if (response?.score) {
      renderScore(response.score);
    } else if (response?.error) {
      overlay?.setScore(null, response.error);
    } else {
      overlay?.setScore(null, 'Open ApplyPilot to score this job');
    }
  } catch {
    overlay?.setScore(null, 'ApplyPilot reloaded - refresh the page');
  }
}

/** Jobright is a SPA: watch history changes; only act on /jobs/info/{id}. */
function watchNavigation() {
  const onUrlChange = () => {
    if (isJobInfoPage()) {
      scheduleScan(200, true);
      return;
    }
    window.clearTimeout(scanTimer);
    scanTimer = undefined;
    overlay?.setStatus('Open a job posting to score it');
  };

  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function patched(this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      onUrlChange();
      return result;
    };
  }

  window.addEventListener('popstate', onUrlChange);

  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onUrlChange();
      return;
    }
    if (isJobInfoPage()) scheduleScan(800);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
