import { DEFAULT_RESUME_FILE, blobToBase64, getFile } from './db';
import { downloadBlob } from './download';
import { getProfile, getResume } from './storage';

/**
 * Hands the profile and resume to the orchestrator.
 *
 * The two processes cannot share storage - the profile lives in chrome.storage
 * and the resume file in IndexedDB, neither reachable from Node - so the bridge
 * is one file the person carries across. It is written to disk rather than sent
 * anywhere: it holds a home address, a phone number and voluntary
 * self-identification answers, and none of that should touch a network.
 */
export async function exportIdentity(): Promise<string> {
  const [profile, resume] = await Promise.all([getProfile(), getResume()]);
  if (!resume?.text) {
    throw new Error('Upload your default resume first - the orchestrator needs it to apply.');
  }

  const file = await getFile(DEFAULT_RESUME_FILE);
  const payload = {
    version: 1 as const,
    profile,
    resume,
    resumeFile: file
      ? {
          name: resume.fileName || 'resume.pdf',
          mimeType: resume.mimeType || 'application/pdf',
          base64: await blobToBase64(file),
        }
      : undefined,
  };

  const name = `mapply-identity-${new Date().toISOString().slice(0, 10)}.json`;
  await downloadBlob(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    name,
  );
  return name;
}
