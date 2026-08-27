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
    let waiting = false;
    const offerWhenFormAppears = () => {
      if (waiting) return;
      waiting = true;
      void waitForApplicationForm().then((found) => {
        waiting = false;
        if (found) startAutofillUi();
      });
    };

    offerWhenFormAppears();

    /*
     * These are single-page apps: the apply form is routed in without a page load, so
     * the wait above is the only thing that ever sees it - and it gives up after a few
     * minutes, which a candidate can easily spend reading the posting before clicking
     * Apply. The page's own history calls are invisible from this isolated world, so
     * the URL is compared on DOM mutations instead. That is a string compare on pages
     * that mutate constantly anyway, and it re-arms detection on arrival at the form.
     */
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      offerWhenFormAppears();
    }).observe(document.documentElement, { childList: true, subtree: true });
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
