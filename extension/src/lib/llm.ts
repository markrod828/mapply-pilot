import { createOpenAiClient } from '@mapply/core/llm/openai';
import type { LlmPort, Settings } from '@mapply/core';

/**
 * Builds the model client for one message.
 *
 * Made per call rather than kept around because settings can change between
 * messages, and the side panel only ever has one request in flight - there is
 * nothing here worth pooling. The orchestrator builds its own, with a real
 * concurrency limit and usage recording.
 */
export function llmFor(settings: Settings): LlmPort {
  return createOpenAiClient({ apiKey: settings.openaiApiKey, concurrency: 1 });
}
