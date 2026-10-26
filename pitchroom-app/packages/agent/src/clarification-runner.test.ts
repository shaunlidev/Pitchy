import { describe,it,expect } from "vitest";
import { startClarificationAttempt,ownsClarificationAttempt,ingestMaterial,newClarification,buildClarificationCandidate } from "@pitchroom/domain";
import { buildDeterministicUnderstanding } from "./deterministic-runner";
import { clarificationModelContext,evaluateClarification,DeterministicClarificationRunner } from "./clarification-runner";
const source=ingestMaterial("project",{name:"brief.md",mediaType:"text/markdown",text:"Northwind sells consumer menu planning."});
const task=()=>newClarification({id:"task",inputId:"input",projectId:"project",commandId:"command",actorId:"user",versionId:"v1",revision:1,base:buildDeterministicUnderstanding({projectId:"project",chunks:source.chunks}).proposal,sources:[{...source,id:source.sourceId,projectId:"project"}],answer:"Procurement must approve a pilot."});
describe("bounded feedback proposals",()=>{
 it("keeps direct user words and interpretation distinguishable",async()=>{const t=task();const output=await evaluateClarification(t,new DeterministicClarificationRunner());expect(output.candidate.themes[0]!.summaryInterpretation!.inputIds).toEqual([t.inputId]);expect(output.candidate.themes[0]!.claims.at(-1)!.statement).toBe(t.answer);expect(output.candidate.themes[0]!.claims.at(-1)!.evidence).toEqual([]);});
 it("rejects nonexistent or repeated modification targets",()=>{expect(()=>buildClarificationCandidate(task(),{reason:"test",operations:[{type:"update_summary",themeId:"missing",text:"changed"}]})).toThrow(/Unknown/);const op={type:"add_answer",themeId:task().base.themes[0]!.id};expect(()=>buildClarificationCandidate(task(),{reason:"test",operations:[op,op]})).toThrow(/Duplicate/);});
 it("does not permit arbitrary replacement of claims or fabricated input ids",()=>{expect(()=>buildClarificationCandidate(task(),{reason:"test",operations:[{type:"replace_claim",statement:"invented",userInputIds:["fake"]}]})).toThrow();});
});

describe("durable attempt ownership",()=>{
 it("fences an old worker after lease recovery",()=>{const t=task();startClarificationAttempt(t,"fake",1000);const old=structuredClone(t);startClarificationAttempt(t,"fake",92000);expect(t.attempts).toHaveLength(2);expect(ownsClarificationAttempt(t,old)).toBe(false);expect(ownsClarificationAttempt(t,t)).toBe(true);});
 it("bounds automatic recovery and does not erase the original answer",()=>{const t=task();startClarificationAttempt(t,"fake",1000);startClarificationAttempt(t,"fake",92000);startClarificationAttempt(t,"fake",183000);expect(startClarificationAttempt(t,"fake",274000)).toBe(false);expect(t.status).toBe("failed");expect(t.attempts).toHaveLength(3);expect(t.answer).toBe("Procurement must approve a pilot.");});
 it("does not let a dismissed task be completed by an old worker",()=>{const t=task();startClarificationAttempt(t,"fake");const old=structuredClone(t);t.status="dismissed";expect(ownsClarificationAttempt(t,old)).toBe(false);});
});

function selectedTask() {
 const old = task();
 const base = structuredClone(old.base);
 base.themes.push({ id: "measurement", title: "Measurement", summary: "The baseline and measurement period remain unknown.", claims: [{ id: "unknown-baseline", statement: "The baseline is unknown.", evidenceState: "unknown", evidence: [], userInputIds: [] }] });
 const question = { question: "How will the reported target be measured?", whyItMatters: "An actual comparison needs a baseline and period.", relatedThemeIndexes: [1] };
 base.topicTasks = [{ id: "measurement-task", themeIndex: 1, question }];
 return newClarification({ id: "selected", inputId: "selected-input", projectId: old.projectId, commandId: "selected-command", actorId: "user", versionId: "v1", revision: 1, base, sources: old.sources, answer: "The measurement period is one month; the baseline is still unknown.", selection: { understandingId: "v1", taskId: "measurement-task", themeIndex: 1 } });
}

describe("selected topic worker ownership", () => {
 it("targets the selected nonzero theme through proposal and explicit Apply without losing sources or unknowns", async () => {
  const t = selectedTask(); const before = structuredClone(t.base);
  const output = await evaluateClarification(t, new DeterministicClarificationRunner());
  expect(t.base).toEqual(before);
  expect(output.result.operations.some(op => op.type === "next_question")).toBe(false);
  for (const op of output.result.operations) {
   if ("themeId" in op) expect(op.themeId).toBe("measurement");
   if (op.type === "next_question" && "relatedThemeIds" in op) expect(op.relatedThemeIds).toEqual(["measurement"]);
  }
  const applied = buildClarificationCandidate({ ...t, result: output.result }, output.result);
  expect(applied.themes[0]).toEqual(before.themes[0]);
  expect(applied.themes[1]!.claims[0]).toEqual(before.themes[1]!.claims[0]);
  expect(applied.themes[1]!.summary).toContain(before.themes[1]!.summary);
  expect(applied.themes[1]!.claims.at(-1)?.statement).toBe(t.answer);
  expect(applied.themes[1]!.claims.at(-1)?.userInputIds).toEqual([t.inputId]);
 });
 it("passes explicit task and theme identity to the model context without calling a provider", () => {
  const t = selectedTask(); const context = clarificationModelContext(t);
  expect(context.selectedTask).toEqual({ ...t.selection, themeId: "measurement" });
  expect(context.question).toEqual(t.question);
  expect(context.answer).toBe(t.answer);
 });
 it("leaves a declined selected issue unknown without changing the base or adding an answer claim", async () => {
  const t = selectedTask(); t.answer = "Not sure";
  const before = structuredClone(t.base);
  const output = await evaluateClarification(t, new DeterministicClarificationRunner());
  expect(output.result.operations).toEqual([]);
  expect(output.candidate.themes).toEqual(before.themes);
  expect(t.base).toEqual(before);
 });
 it("keeps a legacy question associated with its actual nonzero theme", async () => {
  const t = selectedTask(); delete t.selection; delete t.base.topicTasks;
  t.base.nextQuestion = t.question;
  const output = await evaluateClarification(t, new DeterministicClarificationRunner());
  expect(output.candidate.themes[0]).toEqual(t.base.themes[0]);
  expect(output.candidate.themes[1]!.claims.at(-1)?.statement).toBe(t.answer);
 });
});
