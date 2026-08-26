import { deleteRecord, getRecord, putRecord } from './db';
import { downloadBlob } from './download';
import { resumeSavePath } from './savePath';
import type { JobPosting, Profile } from './types';

/**
 * Chrome's downloads API can only write inside the browser's download folder -
 * absolute paths and `..` are rejected - so reaching a folder like Documents needs
 * the File System Access API and a folder the user picks once. The handle is kept
 * in IndexedDB and reused; without one, saving falls back to Downloads.
 */

const DIRECTORY_KEY = 'save-directory';

type PermissionDescriptor = { mode: 'read' | 'readwrite' };

/** Chrome ships these on FileSystemHandle, but they are not in the TS DOM lib. */
interface HandleWithPermissions extends FileSystemDirectoryHandle {
  queryPermission?(descriptor: PermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor: PermissionDescriptor): Promise<PermissionState>;
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      mode?: 'read' | 'readwrite';
      /** Well-known folder to open at, e.g. "documents". */
      startIn?: string;
      id?: string;
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

export function supportsFolderPicker(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/**
 * Ask for a folder to keep resumes in, opening at Documents. Returns its name, or
 * null when the user dismisses the picker.
 */
export async function chooseSaveDirectory(): Promise<string | null> {
  if (!supportsFolderPicker()) {
    throw new Error('This Chrome build cannot pick a folder. Resumes will go to your Downloads folder.');
  }

  let handle: FileSystemDirectoryHandle;
  try {
    handle = await window.showDirectoryPicker!({ mode: 'readwrite', startIn: 'documents', id: 'applypilot-resumes' });
  } catch (error) {
    // AbortError is the user closing the picker, which is not a failure.
    if ((error as DOMException)?.name === 'AbortError') return null;
    throw error;
  }

  await putRecord(DIRECTORY_KEY, handle);
  return handle.name;
}

export async function clearSaveDirectory(): Promise<void> {
  await deleteRecord(DIRECTORY_KEY);
}

export interface SaveResult {
  /** Path to show back to the user. */
  location: string;
  /** True when it went to the browser's download folder rather than the chosen one. */
  viaDownloads: boolean;
}

export async function saveResumePdf(
  pdf: Blob,
  profile: Profile,
  job: Pick<JobPosting, 'company' | 'title'>,
): Promise<SaveResult> {
  const segments = resumeSavePath(profile, job);
  const directory = await getRecord<HandleWithPermissions>(DIRECTORY_KEY);

  if (directory && (await ensurePermission(directory))) {
    await writeInto(directory, segments, pdf);
    return { location: `${directory.name}/${segments.join('/')}`, viaDownloads: false };
  }

  // Relative to the download folder: Chrome creates the subfolders itself.
  await downloadBlob(pdf, segments.join('/'), 'overwrite');
  return { location: `Downloads/${segments.join('/')}`, viaDownloads: true };
}

/**
 * A stored handle loses its grant when Chrome restarts, so re-ask. This has to run
 * inside the click that triggered the save, which is where saving is called from.
 */
async function ensurePermission(directory: HandleWithPermissions): Promise<boolean> {
  try {
    if (!directory.queryPermission || !directory.requestPermission) return true;
    if ((await directory.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    return (await directory.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    // Handle no longer valid (folder deleted, profile moved): fall back to Downloads.
    return false;
  }
}

/** Walk the path, creating each folder, then overwrite the file at the end. */
async function writeInto(
  directory: FileSystemDirectoryHandle,
  segments: string[],
  blob: Blob,
): Promise<void> {
  let current = directory;
  for (const segment of segments.slice(0, -1)) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }

  const file = await current.getFileHandle(segments[segments.length - 1], { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}
