import { createOpenAI } from "@ai-sdk/openai";
import { PitchroomError, type ToolRepository } from "@pitchroom/domain";
import { VercelAiUnderstandingRunner } from "./vercel-ai-runner";
import { DeepSeekUnderstandingRunner } from "./deepseek-runner";

export type LiveModelConfig = { apiKey?: string; model?: string; baseURL?: string };

export function createLiveUnderstandingRunner(repository: ToolRepository, config: LiveModelConfig) {
  if (!config.apiKey) throw new PitchroomError("INVALID_INPUT", "OPENAI_API_KEY is required for a live model run.");
  if (!config.model) throw new PitchroomError("INVALID_INPUT", "OPENAI_MODEL must be pinned for a live model run.");
  if (config.baseURL && new URL(config.baseURL).hostname.endsWith("deepseek.com")) {
    return new DeepSeekUnderstandingRunner(repository, { apiKey: config.apiKey, model: config.model, baseURL: config.baseURL });
  }
  const provider = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  return new VercelAiUnderstandingRunner(provider(config.model), repository);
}
