import type { AtsScore, JobPosting } from '../lib/types';
import { extractJob, jobInfoIdFromUrl } from './extract';
import { mountOverlay, type OverlayHandle } from './overlay';

/** Only score when the SPA is on an individual job page: /jobs/info/{id} */
const JOB_INFO_PATH = /^\/jobs\/info\/[^/]+\/?$/i;

let overlay: OverlayHandle | null = null;
/** Job info id we last started loading (`/jobs/info/{id}`). */
let activeJobId: string | null = null;
/** Job key we last successfully sent to the background. */
let currentJobKey: string | null = null;
/** Description fingerprint for the last capture (detects SPA content settle). */
let contentFingerprint = '';
let scanTimer: number | undefined;
let clearInFlight = false;

export function startJobright(): void {
  overlay = mountOverlay(() => {
    void chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' });
  });

  watchNavigation();
  scheduleScan(600);

  chrome.runtime.onMessage.addListener((message: { type: string; score?: AtsScore }) => {
    if (message.type === 'SCORE_READY' && message.score && isJobInfoPage()) {
      renderScore(message.score);
    }
    if (message.type === 'RESCAN') {
      currentJobKey = null;
      contentFingerprint = '';
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
function scheduleScan(delay: number, force = false) {
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
  currentJobKey = null;
  contentFingerprint = '';
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
    await clearActiveJob('Loading job…');
  }

  const job = extractJob();
  if (!job) {
    overlay?.setStatus('Waiting for job details…');
    return;
  }

  // Reject stale SPA DOM still showing the previous posting under the new URL.
  if (!job.jobKey.endsWith(`:${jobId}`)) {
    overlay?.setStatus('Waiting for job details…');
    return;
  }

  const fingerprint = `${job.title}\n${job.description.length}\n${job.description.slice(0, 400)}`;
  if (job.jobKey === currentJobKey && fingerprint === contentFingerprint) return;

  currentJobKey = job.jobKey;
  contentFingerprint = fingerprint;
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
