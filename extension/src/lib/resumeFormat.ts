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
