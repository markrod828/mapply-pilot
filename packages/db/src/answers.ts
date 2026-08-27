import type { Store } from './index';

export interface BankRow {
  answer: string;
  source: string;
  approved: boolean;
}

/**
 * What has already been answered for a question like this one.
 *
 * Scope lets a company-specific answer sit alongside a general one - "why do you
 * want to work here" is not the same question twice - and the narrower scope
 * wins. Only approved rows are handed back for use: an unapproved one is a
 * suggestion for a person to confirm, not an answer to submit.
 */
export function getAnswer(store: Store, questionKey: string, scope = 'global'): BankRow | null {
  const row = store.sqlite
    .prepare(
      `SELECT answer_text, source, approved FROM answers
        WHERE question_key = ? AND scope IN (?, 'global') AND approved = 1
        ORDER BY scope = ? DESC, times_used DESC
        LIMIT 1`,
    )
    .get(questionKey, scope, scope) as
    | { answer_text: string | null; source: string; approved: number }
    | undefined;

  if (!row?.answer_text) return null;

  store.sqlite
    .prepare(
      `UPDATE answers SET times_used = times_used + 1, last_used_at = ?
        WHERE question_key = ? AND scope IN (?, 'global')`,
    )
    .run(Date.now(), questionKey, scope);

  return { answer: row.answer_text, source: row.source, approved: row.approved === 1 };
}

export interface PutAnswer {
  questionKey: string;
  questionText: string;
  answer: string;
  control?: string;
  scope?: string;
  source?: string;
  approved?: boolean;
}

export function putAnswer(store: Store, input: PutAnswer): void {
  store.sqlite
    .prepare(
      `INSERT INTO answers (question_key, scope, question_text, control, answer_text, source, approved, created_at)
       VALUES (@key, @scope, @text, @control, @answer, @source, @approved, @now)
       ON CONFLICT(question_key, scope) DO UPDATE SET
         answer_text = @answer, source = @source, approved = @approved, question_text = @text`,
    )
    .run({
      key: input.questionKey,
      scope: input.scope ?? 'global',
      text: input.questionText,
      control: input.control ?? 'text',
      answer: input.answer,
      source: input.source ?? 'human',
      approved: input.approved === false ? 0 : 1,
      now: Date.now(),
    });
}

export function listAnswers(store: Store, limit = 100): {
  question_text: string;
  answer_text: string | null;
  source: string;
  times_used: number;
}[] {
  return store.sqlite
    .prepare(
      `SELECT question_text, answer_text, source, times_used FROM answers
        ORDER BY times_used DESC, question_text LIMIT ?`,
    )
    .all(limit) as never;
}
