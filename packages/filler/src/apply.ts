import type { Locator } from 'playwright';
import type { ReviewReason } from '@mapply/core/application';
import { selectComboboxOption } from './combobox';
import { setDate } from './dates';
import { discoverFields, type DiscoveredField } from './discover';
import { fingerprintForm, scrubTerms } from './fingerprint';
import { matchRule, questionKey } from './rules';
import type { FormRoot } from './templates/index';
import type { FormTemplate, Target, TemplatePlan } from './templates/types';
import { comparatorFor, resolveValue, type FillContext } from './values';
import { delay, jitter } from './wait';
import { equivalent, writeVerified, type WriteStrategy } from './write';

export interface FilledField {
  where: string;
  what: string;
  ok: boolean;
  via?: WriteStrategy | 'select' | 'combobox' | 'chooser' | 'setInputFiles' | 'no-trigger';
  got?: string;
  /** What a picker actually had on offer, when the field was one. */
  offered?: string[];
  /** Free-text detail when a field needs explaining more than a flag allows. */
  note?: string;
}

export interface FillOutcome {
  filled: FilledField[];
  /** Stopped short of submitting. `reason` says why, `blocking` says where. */
  parked: boolean;
  reason?: ReviewReason;
  blocking: string[];
  /** Containers the template deliberately did not claim. */
  delegated: string[];
  /** Questions nobody could answer. These are what a person is shown. */
  unanswered: UnansweredQuestion[];
  /**
   * Identity of the form's shape, for recognising it again.
   *
   * Absent when discovery found nothing to fingerprint, which is itself worth
   * knowing - a form nobody can describe is not one to trust.
   */
  fingerprint?: string;
  /**
   * Fields that could not be filled but were not allowed to stop the
   * application. Kept apart from blocking, so the record shows what went out
   * incomplete rather than quietly reading as a clean submission.
   */
  waived: string[];
}

export interface UnansweredQuestion {
  ref: string;
  label: string;
  control: string;
  required: boolean;
  options?: string[];
}

/**
 * Runs a template against a form.
 *
 * Nothing here trusts a write. Every value is read back, and anything that could
 * not be filled - a missing required field, a picker with no matching option -
 * parks the application rather than pressing on and submitting something wrong.
 * At fifty to a hundred applications a day, parking costs seconds of review;
 * a bad submission costs an opportunity that does not come back.
 */
export async function applyTemplate(
  root: FormRoot,
  template: FormTemplate,
  ctx: FillContext,
): Promise<FillOutcome> {
  const outcome: FillOutcome = {
    filled: [], parked: false, blocking: [], delegated: [], unanswered: [], waived: [],
  };

  // Uploads go last, after the employer's questions as well as the template's
  // own fields. Attaching a resume makes Greenhouse parse it and re-render the
  // form around what it read, which detaches controls and empties boxes that
  // were correct a moment earlier - so nothing may depend on the page surviving
  // it. Everything else is settled first, then the file, then one last read.
  const uploads = template.fields.filter((field) => field.kind === 'file');
  const rest = template.fields.filter((field) => field.kind !== 'file');

  for (const field of rest) {
    await delay(jitter(450, 180));
    await applyField(root, field, ctx, outcome);
  }

  await answerQuestions(root, template, ctx, outcome);

  for (const field of uploads) {
    await delay(jitter(450, 180));
    await applyField(root, field, ctx, outcome);
  }

  await reverify(root, template, ctx, outcome);

  if (outcome.blocking.length && !outcome.reason) outcome.reason = 'low_confidence';
  outcome.parked = outcome.blocking.length > 0;
  return outcome;
}

/**
 * Answers the employer's own questions, as far as anything can.
 *
 * Three sources, cheapest first: an answer a person has already approved for
 * this question, then the rule table reading it as a profile field, and nothing
 * else. A question that survives both is recorded rather than guessed at - it is
 * the whole reason the review queue exists, and inventing an answer to
 * "how many years of Kubernetes?" would be a claim on a legal document.
 */
