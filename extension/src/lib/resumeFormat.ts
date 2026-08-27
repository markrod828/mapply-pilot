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
