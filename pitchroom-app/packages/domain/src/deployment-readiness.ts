import { z } from "zod";

export const workerHeartbeatIntervalMs = 10_000;
export const workerHeartbeatLifetimeMs = 30_000;

const migrationSchema = z.object({ id: z.number().int().positive(), hash: z.string(), createdAt: z.number().int().nonnegative() });
export const deploymentObservationSchema = z.object({
  now: z.number().finite(), databaseName: z.string(), role: z.string(), schemaName: z.string(),
  identities: z.array(z.object({ environmentId: z.string(), environment: z.string(), databaseTarget: z.string(), databaseName: z.string(), runtimeRole: z.string(), targetReceiptSha: z.string() })),
  migrations: z.array(migrationSchema),
  workers: z.array(z.object({ instanceId: z.string(), environmentId: z.string(), releaseSha: z.string(), schemaVersion: z.string(), configurationHash: z.string(), state: z.enum(["ready", "stopped"]), seenAt: z.number().finite() })),
});
export type DeploymentObservation = z.infer<typeof deploymentObservationSchema>;
export type MigrationIdentity = { hash: string; createdAt: number };
export type DeploymentExpectation = {
  environment: string; environmentId: string; databaseTarget: string; databaseName: string;
  runtimeRole: string; targetReceiptSha: string; releaseSha: string; schemaVersion: string;
  configurationHash: string; migrationVersion: string; migrations: readonly MigrationIdentity[];
};
export type ReadinessObservation = { kind: "observed"; value: DeploymentObservation } | { kind: "unavailable" };

export function deploymentReadiness(expected: DeploymentExpectation, observation: ReadinessObservation) {
  if (observation.kind === "unavailable") return {
    database: false, targetIdentity: false, schema: false, worker: false, authorization: false as const,
    failures: ["DATABASE_OBSERVATION_UNAVAILABLE"],
  };
  const actual = observation.value;
  const identity = actual.identities.length === 1 ? actual.identities[0] : undefined;
  const targetIdentity = actual.databaseName === expected.databaseName && actual.role === expected.runtimeRole && actual.schemaName === "public"
    && identity !== undefined && identity.environmentId === expected.environmentId && identity.environment === expected.environment
    && identity.databaseTarget === expected.databaseTarget && identity.databaseName === expected.databaseName
    && identity.runtimeRole === expected.runtimeRole && identity.targetReceiptSha === expected.targetReceiptSha;
  const schema = expected.schemaVersion === expected.migrationVersion && actual.migrations.length === expected.migrations.length
    && actual.migrations.every((migration, index) => migration.hash === expected.migrations[index]?.hash
      && migration.createdAt === expected.migrations[index]?.createdAt
      && (index === 0 || migration.id > actual.migrations[index - 1]!.id));
  const active = actual.workers.filter(worker => worker.state === "ready" && actual.now - worker.seenAt < workerHeartbeatLifetimeMs);
  const candidate = active.length === 1 ? active[0] : undefined;
  const worker = targetIdentity && schema && candidate !== undefined && candidate.seenAt <= actual.now
    && candidate.environmentId === expected.environmentId && candidate.releaseSha === expected.releaseSha
    && candidate.schemaVersion === expected.schemaVersion && candidate.configurationHash === expected.configurationHash;
  return {
    database: true, targetIdentity, schema, worker, authorization: false as const,
    failures: [!targetIdentity && "DATABASE_IDENTITY_MISMATCH", !schema && "SCHEMA_IDENTITY_MISMATCH", !worker && "WORKER_UNVERIFIED", "AUTHORIZATION_UNVERIFIED"].filter((failure): failure is string => typeof failure === "string"),
  };
}
