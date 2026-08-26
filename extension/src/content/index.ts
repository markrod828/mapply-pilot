import { looksLikeApplicationForm, waitForApplicationForm } from './autofill/detect';
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
    // On the ATS hosts this script is declared for, only offer to fill once an
    // actual application form shows up - never on their marketing or listing pages.
    void waitForApplicationForm().then((found) => {
      if (found) startAutofillUi();
    });
  }

  chrome.runtime.onMessage.addListener((message: { type: string }, _sender, sendResponse) => {
    if (message.type !== 'AUTOFILL_NOW') return undefined;
    // Every frame gets this message. Staying quiet in the ones without a form lets
    // the frame that actually holds it own the reply.
    if (!looksLikeApplicationForm()) return undefined;
    // Explicitly asked for, so show the panel without waiting on form detection.
    startAutofillUi();
    autofillNow()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
}
