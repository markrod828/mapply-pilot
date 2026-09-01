import { scoreResume } from '@mapply/core/atsScore';
import { generateCoverLetter } from '@mapply/core/coverLetter';
import { askAboutJob } from '@mapply/core/jobChat';
import { DEFAULT_RESUME_FILE, blobToBase64, getFile, tailoredResumeFile } from '../lib/db';
import { hasHostAccess, originFor } from '../lib/hosts';
import type { LlmPort } from '@mapply/core';
import { llmFor } from '../lib/llm';
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
  setResume,
  updateJob,
} from '../lib/storage';
import { answerFormQuestions, type FormQuestion, type QuestionAnswer } from '@mapply/core/questions';
import { parseResumeDocument } from '@mapply/core/resumeParse';
import { resumeFileName } from '@mapply/core/resumePdf';
import { refineResume, tailorResume } from '@mapply/core/tailor';
import type {
  AtsScore,
  JobPosting,
  JobRecord,
  ResumeDoc,
  StructuredResume,
  TailorOptions,
} from '@mapply/core/types';

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

    case 'REQUEST_COVER_LETTER':
      return runCoverLetter(message.jobKey);

    case 'GET_ACTIVE_JOB':
      return { ok: true, record: await getActiveJob() };

    case 'GET_AUTOFILL_PAYLOAD':
      return buildAutofillPayload();

    case 'REQUEST_CHAT':
      return runChat(message.jobKey, message.question);

    case 'CLEAR_CHAT':
      await updateJob(message.jobKey, (record) => ({ ...record, chat: [] }));
      return { ok: true };

    case 'REQUEST_ANSWERS':
      return runAnswers(message.questions);

    case 'RUN_AUTOFILL': {
      const tab = await chrome.tabs.get(message.tabId);
      await assertHostAccess(tab.url);
      // Application forms are often embedded (Greenhouse serves /embed/job_app in an
      // iframe), so every frame gets the script and only the one holding the form answers.
      await chrome.scripting.executeScript({
        target: { tabId: message.tabId, allFrames: true },
        files: ['content.js'],
      });
      try {
        await chrome.tabs.sendMessage(message.tabId, { type: 'AUTOFILL_NOW' });
      } catch {
        throw new Error('No application form found on this page.');
      }
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

  // Capturing a posting does not score it. Scoring costs a call, and more to
  // the point it is a judgement about a job nobody has read yet - so it waits
  // for Score now. A score already computed for this posting still shows on the
  // badge: showing what is known is not the same as deciding to spend on
  // something new.
  const resume = await getResume();
  const known =
    record.baseScore && record.baseResumeHash === hashText(resume?.text ?? '')
      ? record.baseScore
      : undefined;

  if (tabId !== undefined) {
    if (known) await showBadge(tabId, known.overall);
    else await clearBadge(tabId);
  }
  return { ok: true, score: known };
}

/**
 * Answers a question about the open posting.
 *
 * Both turns are written together once the reply is in. Recording the question
 * before the answer arrives would leave a half-conversation behind whenever a
 * call fails, and the next question would then be answered against a thread
 * containing a question nobody ever answered.
 */
