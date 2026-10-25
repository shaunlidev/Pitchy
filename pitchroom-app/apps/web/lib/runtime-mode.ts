import { z } from "zod";

export const runtimeModeSchema = z.enum(["fixture", "postgres-fake", "live"]).default("fixture");
export type RuntimeMode = z.infer<typeof runtimeModeSchema>;

export function readRuntimeMode() {
  return runtimeModeSchema.safeParse(process.env.PITCHROOM_RUNTIME);
}

export function invalidRuntimeResponse(requestId = crypto.randomUUID()) {
  return Response.json({ code: "INVALID_CONFIGURATION", error: "PITCHROOM_RUNTIME must be fixture, postgres-fake or live.", requestId }, {
    status: 503,
    headers: { "cache-control": "no-store", "x-pitchroom-mode": "invalid", "x-request-id": requestId },
  });
}
