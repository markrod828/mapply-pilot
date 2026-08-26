import { putFile, tailoredResumeFile } from './db';
import { buildResumePdf } from './resumePdf';
import { renderResumeText } from './tailor';
import type { Profile, ResumeTemplate, TailoredResume } from './types';

/**
 * Render the draft and store it as the file autofill attaches for this job.
 *
 * Autofill reads this from IndexedDB, so it has to be rewritten whenever the draft
 * changes - not only when the draft is accepted. Accepting is about locking in a
 * score; it is not what makes a resume uploadable.
 *
 * Only the side panel can do this: jsPDF needs a document, which a service worker
 * does not have.
 */
export async function storeTailoredPdf(
  jobKey: string,
  profile: Profile,
  resume: TailoredResume,
  template: ResumeTemplate,
): Promise<void> {
  const pdf = await buildResumePdf(profile, { ...resume, text: renderResumeText(resume) }, template);
  await putFile(tailoredResumeFile(jobKey), pdf);
}
