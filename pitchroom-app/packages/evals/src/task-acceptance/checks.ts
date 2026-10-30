import { z } from "zod";
import { deckProposalV2Schema, storySchema } from "@pitchroom/domain";
import { hashTaskValue } from "./schema";
import type { WorkflowReviewContext } from "./workflow";
import type { ProviderCapture, ReviewRecord } from "./review";

export type EngineeringCheck = { id: string; status: "pass" | "fail" | "incomplete"; reason: string; evidence: string[] };
const equal = (a: unknown, b: unknown) => hashTaskValue(a) === hashTaskValue(b);
/** Independent comparison: this module deliberately does not import the production converter. */
export function compareAdoptedDeck(raw: { story: unknown; storyId: string; generation: number; deck: unknown }) {
  const story = storySchema.parse(raw.story), deck = deckProposalV2Schema.parse(raw.deck), failures: string[] = [];
  const check = (id: string, expected: unknown, actual: unknown) => { if (!equal(expected, actual)) failures.push(id); };
  check("upstream.understanding", story.origin.understandingVersionId, deck.understandingVersionId);
  check("upstream.positioning", story.origin.positioningVersionId, deck.positioningVersionId);
  check("upstream.decision", story.origin.positioningDecisionId ?? null, deck.positioningDecisionId ?? null);
  check("upstream.direction", story.origin.directionId, deck.appliedDirectionId);
  check("story.version", raw.storyId, deck.storyVersionId); check("story.generation", raw.generation, deck.storyGeneration);
  check("pages.count", story.blocks.length, deck.pages.length);
  for (const [index, block] of story.blocks.entries()) {
    const page = deck.pages[index]; if (!page) { failures.push(`pages.${index}.missing`); continue; }
    const prefix = `pages.${index}`;
    check(`${prefix}.id`, `page-${block.id}`, page.id); check(`${prefix}.block`, block.id, page.storyBlockId); check(`${prefix}.role`, block.role, page.kind);
    for (const key of ["title", "body", "emphasis", "basisRefs", "unknownIds", "wording"] satisfies (keyof typeof block)[]) check(`${prefix}.${key}`, block[key], page[key]);
    const excerpts = story.bases.filter(basis => basis.kind === "source_excerpt" && block.basisRefs.includes(basis.id));
    const evidence = excerpts.flatMap(basis => basis.kind === "source_excerpt" ? [{ sourceId: basis.sourceId, chunkId: basis.chunkId, quote: basis.quote }] : []);
    check(`${prefix}.evidence`, evidence, page.evidence);
    check(`${prefix}.userInputIds`, story.bases.flatMap(basis => basis.kind === "consultant_judgment" && block.basisRefs.includes(basis.id) ? [basis.userInputId] : []), page.userInputIds);
    check(`${prefix}.openQuestions`, story.unknowns.filter(unknown => block.unknownIds.includes(unknown.id)).map(unknown => unknown.text), page.openQuestions);
    check(`${prefix}.speakerNotes`, [story.strategicRationale.choice, story.strategicRationale.tradeoff, story.strategicRationale.conditionsToReconsider.join("\n")].join("\n"), page.speakerNotes ?? null);
  }
  return failures;
}
export function providerCaptureHeader(capture: ProviderCapture) {
  return { producer: capture.producer, sessionId: capture.sessionId, sourceHash: capture.sourceHash, runtimeHash: capture.runtimeHash, projectId: capture.projectId,
    commandId: capture.commandId, fromCheckpoint: capture.fromCheckpoint, toCheckpoint: capture.toCheckpoint };
}
export function checkProviderCapture(context: WorkflowReviewContext, capture: ProviderCapture | undefined, operation: WorkflowReviewContext["operations"][number]): EngineeringCheck {
  const id = `provider:${operation.operation.operationId}`, evidence = [operation.operation.checkpointHash, operation.checkpointHash];
  const missing = (reason: string): EngineeringCheck => ({ id, status: "incomplete", reason, evidence });
  if (!capture) return missing("Provider capture missing; unknown usage is not zero calls.");
  if (context.manifest.purpose !== "tool_validation" || capture.producer !== "synthetic_test_collector_v1") return missing("No trusted real-run provider collector is registered.");
  if (capture.sessionId !== context.reference.sessionId || capture.sourceHash !== hashTaskValue(context.manifest.identity.source) || capture.runtimeHash !== hashTaskValue(context.binding.instance) || capture.projectId !== context.binding.projectId
    || capture.commandId !== operation.operation.command.commandId || capture.fromCheckpoint !== operation.operation.checkpointHash || capture.toCheckpoint !== operation.checkpointHash) return missing("Provider capture provenance/interval mismatch.");
  const runtimeStart = context.collectorStarts.find(item => item.operationId === operation.operation.operationId);
  const runtimeEnd = context.collectorEnds.find(item => item.operationId === operation.operation.operationId);
  if (!runtimeStart || !runtimeEnd || runtimeStart.collectorId !== runtimeEnd.collectorId || runtimeEnd.checkpointHash !== capture.toCheckpoint
    || !equal(runtimeEnd.events, capture.events.map(event => ({ callId: event.callId, kind: event.kind })))) return missing("No complete runtime-owned collector interval matches this capture.");
  const start = hashTaskValue(providerCaptureHeader(capture)); if (start !== capture.startMarker) return missing("Provider capture start marker invalid.");
  let previous = start; const open = new Set<string>(), seen = new Set<string>();
  for (const [index, event] of capture.events.entries()) {
    const { hash, ...body } = event;
    if (event.sequence !== index || event.previous !== previous || hashTaskValue(body) !== hash) return missing("Provider capture event gap or changed hash.");
    if (event.kind === "call_started") { if (seen.has(event.callId)) return missing("Duplicate provider call."); open.add(event.callId); seen.add(event.callId); }
    else if (!open.delete(event.callId)) return missing("Provider outcome without call start.");
    previous = event.hash;
  }
  const terminal = { count: capture.events.length, previous };
  if (open.size || capture.terminal.count !== terminal.count || capture.terminal.previous !== previous || capture.terminal.hash !== hashTaskValue({ ...terminal, startMarker: start })) return missing("Provider capture terminal coverage incomplete.");
  return { id, status: seen.size ? "fail" : "pass", reason: seen.size ? "Provider calls observed during deterministic Deck creation." : "Complete synthetic collector interval contains no calls; not real-model evidence.", evidence: [...evidence, hashTaskValue(capture)] };
}