async function answerQuestions(
  root: FormRoot,
  template: FormTemplate,
  ctx: FillContext,
  outcome: FillOutcome,
): Promise<void> {
  const containers = template.fields
    .filter((field): field is Extract<TemplatePlan, { kind: 'delegate' }> => field.kind === 'delegate')
    .map((field) => field.container);

  // A question the template already declared waivable is waivable here too. The
  // same field can be reached either way - by the template when it names it, or
  // by discovery when the template's label did not match - and it would be an
  // odd system where which route found it decided whether it could stop a
  // submission.
  const excused = template.fields
    .filter((field) => field.kind === 'choice' && field.waivable && field.label)
    .map((field) => (field as { label: RegExp }).label);
  const isExcused = (label: string) => excused.some((pattern) => pattern.test(label));

  const seen = new Set<string>();
  const fields: DiscoveredField[] = [];
  for (const container of containers.length ? containers : [undefined]) {
    for (const found of await discoverFields(root, container).catch(() => [])) {
      if (seen.has(found.ref)) continue;
      seen.add(found.ref);
      fields.push(found);
    }
  }

  if (fields.length) {
    outcome.fingerprint = fingerprintForm(
      template.atsKind,
      originOf(root),
      fields,
      scrubTerms(ctx.job.company, ctx.job.url),
    );
  }

  for (const field of fields) {
    if (field.hasValue || field.control === 'file' || !field.label) continue;

    const locator = root.locator(`[data-mp-ref="${field.ref}"]`);
    const resolved = await resolveAnswer(field, ctx);

    if (!resolved) {
      outcome.unanswered.push({
        ref: field.ref,
        label: field.label,
        control: field.control,
        required: field.required,
        options: field.options,
      });
      if (field.required) {
        const detail = `"${field.label}" (no answer for this question)`;
        if (isExcused(field.label)) {
          outcome.waived.push(detail);
        } else {
          outcome.blocking.push(detail);
          outcome.reason = 'unknown_question';
        }
      }
      continue;
    }

    await delay(jitter(400, 150));
    const ok = await setDiscovered(root, locator, resolved, field);

    outcome.filled.push({ where: `"${field.label}"`, what: 'answer', ok, got: resolved });
    if (!ok) {
      // The profile had something to say and the field would not take it - most
      // often because a rule resolved to prose and the form wanted Yes or No.
      // That is a question needing a human answer, not merely a failed write, so
      // it joins the backlog where it can actually be dealt with once.
      outcome.unanswered.push({
        ref: field.ref,
        label: field.label,
        control: field.control,
        required: field.required,
        options: field.options,
      });
      if (field.required) {
        const detail = `"${field.label}" (would not accept "${resolved}")`;
        if (isExcused(field.label)) {
          outcome.waived.push(detail);
        } else {
          outcome.blocking.push(detail);
          outcome.reason = 'ambiguous_choice';
        }
      }
    }
  }
}

/** The origin a form is served from, or an empty string if it cannot be read. */
function originOf(root: FormRoot): string {
  try {
    return new URL(root.url()).origin;
  } catch {
    return '';
  }
}

/** Bank first, then the rules. Neither guesses. */
async function resolveAnswer(field: DiscoveredField, ctx: FillContext): Promise<string | null> {
  const banked = await ctx.lookupAnswer?.(questionKey(field.label), field.label);
  if (banked?.answer) return banked.answer;

  const rule = matchRule(field.label, field.control);
  if (!rule) return null;
  const value = resolveValue(rule.key, ctx);
  return value || null;
}

/**
 * Sets a discovered field, whichever kind of control it turned out to be.
 *
 * Radios and checkboxes are handled here rather than through the text path
 * because writing a value to them does nothing at all: they are set by being
 * clicked, and the thing to click is often the label, since styled forms hide
 * the real input behind one.
 */
