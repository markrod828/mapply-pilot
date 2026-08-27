import { LlmError, LlmTruncatedError, type LlmPort, type LlmRequest, type LlmUsage } from '../ports';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1/chat/completions';

/** Kept exported under its old name: callers still catch it, and it is now an LlmError. */
export { LlmError as OpenAiError };

export interface OpenAiClientOptions {
  apiKey: string;
  /** Override for a proxy or a compatible endpoint. */
  baseUrl?: string;
  /**
   * How many requests may be in flight at once. The side panel only ever makes
   * one at a time; the orchestrator runs a fleet and would otherwise walk
   * straight into a 429 of its own making.
   */
  concurrency?: number;
  /** Attempts after the first, for 429 and 5xx only. */
  maxRetries?: number;
  /** Called once per request, success or failure, for cost accounting. */
  onUsage?: (usage: LlmUsage) => void;
  fetchImpl?: typeof fetch;
}

export function createOpenAiClient(options: OpenAiClientOptions): LlmPort {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const maxRetries = options.maxRetries ?? 3;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const queue = new Gate(options.concurrency ?? 4);

  async function complete(request: LlmRequest, json: boolean): Promise<string> {
    return queue.run(async () => {
      const started = Date.now();
      // Written by `once` as soon as a response body parses, so a truncated
      // answer - which is billed like any other - still reports its tokens.
      let counted: TokenCount = { promptTokens: 0, completionTokens: 0 };
      const report = (ok: boolean, error?: string) =>
        options.onUsage?.({
          purpose: request.purpose,
          model: request.model,
          ...counted,
          latencyMs: Date.now() - started,
          ok,
          error,
        });

      try {
        const content = await withRetries(maxRetries, () =>
          once(request, json, (usage) => {
            counted = usage;
          }),
        );
        report(true);
        return content;
      } catch (error) {
        report(false, (error as Error).message);
        throw error;
      }
    });
  }

  async function once(
    request: LlmRequest,
    json: boolean,
    countTokens: (usage: TokenCount) => void,
  ): Promise<string> {
    if (!options.apiKey) {
      throw new LlmError('No OpenAI API key set. Add one in ApplyPilot settings.');
    }

    let response: Response;
    try {
      response = await doFetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          temperature: request.temperature ?? 0.2,
          max_tokens: request.maxTokens ?? 2000,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
        }),
      });
    } catch (error) {
      throw new Retryable(new LlmError(`Could not reach OpenAI: ${(error as Error).message}`));
    }

    if (!response.ok) {
      const failure = new LlmError(await describeFailure(response));
      // 429 and 5xx are worth another go; 400 and 401 would fail identically forever.
      if (response.status === 429 || response.status >= 500) {
        throw new Retryable(failure, retryAfterMs(response));
      }
      throw failure;
    }

    const body = (await response.json()) as ChatBody;
    countTokens({
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
    });

    const choice = body.choices?.[0];
    const content = choice?.message?.content;
    if (!content) throw new LlmError('OpenAI returned an empty response.');

    if (choice?.finish_reason === 'length') {
      throw new LlmTruncatedError(
        `The response was cut off before it finished. ${
          request.truncationHint ??
          'Try "Quick edit" instead of "Full edit", or shorten your resume text.'
        }`,
      );
    }

    return content;
  }

  return {
    async chatJson<T>(request: LlmRequest): Promise<T> {
      const content = await complete(request, true);
      try {
        return JSON.parse(content) as T;
      } catch {
        throw new LlmError('OpenAI returned malformed JSON.');
      }
    },
    async chatText(request: LlmRequest): Promise<string> {
      return (await complete(request, false)).trim();
    },
  };
}

interface TokenCount {
  promptTokens: number;
  completionTokens: number;
}

interface ChatBody {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Wraps a failure worth trying again, carrying the server's own advice on when. */
class Retryable extends Error {
  constructor(
    readonly failure: LlmError,
    readonly afterMs?: number,
  ) {
    super(failure.message);
  }
}

async function withRetries<T>(attempts: number, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof Retryable)) throw error;
      if (attempt >= attempts) throw error.failure;
      // Exponential, with jitter so a fleet that all hit a 429 together does not
      // come back in lockstep and hit it again.
      const backoff = error.afterMs ?? Math.min(30_000, 1000 * 2 ** attempt);
      await delay(backoff * (0.75 + Math.random() * 0.5));
    }
  }
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** A minimal concurrency limiter, so core needs no dependency for one. */
class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function describeFailure(response: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? '';
  } catch {
    detail = '';
  }
  if (response.status === 401) return `OpenAI rejected the API key (401). ${detail}`.trim();
  if (response.status === 429) return `OpenAI rate limit or quota exceeded (429). ${detail}`.trim();
  return `OpenAI request failed (${response.status}). ${detail}`.trim();
}
