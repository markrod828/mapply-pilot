const API_URL = 'https://api.openai.com/v1/chat/completions';

export class OpenAiError extends Error {}

interface ChatOptions {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
}

/** Calls OpenAI chat completions in JSON mode and returns the parsed object. */
export async function chatJson<T>(options: ChatOptions): Promise<T> {
  if (!options.apiKey) {
    throw new OpenAiError('No OpenAI API key set. Add one in ApplyPilot settings.');
  }

  let response: Response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 2000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: options.system },
          { role: 'user', content: options.user },
        ],
      }),
    });
  } catch (error) {
    throw new OpenAiError(`Could not reach OpenAI: ${(error as Error).message}`);
  }

  if (!response.ok) {
    throw new OpenAiError(await describeFailure(response));
  }

  const body = (await response.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
  };
  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    throw new OpenAiError('OpenAI returned an empty response.');
  }
  if (choice?.finish_reason === 'length') {
    throw new OpenAiError(
      'The response was cut off before it finished. Try "Quick edit" instead of "Full edit", or shorten your resume text.',
    );
  }

  try {
    return JSON.parse(content) as T;
  } catch {
    throw new OpenAiError('OpenAI returned malformed JSON.');
  }
}

async function describeFailure(response: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? '';
  } catch {
    detail = '';
  }
  if (response.status === 401) {
    return `OpenAI rejected the API key (401). ${detail}`.trim();
  }
  if (response.status === 429) {
    return `OpenAI rate limit or quota exceeded (429). ${detail}`.trim();
  }
  return `OpenAI request failed (${response.status}). ${detail}`.trim();
}
