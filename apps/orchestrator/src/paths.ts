import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Where runtime state lives.
 *
 * All of it under one directory, and that directory is gitignored, because what
 * accumulates here is not incidental: screenshots of submitted forms carry a
 * home address, a phone number and voluntary self-identification answers.
 */
/**
 * Overridable so a test run, or a second profile, can keep its own state.
 * Read once at import: everything downstream builds paths from it, and having
 * it change underneath a running worker would scatter artifacts across two
 * directories.
 */
export const DATA_DIR = process.env.MAPPLY_DATA_DIR
  ? resolve(process.env.MAPPLY_DATA_DIR)
  : resolve(process.cwd(), 'data');

export const paths = {
  database: resolve(DATA_DIR, 'mapply.db'),
  identity: resolve(DATA_DIR, 'identity'),
  artifacts: resolve(DATA_DIR, 'artifacts'),
  profiles: resolve(DATA_DIR, 'profiles'),

  /** Per-application working directory: the resume sent, and the proof it went. */
  forApplication(id: number): string {
    const dir = resolve(DATA_DIR, 'artifacts', String(id));
    mkdirSync(dir, { recursive: true });
    return dir;
  },
};

export function ensureDataDirs(): void {
  for (const dir of [DATA_DIR, paths.identity, paths.artifacts, paths.profiles]) {
    mkdirSync(dir, { recursive: true });
  }
}
