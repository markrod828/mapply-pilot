export type DiffKind = 'same' | 'added' | 'removed';

export interface DiffPart {
  text: string;
  kind: DiffKind;
}

/** Words are matched on letters and digits, so punctuation and case never read as a change. */
function key(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9+#]/g, '');
}

/**
 * Word-level diff of one line against another, via longest common subsequence.
 * Inputs are a single bullet or summary, so the quadratic table stays small.
 */
export function diffWords(before: string, after: string): DiffPart[] {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  const aKeys = a.map(key);
  const bKeys = b.map(key);

  const cols = b.length + 1;
  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  const lcs = new Uint16Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * cols + j] =
        aKeys[i] === bKeys[j]
          ? lcs[(i + 1) * cols + (j + 1)] + 1
          : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + (j + 1)]);
    }
  }

  const parts: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (aKeys[i] === bKeys[j]) {
      append(parts, 'same', b[j]);
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + (j + 1)]) {
      append(parts, 'removed', a[i]);
      i += 1;
    } else {
      append(parts, 'added', b[j]);
      j += 1;
    }
  }
  while (i < a.length) {
    append(parts, 'removed', a[i]);
    i += 1;
  }
  while (j < b.length) {
    append(parts, 'added', b[j]);
    j += 1;
  }
  return parts;
}

/** Runs of one kind become a single part, so the markup does not fragment per word. */
function append(parts: DiffPart[], kind: DiffKind, word: string): void {
  const last = parts[parts.length - 1];
  if (last && last.kind === kind) {
    last.text = `${last.text} ${word}`;
    return;
  }
  parts.push({ kind, text: word });
}

export function hasChanges(parts: DiffPart[]): boolean {
  return parts.some((part) => part.kind !== 'same');
}

/** Dice coefficient over word sets - used to pair a rewritten line with its original. */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  return (2 * shared) / (a.size + b.size);
}

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .split(/\s+/)
      .map(key)
      .filter((word) => word.length > 2),
  );
}
