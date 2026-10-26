import { outputLanguageInstruction, outputLanguage } from "./output-language";
import { createOpenAI } from "@ai-sdk/openai";
import { Output, ToolLoopAgent, stepCountIs, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { activeUnderstanding, buildClarificationCandidate, clarificationResultV4Schema, clarificationResultSchema, type ClarificationTask, type ClarificationResult, type ToolRepository } from "@pitchroom/domain";
import { clarificationDraftSchema, compileClarificationDraft, clarificationDraftInstructions } from "./clarification-draft";
import { ClarificationFailure, classifyClarificationFailure } from "./clarification-failure";
import { executeAgentTool } from "./tools";
import { isInstructionLikeSourceText, validateNoUntrustedInstructionEcho } from "./prompt-safety";
import { deepSeekOutputSchema } from "./deepseek-schema";
export interface ClarificationRunner { run(task: ClarificationTask): Promise<ClarificationResult> }
export class DeterministicClarificationRunner implements ClarificationRunner {
  async run(task: ClarificationTask): Promise<ClarificationResult> {
    if (isInstructionLikeSourceText(task.answer)) throw new Error("Answer needs manual review; untrusted instructions cannot steer the agent.");
    const bases = [
      { id: "answer", origin: "user" as const, nature: "record" as const, statement: task.answer.slice(0, 2000), scope: "Saved user answer; not independently verified", inputIds: [task.inputId], requirement: null },
      { id: "interpretation", origin: "agent" as const, nature: "interpretation" as const, statement: "Deterministic mechanism demonstration; semantic judgment remains unverified.", scope: "Synthetic runner only", requirement: null },
    ];
    if (/^(not sure|unknown|i don.t know|不知道|不确定)[.!。\s]*$/i.test(task.answer.trim())) return { schemaVersion: 4, bases: [bases[0]!], reasonBasisRefs: ["answer"], reason: "Your answer leaves the decision open; the current understanding should remain unchanged.", operations: [] };
    const themeIndex = task.selection?.themeIndex ?? task.question.relatedThemeIndexes[0];
    const theme = themeIndex === undefined ? undefined : task.base.themes[themeIndex];
    if (!theme?.id) throw new Error("The saved question requires a valid target theme.");
    const themeId = theme.id;
    const procurement = /procurement|purchas|采购/i.test(task.answer);
    const question = procurement ? "What would make procurement consider the pilot successful?" : "What evidence would let the audience make that decision?";
    const summary = task.selection
      ? `${theme.summary}\nUser context (unverified): ${task.answer.slice(0, 2000)}`
      : procurement ? "The discussion should help procurement decision-makers assess a bounded pilot, its risks and success criteria. Budget and approval criteria remain open unless supported by material." : `Organize the discussion around the decision stated by the user: ${task.answer}`;
    return { schemaVersion: 4, bases, reasonBasisRefs: ["answer", "interpretation"], reason: "Your answer changes the intended audience or decision. This is an interpretation of user input, not a verified source fact.", operations: [
      ...(summary.length <= 4000 ? [{ type: "update_summary" as const, themeId: themeId, basisRefs: ["answer"], applicability: theme.claims.filter(c => c.evidence.length).map(c => ({ claimId: c.id!, status: "unconfirmed" as const, currentInterpretation: "The saved answer supplies current context; applicability of this historical material record remains unconfirmed.", explanation: "Retaining a record does not confirm its applicability to the current discussion.", basisRefs: ["interpretation"] })), text: summary }] : []),
      { type: "add_answer", themeId: themeId },
      ...(!task.selection ? [{ type: "next_question" as const, relatedThemeIds: [themeId], question, whyItMatters: "The next question follows the decision clarified in your answer.", groundingV4: { objective: "Clarify the decision in the saved answer", primaryThemeId: themeId, associations: [{ themeId: themeId, unresolvedIssue: "Decision criteria remain open", questionSpan: question, expectedAnswer: "Information requested by the scripted question; semantic usefulness unverified", rationale: "The scripted question follows this decision; semantic usefulness remains unverified." }], basisRefs: ["interpretation"] } }] : []),
    ] };
  }
}
// Live adapter is implemented but invoked only by an explicitly authorized worker.
export class ModelClarificationRunner implements ClarificationRunner {
  constructor(private model: LanguageModel, private readonly timeoutMs = 60000, private readonly options: { wireFormat?: "draft" | "result-v4"; secrets?: readonly string[]; maxOutputTokens?: number; onEvent?: (event: Record<string, unknown>) => void } = {}) {}
  async run(task: ClarificationTask) {
    try { return await this.generate(task); }
    catch (error) {
      const diagnostic = classifyClarificationFailure(error, this.options.secrets);
      this.options.onEvent?.({ type: "clarification_failed", diagnostic });
      // Preserve the budget stop identity so the external ledger remains stopped.
      if ((error as {name?:string})?.name === "ClarifyStop") throw error;
      throw new ClarificationFailure(diagnostic);
    }
  }
  private async generate(task: ClarificationTask) {
    if (isInstructionLikeSourceText(task.answer)) throw new Error("Answer needs manual review.");
    const repository: ToolRepository = {
      listSources: async project => task.sources.filter(s => s.projectId === project),
      getSource: async (project,id) => task.sources.find(s => s.projectId === project && s.id === id),
      getChunk: async (project,id) => task.sources.filter(s => s.projectId === project).flatMap(s => s.chunks).find(c => c.id === id),
    };
    let calls = 0; let characters = 0; let completedSteps = 0; let fatalBudget: Error | undefined;
    const controller = new AbortController();
    const signal = controller.signal;
    const failBudget = (code: string): never => {
      fatalBudget = new Error(code); controller.abort(fatalBudget);
      this.options.onEvent?.({ type: "runner_budget_exhausted", code });
      throw fatalBudget;
    };
    const read = async (call: unknown) => {
      if (fatalBudget) throw fatalBudget;
      if (++calls > 12) failBudget("TOOL_CALL_BUDGET");
      this.options.onEvent?.({ type: "tool_called", call });
      const result = await executeAgentTool(task.projectId, call, repository);
      if ((characters += JSON.stringify(result).length) > 60000) failBudget("TOOL_CONTEXT_BUDGET");
      this.options.onEvent?.({ type: "tool_returned", result });
      return result;
    };
    const outputSchema: z.ZodType = this.options.wireFormat === "result-v4" ? clarificationResultV4Schema : clarificationDraftSchema(task);
    const agent = new ToolLoopAgent({ model: this.model, maxRetries: 0, onStepEnd: () => { completedSteps++; }, maxOutputTokens: this.options.maxOutputTokens, providerOptions: { openai: { store: false } }, stopWhen: stepCountIs(6), output: Output.object({ schema: outputSchema }),
      instructions: outputLanguageInstruction + "\n" + (this.options.wireFormat === "result-v4" ? "Reassess the saved answer. Return a strict schemaVersion 4 result. Preserve sources and user history; no approval or Apply. Attribute all bases, preserve unknowns, and only ask directly relevant questions." : clarificationDraftInstructions),
      tools: {
        read_chunk: tool({ description: "Inspect a source passage.", inputSchema: z.object({ chunkId: z.string() }), execute: args => read({ name: "read_chunk", arguments: args }) }),
        search_chunks: tool({ description: "Search snapshot passages.", inputSchema: z.object({ query: z.string(), limit: z.number().int().min(1).max(20) }), execute: args => read({ name: "search_chunks", arguments: args }) }),
      },
    });
    let result;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve,reject) => {
      deadline = setTimeout(() => { const error = new Error("TIME_BUDGET"); controller.abort(error); reject(error); },this.timeoutMs);
    });
    try { result = await Promise.race([agent.generate({ prompt: JSON.stringify(clarificationModelContext(task)), abortSignal: signal, timeout: { totalMs: this.timeoutMs } }), timeout]); }
    catch (error) {
      if (fatalBudget) throw fatalBudget;
      if (signal.aborted) failBudget("TIME_BUDGET");
      if (completedSteps >= 6) failBudget("STEP_BUDGET");
      throw error;
    } finally { if (deadline !== undefined) clearTimeout(deadline); }
    if (fatalBudget) throw fatalBudget;
    let output;
    try {
      if(this.options.wireFormat === "result-v4") output = clarificationResultV4Schema.parse(result.output);
      else { const compiled=compileClarificationDraft(task,result.output); output=compiled.result; this.options.onEvent?.({type:"draft_compiled",draft:result.output,omittedBasisIds:compiled.omittedBasisIds,result:output}); }
    }
    catch (error) { if (result.steps.length >= 6) failBudget("STEP_BUDGET"); throw error; }
    validateClarificationSafety(task, output, buildClarificationCandidate(task, output));
    return output;
  }
}
function validateClarificationSafety(task: ClarificationTask, result: ClarificationResult, candidate: ClarificationTask["base"]) {
  const chunks = task.sources.flatMap(s => s.chunks);
  const quarantined = new Set(chunks.filter(c => isInstructionLikeSourceText(c.text)).map(c => c.id));
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (typeof row.chunkId === "string" && quarantined.has(row.chunkId)) throw new Error("Clarification basis referenced quarantined source content.");
    Object.values(row).forEach(visit);
  };
  visit(result);
  validateNoUntrustedInstructionEcho({ proposal: candidate, publicSummary: JSON.stringify(result), chunks });
}
export async function evaluateClarification(task: ClarificationTask, runner: ClarificationRunner) {
  const result = clarificationResultSchema.parse(await runner.run(task));
  const candidate = buildClarificationCandidate(task, result);
  validateClarificationSafety(task, result, candidate);
  return { result, candidate };
}

