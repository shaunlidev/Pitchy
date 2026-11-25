import { createHash } from "node:crypto";
import postgres from "postgres";
import {
  deploymentObservationSchema, deploymentReadiness, workerHeartbeatLifetimeMs,
  type DeploymentExpectation, type DeploymentObservation, type MigrationIdentity,
  type ReadinessObservation, type RuntimeConfiguration,
} from "@pitchroom/domain";

export const releaseMigrations: readonly MigrationIdentity[] = [
  {
    "hash": "4b3cf71072e58ad9ae9427cc6f17b4fc667040bf20854b6a2a98203ee51e5175",
    "createdAt": 1791943399619
  },
  {
    "hash": "33677ee0875d0bad564a02d11c7fa9cef31e32d33ae5b7a91afd1d4b76e9ffed",
    "createdAt": 1791943631811
  },
  {
    "hash": "e3ab69c3d2c9a8f3ad5ed1ee2794e1aa3bc584e943435a00c104d08bd492a5fa",
    "createdAt": 1791943834288
  },
  {
    "hash": "06532234cce8c741f939bcc5b493efd64ca5c87fff9317cc50603df5c9fbb67b",
    "createdAt": 1791944077613
  },
  {
    "hash": "e828b1d3bdd372e2c7f2ce26016b54984bf20948c4a7cae783d5184faac6f494",
    "createdAt": 1791944262575
  },
  {
    "hash": "b403762c532551d577766197925f79755d8f80a7e39be87b0be9e14053e8ff2b",
    "createdAt": 1791945200000
  },
  {
    "hash": "5274419f64aaf528c191d1ba91b7a7e469af5f13baef6d694e1a768ac6fc49dc",
    "createdAt": 1792057875029
  },
  {
    "hash": "efc48105400d3df7bb209cde3dad937eeaaa9beb7ec2b70e13fd412bdb9dc2c3",
    "createdAt": 1792059000000
  },
  {
    "hash": "91537960e18570e0d997ad3648c3af63cde58523829af5bd35bf9d823786b390",
    "createdAt": 1792062000000
  },
  {
    "hash": "5521f95f27e277ee5840a65d6af3f7ff49895090cabab63e78c021ebb3ffb0ee",
    "createdAt": 1792540800000
  },
  {
    "hash": "99eb6c701caef4c17879cca98623d7e79d0ef8202fd3cf1e570a33f4af83c8dc",
    "createdAt": 1792886400000
  },
  {
    "hash": "f2c781948c6de5317393f42cee877a67c0b495854dcf247fddfd7b0890ce7641",
    "createdAt": 1792978435502
  },
  {
    "hash": "34ebbab08fa67b693308af1fbd8291065a0ee3fd7e5be86b9859f2711c3ad0b1",
    "createdAt": 1792980000000
  },
  {
    "hash": "ad1ff9c3e2f8d2a6acfa3f614a83925a5e5e8c94e4b5a38bc36792ee60b4555f",
    "createdAt": 1793333954382
  }
];
export const deploymentSchemaVersion = createHash("sha256").update(JSON.stringify(releaseMigrations)).digest("hex");

export function readinessExpectation(config: RuntimeConfiguration): DeploymentExpectation {
  if (config.deployment.kind !== "deployed" || config.runtime.mode !== "live") throw new Error("DEPLOYED_CONFIGURATION_REQUIRED");
  const deployment = config.deployment;
  const configurationHash = createHash("sha256").update(JSON.stringify({
    ...deployment, runtime: config.runtime.mode, provider: config.runtime.provider, model: config.runtime.model, baseURL: config.runtime.baseURL,
  })).digest("hex");
  return {
    ...deployment, runtimeRole: deployment.databaseRole, databaseName: new URL(config.runtime.databaseUrl).pathname.slice(1),
    configurationHash, migrationVersion: deploymentSchemaVersion, migrations: releaseMigrations,
  };
}

