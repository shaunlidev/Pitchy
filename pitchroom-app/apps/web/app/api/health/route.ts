import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  const runtime = process.env.PITCHROOM_RUNTIME ?? "fixture";
  const configurationReady = runtime === "fixture" || Boolean(process.env.DATABASE_URL);
  const liveModelReady = runtime !== "live" || Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL && process.env.PITCHROOM_LIVE_TRANSFER_ACK === "authorized");
  const ready = configurationReady && liveModelReady;
  return NextResponse.json(
    { status: ready ? "ready" : "not_ready", runtime, checks: { configuration: configurationReady, liveModel: liveModelReady } },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
