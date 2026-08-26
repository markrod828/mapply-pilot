import { scoreResume } from '../lib/atsScore';
import { DEFAULT_RESUME_FILE, blobToBase64, getFile, tailoredResumeFile } from '../lib/db';
import { hasHostAccess, originFor } from '../lib/hosts';
import type { AutofillPayload, Message } from '../lib/messages';
import {
  getActiveJob,
  getJob,
  getProfile,
  getResume,
  getSettings,
  hashText,
  saveJob,
  setActiveJobKey,
  updateJob,
} from '../lib/storage';
import { resumeFileName } from '../lib/resumePdf';
import { refineResume, tailorResume } from '../lib/tailor';
import type { AtsScore, JobPosting, JobRecord, TailorOptions } from '../lib/types';

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message: Message, sender: chrome.runtime.MessageSender) {
  switch (message.type) {
    case 'JOB_CAPTURED':
      return onJobCaptured(message.job, sender.tab?.id);

    case 'JOB_CLEARED':
      await setActiveJobKey(null);
      if (sender.tab?.id !== undefined) await clearBadge(sender.tab.id);
      return { ok: true };

    case 'OPEN_SIDE_PANEL': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return { ok: false, error: 'No tab' };
      const { windowId } = await chrome.tabs.get(tabId);
      await chrome.sidePanel.open({ windowId });
      return { ok: true };
    }

    case 'REQUEST_SCORE':
      return runScore(message.job, message.force ?? false, sender.tab?.id);

    case 'REQUEST_TAILOR':
      return runTailor(message.jobKey, message.options);

    case 'REQUEST_REFINE':
      return runRefine(message.jobKey, message.instruction);

    case 'REQUEST_RESCORE_TAILORED':
      return runTailoredScore(message.jobKey);

    case 'GET_ACTIVE_JOB':
      return { ok: true, record: await getActiveJob() };

    case 'GET_AUTOFILL_PAYLOAD':
      return buildAutofillPayload();

    case 'RUN_AUTOFILL': {
      const tab = await chrome.tabs.get(message.tabId);
      await assertHostAccess(tab.url);
      await chrome.scripting.executeScript({
        target: { tabId: message.tabId },
        files: ['content.js'],
      });
      await chrome.tabs.sendMessage(message.tabId, { type: 'AUTOFILL_NOW' });
      return { ok: true };
    }

    default:
      return { ok: false, error: 'Unknown message' };
  }
}

/**
 * Verify access to the application tab before injecting into it. The prompt itself
 * has to come from the side panel: chrome.permissions.request only works inside a
 * user gesture, which a service worker never has.
 */
async function assertHostAccess(pageUrl: string | undefined) {
  const origin = originFor(pageUrl);
  if (await hasHostAccess(origin)) return;

  throw new Error(
    `ApplyPilot does not have access to ${origin.hostname}. Use "Autofill this page" in the side panel and allow the Chrome prompt.`,
  );
}

async function onJobCaptured(job: JobPosting, tabId?: number) {
  const existing = await getJob(job.jobKey);
  const descriptionChanged =
    Boolean(existing) &&
    jobFingerprint(existing!.job) !== jobFingerprint(job);

  // A different description under the same posting id means the scores were computed
  // against text that is no longer on the page, so they go. The tailored draft stays:
  // it is the user's own work for this posting, it cost API calls, and they can
  // regenerate it from the review step if the rewrite no longer fits.
  const record: JobRecord = existing
    ? {
        ...existing,
        job: { ...job, capturedAt: Date.now() },
        ...(descriptionChanged
          ? {
              baseScore: undefined,
              baseResumeHash: undefined,
              tailoredScore: undefined,
            }
          : {}),
      }
    : { job };
  await saveJob(record);
  await setActiveJobKey(job.jobKey);

  const settings = await getSettings();
  const resume = await getResume();

  if (record.baseScore && record.baseResumeHash === hashText(resume?.text ?? '')) {
    if (tabId !== undefined) await showBadge(tabId, record.baseScore.overall);
    return { ok: true, score: record.baseScore };
  }

  if (!settings.autoScore || !settings.openaiApiKey || !resume?.text) {
    if (tabId !== undefined) await clearBadge(tabId);
    return { ok: true };
  }

  return runScore(job, descriptionChanged, tabId);
}

function jobFingerprint(job: Pick<JobPosting, 'title' | 'description'>): string {
  const body = `${job.title}\n${job.description}`.replace(/\s+/g, ' ').trim();
  return `${body.length}:${body.slice(0, 500)}`;
}

