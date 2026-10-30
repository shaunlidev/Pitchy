import { z } from "zod";

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
export const runtimeModeSchema = z.enum(["fixture", "postgres-fake", "live"]);
export type RuntimeMode = z.infer<typeof runtimeModeSchema>;

const nonblank = z.string().min(1).refine((value) => value === value.trim());
const identifier = nonblank.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/).max(128);
const providerSchema = z.enum(["openai", "deepseek"]);
const runtimeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("fixture") }),
  z.object({ mode: z.literal("postgres-fake"), databaseUrl: nonblank }),
  z.object({
    mode: z.literal("live"), databaseUrl: nonblank,
    provider: providerSchema, apiKey: nonblank, model: identifier, baseURL: nonblank,
  }),
]);
const deploymentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), environment: z.literal("local") }),
  z.object({
    kind: z.literal("deployed"), environment: z.enum(["staging", "trial", "production"]),
    releaseSha: z.string().regex(/^[a-f0-9]{40}$/), schemaVersion: identifier,
    databaseTarget: nonblank, transferApprovalId: identifier, budgetId: identifier,
    environmentId: z.string().uuid(), databaseRole: identifier,
    targetReceiptSha: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);
export type RuntimeConfiguration = {
  deployment: z.infer<typeof deploymentSchema>;
  runtime: z.infer<typeof runtimeSchema>;
};
type ConfigurationResult =
  | { success: true; config: RuntimeConfiguration }
  | { success: false; fields: string[] };

function databaseTarget(value: string, deployed: boolean): string | undefined {
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2 || url.hash) return;
    const databasePath = decodeURIComponent(url.pathname);
    if (deployed) {
      // Keep the raw URL unambiguous for the installed driver's independent parser.
      if (url.href !== value || !url.port || !/^[a-zA-Z0-9.-]+$/.test(url.hostname) || databasePath !== url.pathname || databasePath.slice(1).includes("/")) return;
      const allowedParameters = new Set(["sslmode", "channel_binding", "application_name"]);
      const parameters = [...url.searchParams.keys()];
      if (!url.username || !url.password || parameters.some((key) => !allowedParameters.has(key)) || new Set(parameters).size !== parameters.length) return;
      if (url.searchParams.get("sslmode") !== "verify-full") return;
    }
    return `${url.hostname}:${url.port || "5432"}${databasePath}`;
  } catch { return; }
}

function validProviderEndpoint(value: string, provider: z.infer<typeof providerSchema>, deployed: boolean): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (!deployed) {
      if (url.hostname === "api.openai.com" && provider !== "openai") return false;
      if (url.hostname === "api.deepseek.com" && provider !== "deepseek") return false;
      return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    }
    const endpoints = provider === "openai" ? ["https://api.openai.com/v1"] : ["https://api.deepseek.com", "https://api.deepseek.com/v1"];
    return endpoints.includes(url.href.replace(/\/+$/, ""));
  } catch { return false; }
}

export function parseRuntimeConfiguration(
  environment: RuntimeEnvironment,
  options: { component: "web" | "worker"; liveFlag?: boolean } = { component: "web" },
): ConfigurationResult {
  const refuse = (...fields: string[]): ConfigurationResult => ({ success: false, fields });
  if (environment.NODE_ENV !== undefined && !["development", "test", "production"].includes(environment.NODE_ENV)) return refuse("NODE_ENV");
  const selectedEnvironment = environment.PITCHROOM_DEPLOYMENT_ENV ?? (environment.NODE_ENV === "production" ? undefined : "local");
  if (!selectedEnvironment || !["local", "staging", "trial", "production"].includes(selectedEnvironment)) return refuse("PITCHROOM_DEPLOYMENT_ENV");
  const deployed = selectedEnvironment !== "local";
  if (deployed && environment.NODE_TLS_REJECT_UNAUTHORIZED !== undefined && environment.NODE_TLS_REJECT_UNAUTHORIZED !== "1") return refuse("NODE_TLS_REJECT_UNAUTHORIZED");
  const deployment = deploymentSchema.safeParse(deployed ? {
    kind: "deployed", environment: selectedEnvironment,
    releaseSha: environment.PITCHROOM_RELEASE_SHA, schemaVersion: environment.PITCHROOM_SCHEMA_VERSION,
    databaseTarget: environment.PITCHROOM_DATABASE_TARGET,
    environmentId: environment.PITCHROOM_ENVIRONMENT_ID, databaseRole: environment.PITCHROOM_DATABASE_ROLE,
    targetReceiptSha: environment.PITCHROOM_TARGET_RECEIPT_SHA,
    transferApprovalId: environment.PITCHROOM_TRANSFER_APPROVAL_ID, budgetId: environment.PITCHROOM_BUDGET_ID,
  } : { kind: "local", environment: "local" });
  if (!deployment.success) return refuse(...deployment.error.issues.map((issue) => `deployment.${issue.path.join(".")}`));
  const localDefault = options.component === "worker" ? (options.liveFlag ? "live" : "postgres-fake") : "fixture";
  const explicitRuntimeRequired = deployed || environment.NODE_ENV === "production";
  const mode = runtimeModeSchema.safeParse(environment.PITCHROOM_RUNTIME ?? (explicitRuntimeRequired ? undefined : localDefault));
  if (!mode.success || (deployed && mode.data !== "live") || (options.component === "worker" && mode.data === "fixture") || (options.liveFlag && mode.data !== "live")) return refuse("PITCHROOM_RUNTIME");
  let inferredProvider = "openai";
  try { if (environment.OPENAI_BASE_URL && new URL(environment.OPENAI_BASE_URL).hostname === "api.deepseek.com") inferredProvider = "deepseek"; } catch { /* Endpoint validation below refuses malformed URLs. */ }
  const runtime = runtimeSchema.safeParse({
    mode: mode.data, databaseUrl: environment.DATABASE_URL,
    provider: environment.PITCHROOM_PROVIDER ?? (deployed ? undefined : inferredProvider),
    apiKey: environment.OPENAI_API_KEY, model: environment.OPENAI_MODEL,
    baseURL: environment.OPENAI_BASE_URL ?? (deployed ? undefined : "https://api.openai.com/v1"),
  });
  if (!runtime.success) return refuse(...runtime.error.issues.map((issue) => `runtime.${issue.path.join(".")}`));
  if (runtime.data.mode !== "fixture") {
    const target = databaseTarget(runtime.data.databaseUrl, deployed);
    if (!target) return refuse("DATABASE_URL");
    if (deployment.data.kind === "deployed" && target !== deployment.data.databaseTarget) return refuse("PITCHROOM_DATABASE_TARGET");
  }
  if (runtime.data.mode === "live") {
    if (environment.PITCHROOM_LIVE_TRANSFER_ACK !== "authorized") return refuse("PITCHROOM_LIVE_TRANSFER_ACK");
    if (!validProviderEndpoint(runtime.data.baseURL, runtime.data.provider, deployed)) return refuse("OPENAI_BASE_URL");
  }
  return { success: true, config: { deployment: deployment.data, runtime: runtime.data } };
}

export function configurationSummary(config: RuntimeConfiguration) {
  return {
    environment: config.deployment.environment, runtime: config.runtime.mode,
    externalModelEnabled: config.runtime.mode === "live",
    ...(config.deployment.kind === "deployed" ? {
      releaseSha: config.deployment.releaseSha, expectedSchemaVersion: config.deployment.schemaVersion,
      deploymentReadiness: "unverified",
    } : {}),
  };
}
