import { readRuntimeMode, invalidRuntimeResponse, type RuntimeMode } from "../../../lib/runtime-mode";
import { NextResponse } from "next/server";
import { PitchroomError } from "@pitchroom/domain";
import { proposeFixtureStory, decideFixtureStory, undoFixtureStory, createFixtureStoryDeck, submitFixtureClarification, decideFixtureClarification, acceptFixture, addFixtureMaterial, adjustFixturePositioning, answerFixtureQuestion, applyFixturePositioning, correctFixtureClaim, editFixtureDeckPage, generateFixtureDeck, generateFixturePositioning, keepFixtureUnknown, readFixtureState, removeFixtureMaterial, resetFixtureState, runFixtureAgent, undoFixturePositioning } from "../../../lib/fixture-store";
import { proposePersistentStory, decidePersistentStory, undoPersistentStory, createPersistentStoryDeck, submitPersistentClarification, decidePersistentClarification, acceptPersistent, addPersistentMaterial, adjustPersistentPositioning, answerPersistentQuestion, applyPersistentPositioning, correctPersistentClaim, editPersistentDeckPage, generatePersistentDeck, generatePersistentPositioning, keepPersistentUnknown, readPersistentState, removePersistentMaterial, runPersistentAgent, undoPersistentPositioning } from "../../../lib/persistent-workspace";
import { errorEnvelopeSchema, workspaceCommandSchema, workspaceStateSchema } from "../../../lib/api-contract";
export const dynamic = "force-dynamic";
const headers = (requestId: string, runtime: RuntimeMode) => ({ "cache-control": "no-store", "x-pitchroom-mode": runtime, "x-request-id": requestId });
export async function workspaceResponse(readState?: () => unknown | Promise<unknown>) {
  const requestId = crypto.randomUUID();
  const configured = readRuntimeMode();
  if (!configured.success) return invalidRuntimeResponse(requestId);
  const runtime = configured.data;
  try {
    const state = await (readState ? readState() : runtime === "fixture" ? readFixtureState() : readPersistentState(runtime === "live" ? "live" : "postgres-fake"));
    return NextResponse.json(workspaceStateSchema.parse(state), { headers: headers(requestId, runtime) });
  } catch {
    const envelope = errorEnvelopeSchema.parse({ code: "PERSISTENCE_ERROR", error: "Workspace storage is temporarily unavailable. Retry in a moment.", requestId });
    return NextResponse.json(envelope, { status: 503, headers: headers(requestId, runtime) });
  }
}
export async function GET() {
  return workspaceResponse();
}
export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const configured = readRuntimeMode();
  if (!configured.success) return invalidRuntimeResponse(requestId);
  const runtime = configured.data;
  const persistentMode = runtime === "live" ? "live" as const : "postgres-fake" as const;
  try {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 1_100_000) throw new Error("Request body exceeds the local fixture limit.");
    const body = workspaceCommandSchema.parse(await request.json()); let state;
    const persistent = runtime !== "fixture";
    const commandId = body.commandId ?? requestId;
    switch (body.action) {
      case "propose_story": state = persistent ? await proposePersistentStory(body,persistentMode) : await proposeFixtureStory(body); break;
      case "decide_story": state = persistent ? await decidePersistentStory(body,persistentMode) : decideFixtureStory(body); break;
      case "undo_story": state = persistent ? await undoPersistentStory(body,persistentMode) : undoFixtureStory(body); break;
      case "create_story_deck": state = persistent ? await createPersistentStoryDeck(body,persistentMode) : createFixtureStoryDeck(body); break;
      case "submit_clarification": state = persistent ? await submitPersistentClarification({ ...body, commandId }) : submitFixtureClarification({ ...body, commandId }); break;
      case "apply_clarification":
      case "dismiss_clarification":
      case "retry_clarification": {
        const action = body.action === "apply_clarification" ? "apply" as const : body.action === "dismiss_clarification" ? "dismiss" as const : "retry" as const;
        const decision = { taskId: body.taskId, action, commandId, result: body.action === "apply_clarification" ? body.result : undefined };
        state = persistent ? await decidePersistentClarification(decision) : decideFixtureClarification(decision); break;
      }
      case "reset": if (persistent) throw new Error("Reset is disabled for persistent projects."); state = resetFixtureState(); break;
      case "add_material": state = persistent ? await addPersistentMaterial({ name: body.name, text: body.text, mediaType: body.mediaType, idempotencyKey: commandId }) : addFixtureMaterial({ name: body.name, text: body.text, mediaType: body.mediaType }); break;
      case "remove_material": state = persistent ? await removePersistentMaterial(body.sourceId) : removeFixtureMaterial(body.sourceId); break;
      case "run": state = persistent ? await runPersistentAgent(commandId, persistentMode, request.signal) : runFixtureAgent(); break;
      case "correct": state = persistent ? await correctPersistentClaim(body.text, body.themeIndex, body.claimIndex, body.expectedRevision, commandId) : correctFixtureClaim(body.text, body.themeIndex, body.claimIndex, body.expectedRevision); break;
      case "answer": state = persistent ? await answerPersistentQuestion(body.text, body.expectedRevision, commandId) : answerFixtureQuestion(body.text, body.expectedRevision); break;
      case "keep_unknown": state = persistent ? await keepPersistentUnknown(body.expectedRevision, commandId) : keepFixtureUnknown(body.expectedRevision); break;
      case "accept": state = persistent ? await acceptPersistent(body.expectedRevision, commandId) : acceptFixture(body.expectedRevision); break;
      case "generate_positioning": state = persistent ? await generatePersistentPositioning(body.expectedRevision, commandId, persistentMode) : generateFixturePositioning(body.expectedRevision); break;
      case "apply_positioning": state = persistent ? await applyPersistentPositioning(body.directionId, body.expectedRevision, commandId) : applyFixturePositioning(body.directionId, body.expectedRevision); break;
      case "undo_positioning": state = persistent ? await undoPersistentPositioning(body.expectedRevision, commandId) : undoFixturePositioning(body.expectedRevision); break;
      case "adjust_positioning": state = persistent ? await adjustPersistentPositioning(body.directionId, body.mode, body.text, body.expectedRevision, commandId) : adjustFixturePositioning(body.directionId, body.mode, body.text, body.expectedRevision); break;
      case "generate_deck": state = persistent ? await generatePersistentDeck(body.expectedRevision, commandId, persistentMode) : generateFixtureDeck(body.expectedRevision); break;
      case "edit_deck_page": state = persistent ? await editPersistentDeckPage(body.deckId, body.expectedDeckVersion, body.pageId, body.title, body.body, commandId) : editFixtureDeckPage(body.deckId, body.expectedDeckVersion, body.pageId, body.title, body.body); break;
    }
    if (persistent && runtime === "live") state = { ...state, mode: "live" as const };
    return NextResponse.json(workspaceStateSchema.parse(state), { status: body.action === "submit_clarification" ? 202 : 200, headers: headers(requestId, runtime) });
  } catch (error) {
    const domainCode = error instanceof PitchroomError ? error.code : undefined;
    const code = domainCode ?? (error instanceof SyntaxError ? "INVALID_JSON" : "INVALID_REQUEST");
    const status = domainCode === "NOT_FOUND" ? 404 : domainCode === "CONFLICT" ? 409 : domainCode === "PROVIDER_TIMEOUT" ? 504 : domainCode === "PERSISTENCE_ERROR" ? 500 : 400;
    const envelope = errorEnvelopeSchema.parse({ code, error: error instanceof Error ? error.message : "Unknown error", requestId, details: error instanceof PitchroomError ? error.details : undefined });
    return NextResponse.json(envelope, { status, headers: headers(requestId, runtime) });
  }
}
