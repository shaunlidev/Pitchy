import { evaluationInstance } from "./evaluation-instance";
import { readRuntimeMode, invalidRuntimeResponse, type RuntimeMode } from "./runtime-mode";
import { errorEnvelopeSchema, workspaceStateSchema } from "./api-contract";
import { NextResponse } from "next/server";
import { createDatabase } from "@pitchroom/persistence";

async function probeDatabase(url: string) {
  const database = createDatabase(url);
  try {
    await database.client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await database.client.end({ timeout: 1 });
  }
}

export async function healthResponse(databaseProbe: (url: string) => Promise<boolean> = probeDatabase) {
  const instance = evaluationInstance();
  if (instance.kind === "invalid") return NextResponse.json({ status: "not_ready", code: "INVALID_EVALUATION_INSTANCE" }, { status: 503 });
  const configured = readRuntimeMode();
  if (!configured.success) return NextResponse.json({ status: "not_ready", runtime: "invalid", checks: { configuration: false, database: false, liveModel: false } }, { status: 503, headers: { "cache-control": "no-store" } });
  const runtime = configured.data;
  const configurationReady = runtime === "fixture" || Boolean(process.env.DATABASE_URL);
  const databaseReady = runtime === "fixture" || (configurationReady && await databaseProbe(process.env.DATABASE_URL!));
  const liveModelReady = runtime !== "live" || Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL && process.env.PITCHROOM_LIVE_TRANSFER_ACK === "authorized");
  const ready = configurationReady && databaseReady && liveModelReady;
  return NextResponse.json(
    { status: ready ? "ready" : "not_ready", runtime, ...(instance.kind === "enabled" ? { evaluationInstance: instance.identity } : {}),
      ...(instance.kind === "budgeted_live" ? { evaluationBudgetInstance: instance.identity } : {}),
      checks: { configuration: configurationReady, database: databaseReady, liveModel: liveModelReady } },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}

const headers = (requestId: string, runtime: RuntimeMode) => ({ "cache-control": "no-store", "x-pitchroom-mode": runtime, "x-request-id": requestId });
export async function workspaceResponse(readState: (runtime: RuntimeMode) => unknown | Promise<unknown>) {
  const requestId = crypto.randomUUID();
  const configured = readRuntimeMode();
  if (!configured.success) return invalidRuntimeResponse(requestId);
  const runtime = configured.data;
  try {
    const state = await readState(runtime);
    return NextResponse.json(workspaceStateSchema.parse(state), { headers: headers(requestId, runtime) });
  } catch {
    const envelope = errorEnvelopeSchema.parse({ code: "PERSISTENCE_ERROR", error: "Workspace storage is temporarily unavailable. Retry in a moment.", requestId });
    return NextResponse.json(envelope, { status: 503, headers: headers(requestId, runtime) });
  }
}
