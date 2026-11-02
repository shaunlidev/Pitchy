import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRuntimeConfiguration } from "@pitchroom/domain";
import { deployedEnvironment } from "../../domain/src/runtime-configuration.testkit";
import { createDatabase } from "./repository";

beforeEach(() => {
  vi.stubEnv("PGHOST", "other.example");
  vi.stubEnv("PGPORT", "6543");
  vi.stubEnv("PGDATABASE", "other_database");
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("Offline configuration checks must not open sockets.");
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("deployed configuration and actual database client target", () => {
  const baseline = deployedEnvironment();
  it.each([
    ["omitted port", baseline.DATABASE_URL.replace(":5432", ""), "db.example:5432/trial"],
    ["encoded database name", baseline.DATABASE_URL.replace("/trial?", "/trial%2Ddb?"), "db.example:5432/trial-db"],
    ["encoded database declaration", baseline.DATABASE_URL.replace("/trial?", "/trial%2Ddb?"), "db.example:5432/trial%2Ddb"],
    ["multiple hosts", baseline.DATABASE_URL.replace("db.example", "db.example,other.example"), "db.example,other.example:5432/trial"],
    ["IPv6 driver ambiguity", baseline.DATABASE_URL.replace("db.example", "[::1]"), "[::1]:5432/trial"],
    ["IPv4 certificate identity mismatch", baseline.DATABASE_URL.replace("db.example", "127.0.0.1"), "127.0.0.1:5432/trial"],
    ["remote IPv4 certificate identity mismatch", baseline.DATABASE_URL.replace("db.example", "192.0.2.1"), "192.0.2.1:5432/trial"],
    ["noncanonical userinfo", baseline.DATABASE_URL.replace("example@", "example@other.example,@"), "db.example:5432/trial"],
  ])("refuses %s before client creation", (_name, databaseUrl, target) => {
    expect(parseRuntimeConfiguration({ ...baseline, DATABASE_URL: databaseUrl, PITCHROOM_DATABASE_TARGET: target })).toEqual({ success: false, fields: ["DATABASE_URL"] });
    expect(Socket.prototype.connect).not.toHaveBeenCalled();
  });

  it.each([
    { host: "db.example", port: 5432, database: "trial-db" },
    { host: "db.example", port: 6544, database: "trial_db" },
    { host: "localhost", port: 5432, database: "trial" },
  ])("uses the declared $host:$port/$database despite inherited PG variables", async ({ host, port, database }) => {
    const url = new URL(baseline.DATABASE_URL);
    url.hostname = host;
    url.port = String(port);
    url.pathname = `/${database}`;
    url.username = "trial_user@synthetic";
    const configured = parseRuntimeConfiguration({ ...baseline, DATABASE_URL: url.href, PITCHROOM_DATABASE_TARGET: `${host}:${port}/${database}` });
    expect(configured.success).toBe(true);
    if (!configured.success || configured.config.runtime.mode !== "live") throw new Error("Expected a valid synthetic live declaration.");
    const connection = createDatabase(configured.config.runtime.databaseUrl);
    try {
      expect(connection.client.options.host).toEqual([host]);
      expect(connection.client.options.port).toEqual([port]);
      expect(connection.client.options.database).toBe(database);
      expect(connection.client.options.ssl).toBe("verify-full");
    } finally {
      await connection.client.end({ timeout: 0 });
    }
    expect(Socket.prototype.connect).not.toHaveBeenCalled();
  });

  it("preserves explicit local synthetic IP compatibility", () => {
    expect(parseRuntimeConfiguration({ PITCHROOM_DEPLOYMENT_ENV: "local", PITCHROOM_RUNTIME: "postgres-fake", DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:55463/synthetic" }).success).toBe(true);
    expect(Socket.prototype.connect).not.toHaveBeenCalled();
  });
});
