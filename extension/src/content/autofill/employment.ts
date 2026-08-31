import { isCurrentRole, monthFromLabel, monthOptions, parseMonthYear } from '@mapply/core/resumeFormat';
import type { ExperienceEntry } from '@mapply/core/types';
import { waitFor } from './combobox';
import {
  claimAttempt,
  collectFields,
  describeField,
  hasValue,
  highlight,
  isVisible,
  markTouched,
  setValue,
  wasTouched,
  type Fillable,
} from './fill';

/**
 * Employment history asked for row by row.
 *
 * Greenhouse and Workday do not want a resume here - they want one repeated group of
 * boxes per job, with the dates split into separate month and year pickers, a "current
 * role" checkbox instead of an end date, and an "Add another" button that creates the
 * next group. Every other pass in this engine fills a label once; this one has to fill
 * the same labels N times with different jobs, and press a button to get row N+1.
 */

/** Never add more rows than this, however long the history is. */
const MAX_ROWS = 6;
/** How long to wait for a framework to render the row that "Add another" creates. */
const NEW_ROW_MS = 3000;

interface RowFields {
  company?: Fillable;
  title?: Fillable;
  startMonth?: Fillable;
  startYear?: Fillable;
  endMonth?: Fillable;
  endYear?: Fillable;
  current?: HTMLInputElement;
}

const COMPANY = /company|employer|organi[sz]ation/;
const COMPANY_NOT = /why|reason|describe|size|industry|website|url/;
const TITLE = /\btitle\b|\bposition\b|\brole\b/;
const TITLE_NOT = /current role|currently|company|desired|preferred|why/;
const START_MONTH = /start (date )?month|from month|month started/;
const START_YEAR = /start (date )?year|from year|year started/;
const END_MONTH = /end (date )?month|to month|month ended/;
const END_YEAR = /end (date )?year|to year|year ended/;
const CURRENT = /current(ly)? (role|position|job)|i currently work|present( role)?|still work/;
const ADD_ANOTHER = /add another|add more|add employment|add experience|add position|^\+\s*add/;

const matches = (label: string, test: RegExp, not?: RegExp) => test.test(label) && !not?.test(label);

/**
 * The container holding exactly one job.
 *
 * The *tightest* ancestor that holds more of this job than its company box, not the
 * widest. Growing outward looks equivalent while a form has one row, but every
 * ancestor up to <html> also qualifies, and a row that has swallowed the whole page
 * leaves nothing outside it to find "Add another" in.
 */
