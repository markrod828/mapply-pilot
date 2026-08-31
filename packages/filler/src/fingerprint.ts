import { createHash } from 'node:crypto';
import type { DiscoveredField } from './discover';

/**
 * A stable identity for the shape of a form.
 *
 * Two postings on the same ATS ask the same questions in the same controls; only
 * the employer's name and the wording around it differ. Scrubbing those out is
 * what makes the fingerprint useful at all - without it "Why do you want to work
 * at Acme?" and "...at Beta?" are different forms, every application looks novel,
 * and nothing can ever be learned about a form's reliability.
 *
 * Order is deliberately not part of it. A form that renders its questions in a
 * different sequence is the same form, and treating it as new would throw away
 * whatever had been established about it.
 */
export function fingerprintForm(
  atsKind: string,
  origin: string,
  fields: readonly DiscoveredField[],
  scrub: readonly string[] = [],
): string {
  const signatures = fields
    .map((field) =>
      [
        field.control,
        normalizeLabel(field.label, scrub),
        field.required ? '1' : '0',
        field.options?.length
          ? hash(field.options.map((option) => normalizeLabel(option, scrub)).sort().join('|')).slice(0, 8)
          : '',
      ].join(':'),
    )
    .sort();

  return hash(`${atsKind}\n${origin}\n${signatures.join('\n')}`).slice(0, 32);
}

const NOISE = /\(\s*(required|optional)\s*\)|[*✱]|\bplease\b|\bselect one\b/gi;

/** Strips the wording that varies between two postings of the same form. */
export function normalizeLabel(text: string, scrub: readonly string[] = []): string {
  let out = text.toLowerCase();
  for (const term of scrub) {
    const trimmed = term.trim().toLowerCase();
    // Anything shorter is likely to appear inside unrelated words and would
    // scrub away meaning rather than noise.
    if (trimmed.length > 2) out = out.split(trimmed).join('<co>');
  }
  return out
    .replace(NOISE, ' ')
    .replace(/[^a-z0-9<>\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The names a form might use for the employer, worth scrubbing before hashing.
 *
 * Includes the name with common suffixes removed, because a posting writes
 * "Acme, Inc." in one sentence and "Acme" in the next.
 */
export function scrubTerms(company: string, origin: string): string[] {
  const bare = company.replace(/\b(inc|llc|ltd|corp|co|gmbh|plc)\b\.?/gi, '').trim();
  let host = '';
  try {
    host = new URL(origin).hostname.split('.')[0];
  } catch {
    host = '';
  }
  return [company, bare, host].filter((term) => term.length > 2);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