async function runChat(jobKey: string, question: string) {
  const settings = await getSettings();
  if (!settings.openaiApiKey) return { ok: false, error: 'No OpenAI API key set.' };

  const record = await getJob(jobKey);
  if (!record) return { ok: false, error: 'That job is no longer cached. Reopen it on Jobright.' };

  const resume = await getResume();
  if (!resume?.text) return { ok: false, error: 'Upload your default resume first.' };

  try {
    const reply = await askAboutJob({
      llm: llmFor(settings),
      model: settings.scoreModel,
      job: record.job,
      resumeText: resume.text,
      profile: await getProfile(),
      history: record.chat ?? [],
      question,
    });

    const now = Date.now();
    const updated = await updateJob(jobKey, (current) => ({
      ...current,
      chat: [
        ...(current.chat ?? []),
        { role: 'you' as const, text: question, at: now },
        { role: 'assistant' as const, text: reply, at: Date.now() },
      ],
    }));
    return { ok: true, reply, chat: updated?.chat ?? [] };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
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
      llm: llmFor(settings),
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

/**
 * Parses the stored resume into fields once and caches it on the document.
 *
 * Called only from the tailor path, which already pays for an extraction round-trip: the
 * first tailor costs the same as before and every one after it saves that call. Returns
 * null whenever it cannot parse, and the caller falls back to the raw-text path.
 */
async function ensureResumeData(
  resume: ResumeDoc,
  llm: LlmPort,
  model: string,
): Promise<StructuredResume | null> {
  if (resume.data) return resume.data;

  const data = await parseResumeDocument({ llm, model, resumeText: resume.text });
  if (!data) return null;

  // The parse is slow enough that the resume may have been re-uploaded or edited while it
  // ran. Caching it against different text would pin the tailor to a stale history, so
  // only write it back when what we parsed is still what is stored.
  const current = await getResume();
  if (current && current.text === resume.text) {
    await setResume({ ...current, data, parsedAt: Date.now() });
  }
  return data;
}

async function runTailor(jobKey: string, options: TailorOptions) {
  const settings = await getSettings();
  const resume = await getResume();
  const record = await getJob(jobKey);
  if (!resume?.text) return { ok: false, error: 'Upload your default resume first.' };
  if (!record) return { ok: false, error: 'That job is no longer cached. Reopen it on Jobright.' };

  const baseData = await ensureResumeData(resume, llmFor(settings), settings.tailorModel);

  const tailored = await tailorResume({
    llm: llmFor(settings),
    model: settings.tailorModel,
    resumeText: resume.text,
    baseData: baseData ?? undefined,
    job: record.job,
    baseScore: record.baseScore,
    options,
  });

  // The letter is written from the tailored resume, so the old one no longer matches.
  // Autofill writes a fresh one when a form actually asks for it.
  await saveJob({ ...record, tailored, tailoredScore: undefined, coverLetter: undefined });
  return { ok: true, tailored };
}

/**
 * Written on demand, when autofill finds a form asking for one. Cached against the
 * job so filling the same form twice neither pays twice nor reworders itself.
 */
async function runCoverLetter(jobKey?: string) {
  const record = jobKey ? await getJob(jobKey) : await getActiveJob();
  if (!record) return { ok: false, error: 'Open the job on Jobright first so the letter matches it.' };
  if (record.coverLetter) return { ok: true, coverLetter: record.coverLetter };

  const settings = await getSettings();
  if (!settings.openaiApiKey) return { ok: false, error: 'No OpenAI API key set.' };

  const resume = await getResume();
  const source = record.tailored?.text ?? resume?.text;
  if (!source) return { ok: false, error: 'Upload your default resume first.' };

  const coverLetter = await writeCoverLetter(record.job.jobKey, source);
  return { ok: true, coverLetter };
}

async function writeCoverLetter(jobKey: string, resumeText: string) {
  const settings = await getSettings();
  const profile = await getProfile();
  const record = await getJob(jobKey);
  if (!record) throw new Error('That job is no longer cached.');

  const coverLetter = await generateCoverLetter({
    llm: llmFor(settings),
    model: settings.tailorModel,
    job: record.job,
    profile,
    resumeText,
  });

  await updateJob(jobKey, (current) => ({ ...current, coverLetter }));
  return coverLetter;
}

async function runRefine(jobKey: string, instruction: string) {
  const settings = await getSettings();
  const resume = await getResume();
  const record = await getJob(jobKey);
  if (!resume?.text) return { ok: false, error: 'Upload your default resume first.' };
  if (!record?.tailored) return { ok: false, error: 'Tailor the resume first.' };

  const tailored = await refineResume({
    llm: llmFor(settings),
    model: settings.tailorModel,
    resumeText: resume.text,
    job: record.job,
    current: record.tailored,
    instruction,
  });

  // Refining changes the resume the letter was written from, so drop it too.
  await saveJob({ ...record, tailored, tailoredScore: undefined, coverLetter: undefined });
  return { ok: true, tailored };
}

async function runTailoredScore(jobKey: string) {
  const settings = await getSettings();
  const record = await getJob(jobKey);
  if (!record?.tailored) return { ok: false, error: 'Tailor the resume first.' };

  const score = await scoreResume({
    llm: llmFor(settings),
    model: settings.scoreModel,
    resumeText: record.tailored.text,
    job: record.job,
    source: 'tailored',
  });

  await updateJob(jobKey, (current) => ({ ...current, tailoredScore: score }));
  return { ok: true, score };
}

/**
 * Answer the screening questions a form asks, grounded in the resume for the job
 * that is open. Answers are cached on the job so re-running autofill on the same
 * form does not pay for them twice or word them differently.
 */
async function runAnswers(questions: FormQuestion[]) {
  const settings = await getSettings();
  if (!settings.answerQuestions) return { ok: true, answers: [] };
  if (!settings.openaiApiKey) return { ok: false, error: 'No OpenAI API key set.' };

  const record = await getActiveJob();
  if (!record) return { ok: false, error: 'Open the job on Jobright first so answers match it.' };

  const resume = await getResume();
  const resumeText = record.tailored?.text ?? resume?.text;
  if (!resumeText) return { ok: false, error: 'Upload your default resume first.' };

  const cached = new Map((record.answers ?? []).map((entry) => [entry.question, entry.answer]));
  const answers: QuestionAnswer[] = [];
  const unanswered: FormQuestion[] = [];

  for (const question of questions) {
    const hit = cached.get(question.label);
    if (hit) answers.push({ id: question.id, answer: hit });
    else unanswered.push(question);
  }

  if (unanswered.length) {
    const fresh = await answerFormQuestions({
      llm: llmFor(settings),
      model: settings.tailorModel,
      job: record.job,
      profile: await getProfile(),
      resumeText,
      questions: unanswered,
    });

    const byId = new Map(unanswered.map((question) => [question.id, question.label]));
    await updateJob(record.job.jobKey, (current) => ({
      ...current,
      answers: [
        ...(current.answers ?? []),
        ...fresh.map((entry) => ({ question: byId.get(entry.id) ?? '', answer: entry.answer })),
      ].filter((entry) => entry.question),
    }));

    answers.push(...fresh);
  }

  return { ok: true, answers };
}

async function buildAutofillPayload(): Promise<{ ok: boolean; error?: string; payload?: AutofillPayload }> {
  const settings = await getSettings();
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
      experience: tailored?.experience ?? resume?.data?.experience ?? [],
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
      answerQuestions: settings.answerQuestions && Boolean(settings.openaiApiKey),
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
