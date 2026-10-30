import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deploymentReadiness, parseRuntimeConfiguration, type DeploymentExpectation } from "@pitchroom/domain";
import { deployedEnvironment } from "../../domain/src/runtime-configuration.testkit";
import { createDatabase, PitchroomRepository } from "./repository";
import { deploymentSchemaVersion, openDeploymentReadiness, readinessExpectation } from "./deployment-readiness";

// The runner must authorize the parent synthetic database. All destructive cases
// are confined to a newly created database with an unguessable test-owned name.
const parent = new URL(process.env.DATABASE_URL!);
if (!["localhost", "127.0.0.1"].includes(parent.hostname) || parent.username !== "clarify_qa" || parent.pathname !== "/clarify_qa") throw new Error("Synthetic integration target required");
const admin = postgres(parent.href, { max: 1 });
const name = `readiness_${randomUUID().replaceAll("-", "")}`;
const target = new URL(parent); target.pathname = `/${name}`;
const database = createDatabase(target.href);
const repository = new PitchroomRepository(database.db);
const observer = openDeploymentReadiness(target.href);
let expected: DeploymentExpectation;
let owned = false;

beforeAll(async () => {
  await admin.unsafe(`create database ${name}`); owned = true;
  await migrate(database.db, { migrationsFolder: new URL("../migrations", import.meta.url).pathname });
  const result = parseRuntimeConfiguration({ ...deployedEnvironment(), DATABASE_URL: target.href + "?sslmode=verify-full", PITCHROOM_DATABASE_TARGET: `${target.hostname}:${target.port}/${name}`, PITCHROOM_DATABASE_ROLE: "clarify_qa", PITCHROOM_SCHEMA_VERSION: deploymentSchemaVersion });
  if (!result.success) throw new Error("Invalid synthetic configuration");
  expected = readinessExpectation(result.config);
  await database.client`insert into deployment_identity values (1, ${expected.environmentId}, ${expected.environment}, ${expected.databaseTarget}, ${expected.databaseName}, ${expected.runtimeRole}, ${expected.targetReceiptSha})`;
});
afterAll(async () => {
  await observer.close(); await database.client.end({ timeout: 1 });
  try { if (owned) await admin.unsafe(`drop database ${name} with (force)`); } finally { await admin.end({ timeout: 1 }); }
});

describe("actual deployment database observations", () => {
  it("detects identity, chain, heartbeat failures and recovers without changing project state", async () => {
    const project = await repository.createProject("PIT-34 immutable synthetic sentinel");
    const before = await repository.getProject(project.id);
    const check = async () => deploymentReadiness(expected, await observer.observe());
    expect(await check()).toMatchObject({ database: true, targetIdentity: true, schema: true, worker: false, authorization: false });
    const first = randomUUID(); await observer.pulse(expected, first);
    expect(await check()).toMatchObject({ targetIdentity: true, schema: true, worker: true, authorization: false });
    const other = openDeploymentReadiness(target.href);
    try { await expect(other.pulse(expected, randomUUID())).rejects.toThrow("WORKER_INSTANCE_CONFLICT"); } finally { await other.close(); }

    await database.client`update deployment_identity set environment = 'wrong'`;
    expect(await check()).toMatchObject({ targetIdentity: false, worker: false });
    await expect(observer.pulse(expected, first)).rejects.toThrow("WORKER_DATABASE_UNVERIFIED");
    await database.client`update deployment_identity set environment = ${expected.environment}`;
    const [identity] = await database.client`delete from deployment_identity returning *`;
    expect((await check()).targetIdentity).toBe(false);
    await database.client`insert into deployment_identity ${database.client(identity!)}`;

    const ledger = await database.client`select * from drizzle.__drizzle_migrations order by id`;
    await database.client`update drizzle.__drizzle_migrations set hash = 'tampered' where id = ${ledger[0]!.id}`;
    expect((await check()).schema).toBe(false);
    await expect(observer.pulse(expected, first)).rejects.toThrow("WORKER_DATABASE_UNVERIFIED");
    await database.client`update drizzle.__drizzle_migrations set hash = ${ledger[0]!.hash} where id = ${ledger[0]!.id}`;
    await database.client`delete from drizzle.__drizzle_migrations where id = ${ledger[0]!.id}`;
    expect((await check()).schema).toBe(false);
    await database.client`insert into drizzle.__drizzle_migrations ${database.client(ledger[0]!)}`;
    const [extra] = await database.client`insert into drizzle.__drizzle_migrations (hash, created_at) values ('unknown-newer', 9999999999999) returning id`;
    expect((await check()).schema).toBe(false);
    await database.client`delete from drizzle.__drizzle_migrations where id = ${extra!.id}`;
    await database.client`alter table drizzle.__drizzle_migrations rename to withheld_migrations`;
    expect((await check()).schema).toBe(false);
    await database.client`alter table drizzle.withheld_migrations rename to __drizzle_migrations`;

    for (const field of ["release_sha", "schema_version", "configuration_hash"] as const) {
      const [original] = await database.client`select * from worker_heartbeats where instance_id = ${first}`;
      await database.client`update worker_heartbeats set ${database.client({ [field]: "wrong" })} where instance_id = ${first}`;
      expect((await check()).worker).toBe(false);
      await database.client`update worker_heartbeats set ${database.client({ [field]: original![field] })} where instance_id = ${first}`;
    }
    await database.client`update worker_heartbeats set seen_at = clock_timestamp() - interval '30 seconds'`;
    expect((await check()).worker).toBe(false);
    await database.client`update worker_heartbeats set seen_at = clock_timestamp() + interval '1 hour'`;
    expect((await check()).worker).toBe(false);
    await observer.pulse(expected, first);
    await observer.stop(first); expect((await check()).worker).toBe(false);
    await expect(observer.pulse(expected, first)).rejects.toThrow("WORKER_INSTANCE_STOPPED");
    const restarted = randomUUID(); await observer.pulse(expected, restarted);
    expect((await check()).worker).toBe(true);
    await observer.stop(restarted);

    // Competing startup transactions must not both register as ready.
    const contender = openDeploymentReadiness(target.href);
    const attempts = [randomUUID(), randomUUID()];
    try {
      const results = await Promise.allSettled([observer.pulse(expected, attempts[0]!), contender.pulse(expected, attempts[1]!)]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
      expect((await check()).worker).toBe(true);
    } finally { for (const id of attempts) await observer.stop(id); await contender.close(); }

    // An ACCESS EXCLUSIVE lock exercises the actual driver's bounded failure.
    const blocker = await database.client.reserve();
    try {
      await blocker`begin`; await blocker`lock table deployment_identity in access exclusive mode`;
      const started = Date.now(); expect(await observer.observe()).toEqual({ kind: "unavailable" });
      expect(Date.now() - started).toBeLessThan(4000);
    } finally { await blocker`rollback`; blocker.release(); }
    const deniedRole = `denied_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`create role ${deniedRole} login password 'test-denied'`);
    const deniedUrl = new URL(target); deniedUrl.username = deniedRole; deniedUrl.password = "test-denied";
    const denied = openDeploymentReadiness(deniedUrl.href);
    try { expect(await denied.observe()).toEqual({ kind: "unavailable" }); }
    finally { await denied.close(); await admin.unsafe(`drop role ${deniedRole}`); }
    const final = randomUUID(); await observer.pulse(expected, final);
    expect((await check()).worker).toBe(true);
    expect(await repository.getProject(project.id)).toEqual(before);
    await observer.stop(final);
  }, 20_000);
});
