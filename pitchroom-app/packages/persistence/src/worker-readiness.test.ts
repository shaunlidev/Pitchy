import { afterEach, describe, expect, it, vi } from "vitest";
import { startWorkerReadiness } from "../../../scripts/worker-readiness";

afterEach(() => vi.useRealTimers());
const store = () => ({ pulse: vi.fn(async (_id: string) => {}), stop: vi.fn(async (_id: string) => {}), close: vi.fn(async () => {}) });
describe("worker readiness lifecycle", () => {
  it("refuses startup before claims and closes the owned client", async () => {
    const db = store(); db.pulse.mockRejectedValue(new Error("secret"));
    await expect(startWorkerReadiness(db)).rejects.toThrow("WORKER_READINESS_FAILED");
    expect(db.close).toHaveBeenCalledOnce(); expect(db.stop).not.toHaveBeenCalled();
  });
  it("refreshes independently of long work and stops idempotently", async () => {
    vi.useFakeTimers(); const db = store(); const ready = await startWorkerReadiness(db);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(db.pulse).toHaveBeenCalledTimes(5);
    await expect(ready.beforeClaim()).resolves.toBe(true);
    await Promise.all([ready.stop(), ready.stop()]);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(db.stop).toHaveBeenCalledExactlyOnceWith(ready.instanceId); expect(db.close).toHaveBeenCalledOnce();
    await expect(ready.beforeClaim()).rejects.toThrow("WORKER_NOT_READY");
  });
  it("serializes an in-flight pulse with stop and never resumes claims after failure", async () => {
    vi.useFakeTimers(); const db = store(); const ready = await startWorkerReadiness(db);
    let finish!: () => void;
    db.pulse.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(10_000);
    const claim = ready.beforeClaim(); const stopped = ready.stop();
    expect(db.stop).not.toHaveBeenCalled(); finish();
    expect(await claim).toBe(false); await stopped;
    expect(db.stop).toHaveBeenCalledOnce();
    const failing = store(); const failed = await startWorkerReadiness(failing);
    failing.pulse.mockRejectedValue(new Error("connection lost"));
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(failed.beforeClaim()).rejects.toThrow("WORKER_NOT_READY");
    await failed.stop(); expect(failing.close).toHaveBeenCalledOnce();
  });
});
