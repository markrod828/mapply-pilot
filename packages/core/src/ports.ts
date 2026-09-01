/**
 * The seams where core meets a platform.
 *
 * Core does the thinking - scoring a resume, rewriting it, answering a screening
 * question - and knows nothing about where the model lives, where a file is
 * written, or where the profile is kept. Each consumer supplies those. That is
 * what lets the same tailoring code run inside a Chrome side panel and inside a
 * Node orchestrator, and what makes it testable without a network.
 */

/** What a call is for. Adapters use this to attribute cost and to pick limits. */
export type LlmPurpose =
  | 'score'
  | 'tailor'
  | 'refine'
  | 'extract_experience'
  | 'answer'
  | 'cover_letter'
  | 'parse_resume'
  | 'map_form'
  | 'chat';

export interface LlmRequest {
  purpose: LlmPurpose;
  /**
   * Which model to use. Kept on the request rather than fixed by the adapter
   * because the choice is a policy one the caller owns: scoring runs on a cheap
   * model where tailoring does not.
   */
  model: string;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  /** Advice to show if the model runs out of room mid-answer. */
  truncationHint?: string;
}

/**
 * A chat model, reduced to the two shapes core actually asks for.
 *
 * Deliberately returns the value alone. Token accounting is the adapter's
 * business: it knows the prices, and in the orchestrator it is built per
 * application, so it can attribute a call without core having to carry a
 * usage object through every return.
 */
export interface LlmPort {
  /** Calls the model in JSON mode and returns the parsed object. */
  chatJson<T>(request: LlmRequest): Promise<T>;
  /** Same call, for prompts whose answer is prose rather than a structure. */
  chatText(request: LlmRequest): Promise<string>;
}

/** Anything an adapter could not get an answer for. */
export class LlmError extends Error {}

/**
 * The model hit its output ceiling. Separate from LlmError because it is the one
 * failure a caller can do something about - retry with more room, or ask for
 * less - rather than merely report.
 */
export class LlmTruncatedError extends LlmError {}

/**
 * What one model call cost, reported by an adapter after the fact.
 *
 * Deliberately carries tokens rather than dollars: prices move, and baking a
 * table into core would mean editing core to correct a number. Whoever records
 * these knows the rates it is being billed at.
 */
export interface LlmUsage {
  purpose: LlmPurpose;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  ok: boolean;
  /** Set when the call failed, after retries were exhausted. */
  error?: string;
}
