const DB_NAME = 'applypilot';
const DB_VERSION = 1;
const STORE = 'files';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function putFile(key: string, blob: Blob): Promise<IDBValidKey> {
  return withStore('readwrite', (store) => store.put(blob, key));
}

export function getFile(key: string): Promise<Blob | undefined> {
  return withStore<Blob | undefined>('readonly', (store) => store.get(key));
}

export function deleteFile(key: string): Promise<undefined> {
  return withStore<undefined>('readwrite', (store) => store.delete(key));
}

/** Same store, for values that are not files - e.g. a picked directory handle. */
export function putRecord<T>(key: string, value: T): Promise<IDBValidKey> {
  return withStore('readwrite', (store) => store.put(value, key));
}

export function getRecord<T>(key: string): Promise<T | undefined> {
  return withStore<T | undefined>('readonly', (store) => store.get(key));
}

export function deleteRecord(key: string): Promise<undefined> {
  return withStore<undefined>('readwrite', (store) => store.delete(key));
}

export const DEFAULT_RESUME_FILE = 'default-resume';
export const tailoredResumeFile = (jobKey: string) => `tailored:${jobKey}`;

export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}
