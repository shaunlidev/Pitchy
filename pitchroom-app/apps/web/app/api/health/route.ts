import { evaluationInstance } from "../../../lib/evaluation-instance";
import { readRuntimeConfiguration } from "../../../lib/runtime-mode";
import { configurationSummary } from "@pitchroom/domain";
import { NextResponse } from "next/server";
import { createDatabase, probeDeployment } from "@pitchroom/persistence";

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

export async function healthResponse(databaseProbe: (url: string) => Promise<boolean> = probeDatabase, deploymentProbe: typeof probeDeployment = probeDeployment) {
  const instance = evaluationInstance();
  if (instance.kind === "invalid") return NextResponse.json({ status: "not_ready", code: "INVALID_EVALUATION_INSTANCE" }, { status: 503 });
  const configured = readRuntimeConfiguration();
  if (!configured.success) return NextResponse.json({ status: "not_ready", runtime: "invalid", checks: { configuration: false, database: false, liveModel: false } }, { status: 503, headers: { "cache-control": "no-store" } });
  const { runtime, deployment } = configured.config;
  if (deployment.kind === "deployed") {
    let checks;
    try { checks = await deploymentProbe(configured.config); }
    catch { checks = { database: false, targetIdentity: false, schema: false, worker: false, authorization: false, failures: ["DATABASE_OBSERVATION_UNAVAILABLE"] }; }
    return NextResponse.json({ status: "not_ready", ...configurationSummary(configured.config), code: "DEPLOYMENT_READINESS_UNVERIFIED",
      checks: { configuration: true, liveModel: true, ...checks } }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  let databaseReady = runtime.mode === "fixture";
  if (runtime.mode !== "fixture") {
    try { databaseReady = await databaseProbe(runtime.databaseUrl); } catch { databaseReady = false; }
  }
  const ready = databaseReady;
  return NextResponse.json(
    { status: ready ? "ready" : "not_ready", ...configurationSummary(configured.config), ...(instance.kind === "enabled" ? { evaluationInstance: instance.identity } : {}),
      ...(instance.kind === "budgeted_live" ? { evaluationBudgetInstance: instance.identity } : {}),
      checks: { configuration: true, database: databaseReady, liveModel: true } },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}

export async function GET() {
  return healthResponse();
}