async function setDiscovered(
  root: FormRoot,
  locator: Locator,
  want: string,
  field: DiscoveredField,
): Promise<boolean> {
  if (field.control === 'select' || field.control === 'combobox') {
    return (await applyDiscoveredChoice(root, locator, want, field)).ok;
  }
  if (field.control === 'date') return setDate(locator, want);
  if (field.control === 'radiogroup') return setRadioGroup(locator, want);
  if (field.control === 'checkbox') return setCheckbox(locator, want);
  return (await writeVerified(locator, want, { comparator: 'loose' })).ok;
}

/**
 * Picks one radio out of its group, by what the option says.
 *
 * Matched by meaning and never by position: on a Yes/No, taking the first
 * option is a coin flip recorded as an answer. Clicks the option's label rather
 * than the input, because a styled form routinely hides the input itself, and
 * reads the result back rather than trusting the click.
 */
async function setRadioGroup(lead: Locator, want: string): Promise<boolean> {
  return lead
    .evaluate((element, wanted) => {
      const input = element as HTMLInputElement;
      const root = input.getRootNode() as Document | ShadowRoot;
      const members = Array.from(
        root.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(input.name)}"]`),
      );
      if (!members.length) return false;

      const labelOf = (member: HTMLInputElement): string => {
        const own = member.id ? root.querySelector(`label[for="${CSS.escape(member.id)}"]`) : null;
        const text = own?.textContent ?? member.closest('label')?.textContent ?? member.value;
        return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      };

      const target = wanted.trim().toLowerCase();
      const pick =
        members.find((member) => labelOf(member) === target) ??
        members.find((member) => labelOf(member).startsWith(target)) ??
        members.find((member) => labelOf(member).includes(target));
      if (!pick) return false;

      const label = pick.id ? root.querySelector<HTMLElement>(`label[for="${CSS.escape(pick.id)}"]`) : null;
      (label ?? pick).click();
      return pick.checked;
    }, want)
    .catch(() => false);
}

/**
 * Ticks a checkbox when the answer is affirmative.
 *
 * Only ever ticks. A box the form arrived with already ticked was ticked for a
 * reason, and clearing it on the strength of a fuzzy match would be a change
 * nobody asked for.
 */
async function setCheckbox(locator: Locator, want: string): Promise<boolean> {
  if (!/^(yes|true|1|agree|accept|i agree)/i.test(want.trim())) return false;
  await locator.check({ timeout: 5000 }).catch(async () => {
    // A hidden input cannot be checked directly; its label is what a person clicks.
    await locator.evaluate((element) => {
      const input = element as HTMLInputElement;
      const root = input.getRootNode() as Document | ShadowRoot;
      const label = input.id ? root.querySelector<HTMLElement>(`label[for="${CSS.escape(input.id)}"]`) : null;
      (label ?? input.closest('label') ?? input).click();
    }).catch(() => {});
  });
  return locator.isChecked().catch(() => false);
}

async function applyDiscoveredChoice(
  root: FormRoot,
  locator: Locator,
  want: string,
  field: DiscoveredField,
): Promise<{ ok: boolean }> {
  if (field.control === 'select') return { ok: await chooseNativeOption(locator, want) };
  const choice = await selectComboboxOption(root, locator, want, {});
  return { ok: choice.ok };
}

/**
 * Re-reads every text field once everything else is done.
 *
 * Verifying at the moment of writing is not enough. Greenhouse parses an
 * uploaded resume and re-renders the form around what it found, and that wipes
 * values that were correct when they were written - a form can therefore pass
 * every individual check and still be sitting there empty. This is the only
 * check that sees the form as the employer will receive it, so it is the one
 * that decides whether anything may be submitted.
 */