async function observeTransaction(sql: postgres.TransactionSql): Promise<DeploymentObservation> {
  const [session] = await sql`select current_database() as "databaseName", current_user as role, current_schema() as "schemaName",
    extract(epoch from clock_timestamp()) * 1000 as "now",
    to_regclass('public.deployment_identity') is not null as identity_exists,
    to_regclass('drizzle.__drizzle_migrations') is not null as migrations_exist,
    to_regclass('public.worker_heartbeats') is not null as workers_exist`;
  if (!session) throw new Error("DATABASE_OBSERVATION_UNAVAILABLE");
  const identities = session.identity_exists ? await sql`select environment_id as "environmentId", environment,
    database_target as "databaseTarget", database_name as "databaseName", runtime_role as "runtimeRole", target_receipt_sha as "targetReceiptSha"
    from public.deployment_identity limit 2` : [];
  const migrations = session.migrations_exist ? await sql`select id, hash, created_at as "createdAt" from drizzle.__drizzle_migrations order by id` : [];
  const workers = session.workers_exist ? await sql`select instance_id as "instanceId", environment_id as "environmentId", release_sha as "releaseSha",
    schema_version as "schemaVersion", configuration_hash as "configurationHash", state, extract(epoch from seen_at) * 1000 as "seenAt"
    from public.worker_heartbeats where state = 'ready' and seen_at > clock_timestamp() - interval '30 seconds' order by seen_at desc limit 2` : [];
  return deploymentObservationSchema.parse({ ...session, now: Number(session.now), identities,
    migrations: migrations.map(row => ({ ...row, createdAt: Number(row.createdAt) })),
    workers: workers.map(row => ({ ...row, seenAt: Number(row.seenAt) })),
  });
}

export function openDeploymentReadiness(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 2, idle_timeout: 5,
    connection: { statement_timeout: 1500, lock_timeout: 500 } });
  return {
    async observe(): Promise<ReadinessObservation> {
      try {
        const value = await client.begin("isolation level repeatable read read only", observeTransaction);
        return { kind: "observed", value };
      } catch { return { kind: "unavailable" }; }
    },
    async pulse(expected: DeploymentExpectation, instanceId: string): Promise<void> {
      await client.begin(async sql => {
        await sql`select pg_advisory_xact_lock(hashtext('pitchroom:worker-readiness'))`;
        const observation = await observeTransaction(sql);
        const checks = deploymentReadiness(expected, { kind: "observed", value: observation });
        if (!checks.targetIdentity || !checks.schema) throw new Error("WORKER_DATABASE_UNVERIFIED");
        if (observation.workers.some(worker => worker.instanceId !== instanceId && worker.state === "ready"
          && observation.now - worker.seenAt < workerHeartbeatLifetimeMs)) throw new Error("WORKER_INSTANCE_CONFLICT");
        const rows = await sql`insert into public.worker_heartbeats
          (instance_id, environment_id, release_sha, schema_version, configuration_hash, state, seen_at)
          values (${instanceId}, ${expected.environmentId}, ${expected.releaseSha}, ${expected.schemaVersion}, ${expected.configurationHash}, 'ready', clock_timestamp())
          on conflict (instance_id) do update set seen_at = clock_timestamp() where worker_heartbeats.state = 'ready'
            and worker_heartbeats.environment_id = ${expected.environmentId} and worker_heartbeats.release_sha = ${expected.releaseSha}
            and worker_heartbeats.schema_version = ${expected.schemaVersion} and worker_heartbeats.configuration_hash = ${expected.configurationHash}
          returning instance_id`;
        if (rows.length !== 1) throw new Error("WORKER_INSTANCE_STOPPED");
      });
    },
    async stop(instanceId: string): Promise<void> {
      await client`update public.worker_heartbeats set state = 'stopped', seen_at = clock_timestamp() where instance_id = ${instanceId}`;
    },
    async close(): Promise<void> { await client.end({ timeout: 1 }); },
  };
}

export async function probeDeployment(config: RuntimeConfiguration) {
  const expected = readinessExpectation(config);
  if (config.runtime.mode === "fixture") throw new Error("DEPLOYED_CONFIGURATION_REQUIRED");
  const connection = openDeploymentReadiness(config.runtime.databaseUrl);
  try { return deploymentReadiness(expected, await connection.observe()); }
  finally { await connection.close(); }
}
