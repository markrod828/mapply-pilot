/**
 * chrome.downloads.download resolves as soon as the transfer *starts*, so revoking
 * the object URL there can pull the file out from under a download still in flight.
 * These helpers keep the URL alive until Chrome reports the download settled.
 */

/** Generous: with "ask where to save" on, a download sits in progress until the user picks. */
const SETTLE_TIMEOUT_MS = 10 * 60 * 1000;

export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob);

  let downloadId: number;
  try {
    downloadId = await chrome.downloads.download({ url, filename });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }

  try {
    const failure = await waitUntilSettled(downloadId);
    if (failure) throw new Error(`Download failed: ${failure}.`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Resolves with an error string when the download failed, or null when it is safe to revoke. */
function waitUntilSettled(downloadId: number): Promise<string | null> {
  return new Promise((resolve) => {
    let timer: number | undefined;

    const settle = (state: string | undefined, error: string | undefined) => {
      if (state !== 'complete' && state !== 'interrupted') return;
      chrome.downloads.onChanged.removeListener(onChanged);
      window.clearTimeout(timer);
      // Cancelling is a deliberate user action, not something to report as a failure.
      resolve(state === 'interrupted' && error && error !== 'USER_CANCELED' ? error : null);
    };

    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id === downloadId) settle(delta.state?.current, delta.error?.current);
    };

    chrome.downloads.onChanged.addListener(onChanged);

    // The download may already have settled before the listener attached.
    void chrome.downloads.search({ id: downloadId }).then((items) => {
      settle(items[0]?.state, items[0]?.error);
    });

    // Leaking one object URL until the panel closes beats truncating the user's file.
    timer = window.setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(null);
    }, SETTLE_TIMEOUT_MS);
  });
}
