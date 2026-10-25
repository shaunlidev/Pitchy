// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readDrafts, textDraftSchema, draftLifetimeMs } from "./local-drafts";
import { useLocalDraft } from "./use-local-draft";
const options = { projectId: "synthetic-a", kind: "answer", context: "understanding-1", schema: textDraftSchema, initial: "", hasContent: (value: string) => Boolean(value), enabled: true };
beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const saved = () => readDrafts(localStorage, options.projectId, options.kind, textDraftSchema);
it("restores the exact local draft after remount without submitting anything", () => {
 const fetch = vi.spyOn(globalThis, "fetch");
 const first = renderHook(() => useLocalDraft(options));
 act(() => first.result.current.set("原话 stays exact \n  "));
 first.unmount();
 const reopened = renderHook(() => useLocalDraft(options));
 expect(reopened.result.current.value).toBe("原话 stays exact \n  ");
 expect(saved()).toHaveLength(1);
 expect(fetch).not.toHaveBeenCalled();
});
it("keeps independent tab branches and preserves both when choosing a conflicting draft", () => {
 const a = renderHook(() => useLocalDraft(options));
 const b = renderHook(() => useLocalDraft(options));
 act(() => { a.result.current.set("tab A"); b.result.current.set("tab B"); window.dispatchEvent(new StorageEvent("storage", { key: saved()[0]!.key })); });
 expect(a.result.current.value).toBe("tab A"); expect(b.result.current.value).toBe("tab B");
 expect(saved().map(draft => draft.value).sort()).toEqual(["tab A", "tab B"]);
 const candidate = a.result.current.offers.find(draft => draft.value === "tab B")!;
 act(() => a.result.current.restore(candidate));
 expect(a.result.current.value).toBe("tab B");
 expect(saved().map(draft => draft.value).sort()).toEqual(["tab A", "tab B"]);
});
it("offers earlier-version text without automatically applying it", () => {
 const hook = renderHook(({ context }) => useLocalDraft({ ...options, context }), { initialProps: { context: "understanding-1" } });
 act(() => hook.result.current.set("earlier judgment"));
 hook.rerender({ context: "understanding-2" });
 expect(hook.result.current.value).toBe(""); expect(hook.result.current.offers).toHaveLength(1);
 act(() => hook.result.current.restore(hook.result.current.offers[0]!));
 expect(hook.result.current.value).toBe("earlier judgment");
 expect(hook.result.current.notice).toContain("earlier-version");
});
it("expires saved text after seven days and never restores another project's text", () => {
 vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
 const first = renderHook(() => useLocalDraft(options)); act(() => first.result.current.set("expires")); first.unmount();
 const other = renderHook(() => useLocalDraft({ ...options, projectId: "synthetic-b" })); expect(other.result.current.value).toBe(""); other.unmount();
 vi.setSystemTime(Date.now() + draftLifetimeMs + 1);
 const reopened = renderHook(() => useLocalDraft(options)); expect(reopened.result.current.value).toBe(""); expect(saved()).toEqual([]);
});
it("clears only the submitted snapshot and preserves typing or foreign changes during a request", () => {
 const hook = renderHook(() => useLocalDraft(options)); act(() => hook.result.current.set("submitted"));
 const committed = hook.result.current.captureSubmission();
 act(() => hook.result.current.set("typed while waiting")); act(committed);
 expect(hook.result.current.value).toBe("typed while waiting"); expect(saved().map(draft => draft.value)).toEqual(["typed while waiting"]);
 const clear = hook.result.current.captureSubmission(); act(clear); expect(saved()).toEqual([]); expect(hook.result.current.value).toBe("");
});
it("clears a submitted old-context snapshot without erasing a new-context draft", () => {
 const hook = renderHook(({ context }) => useLocalDraft({ ...options, context }), { initialProps: { context: "v1" } });
 act(() => hook.result.current.set("submitted v1")); const committed = hook.result.current.captureSubmission();
 hook.rerender({ context: "v2" }); act(() => hook.result.current.set("new v2")); act(committed);
 expect(hook.result.current.value).toBe("new v2"); expect(saved().map(draft => draft.value)).toEqual(["new v2"]);
});
it("keeps input usable and reports storage quota failure", () => {
 const hook = renderHook(() => useLocalDraft(options));
 vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
 act(() => hook.result.current.set("still in this tab"));
 expect(hook.result.current.value).toBe("still in this tab"); expect(hook.result.current.notice).toContain("could not be saved");
});
it("clearing one input does not clear a different input kind", () => {
 const answer = renderHook(() => useLocalDraft(options)); const brief = renderHook(() => useLocalDraft({ ...options, kind: "brief" }));
 act(() => { answer.result.current.set("answer"); brief.result.current.set("brief"); });
 act(answer.result.current.captureSubmission());
 expect(saved()).toEqual([]); expect(readDrafts(localStorage, options.projectId, "brief", textDraftSchema).map(d => d.value)).toEqual(["brief"]);
});

it("opening a draft does not extend its original seven-day expiry", () => {
 vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
 const first = renderHook(() => useLocalDraft(options)); act(() => first.result.current.set("seven days from editing")); first.unmount();
 const originalExpiry=saved()[0]!.expiresAt;
 vi.setSystemTime(Date.now()+6*24*60*60*1000);
 const reopened=renderHook(()=>useLocalDraft(options)); expect(reopened.result.current.value).toBe("seven days from editing"); expect(saved()[0]!.expiresAt).toBe(originalExpiry); reopened.unmount();
 vi.setSystemTime(originalExpiry+1);
 const expired=renderHook(()=>useLocalDraft(options)); expect(expired.result.current.value).toBe(""); expect(saved()).toEqual([]);
});
it("ignores malformed browser data and expires old drafts even when another project opens", () => {
 const first=renderHook(()=>useLocalDraft(options)); act(()=>first.result.current.set("old project")); first.unmount();
 const record=saved()[0]!;
 localStorage.setItem("pitchroom:local-draft:v1:synthetic-a:answer:broken","not-json");
 expect(readDrafts(localStorage,"synthetic-b","answer",textDraftSchema,record.expiresAt+1)).toEqual([]);
 expect(localStorage.getItem(record.key)).toBeNull();
 const reopened=renderHook(()=>useLocalDraft(options)); expect(reopened.result.current.value).toBe("");
});
it("a delayed editor cleanup cannot erase newer unsent wording", () => {
 const hook=renderHook(()=>useLocalDraft(options)); act(()=>hook.result.current.set("submitted")); const old=hook.result.current;
 act(()=>hook.result.current.set("new unsent edit")); act(()=>old.setIfUnchanged(old.value,""));
 expect(hook.result.current.value).toBe("new unsent edit"); expect(saved().map(d=>d.value)).toEqual(["new unsent edit"]);
});