async function runScore(job: JobPosting, force: boolean, tabId?: number) {
  const settings = await getSettings();
  const resume = await getResume();
  if (!resume?.text) {
    return { ok: false, error: 'Upload your default resume first.' };
  }

  const resumeHash = hashText(resume.text);
  const existing = await getJob(job.jobKey);
  if (!force && existing?.baseScore && existing.baseResumeHash === resumeHash) {
    if (tabId !== undefined) await showBadge(tabId, existing.baseScore.overall);
    return { ok: true, score: existing.baseScore };
  }

  if (tabId !== undefined) await setBadgeText(tabId, '...', '#64748b');

  try {
    const score = await scoreResume({
      apiKey: settings.openaiApiKey,
      model: settings.scoreModel,
      resumeText: resume.text,
      job,
      source: 'default',
    });

    const record: JobRecord = { ...(existing ?? { job }), job, baseScore: score, baseResumeHash: resumeHash };
    await saveJob(record);
    if (tabId !== undefined) await showBadge(tabId, score.overall);
    await notifyTab(tabId, score);
    return { ok: true, score };
  } catch (error) {
    if (tabId !== undefined) await setBadgeText(tabId, '!', '#dc2626');
    throw error;
  }
}

async function runTailor(jobKey: string, options: TailorOptions) {
  const settings = await getSettings();
  const resume = await getResume();
  const record = await getJob(jobKey);
  if (!resume?.text) return { ok: false, error: 'Upload your default resume first.' };
  if (!record) return { ok: false, error: 'That job is no longer cached. Reopen it on Jobright.' };

  const tailored = await tailorResume({
    apiKey: settings.openaiApiKey,
    model: settings.tailorModel,
    resumeText: resume.text,
    job: record.job,
    baseScore: record.baseScore,
    options,
  });

  await saveJob({ ...record, tailored, tailoredScore: undefined });
  return { ok: true, tailored };
}

async function runRefine(jobKey: string, instruction: string) {
  const settings = await getSettings();
  const resume = await getResume();
  const record = await getJob(jobKey);
  if (!resume?.text) return { ok: false, error: 'Upload your default resume first.' };
  if (!record?.tailored) return { ok: false, error: 'Tailor the resume first.' };

  const tailored = await refineResume({
    apiKey: settings.openaiApiKey,
    model: settings.tailorModel,
    resumeText: resume.text,
    job: record.job,
    current: record.tailored,
    instruction,
  });

  await saveJob({ ...record, tailored, tailoredScore: undefined });
  return { ok: true, tailored };
}

async function runTailoredScore(jobKey: string) {
  const settings = await getSettings();
  const record = await getJob(jobKey);
  if (!record?.tailored) return { ok: false, error: 'Tailor the resume first.' };

  const score = await scoreResume({
    apiKey: settings.openaiApiKey,
    model: settings.scoreModel,
    resumeText: record.tailored.text,
    job: record.job,
    source: 'tailored',
  });

  await updateJob(jobKey, (current) => ({ ...current, tailoredScore: score }));
  return { ok: true, score };
}

async function buildAutofillPayload(): Promise<{ ok: boolean; error?: string; payload?: AutofillPayload }> {
  const profile = await getProfile();
  const resume = await getResume();
  const record = await getActiveJob();
  // Not gated on `accepted`: every tailor and refine resets that flag, and the draft
  // on screen is the one the user means to send. The side panel keeps its PDF current.
  const tailored = record?.tailored;

  let fileBlob: Blob | undefined;
  let fileName = resume?.fileName ?? 'resume.pdf';
  let fileMime = resume?.mimeType ?? 'application/pdf';
  let tailoredUnavailable = false;

  if (tailored) {
    fileBlob = await getFile(tailoredResumeFile(tailored.jobKey));
    if (fileBlob) {
      fileName = resumeFileName(profile, record?.job.company ?? '');
      fileMime = 'application/pdf';
    } else {
      tailoredUnavailable = true;
    }
  }
  if (!fileBlob) {
    fileBlob = await getFile(DEFAULT_RESUME_FILE);
  }

  const usingTailored = Boolean(tailored) && !tailoredUnavailable;

  return {
    ok: true,
    payload: {
      profile,
      // Kept in step with the attached file, so a form never gets tailored text
      // pasted next to the original PDF.
      resumeText: (usingTailored ? tailored?.text : resume?.text) ?? '',
      resumeFileName: fileName,
      resumeFileBase64: fileBlob ? await blobToBase64(fileBlob) : '',
      resumeFileMime: fileMime,
      usingTailored,
      resumeLabel: usingTailored
        ? `tailored resume for ${record?.job.title || 'this job'}`
        : `your default resume${resume?.fileName ? ` (${resume.fileName})` : ''}`,
      tailoredUnavailable,
    },
  };
}

async function notifyTab(tabId: number | undefined, score: AtsScore) {
  if (tabId === undefined) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SCORE_READY', score });
  } catch {
    // Content script may have navigated away; the side panel still has the score.
  }
}

async function showBadge(tabId: number, score: number) {
  const color = score >= 75 ? '#16a34a' : score >= 50 ? '#d97706' : '#dc2626';
  await setBadgeText(tabId, String(score), color);
}

async function setBadgeText(tabId: number, text: string, color: string) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch {
    // Tab closed.
  }
}

async function clearBadge(tabId: number) {
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch {
    // Tab closed.
  }
}