async function reverify(
  root: FormRoot,
  template: FormTemplate,
  ctx: FillContext,
  outcome: FillOutcome,
): Promise<void> {
  for (const field of template.fields) {
    if (field.kind !== 'text') continue;
    const want = resolveValue(field.value, ctx);
    if (!want) continue;

    const locator = locate(root, field);
    if (!locator) continue;
    const got = await locator.inputValue().catch(() => null);
    if (got === null) continue;

    const comparator = field.comparator ?? comparatorFor(field.value);
    if (equivalent(got, want, comparator)) continue;

    const entry = outcome.filled.find((item) => item.what === field.value);
    if (entry) {
      entry.ok = false;
      entry.got = got;
    }
    outcome.blocking.push(
      `${describe(field)} (was set to "${want}" but the form now holds "${got}" - something cleared it)`,
    );
    outcome.reason = 'verification_failed';
  }
}

/** Profile values that are dates, whatever control a form puts them in. */
const DATE_VALUES: ReadonlySet<string> = new Set(['availableStartDate']);

/** How a field is described in the log and in the review queue. */
function describe(target: Target): string {
  return target.selector ?? String(target.label);
}

/**
 * Resolves a target to one element.
 *
 * `getByLabel` rather than a selector wherever the id is generated per posting.
 * It computes the accessible name, so it follows `aria-labelledby` to the label
 * element - which is the only durable handle on a Greenhouse EEOC question.
 */
function locate(root: FormRoot, target: Target): Locator | null {
  if (target.selector) return root.locator(target.selector).first();
  if (target.label) return root.getByLabel(target.label).first();
  return null;
}

async function applyField(
  root: FormRoot,
  field: TemplatePlan,
  ctx: FillContext,
  outcome: FillOutcome,
): Promise<void> {
  if (field.kind === 'delegate') {
    if ((await root.locator(field.container).count()) > 0) outcome.delegated.push(field.container);
    return;
  }

  const where = describe(field);
  const locator = locate(root, field);
  if (!locator || (await locator.count()) === 0) {
    // A field the template expected and the page does not have. Only a problem
    // when it was required: forms legitimately omit optional ones.
    if (field.required) {
      outcome.blocking.push(`${where} (expected, not on the form)`);
      outcome.reason = 'unexpected_step';
    }
    return;
  }

  if (field.kind === 'file') {
    await applyFile(root, locator, where, field, ctx, outcome);
    return;
  }

  const want = resolveValue(field.value, ctx);
  if (!want && !(field.kind === 'choice' && field.fallback)) {
    if (field.required) {
      outcome.blocking.push(`${where} (profile has no ${field.value})`);
      outcome.reason = 'unknown_question';
    }
    return;
  }

  if (field.kind === 'choice') {
    await applyChoice(root, locator, where, field, want, outcome);
    return;
  }

  // A date is written as a date even when the template called it text: the box
  // decides the format, and ISO typed into one expecting DD/MM is not rejected,
  // it is accepted as the wrong day.
  const result = DATE_VALUES.has(field.value)
    ? { ok: await setDate(locator, want), via: undefined, got: want }
    : await writeVerified(locator, want, {
        comparator: field.comparator ?? comparatorFor(field.value),
        typeOnly: field.typeahead,
      });
  outcome.filled.push({ where, what: field.value, ok: result.ok, via: result.via, got: result.got });
  if (!result.ok) {
    outcome.blocking.push(`${where} (wrote "${want}", read back "${result.got}")`);
    outcome.reason = 'verification_failed';
  }
}

/**
 * A pick-one field, whichever way the page draws it.
 *
 * Decided by looking for real `<option>` children rather than by what the
 * template declared, because the same question is a native select on the older
 * Greenhouse form and react-select on the current one, and a template that
 * guessed would break on half the postings.
 */
