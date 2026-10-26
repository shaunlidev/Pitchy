import { describe, expect, it } from "vitest";
import type { ToolRepository } from "@pitchroom/domain";
import { createLiveUnderstandingRunner } from "./live-runner";

const repository: ToolRepository = { async listSources() { return []; }, async getSource() { return undefined; }, async getChunk() { return undefined; } };

describe("live model configuration gate", () => {
  it("fails closed without credentials", () => expect(() => createLiveUnderstandingRunner(repository, { model: "pinned-model" })).toThrow("OPENAI_API_KEY"));
  it("fails closed without a pinned model", () => expect(() => createLiveUnderstandingRunner(repository, { apiKey: "test-key" })).toThrow("OPENAI_MODEL"));
  it("creates a runner without making a network call", () => expect(createLiveUnderstandingRunner(repository, { apiKey: "test-key", model: "pinned-model" })).toBeDefined());
});
