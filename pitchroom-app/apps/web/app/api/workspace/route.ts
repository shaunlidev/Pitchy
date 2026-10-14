import { NextResponse } from "next/server";
import { PitchroomError } from "@pitchroom/domain";
import { acceptFixture, addFixtureMaterial, answerFixtureQuestion, correctFixtureClaim, keepFixtureUnknown, readFixtureState, resetFixtureState, runFixtureAgent } from "../../../lib/fixture-store";
import { acceptPersistent, addPersistentMaterial, answerPersistentQuestion, correctPersistentClaim, keepPersistentUnknown, readPersistentState, runPersistentAgent } from "../../../lib/persistent-workspace";
import { errorEnvelopeSchema, workspaceCommandSchema, workspaceStateSchema } from "../../../lib/api-contract";
export const dynamic = "force-dynamic";
const runtime = () => process.env.PITCHROOM_RUNTIME ?? "fixture";
const persistentMode = () => runtime() === "live" ? "live" as const : "postgres-fake" as const;
const headers = (requestId: string) => ({ "cache-control": "no-store", "x-pitchroom-mode": runtime(), "x-request-id": requestId });
export async function GET() {
  const requestId = crypto.randomUUID();
  const state = runtime() === "fixture" ? readFixtureState() : await readPersistentState(persistentMode());
  return NextResponse.json(workspaceStateSchema.parse(state), { headers: headers(requestId) });
}
export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 1_100_000) throw new Error("Request body exceeds the local fixture limit.");
    const body = workspaceCommandSchema.parse(await request.json()); let state;
    const persistent = runtime() !== "fixture";
    const commandId = body.commandId ?? requestId;
    switch (body.action) {
      case "reset": if (persistent) throw new Error("Reset is disabled for persistent projects."); state = resetFixtureState(); break;
      case "add_material": state = persistent ? await addPersistentMaterial({ name: body.name, text: body.text, mediaType: body.mediaType, idempotencyKey: commandId }) : addFixtureMaterial({ name: body.name, text: body.text, mediaType: body.mediaType }); break;
      case "run": state = persistent ? await runPersistentAgent(commandId, persistentMode(), request.signal) : runFixtureAgent(); break;
      case "correct": state = persistent ? await correctPersistentClaim(body.text, body.expectedRevision, commandId) : correctFixtureClaim(body.text, body.expectedRevision); break;
      case "answer": state = persistent ? await answerPersistentQuestion(body.text, body.expectedRevision, commandId) : answerFixtureQuestion(body.text, body.expectedRevision); break;
      case "keep_unknown": state = persistent ? await keepPersistentUnknown(body.expectedRevision, commandId) : keepFixtureUnknown(body.expectedRevision); break;
      case "accept": state = persistent ? await acceptPersistent(body.expectedRevision, commandId) : acceptFixture(body.expectedRevision); break;
    }
    if (persistent && runtime() === "live") state = { ...state, mode: "live" as const };
    return NextResponse.json(workspaceStateSchema.parse(state), { headers: headers(requestId) });
  } catch (error) {
    const domainCode = error instanceof PitchroomError ? error.code : undefined;
    const code = domainCode ?? (error instanceof SyntaxError ? "INVALID_JSON" : "INVALID_REQUEST");
    const status = domainCode === "NOT_FOUND" ? 404 : domainCode === "CONFLICT" ? 409 : domainCode === "PERSISTENCE_ERROR" ? 500 : 400;
    const envelope = errorEnvelopeSchema.parse({ code, error: error instanceof Error ? error.message : "Unknown error", requestId, details: error instanceof PitchroomError ? error.details : undefined });
    return NextResponse.json(envelope, { status, headers: headers(requestId) });
  }
}