async function applyChoice(
  root: FormRoot,
  locator: Locator,
  where: string,
  field: Extract<TemplatePlan, { kind: 'choice' }>,
  want: string,
  outcome: FillOutcome,
): Promise<void> {
  const native = await locator.locator('option').count().catch(() => 0);

  if (native > 0) {
    const ok = await chooseNativeOption(locator, want, field.fallback);
    outcome.filled.push({ where, what: field.value, ok, via: 'select', got: want });
    if (!ok && field.required) {
      outcome.blocking.push(`${where} (no option matching "${want}")`);
      outcome.reason = 'ambiguous_choice';
    }
    return;
  }

  const choice = await selectComboboxOption(root, locator, want, {
    fallback: field.fallback,
    allowFirst: field.allowFirst,
  });
  outcome.filled.push({
    where,
    what: field.value,
    ok: choice.ok,
    via: 'combobox',
    got: choice.chosen ?? want,
    // Kept even when nothing blocked: a picker that offered nothing and one that
    // offered five wrong things fail identically in the log otherwise, and they
    // need completely different fixes.
    offered: choice.options?.slice(0, 10),
  });
  if (!choice.ok && field.required) {
    const offered = choice.options?.length ? `; offered: ${choice.options.slice(0, 8).join(' / ')}` : '';
    const detail = `${where} (could not choose "${want}"${offered})`;
    if (field.waivable) {
      outcome.waived.push(detail);
    } else {
      outcome.blocking.push(detail);
      outcome.reason = 'ambiguous_choice';
    }
  }
}

/**
 * Attaches a file, the way the form expects to receive one.
 *
 * Setting files directly on the input is the obvious approach and it does not
 * work here: Greenhouse's uploader is a controlled React component that discards
 * a value it did not ask for, so the input is replaced and nothing is attached.
 * Clicking its own "Attach" button and answering the file chooser goes through
 * the same path a person does, and that it accepts.
 *
 * Verification cannot read the input either - the component keeps its own state
 * and leaves `files` empty even on success - so the evidence is the filename the
 * form prints back.
 */
async function applyFile(
  root: FormRoot,
  locator: Locator,
  where: string,
  field: Extract<TemplatePlan, { kind: 'file' }>,
  ctx: FillContext,
  outcome: FillOutcome,
): Promise<void> {
  const path = field.artifact === 'resume' ? ctx.resumePath : ctx.coverLetterPath;
  if (!path) {
    if (field.required) outcome.blocking.push(`${where} (no ${field.artifact} to upload)`);
    return;
  }

  const page = 'context' in root ? root : root.page();
  let ok = false;
  let via: 'chooser' | 'setInputFiles' | 'no-trigger' = 'no-trigger';

  let note = '';
  const trigger = await findUploadTrigger(root, locator);
  if (!trigger) {
    note = 'no attach button found near the input';
  } else {
    via = 'chooser';
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 8000 }),
        trigger.click(),
      ]);
      await chooser.setFiles(path);
      ok = await uploadLanded(root, trigger, path);
      if (!ok) note = 'chooser accepted the file but the form never acknowledged it';
    } catch (error) {
      note = `chooser did not open: ${(error as Error).message.slice(0, 90)}`;
    }
  }

  if (!ok) {
    // Either there was no button to press, or pressing it opened something that
    // was not a file chooser. Setting the input directly still works on plainer
    // forms, so it is worth trying before giving up.
    via = 'setInputFiles';
    try {
      await locator.setInputFiles(path);
      const attached = await locator
        .evaluate((el) => (el as HTMLInputElement).files?.length ?? 0, undefined, { timeout: 2500 })
        .catch(() => 0);
      ok = attached > 0 || (await showsFileName(root, path));
    } catch {
      ok = false;
    }
  }

  outcome.filled.push({ where, what: field.artifact, ok, via, note: note || undefined });
  if (!ok && field.required) {
    outcome.blocking.push(`${where} (upload did not attach)`);
    outcome.reason = 'verification_failed';
  }
}

