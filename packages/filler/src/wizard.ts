import { applyTemplate, type FillOutcome } from './apply';
import { collectValidationErrors } from './submit';
import type { FormRoot } from './templates/index';
import type { FormTemplate } from './templates/types';
import type { FillContext } from './values';
import { delay, jitter, waitForDomQuiet } from './wait';

/** More steps than any application form has; a stop against looping forever. */
const MAX_STEPS = 10;
/** Attempts to fix what a step complains about before giving up on it. */
const MAX_REPAIRS = 2;

export interface WizardOutcome extends FillOutcome {
  /** How many steps were filled. One for an ordinary single-page form. */
  steps: number;
}

/**
 * Fills a form that may be spread over several steps.
 *
 * The important part is not clicking Next, it is what happens when Next does
 * nothing. A wizard that refuses to advance is telling us something specific -
 * it has a complaint - and reading that complaint back is both how the step gets
 * fixed and the only reliable way to learn what a form truly requires. Markup
 * lies about that; a form's own validation does not.
 *
 * Everything is re-resolved on each step rather than carried over. The previous
 * step's fields are gone, and the approach this replaces re-ran only some of its
 * passes on later steps - which is why an uploaded resume and every screening
 * answer silently never happened past step one.
 */
export async function fillForm(
  root: FormRoot,
  template: FormTemplate,
  ctx: FillContext,
): Promise<WizardOutcome> {
  const merged: WizardOutcome = {
    steps: 0,
    filled: [],
    parked: false,
    blocking: [],
    delegated: [],
    unanswered: [],
    waived: [],
  };

  let repairs = 0;

  for (let step = 1; step <= MAX_STEPS; step += 1) {
    const outcome = await applyTemplate(root, template, ctx);
    merged.steps = step;
    absorb(merged, outcome);

    if (outcome.blocking.length) return merged;

    const next = await findNext(root, template);
    if (!next) return merged;

    const before = await stepSignature(root, template);
    await next.hover().catch(() => {});
    await delay(jitter(600, 200));
    await next.click().catch(() => {});
    await waitForDomQuiet(root, { quietMs: 600, timeoutMs: 10_000 });

    if ((await stepSignature(root, template)) !== before) {
      repairs = 0;
      continue;
    }

    // The step did not advance. Whatever it is objecting to is what it actually
    // requires, so try to answer that and press on; if it still will not move,
    // stop rather than click at it repeatedly.
    const errors = await collectValidationErrors(root);
    if (errors.length && repairs < MAX_REPAIRS) {
      repairs += 1;
      merged.blocking.push(...errors.map((message) => `step ${step} says: ${message}`));
      // Filling again with the complaint on screen often resolves it: a field
      // that was hidden until now becomes visible and gets its turn.
      const retry = await applyTemplate(root, template, ctx);
      absorb(merged, retry);
      merged.blocking = merged.blocking.filter((item) => !item.startsWith(`step ${step} says:`));
      continue;
    }

    merged.blocking.push(
      ...(errors.length
        ? errors.map((message) => `step ${step} says: ${message}`)
        : [`step ${step} would not advance, and gave no reason`]),
    );
    merged.reason = 'wizard_stuck';
    merged.parked = true;
    return merged;
  }

  merged.blocking.push(`gave up after ${MAX_STEPS} steps`);
  merged.reason = 'wizard_stuck';
  merged.parked = true;
  return merged;
}

function absorb(into: WizardOutcome, from: FillOutcome): void {
  into.filled.push(...from.filled);
  into.blocking.push(...from.blocking);
  into.waived.push(...from.waived);
  into.unanswered.push(...from.unanswered);
  for (const container of from.delegated) {
    if (!into.delegated.includes(container)) into.delegated.push(container);
  }
  // The first fingerprint is the one that identifies the form; later steps are
  // parts of the same thing, not separate forms to be trusted separately.
  into.fingerprint ??= from.fingerprint;
  if (from.reason && !into.reason) into.reason = from.reason;
  into.parked = into.blocking.length > 0;
}

/**
 * The button that moves to the next step, if this is not the last one.
 *
 * Submit is deliberately excluded. Mistaking it for Next is the one error here
 * that cannot be undone.
 */
async function findNext(root: FormRoot, template: FormTemplate) {
  if (!template.nextSelector) return null;

  const candidate = root.locator(template.nextSelector).first();
  if ((await candidate.count()) === 0) return null;
  if (!(await candidate.isVisible().catch(() => false))) return null;

  const label = ((await candidate.textContent().catch(() => '')) ?? '').toLowerCase();
  if (/submit|apply now|send application/.test(label)) return null;

  // A form showing its submit button is on its last step, whatever else it shows.
  if ((await root.locator(template.submitSelector).count()) > 0) return null;

  return candidate;
}

/** Enough of a step to tell whether it changed. */
async function stepSignature(root: FormRoot, template: FormTemplate): Promise<string> {
  return root
    .evaluate((submitSelector) => {
      const headings = Array.from(document.querySelectorAll('h1, h2, legend, [role="heading"]'))
        .map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 6)
        .join('|');
      const controls = document.querySelectorAll('input, select, textarea').length;
      const hasSubmit = document.querySelectorAll(submitSelector).length;
      return `${location.pathname}#${headings}#${controls}#${hasSubmit}`;
    }, template.submitSelector)
    .catch(() => `unreadable-${Date.now()}`);
}
