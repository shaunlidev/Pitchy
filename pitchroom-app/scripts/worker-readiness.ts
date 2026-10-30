import { randomUUID } from "node:crypto";
import { workerHeartbeatIntervalMs } from "../packages/domain/src/index";

export interface WorkerReadinessStore {
  pulse(instanceId: string): Promise<void>;
  stop(instanceId: string): Promise<void>;
  close(): Promise<void>;
}

export async function startWorkerReadiness(store: WorkerReadinessStore) {
  const instanceId = randomUUID();
  let state: "ready" | "stopped" | "failed" = "ready";
  let pending: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const pulse = () => {
    if (state !== "ready") return Promise.reject(new Error("WORKER_NOT_READY"));
    if (!pending) pending = store.pulse(instanceId).catch(() => {
      state = "failed";
      throw new Error("WORKER_READINESS_FAILED");
    }).finally(() => { pending = undefined; });
    return pending;
  };
  try { await pulse(); }
  catch (error) { await store.close(); throw error; }
  const timer = setInterval(() => { if (state === "ready") void pulse().catch(() => {}); }, workerHeartbeatIntervalMs);
  timer.unref();
  const stop = () => {
    state = "stopped";
    clearInterval(timer);
    if (!stopPromise) stopPromise = (async () => {
      try { await pending; } catch { /* A failed heartbeat must not prevent stop or connection cleanup. */ }
      try { await store.stop(instanceId); } finally { await store.close(); }
    })();
    return stopPromise;
  };
  return {
    instanceId,
    async beforeClaim() { await pulse(); return state === "ready"; },
    stop,
  };
}