function rowRootFor(company: Fillable): HTMLElement | null {
  let node: HTMLElement | null = company.parentElement;

  for (let depth = 0; node && depth < 8; depth += 1) {
    const labels = collectFields(node).map(describeField);
    // Two companies means this ancestor is the list, so the row boundary was missed.
    if (labels.filter((label) => matches(label, COMPANY, COMPANY_NOT)).length > 1) return null;
    if (labels.some((label) => matches(label, TITLE, TITLE_NOT) || START_YEAR.test(label))) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function readRow(root: HTMLElement): RowFields {
  const row: RowFields = {};

  for (const field of collectFields(root)) {
    const label = describeField(field);
    if (!label) continue;
    if (!row.company && matches(label, COMPANY, COMPANY_NOT)) row.company = field;
    else if (!row.title && matches(label, TITLE, TITLE_NOT)) row.title = field;
    else if (!row.startMonth && START_MONTH.test(label)) row.startMonth = field;
    else if (!row.startYear && START_YEAR.test(label)) row.startYear = field;
    else if (!row.endMonth && END_MONTH.test(label)) row.endMonth = field;
    else if (!row.endYear && END_YEAR.test(label)) row.endYear = field;
  }

  // Checkboxes are skipped by collectFields' callers everywhere else, so find it here.
  for (const box of root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    if (box.disabled) continue;
    if (CURRENT.test(describeField(box))) {
      row.current = box;
      break;
    }
  }

  return row;
}

export function findRows(): HTMLElement[] {
  const roots: HTMLElement[] = [];

  for (const field of collectFields()) {
    const label = describeField(field);
    if (!label || !matches(label, COMPANY, COMPANY_NOT)) continue;

    const root = rowRootFor(field);
    // Nested containers can both qualify; keep the outermost distinct one per company.
    if (root && !roots.some((seen) => seen === root || seen.contains(root) || root.contains(seen))) {
      roots.push(root);
    }
  }

  return roots;
}

/**
 * Picks the option that means this month, whatever spelling the picker uses.
 *
 * A dropdown is matched on meaning rather than on text: every option is read back to
 * the month it stands for, so "4", "04", "Apr" and "April" all resolve to the same
 * thing and a "Select a month" placeholder resolves to nothing. Matching text instead
 * risks the wrong month — "1" is a substring of "10", "11" and "12".
 *
 * Anything that is not a <select> — a typed box, or a custom combobox — has no options
 * to read, so there the spellings are offered in turn until one lands.
 */
function fillMonth(field: Fillable | undefined, month: number | null): boolean {
  if (!field || month === null || hasValue(field) || wasTouched(field)) return false;

  if (field instanceof HTMLSelectElement) {
    const match = Array.from(field.options).find(
      (option) => monthFromLabel(option.text) === month || monthFromLabel(option.value) === month,
    );
    return match ? setValue(field, match.value || match.text) : false;
  }

  return monthOptions(month).some((option) => setValue(field, option));
}

function fillText(field: Fillable | undefined, value: string): boolean {
  if (!field || !value || hasValue(field) || wasTouched(field)) return false;
  return setValue(field, value);
}

function fillRow(root: HTMLElement, role: ExperienceEntry, handled: Set<Fillable>): string[] {
  const row = readRow(root);
  const filled: string[] = [];

  const remember = (field: Fillable | undefined, key: string, ok: boolean) => {
    if (!field || !ok) return;
    handled.add(field);
    highlight(field, true);
    filled.push(key);
  };

  remember(row.company, 'employer.company', fillText(row.company, role.company));
  remember(row.title, 'employer.title', fillText(row.title, role.title));

  const start = parseMonthYear(role.startDate);
  if (start) {
    remember(row.startMonth, 'employer.startMonth', fillMonth(row.startMonth, start.month));
    remember(row.startYear, 'employer.startYear', fillText(row.startYear, start.year));
  }

  // A role still held has no end date to give: the form wants the checkbox instead,
  // and ticking it usually hides the end pickers altogether.
  if (isCurrentRole(role.endDate)) {
    if (row.current && !row.current.checked && !wasTouched(row.current)) {
      row.current.click();
      markTouched(row.current);
      highlight(row.current, true);
      filled.push('employer.currentRole');
    }
  } else {
    const end = parseMonthYear(role.endDate);
    if (end) {
      remember(row.endMonth, 'employer.endMonth', fillMonth(row.endMonth, end.month));
      remember(row.endYear, 'employer.endYear', fillText(row.endYear, end.year));
    }
  }

  return filled;
}

/** The control that creates the next row, searched outward from the rows themselves. */
/**
 * The "Add another" belonging to these rows, and to nothing else.
 *
 * Only the rows' own container is searched. The previous version climbed five
 * levels looking for any matching control, which on a form that repeats both
 * employment and education - as most do - eventually reached a scope holding
 * both buttons and took the wrong one. Worse, a form whose work-history section
 * has no add button at all would always find education's, and clicking it grew
 * an empty education block that the next pass then tried to fill, forever.
 *
 * A list's add button sits with the list. If it is not there, this list cannot
 * be extended, and filling only the rows that already exist is a far better
 * outcome than adding rows to something else.
 */
export function addAnotherFor(rows: HTMLElement[]): HTMLElement | null {
  const last = rows[rows.length - 1];
  const scope = last?.parentElement;
  if (!last || !scope) return null;

  const candidates = Array.from(scope.querySelectorAll<HTMLElement>('button, a, [role="button"]')).filter(
    (control) =>
      isVisible(control) &&
      !(control as HTMLButtonElement).disabled &&
      // Not one of the row's own controls, and after the row it extends.
      !rows.some((row) => row.contains(control)) &&
      ADD_ANOTHER.test((control.textContent ?? '').replace(/s+/g, ' ').trim().toLowerCase()) &&
      Boolean(last.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING),
  );

  return candidates[0] ?? null;
}


/**
 * Fills the work-history rows from the resume, adding rows as needed.
 *
 * Runs before the label rules so a bare "Title" box inside a job row is claimed by the
 * job it belongs to rather than by the profile's current title.
 */
export async function fillEmploymentHistory(
  experience: ExperienceEntry[],
  handled: Set<Fillable>,
): Promise<string[]> {
  if (!experience.length) return [];

  let rows = findRows();
  if (!rows.length) return [];

  const filled: string[] = [];
  const wanted = Math.min(experience.length, MAX_ROWS);

  for (let index = 0; index < wanted; index += 1) {
    if (index >= rows.length) {
      const add = addAnotherFor(rows);
      if (!add) break;
      // At most one click per button per press. The sweep that fills newly
      // arrived fields re-runs this on every DOM change, and the click is
      // itself a DOM change - so without a budget a click that fails to grow
      // the list repeats for as long as the page is open, adding an empty row
      // each time. Ten stray education blocks is what that looked like.
      if (!claimAttempt(add)) break;

      const before = rows.length;
      add.click();
      const grown = await waitFor(() => {
        const next = findRows();
        return next.length > before ? next : null;
      }, NEW_ROW_MS);
      if (!grown) break;
      rows = grown;
    }

    filled.push(...fillRow(rows[index], experience[index], handled));
  }

  return filled;
}
