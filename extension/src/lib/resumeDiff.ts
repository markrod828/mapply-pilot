import { diffWords, similarity, tokenize, type DiffPart } from './diffText';
import { stripBulletPrefix } from './resumeFormat';
import { containsKeyword } from './tailor';
import type { ExperienceEntry, ProjectEntry } from './types';

/** Below this, two lines are unrelated rather than a rewrite of one another. */
const MIN_SIMILARITY = 0.3;
/** Shorter original lines are headings, dates or contact details, not content. */
const MIN_WORDS = 4;
/**
 * A line whose words mostly reappear somewhere in the new resume was reorganised,
 * not cut - a role heading, the skills list, an education entry. Only report a line
 * as dropped when its content genuinely went missing.
 */
const SURVIVAL_THRESHOLD = 0.6;
/** Cap the leftovers so the preview does not turn back into the old resume. */
const MAX_OTHER_DROPPED = 8;
/** Contact details never become bullets; the header comes from your profile instead. */
const CONTACT_LINE = /@|linkedin\.com|github\.com|\d{3}[.\-\s]?\d{3}[.\-\s]?\d{4}/i;

export interface ResumeDiff {
  /** New line -> its word diff against the closest line in the original resume. */
  lines: Map<string, DiffPart[]>;
  /** New lines with no counterpart in the original: written from scratch. */
  additions: Set<string>;
  /** Original lines that survive nowhere, grouped by the role they came from. */
  droppedByRole: Map<number, string[]>;
  /** Dropped lines that could not be pinned to a role. */
  droppedOther: string[];
  /** Lower-cased skills that appear nowhere in the original resume. */
  addedSkills: Set<string>;
}

export interface DiffableResume {
  headline?: string;
  summary: string;
  skills?: string[];
  experience?: ExperienceEntry[];
  projects?: ProjectEntry[];
}

interface NewLine {
  text: string;
  tokens: Set<string>;
  /** Index into `experience`, or null for the headline, summary and projects. */
  roleIndex: number | null;
}

interface OriginalLine {
  text: string;
  tokens: Set<string>;
  /** Line number in the original text, so dropped lines can be traced to a role. */
  index: number;
}

/**
 * Compare the tailored draft against the resume it came from.
 *
 * The original is plain text with no structure, so this works line by line: every
 * new bullet is paired with the original line it most resembles and diffed against
 * it, and originals nothing paired with are reported as dropped.
 */
export function buildResumeDiff(
  originalText: string,
  resume: DiffableResume,
  /** The rendered new resume, used to tell a dropped line from a moved one. */
  newText: string,
): ResumeDiff {
  const originals = readOriginalLines(originalText);
  const newLines = readNewLines(resume);
  const newTokens = tokenize(newText);
  const { pairs, unmatchedNew, unmatchedOriginal } = matchLines(newLines, originals);

  const lines = new Map<string, DiffPart[]>();
  const matchedByRole = new Map<number, number[]>();

  for (const [newIndex, originalIndex] of pairs) {
    const line = newLines[newIndex];
    const original = originals[originalIndex];
    lines.set(line.text, diffWords(original.text, line.text));
    if (line.roleIndex !== null) {
      matchedByRole.set(line.roleIndex, [...(matchedByRole.get(line.roleIndex) ?? []), original.index]);
    }
  }

  const ranges = roleRanges(matchedByRole);
  const droppedByRole = new Map<number, string[]>();
  const droppedOther: string[] = [];

  for (const originalIndex of unmatchedOriginal) {
    const original = originals[originalIndex];
    if (survives(original, newTokens)) continue;

    const range = ranges.find((item) => original.index >= item.start && original.index <= item.end);
    if (range) {
      droppedByRole.set(range.role, [...(droppedByRole.get(range.role) ?? []), original.text]);
    } else {
      droppedOther.push(original.text);
    }
  }

  return {
    lines,
    additions: new Set(unmatchedNew.map((index) => newLines[index].text)),
    droppedByRole,
    droppedOther: droppedOther.slice(0, MAX_OTHER_DROPPED),
    addedSkills: new Set(
      (resume.skills ?? [])
        .filter((skill) => !containsKeyword(originalText, skill))
        .map((skill) => skill.toLowerCase()),
    ),
  };
}

/**
 * A role owns the original text from its first matched line up to where the next
 * role starts, so bullets cut from the end of a role are still attributed to it.
 * The last role runs to the end of the document; whatever follows it there is
 * education and skills, which the survival check has already filtered out.
 */
function roleRanges(matchedByRole: Map<number, number[]>): { role: number; start: number; end: number }[] {
  const ranges = Array.from(matchedByRole, ([role, indices]) => ({
    role,
    start: Math.min(...indices),
    end: Math.max(...indices),
  })).sort((a, b) => a.start - b.start);

  ranges.forEach((range, position) => {
    const next = ranges[position + 1];
    range.end = next ? Math.max(range.end, next.start - 1) : Number.MAX_SAFE_INTEGER;
  });

  return ranges;
}

/** True when most of this line's words turn up somewhere in the new resume. */
function survives(line: OriginalLine, newTokens: Set<string>): boolean {
  if (!line.tokens.size) return true;
  let present = 0;
  for (const token of line.tokens) {
    if (newTokens.has(token)) present += 1;
  }
  return present / line.tokens.size >= SURVIVAL_THRESHOLD;
}

/** Greedy best-first pairing: the strongest resemblance wins, each line used once. */
function matchLines(newLines: NewLine[], originals: OriginalLine[]) {
  const candidates: { newIndex: number; originalIndex: number; score: number }[] = [];
  newLines.forEach((line, newIndex) => {
    originals.forEach((original, originalIndex) => {
      const score = similarity(line.tokens, original.tokens);
      if (score >= MIN_SIMILARITY) candidates.push({ newIndex, originalIndex, score });
    });
  });
  candidates.sort((a, b) => b.score - a.score);

  const pairs: [number, number][] = [];
  const usedNew = new Set<number>();
  const usedOriginal = new Set<number>();
  for (const candidate of candidates) {
    if (usedNew.has(candidate.newIndex) || usedOriginal.has(candidate.originalIndex)) continue;
    usedNew.add(candidate.newIndex);
    usedOriginal.add(candidate.originalIndex);
    pairs.push([candidate.newIndex, candidate.originalIndex]);
  }

  return {
    pairs,
    unmatchedNew: newLines.map((_, index) => index).filter((index) => !usedNew.has(index)),
    unmatchedOriginal: originals.map((_, index) => index).filter((index) => !usedOriginal.has(index)),
  };
}

function readOriginalLines(originalText: string): OriginalLine[] {
  const lines: OriginalLine[] = [];
  originalText.split('\n').forEach((raw, index) => {
    const text = stripBulletPrefix(raw).trim();
    if (text.split(/\s+/).filter(Boolean).length < MIN_WORDS) return;
    if (CONTACT_LINE.test(text)) return;
    lines.push({ text, index, tokens: tokenize(text) });
  });
  return lines;
}

function readNewLines(resume: DiffableResume): NewLine[] {
  const lines: NewLine[] = [];
  const add = (raw: string, roleIndex: number | null) => {
    const text = stripBulletPrefix(raw).trim();
    if (text) lines.push({ text, roleIndex, tokens: tokenize(text) });
  };

  if (resume.headline) add(resume.headline, null);
  if (resume.summary) add(resume.summary, null);
  resume.experience?.forEach((role, index) => role.bullets.forEach((bullet) => add(bullet, index)));
  resume.projects?.forEach((project) => project.bullets.forEach((bullet) => add(bullet, null)));

  return lines;
}
