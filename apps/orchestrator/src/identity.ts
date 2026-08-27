import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrateProfile } from '@mapply/core/profile';
import type { Profile, ResumeDoc } from '@mapply/core';
import type { Store } from '@mapply/db';
import { ensureDataDirs, paths } from './paths';

/**
 * What the extension exports and the orchestrator imports.
 *
 * A file rather than a shared database because the two live in different worlds:
 * the extension's profile is in chrome.storage and its resume in IndexedDB,
 * neither of which a Node process can reach. One hand-carried file is a smaller
 * and more honest bridge than trying to read Chrome's own storage from outside.
 */
export interface IdentityExport {
  version: 1;
  profile: Profile;
  resume: ResumeDoc;
  resumeFile?: {
    name: string;
    mimeType: string;
    base64: string;
  };
}

export interface Identity {
  profile: Profile;
  resume: ResumeDoc;
  /** Absolute path to the PDF that gets uploaded. */
  resumePath?: string;
}

export function importIdentity(store: Store, exported: IdentityExport): Identity {
  if (exported.version !== 1) {
    throw new Error(`Unsupported identity export version ${exported.version}.`);
  }
  ensureDataDirs();

  let resumePath: string | undefined;
  if (exported.resumeFile) {
    // Kept under its real extension so the ATS sees a sensible filename, and
    // written once rather than per application - it is the same file every time.
    const extension = exported.resumeFile.name.match(/\.[a-z0-9]+$/i)?.[0] ?? '.pdf';
    resumePath = resolve(paths.identity, `resume${extension}`);
    writeFileSync(resumePath, Buffer.from(exported.resumeFile.base64, 'base64'));
  }

  const profile = migrateProfile(exported.profile);
  store.sqlite
    .prepare(
      `INSERT INTO identity (id, profile_json, resume_json, resume_path, updated_at)
       VALUES (1, @profile, @resume, @path, @now)
       ON CONFLICT(id) DO UPDATE SET
         profile_json = @profile, resume_json = @resume,
         resume_path = @path, updated_at = @now`,
    )
    .run({
      profile: JSON.stringify(profile),
      resume: JSON.stringify(exported.resume),
      path: resumePath ?? null,
      now: Date.now(),
    });

  return { profile, resume: exported.resume, resumePath };
}

export function loadIdentity(store: Store): Identity {
  const row = store.sqlite
    .prepare('SELECT profile_json, resume_json, resume_path FROM identity WHERE id = 1')
    .get() as { profile_json: string; resume_json: string | null; resume_path: string | null } | undefined;

  if (!row) {
    throw new Error(
      'No profile imported yet. Export one from the extension (Settings -> Export for orchestrator), then run: mapply import <file>',
    );
  }

  return {
    profile: migrateProfile(JSON.parse(row.profile_json)),
    resume: row.resume_json ? (JSON.parse(row.resume_json) as ResumeDoc) : emptyResume(),
    resumePath: row.resume_path ?? undefined,
  };
}

function emptyResume(): ResumeDoc {
  return { fileName: '', mimeType: '', text: '', size: 0, updatedAt: 0 };
}

/** A short, honest summary for the CLI, so an import can be eyeballed. */
export function describeIdentity(identity: Identity): string {
  const p = identity.profile;
  const missing = (['firstName', 'lastName', 'email', 'phone'] as const).filter((key) => !p[key]);
  return [
    `  name    ${[p.firstName, p.lastName].filter(Boolean).join(' ') || '(none)'}`,
    `  email   ${p.email || '(none)'}`,
    `  phone   ${p.phone || '(none)'}`,
    `  resume  ${identity.resumePath ?? '(no file - uploads will be skipped)'}`,
    `  text    ${identity.resume.text ? `${identity.resume.text.length} chars` : '(none)'}`,
    missing.length ? `  MISSING ${missing.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
