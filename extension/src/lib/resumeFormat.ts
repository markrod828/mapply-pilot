/** Strip markers the model often leaves on so the renderer does not double them. */
export function stripBulletPrefix(text: string): string {
  return text.replace(/^(?:[\s]*([•●◦▪▫\-–—*]+|\d+[.)])\s*)+/u, '').trim();
}

/** Best-effort parse of "Title - Company (dates)" or "Title | Company". */
export function parseRoleHeading(heading: string): { title: string; company: string; dates: string } {
  const dateMatch = heading.match(/\(([^)]*(?:present|\d{4})[^)]*)\)/i);
  const dates = dateMatch?.[1]?.trim() ?? '';
  const withoutDates = heading.replace(/\s*\([^)]*(?:present|\d{4})[^)]*\)\s*/i, '').trim();
  const parts = withoutDates.split(/\s+[|\u2013\-–—]\s+/);
  if (parts.length >= 2) {
    return { title: parts[0].trim(), company: parts.slice(1).join(' - ').trim(), dates };
  }
  return { title: withoutDates || heading, company: '', dates };
}

/** "June 2022 – Present" splits here; a bare hyphen only counts between two years. */
const WRITTEN_RANGE = /^(.*?)(?:\s*[\u2013\u2014]\s*|\s+-\s+|\s+to\s+)(.*)$/i;
const YEAR_RANGE = /^(\d{4})\s*-\s*(\d{4}|present)$/i;

/**
 * Splits a written range into its two halves, for reading drafts stored before start
 * and end were separate fields.
 *
 * A lone value is treated as the end, because that is what it means on a resume: "2019"
 * against a degree is when it finished. The bare-hyphen case is deliberately narrow so
 * that "Co-op Engineer" and "Jan-2020" are not torn in half.
 */
export function splitDateRange(value: string): { startDate: string; endDate: string } {
  const text = value.trim();
  if (!text) return { startDate: '', endDate: '' };

  const match = WRITTEN_RANGE.exec(text) ?? YEAR_RANGE.exec(text);
  if (!match) return { startDate: '', endDate: text };

  return { startDate: match[1].trim(), endDate: match[2].trim() };
}

/**
 * Rejoins the halves for display. One-sided ranges show only the side they have.
 *
 * Tolerates missing halves despite the types: stored drafts are untyped JSON, and a
 * resume failing to render is a worse outcome than a blank date.
 */
export function formatDateRange(startDate: string, endDate: string): string {
  const start = (startDate ?? '').trim();
  const end = (endDate ?? '').trim();
  if (start && end) return `${start} – ${end}`;
  return start || end;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Splits a written date into the parts a form asks for in separate boxes.
 *
 * Returns null when there is no year to find - "Present" is a state, not a date, and
 * belongs in a "current role" checkbox instead.
 */
export function parseMonthYear(value: string): { month: number | null; year: string } | null {
  const text = (value ?? '').trim();
  if (!text) return null;

  const year = text.match(/\b(?:19|20)\d{2}\b/)?.[0];
  if (!year) return null;

  const lower = text.toLowerCase();
  const named = MONTH_NAMES.findIndex((name) => lower.includes(name.slice(0, 3).toLowerCase()));
  const numeric =
    text.match(/\b(0?[1-9]|1[0-2])\s*[/-]\s*(?:19|20)\d{2}\b/) ??
    text.match(/\b(?:19|20)\d{2}\s*[/-]\s*(0?[1-9]|1[0-2])\b/);

  return { month: named >= 0 ? named + 1 : numeric ? Number(numeric[1]) : null, year };
}

/**
 * The spellings a month dropdown might use, most specific first. Forms number their
 * months, zero-pad them or name them, and there is no way to tell which without trying.
 */
export function monthOptions(month: number): string[] {
  const name = MONTH_NAMES[month - 1];
  return [String(month), String(month).padStart(2, '0'), name, name.slice(0, 3)];
}

const MONTH_PREFIXES = MONTH_NAMES.map((name) => name.slice(0, 3).toLowerCase());

/**
 * The month an option stands for, whatever spelling it uses: "4", "04", "Apr",
 * "April", "04 - April", "APRIL".
 *
 * Null when the option is not a month at all, which is what keeps a "Select a month"
 * placeholder — or a year, on a picker that reuses the same code — from being mistaken
 * for one. Reading options back this way beats matching their text, because a form is
 * free to label an option "Apr" while its value says "04".
 */
export function monthFromLabel(label: string): number | null {
  const text = (label ?? '').trim().toLowerCase();
  if (!text) return null;

  // Anchored and bounded, so "2026" is a year rather than month 2.
  const numeric = text.match(/^(0?[1-9]|1[0-2])\b/);
  if (numeric) return Number(numeric[1]);

  const named = MONTH_PREFIXES.findIndex((prefix) => text.startsWith(prefix));
  return named >= 0 ? named + 1 : null;
}

/** Whether a written end date means "still there" rather than a date. */
export function isCurrentRole(endDate: string): boolean {
  return /present|current|now|ongoing|to date/i.test((endDate ?? '').trim());
}
