import { deckProposalV2Schema } from "@pitchroom/domain";
import { expect, it } from "vitest";
import { httpFixture, reachDeck } from "./review-fixture";
import { installSyntheticProviderCollector, prepare, readWorkflowReviewContext } from "./workflow";
import { checkProviderCapture, compareAdoptedDeck, providerCaptureHeader } from "./checks";
import { hashTaskValue } from "./schema";
import { targetAt, type ProviderCapture, type ReviewRecord } from "./review";
import { userTaskVerdict } from "./verdict";
it.each([false, true])("requires runtime-owned provider interval and detects actual synthetic dispatch (call=%s)", async call => {
  const collector = installSyntheticProviderCollector();
  try {
    const f = await httpFixture(true, call ? () => collector.observeCall(`synthetic-${crypto.randomUUID()}`, async () => undefined) : undefined);
    const run = prepare(f.input), view = await reachDeck(run), context = readWorkflowReviewContext(run);
    const operation = context.operations.find(item => item.operation.command.action === "create_story_deck");
    if (!operation) throw new Error("Missing real Deck operation");
    const captured = context.collectorEnds.find(item => item.operationId === operation.operation.operationId);
    if (!captured) throw new Error("Missing runtime collector");
    const capture: ProviderCapture = { kind: "provider_capture", id: "capture", at: new Date().toISOString(), actorId: "synthetic-reviewer", authorityHash: hashTaskValue("synthetic-authority"),
      producer: "synthetic_test_collector_v1", sessionId: context.reference.sessionId, sourceHash: hashTaskValue(context.manifest.identity.source), runtimeHash: hashTaskValue(context.binding.instance), projectId: context.binding.projectId,
      commandId: operation.operation.operationId, fromCheckpoint: operation.operation.checkpointHash, toCheckpoint: operation.checkpointHash, startMarker: hashTaskValue(null), events: [], terminal: { count: 0, previous: hashTaskValue(null), hash: hashTaskValue(null) } };
    capture.startMarker = hashTaskValue(providerCaptureHeader(capture)); let previous = capture.startMarker;
    capture.events = captured.events.map((event, sequence) => { const body = { ...event, sequence, previous }; const hash = hashTaskValue(body); previous = hash; return { ...body, hash }; });
    capture.terminal = { count: capture.events.length, previous, hash: hashTaskValue({ count: capture.events.length, previous, startMarker: capture.startMarker }) };
    expect(checkProviderCapture(context, capture, operation).status).toBe(call ? "fail" : "pass");
    expect(checkProviderCapture({ ...context, collectorStarts: [], collectorEnds: [] }, capture, operation).status).toBe("incomplete");
    expect(checkProviderCapture(context, undefined, operation).status).toBe("incomplete");
    expect(checkProviderCapture({ ...context, manifest: { ...context.manifest, purpose: "task_evidence" } }, capture, operation).status).toBe("incomplete");
    expect(checkProviderCapture(context, { ...capture, terminal: { ...capture.terminal, count: capture.terminal.count + 1 } }, operation).status).toBe("incomplete");
    const adopted = view.workspace.story?.versions.find(item => item.id === view.workspace.story?.head.storyId);
    if (!adopted || !view.workspace.story || !view.workspace.deck) throw new Error("Missing saved outputs");
    const comparison = { story: adopted.story, storyId: adopted.id, generation: view.workspace.story.head.generation, deck: view.workspace.deck.proposal };
    expect(compareAdoptedDeck(comparison)).toEqual([]);
    if (!call) {
      const target = targetAt(context, view.checkpointHash), realContext = { ...context, manifest: { ...context.manifest, purpose: "task_evidence" as const } };
      const use: ReviewRecord = { kind: "review_use", id: "synthetic-observation", at: new Date().toISOString(), actorId: "synthetic-human-role", authorityHash: hashTaskValue("synthetic-authority"), binding: target.binding,
        scope: "assisted_self_test", observation: "Synthetic unit control; no actual real participant.", actualUse: true, evidenceKind: "real", outcome: "useful",
        understandsDirectionDifference: true, distinguishesPreviewAndApply: true, completedFeedbackAndApply: true,
        behaviorEvidence: [{ reference: "synthetic-behavior", contentHash: hashTaskValue("behavior") }], downstreamUse: [{ reference: "synthetic-use", contentHash: hashTaskValue("use") }] };
      expect(userTaskVerdict(context, [use], target).kind).toBe("awaiting_observation");
      expect(userTaskVerdict(realContext, [use], target).kind).toBe("pass");
      for (const change of [{ evidenceKind: "synthetic" as const }, { actualUse: false }, { understandsDirectionDifference: false }, { distinguishesPreviewAndApply: false }, { completedFeedbackAndApply: false }, { behaviorEvidence: [] }, { downstreamUse: [] }]) {
        expect(userTaskVerdict(realContext, [{ ...use, ...change }], target).kind).toBe("awaiting_observation");
      }
      expect(userTaskVerdict(realContext, [{ ...use, outcome: "not_useful" }], target).kind).toBe("fail");
      expect(userTaskVerdict(realContext, [{ ...use, binding: { ...use.binding, outputHash: hashTaskValue("stale") } }], target).kind).toBe("awaiting_observation");
    }
    const deck = deckProposalV2Schema.parse(view.workspace.deck.proposal);
    const pageMutants: [string, unknown][] = [
      ["id", "different-page"], ["storyBlockId", "different-block"], ["kind", deck.pages[0]?.kind === "promise" ? "situation" : "promise"],
      ["title", "Wrong attribution"], ["body", "Changed body"], ["emphasis", ["extra"]], ["basisRefs", ["extra"]], ["unknownIds", ["extra"]],
      ["wording", deck.pages[0]?.wording === "agent_proposed" ? "user_edited_unreviewed" : "agent_proposed"],
      ["evidence", [{ sourceId: "extra", chunkId: "extra", quote: "extra" }]], ["userInputIds", ["extra"]], ["openQuestions", ["extra"]], ["speakerNotes", "Lost conditions"],
    ];
    for (const [key, value] of pageMutants) {
      const mutated = structuredClone(deck); const page = mutated.pages[0]; if (!page) throw new Error("No page");
      Reflect.set(page, key, value);
      expect(compareAdoptedDeck({ ...comparison, deck: mutated }), key).not.toEqual([]);
    }
    for (const key of ["understandingVersionId", "positioningVersionId", "positioningDecisionId", "appliedDirectionId", "storyVersionId"]) {
      const mutated = structuredClone(deck); Reflect.set(mutated, key, "wrong-version");
      expect(compareAdoptedDeck({ ...comparison, deck: mutated }), key).not.toEqual([]);
    }
    expect(compareAdoptedDeck({ ...comparison, deck: { ...deck, storyGeneration: deck.storyGeneration + 1 } })).toContain("story.generation");
    expect(compareAdoptedDeck({ ...comparison, deck: { ...deck, pages: [...deck.pages].reverse() } })).not.toEqual([]);
    expect(compareAdoptedDeck({ ...comparison, deck: { ...deck, pages: [...deck.pages, deck.pages[0]] } })).toContain("pages.count");
    expect(() => compareAdoptedDeck({ ...comparison, deck: { ...deck, schemaVersion: 1 } })).toThrow();
  } finally { collector.dispose(); }
}, 30000);
