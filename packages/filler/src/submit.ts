import type { Frame, Page, Response } from 'playwright';
import type { FormRoot } from './templates/index';
import type { ConfirmSpec, FormTemplate } from './templates/types';
import { delay, jitter, waitForDomQuiet } from './wait';

export type ConfirmationSignal = 'network' | 'url' | 'text' | 'structural';

export interface SubmitResult {
  /** True only when at least two independent signals agree. */
  confirmed: boolean;
  signals: ConfirmationSignal[];
  httpStatus?: number;
  confirmationText?: string;
  /** Set when the click landed but nothing confirmed it. Never auto-retried. */
  unverified: boolean;
}

const SETTLE_MS = 20_000;

/**
 * Clicks submit and then works out whether the application actually arrived.
 *
 * Two independent signals are required, because each one alone lies. A single-page
 * form can show "thank you" without the POST having succeeded; a URL can change
 * on a validation bounce; a button can detach because the framework re-rendered.
 * Agreement between two is what separates "submitted" from "probably submitted".
 *
 * `onBeforeClick` runs immediately before the click and is where the caller
 * records `submit_attempted_at`. That ordering is the duplicate guard: if this
 * process dies mid-click, the row already says an attempt was made, and recovery
 * parks it for a human instead of trying again.
 */
export async function submitAndConfirm(
  page: Page,
  /** Where the form is. The same as the page unless the ATS is in an iframe. */
  root: FormRoot,
  template: FormTemplate,
  onBeforeClick: () => Promise<void>,
): Promise<SubmitResult> {
  const signals = new Set<ConfirmationSignal>();
  let httpStatus: number | undefined;

  // Registered before the click: a fast server can answer before an await we
  // set up afterwards would have been listening.
  const onResponse = (response: Response) => {
    if (!template.confirm.responseUrl.test(response.url())) return;
    const request = response.request();
    if (request.method() !== 'POST') return;
    httpStatus = response.status();
    // 3xx counts as well as 2xx: post-redirect-get is how most server-rendered
    // ATS forms confirm, and accepting only 2xx silently loses the strongest
    // signal on exactly the forms that produce it. A redirect straight back to
    // the form still fails the URL and text checks, and two are required.
    if (response.status() >= 200 && response.status() < 400) signals.add('network');
  };
  page.on('response', onResponse);

  const submit = root.locator(template.submitSelector).first();
  const urlBefore = page.url();

  try {
    await submit.scrollIntoViewIfNeeded();
    await submit.hover().catch(() => {});
    await delay(jitter(600, 200));

    await onBeforeClick();
    await submit.click();

    const deadline = Date.now() + SETTLE_MS;
    while (Date.now() < deadline && signals.size < 2) {
      await waitForDomQuiet(page, { quietMs: 400, timeoutMs: 3000 });

      if (page.url() !== urlBefore && template.confirm.urlPattern.test(page.url())) {
        signals.add('url');
      }

      const body = await page.locator('body').innerText().catch(() => '');
      const match = body.match(template.confirm.textPattern);
      if (match) signals.add('text');

      // The form is gone and so is its button. On its own this is weak - a
      // re-render looks the same - which is exactly why it only ever counts
      // as one of the two. Counting can also throw outright once a navigation
      // has detached the frame the form was in, which means the same thing.
      const stillThere = await root.locator(template.submitSelector).count().catch(() => 0);
      if (stillThere === 0) signals.add('structural');

      if (signals.size >= 2) {
        return {
          confirmed: true,
          signals: [...signals],
          httpStatus,
          confirmationText: match?.[0],
          unverified: false,
        };
      }
      await delay(500);
    }

    return { confirmed: false, signals: [...signals], httpStatus, unverified: true };
  } finally {
    page.off('response', onResponse);
  }
}

/**
 * Reads the form's own complaints.
 *
 * More reliable than any attribute for knowing what a form insists on: whatever
 * it refuses to submit without is required, whatever its markup claims.
 */
export async function collectValidationErrors(root: FormRoot): Promise<string[]> {
  return root.evaluate(() => {
    const seen = new Set<string>();
    const selectors = [
      '[aria-invalid="true"]',
      '[role="alert"]',
      '.error',
      '.invalid',
      '[class*="error" i]:not(:has(*))',
    ];

    for (const selector of selectors) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text && text.length < 200) seen.add(text);
      }
    }

    for (const node of Array.from(document.querySelectorAll('input, select, textarea'))) {
      const field = node as HTMLInputElement;
      if (field.willValidate && !field.checkValidity() && field.validationMessage) {
        const name = field.labels?.[0]?.textContent?.trim() || field.name || field.id;
        seen.add(`${name}: ${field.validationMessage}`);
      }
    }
    return [...seen];
  });
}

export type { ConfirmSpec, Frame };