export function createModelClarificationRunner(config: { apiKey: string; model: string; baseURL?: string; fetch?: typeof fetch; onEvent?: (event: Record<string, unknown>) => void; maxOutputTokens?: number }) {
  const deepSeek = config.baseURL && new URL(config.baseURL).hostname === "api.deepseek.com";
  const transport = config.fetch ?? fetch;
  const providerFetch: typeof fetch = deepSeek ? async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.text?.format?.type === "json_schema") body.text.format.schema = deepSeekOutputSchema(body.text.format.schema);
    return transport(url, { ...init, body: JSON.stringify(body) });
  } : transport;
  return new ModelClarificationRunner(createOpenAI({apiKey:config.apiKey,baseURL:config.baseURL,fetch:providerFetch}).responses(config.model), 60000, { onEvent: config.onEvent, maxOutputTokens: config.maxOutputTokens ?? (deepSeek ? 8000 : undefined), secrets: [config.apiKey] });
}

export function clarificationModelContext(task: ClarificationTask) {
  return { outputLanguage,
    selectedTask: task.selection ? { ...task.selection, themeId: task.base.themes[task.selection.themeIndex]?.id } : undefined,
    base: activeUnderstanding(task.base), question: task.question, answer: task.answer, inputId: task.inputId,
    groundingPolicy: "Preserved source claims are historical source records; current applicability lives in summaryInterpretation.groundingV4 (or legacy grounding). Respect scope and attribution; user-edited grounding is unreviewed.",
    supersededHistory: task.base.themes.flatMap(theme => theme.claims.filter(c => c.supersededBy).map(claim => ({ themeId: theme.id, claim }))),
    reassessment: task.reassessment,
    referenceIndex: {
      disputedThemeIds: task.base.themes.filter(t=>t.claims.some(c=>c.evidenceState==="conflicting")).map(t=>t.id),
      materialClaimIdsByTheme: Object.fromEntries(task.base.themes.map(t=>[t.id,t.claims.filter(c=>c.evidence.length).map(c=>c.id)])),
      correctableUserClaimIdsByTheme: Object.fromEntries(task.base.themes.map(t=>[t.id,t.claims.filter(c=>c.evidenceState==="user_asserted"&&!c.supersededBy).map(c=>c.id)])),
    },
    sourceIndex: task.sources.map(s => ({ id: s.id, name: s.name, contentHash: s.contentHash, chunks: s.chunks.map(c => c.id) })) };
}
