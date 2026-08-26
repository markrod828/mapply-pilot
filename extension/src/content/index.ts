import { autofillNow, startAutofillUi } from './autofill/ui';
import { startJobright } from './jobright';

declare global {
  interface Window {
    __applyPilotLoaded?: boolean;
  }
}

if (!window.__applyPilotLoaded) {
  window.__applyPilotLoaded = true;

  if (/(^|\.)jobright\.ai$/.test(location.hostname)) {
    startJobright();
  } else {
    startAutofillUi();
  }

  chrome.runtime.onMessage.addListener((message: { type: string }, _sender, sendResponse) => {
    if (message.type !== 'AUTOFILL_NOW') return undefined;
    startAutofillUi();
    autofillNow()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
}
