import { evaluationInstance } from "../../../lib/evaluation-instance";
import { readRuntimeMode } from "../../../lib/runtime-mode";
import { NextResponse } from "next/server";
import { createDatabase } from "@pitchroom/persistence";

export const dynamic = "force-dynamic";

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
    { status: ready ? "ready" : "not_ready", runtime, ...(instance.kind === "enabled" ? { evaluationInstance: instance.identity } : {}), checks: { configuration: configurationReady, database: databaseReady, liveModel: liveModelReady } },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}

export async function GET() {
  return healthResponse();
}
