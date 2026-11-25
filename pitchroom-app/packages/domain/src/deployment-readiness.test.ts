import { describe, expect, it } from "vitest";
import { deploymentReadiness, type DeploymentExpectation, type DeploymentObservation } from "./deployment-readiness";

const expected: DeploymentExpectation = { environment: "trial", environmentId: "environment-1", databaseTarget: "localhost:5432/test", databaseName: "test", runtimeRole: "runtime", targetReceiptSha: "receipt", releaseSha: "release", schemaVersion: "schema", migrationVersion: "schema", configurationHash: "config", migrations: [{ hash: "migration-a", createdAt: 1 }, { hash: "migration-b", createdAt: 2 }] };
function valid(): DeploymentObservation {
  return { now: 100_000, databaseName: "test", role: "runtime", schemaName: "public", identities: [{ ...expected }], migrations: expected.migrations.map((m, i) => ({ ...m, id: i + 1 })), workers: [{ instanceId: "instance-1", environmentId: "environment-1", releaseSha: "release", schemaVersion: "schema", configurationHash: "config", state: "ready", seenAt: 99_000 }] };
}
const check = (value: DeploymentObservation) => deploymentReadiness(expected, { kind: "observed", value });

describe("deployment observations", () => {
  it("accepts matching observations without inventing authorization", () => {
    expect(check(valid())).toEqual({ database: true, targetIdentity: true, schema: true, worker: true, authorization: false, failures: ["AUTHORIZATION_UNVERIFIED"] });
    expect(deploymentReadiness(expected, { kind: "unavailable" })).toMatchObject({ database: false, targetIdentity: false, schema: false, worker: false, authorization: false });
  });
  it("refuses missing, duplicated or mismatched database identity", () => {
    for (const field of ["environmentId", "environment", "databaseTarget", "databaseName", "runtimeRole", "targetReceiptSha"] as const) {
      const value = valid(); value.identities[0]![field] = "wrong";
      expect(check(value)).toMatchObject({ targetIdentity: false, worker: false });
    }
    for (const field of ["databaseName", "role", "schemaName"] as const) {
      const value = valid(); value[field] = "wrong";
      expect(check(value).targetIdentity).toBe(false);
    }
    for (const identities of [[], [...valid().identities, ...valid().identities]]) expect(check({ ...valid(), identities }).targetIdentity).toBe(false);
  });
  it("requires the complete migration chain and the compiled fingerprint", () => {
    const original = valid().migrations;
    for (const migrations of [[], original.slice(1), [...original, { id: 3, hash: "unknown", createdAt: 3 }], [...original].reverse(), [{ ...original[0]!, hash: "tampered" }, original[1]!], [original[0]!, { ...original[1]!, createdAt: 3 }], [original[0]!, { ...original[1]!, id: 1 }]]) {
      expect(check({ ...valid(), migrations })).toMatchObject({ schema: false, worker: false });
    }
    expect(deploymentReadiness({ ...expected, schemaVersion: "other" }, { kind: "observed", value: valid() }).schema).toBe(false);
  });
  it("rejects stale, future, stopped, duplicate and incompatible workers", () => {
    for (const age of [0, 29_999]) expect(check({ ...valid(), workers: [{ ...valid().workers[0]!, seenAt: 100_000 - age }] }).worker).toBe(true);
    for (const age of [-1, 30_000, 30_001]) expect(check({ ...valid(), workers: [{ ...valid().workers[0]!, seenAt: 100_000 - age }] }).worker).toBe(false);
    for (const field of ["environmentId", "releaseSha", "schemaVersion", "configurationHash"] as const) {
      const value = valid(); value.workers[0]![field] = "wrong"; expect(check(value).worker).toBe(false);
    }
    for (const workers of [[], [{ ...valid().workers[0]!, state: "stopped" as const }], [...valid().workers, { ...valid().workers[0]!, instanceId: "instance-2" }]]) expect(check({ ...valid(), workers }).worker).toBe(false);
    expect(check({ ...valid(), workers: [...valid().workers, { ...valid().workers[0]!, instanceId: "old", seenAt: 0 }] }).worker).toBe(true);
  });
});
