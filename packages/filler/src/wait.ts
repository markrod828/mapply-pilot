import type { Frame, Page } from 'playwright';

/**
 * Waits for the DOM to actually stop changing.
 *
 * The extension this replaces used a MutationObserver that fired a fixed delay
 * after the *first* mutation and called it settled. On a framework-rendered
 * application that lands mid-render: the sweep sees a half-built form, fills
 * what exists, and never comes back. This is the debounce that was meant -
 * every mutation resets the timer, so it returns only once the page has been
 * still for `quietMs`, or once `timeoutMs` runs out and we proceed anyway.
 */
export async function waitForDomQuiet(
  target: Page | Frame,
  { quietMs = 500, timeoutMs = 8000 }: { quietMs?: number; timeoutMs?: number } = {},
): Promise<boolean> {
  try {
    return await target.evaluate(
      ({ quiet, timeout }) =>
        new Promise<boolean>((resolve) => {
          let timer: number;
          const started = Date.now();

          const done = (settled: boolean) => {
            clearTimeout(timer);
            observer.disconnect();
            resolve(settled);
          };

          const observer = new MutationObserver(() => {
            if (Date.now() - started > timeout) return done(false);
            clearTimeout(timer);
            timer = window.setTimeout(() => done(true), quiet);
          });

          timer = window.setTimeout(() => done(true), quiet);
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            // Attributes matter here: a field going from disabled to enabled, or
            // an error appearing via aria-invalid, changes what we should do next
            // and produces no child-list mutation at all.
            attributes: true,
            attributeFilter: ['class', 'style', 'disabled', 'aria-invalid', 'aria-expanded', 'hidden'],
          });
          window.setTimeout(() => done(false), timeout);
        }),
      { quiet: quietMs, timeout: timeoutMs },
    );
  } catch {
    // Navigating mid-evaluate destroys the execution context. That is not a
    // failure to settle - the next step will wait on the new document.
    return false;
  }
}

/** Normal-ish jitter, so nothing in the fill runs on a metronome. */
export function jitter(meanMs: number, spreadMs: number): number {
  const gauss = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
  return Math.max(20, Math.round(meanMs + gauss * spreadMs));
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