/** Requires the workflow's replay-verified projection; never accepts caller-written PASS receipts. */
export function engineeringChecks(context: WorkflowReviewContext, records: ReviewRecord[]): EngineeringCheck[] {
  const checks: EngineeringCheck[] = [];
  const add = (id: string, valid: boolean, reason: string, evidence: string[]) => checks.push({ id, status: valid ? "pass" : "fail", reason, evidence });
  for (const completed of context.operations) {
    const { operation, checkpointHash } = completed;
    const before = context.snapshots.find(item => item.checkpointHash === operation.checkpointHash)?.workspace;
    const after = context.snapshots.find(item => item.checkpointHash === checkpointHash)?.workspace;
    if (!before || !after) throw new Error("CHECK_OPERATION_SNAPSHOT_MISSING");
    const evidence = [operation.checkpointHash, checkpointHash], command = operation.command;
    const human = operation.decisionId ? context.decisions.find(item => item.decisionId === operation.decisionId) : undefined;
    if (["accept", "apply_clarification", "apply_positioning", "decide_story", "undo_story", "edit_deck_page"].includes(command.action)) add(`choice:${operation.operationId}`, Boolean(human && context.resolvedDecisionIds.includes(human.decisionId)), "Product adoption/mutation requires its exact resolved human decision.", evidence);
    if (command.action === "propose_story" || command.action === "generate_positioning" || command.action === "submit_clarification") {
      add(`preview:${operation.operationId}`, equal(before.story?.head ?? null, after.story?.head ?? null) && equal(before.deck ?? null, after.deck ?? null), "Generating a candidate does not adopt a Story or replace a Deck.", evidence);
    }
    if (command.action === "decide_story" && command.decision === "keep_current") add(`keep:${operation.operationId}`, equal(before.story?.head ?? null, after.story?.head ?? null) && equal(before.deck ?? null, after.deck ?? null), "Keep preserves adopted content.", evidence);
    if (command.action === "submit_clarification" && human?.response.kind === "answer_clarification") add(`words:${operation.operationId}`, command.text === human.response.originalWords, "Original clarification answer is unchanged.", evidence);
    if (command.action === "propose_story" && human?.response.kind === "feedback") add(`words:${operation.operationId}`, command.request.kind === "revise_story" && command.request.judgment === human.response.originalWords, "Only original feedback, not private expectations, reaches revision.", evidence);
    if (command.action === "create_story_deck") {
      const adopted = before.story?.versions.find(item => item.id === before.story?.head.storyId);
      if (!adopted || !before.story || !after.deck || after.deck.proposal.schemaVersion !== 2) add(`deck:${operation.operationId}`, false, "A fresh adopted Story and V2 Deck are required.", evidence);
      else {
        const mismatches = compareAdoptedDeck({ story: adopted.story, storyId: adopted.id, generation: before.story.head.generation, deck: after.deck.proposal });
        add(`deck:${operation.operationId}`, !mismatches.length, mismatches.length ? mismatches.join(",") : "Every saved Deck field independently matches the adopted Story.", evidence);
        const understanding = before.versions.find(item => item.id === adopted.story.origin.understandingVersionId);
        add(`unknowns:${operation.operationId}`, Boolean(understanding && understanding.proposal.gaps.every(gap => adopted.story.unknowns.some(item => item.text === gap.description))), "Understanding unknowns remain present in the adopted Story.", evidence);
        add(`sources:${operation.operationId}`, adopted.story.bases.every(basis => basis.kind !== "source_excerpt" || before.sources.some(source => source.sourceId === basis.sourceId && source.chunks.some(chunk => chunk.id === basis.chunkId && chunk.text.includes(basis.quote)))), "Source excerpt identities and original quotations resolve in the actual adopted source set.", evidence);
      }
      const captures = records.filter(item => item.kind === "provider_capture" && item.commandId === command.commandId);
      if (captures.length > 1) checks.push({ id: `provider:${operation.operationId}`, status: "incomplete", reason: "Multiple captures require explicit reconciliation.", evidence });
      else checks.push(checkProviderCapture(context, captures[0]?.kind === "provider_capture" ? captures[0] : undefined, completed));
    }
  }
  for (const action of ["accept", "apply_positioning", "decide_story", "create_story_deck"]) if (!context.operations.some(item => item.operation.command.action === action)) checks.push({ id: `required:${action}`, status: "incomplete", reason: "Required stage/adoption not observed.", evidence: [] });
  return checks;
}
