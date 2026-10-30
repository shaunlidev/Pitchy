import { evaluationInstance } from "../../../lib/evaluation-instance";
import { readRuntimeConfiguration } from "../../../lib/runtime-mode";
import { configurationSummary } from "@pitchroom/domain";
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
  const configured = readRuntimeConfiguration();
  if (!configured.success) return NextResponse.json({ status: "not_ready", runtime: "invalid", checks: { configuration: false, database: false, liveModel: false } }, { status: 503, headers: { "cache-control": "no-store" } });
  const { runtime, deployment } = configured.config;
  let databaseReady = runtime.mode === "fixture";
  if (runtime.mode !== "fixture") {
    try { databaseReady = await databaseProbe(runtime.databaseUrl); } catch { databaseReady = false; }
  }
  // A declared release/target and SELECT 1 do not establish applied schema or worker identity.
  const deploymentChecks = deployment.kind === "deployed" ? { targetIdentity: false, schema: false, worker: false, authorization: false } : {};
  const ready = databaseReady && deployment.kind === "local";
  return NextResponse.json(
    { status: ready ? "ready" : "not_ready", ...configurationSummary(configured.config), ...(deployment.kind === "deployed" ? { code: "DEPLOYMENT_READINESS_UNVERIFIED" } : {}), ...(instance.kind === "enabled" ? { evaluationInstance: instance.identity } : {}), checks: { configuration: true, database: databaseReady, liveModel: true, ...deploymentChecks } },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}

export async function GET() {
  return healthResponse();
}