/**
 * The button a person would press to attach a file.
 *
 * Found by walking out from the hidden input rather than by a selector in the
 * template, because the buttons around an uploader are not distinctive - a form
 * with a resume and a cover letter has two identical "Attach" buttons, and only
 * proximity to the right input tells them apart.
 */
async function findUploadTrigger(root: FormRoot, input: Locator): Promise<Locator | null> {
  const ref = await input
    .evaluate((element) => {
      const TRIGGER = /^(attach|upload|choose file|browse|add file|select file|upload file)$/i;
      let node: Element | null = element;
      for (let depth = 0; depth < 5 && node; depth += 1) {
        const button = Array.from(node.querySelectorAll('button')).find((candidate) =>
          TRIGGER.test((candidate.textContent ?? '').replace(/\s+/g, ' ').trim()),
        );
        if (button) {
          const marker = `mpup${Date.now() % 100000}`;
          button.setAttribute('data-mp-upload', marker);
          return marker;
        }
        node = node.parentElement;
      }
      return null;
    })
    .catch(() => null);

  return ref ? root.locator(`[data-mp-upload="${ref}"]`) : null;
}

/**
 * Waits for the form to acknowledge the upload, by either of two signs.
 *
 * The filename appearing is the clearest, but Greenhouse parses the resume
 * before it renders anything, and that takes longer than it looks. The button
 * that was just pressed disappearing is the other: a component that has swapped
 * out its own "Attach" control has moved on to holding a file. Either will do,
 * and waiting for both would fail on forms that only ever show one.
 */
async function uploadLanded(root: FormRoot, trigger: Locator, path: string): Promise<boolean> {
  const name = path.split(/[\/]/).pop() ?? path;
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    if ((await root.getByText(name, { exact: false }).count().catch(() => 0)) > 0) return true;
    if (!(await trigger.isVisible().catch(() => false))) return true;
    await delay(400);
  }
  return false;
}

/**
 * Looks for evidence the form is now holding the file.
 *
 * The filename, not the input: a controlled uploader reports no files even when
 * it has accepted one, so the only honest signal is what the form displays.
 */
async function showsFileName(root: FormRoot, path: string, timeoutMs = 5000): Promise<boolean> {
  const name = path.split(/[\/]/).pop() ?? path;
  if (name.length < 4) return false;

  // Polled rather than read once. The upload is handed off to the page and the
  // filename appears when the component gets round to rendering it; checking the
  // instant after handing it over reads the form before it has answered, and
  // reports a good upload as a failure.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await root.getByText(name, { exact: false }).count().catch(() => 0)) > 0) return true;
    await delay(250);
  }
  return false;
}

/**
 * Picks a native option by meaning, never by position.
 *
 * Exact, then prefix, then substring, then the fallback. Deliberately no "take
 * the first" - on a Yes/No that is a coin flip recorded as an answer.
 */
async function chooseNativeOption(
  locator: Locator,
  want: string,
  fallback?: RegExp,
): Promise<boolean> {
  const options = await locator
    .locator('option')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        value: (node as HTMLOptionElement).value,
        label: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
      })),
    )
    .catch(() => [] as { value: string; label: string }[]);

  if (!options.length) return false;

  // An option with an empty value is the "Select..." placeholder, never an answer.
  const usable = options.filter((option) => option.value !== '');
  const wanted = want.trim().toLowerCase();
  const labelOf = (option: { label: string }) => option.label.toLowerCase();

  const byText = wanted
    ? (usable.find((o) => labelOf(o) === wanted) ??
      usable.find((o) => labelOf(o).startsWith(wanted)) ??
      usable.find((o) => labelOf(o).includes(wanted)))
    : undefined;

  const byFallback = fallback ? usable.find((o) => fallback.test(o.label)) : undefined;

  const match = byText ?? byFallback;
  if (!match) return false;

  await locator.selectOption({ value: match.value });
  // Read back rather than trust: a controlled select can reject a choice.
  return (await locator.inputValue()) === match.value;
}

