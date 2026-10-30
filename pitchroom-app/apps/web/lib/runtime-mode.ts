import { parseRuntimeConfiguration, type RuntimeMode } from "@pitchroom/domain";
export { runtimeModeSchema, type RuntimeMode } from "@pitchroom/domain";

export function readRuntimeConfiguration() {
  return parseRuntimeConfiguration(process.env);
}

export function readRuntimeMode(): { success: true; data: RuntimeMode } | { success: false; fields: string[] } {
  const result = readRuntimeConfiguration();
  return result.success ? { success: true, data: result.config.runtime.mode } : result;
}

export function invalidRuntimeResponse(requestId = crypto.randomUUID()) {
  return Response.json({ code: "INVALID_CONFIGURATION", error: "Runtime configuration is missing or inconsistent. Check the server configuration.", requestId }, {
    status: 503,
    headers: { "cache-control": "no-store", "x-pitchroom-mode": "invalid", "x-request-id": requestId },
  });
}
