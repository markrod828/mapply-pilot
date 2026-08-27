import { collectFields } from './fill';

/** Below this a page is a marketing or listing page, not something worth offering to fill. */
const MIN_FIELDS = 3;
/**
 * Several ATSs - Workday among them - never emit a <form> element at all; they post
 * over XHR. A form tag therefore cannot be a requirement. Without one the bar is
 * higher, because a search page or a newsletter signup also has a couple of inputs,
 * while a real application asks for name, contact and address at minimum.
 */
const MIN_FIELDS_WITHOUT_FORM = 6;
const POLL_MS = 500;
/**
 * Long, because these are SPAs: the user may read listings for a while before the
 * application form is routed in. Bounded only so the observer cannot live forever.
 */
const GIVE_UP_MS = 5 * 60 * 1000;

export function looksLikeApplicationForm(): boolean {
  // A resume upload is the strongest single signal an ATS form is on the page.
  if (document.querySelector('input[type="file"]')) return true;

  const fields = collectFields().length;
  return document.querySelector('form, [role="form"]')
    ? fields >= MIN_FIELDS
    : fields >= MIN_FIELDS_WITHOUT_FORM;
}

/**
 * ATS pages are usually client-rendered, so the form is rarely there at document_idle.
 * Throttled rather than run per mutation: these pages mutate constantly while loading.
 */
export function waitForApplicationForm(): Promise<boolean> {
  if (looksLikeApplicationForm()) return Promise.resolve(true);

  return new Promise((resolve) => {
    let timer: number | undefined;
    let giveUp: number | undefined;

    const finish = (found: boolean) => {
      observer.disconnect();
      window.clearTimeout(timer);
      window.clearTimeout(giveUp);
      resolve(found);
    };

    const check = () => {
      timer = undefined;
      if (looksLikeApplicationForm()) finish(true);
    };

    const observer = new MutationObserver(() => {
      if (timer === undefined) timer = window.setTimeout(check, POLL_MS);
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
    giveUp = window.setTimeout(() => finish(false), GIVE_UP_MS);
  });
}
