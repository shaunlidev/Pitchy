import { useEffect, useMemo, useRef, useState } from "react";
import type { z } from "zod";
import { draftKey, draftPrefix, readDrafts, removeUnchangedDraft, writeDraft, type SavedDraft } from "./local-drafts";

let documentWriter: string | undefined;
function draftWriter() {
  if (documentWriter) return documentWriter;
  if (typeof window === "undefined") return "server";
  const fresh = crypto.randomUUID();
  try {
    const navigation = window.performance.getEntriesByType("navigation")[0];
    const previous = window.sessionStorage.getItem("pitchroom:draft-tab:v1");
    documentWriter = previous && navigation && "type" in navigation && navigation.type === "reload" ? previous : fresh;
    window.sessionStorage.setItem("pitchroom:draft-tab:v1", documentWriter);
  } catch { documentWriter = fresh; }
  return documentWriter;
}

export function useLocalDraft<T>(input: { projectId: string; kind: string; context: string; schema: z.ZodType<T>; initial: T; hasContent: (value: T) => boolean; enabled: boolean; writerId?: string }) {
  const writer = input.writerId ?? draftWriter();
  const identity = JSON.stringify([input.projectId, input.kind, input.context, writer]);
  const branch = useMemo(() => `${writer}:${encodeURIComponent(input.context)}`, [identity, writer]);
  const key = draftKey(input.projectId, input.kind, branch);
  const [frame, setFrame] = useState({ identity, value: input.initial });
  const value = frame.identity === identity ? frame.value : input.initial;
  const current = useRef(value); current.current = value;
  const activeIdentity = useRef(identity); activeIdentity.current = identity;
  const selected = useRef<SavedDraft<T> | undefined>(undefined);
  const [offers, setOffers] = useState<SavedDraft<T>[]>([]);
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState("");
  const refresh = () => {
    try { setOffers(readDrafts(window.localStorage, input.projectId, input.kind, input.schema).filter(draft => draft.key !== key && JSON.stringify(draft.value) !== JSON.stringify(current.current))); }
    catch { setNotice("Draft recovery is unavailable in this browser. Your input remains in this tab; copy it before closing."); }
  };
  const set = (next: T) => {
    if (activeIdentity.current === identity) { current.current = next; setFrame({ identity, value: next }); }
    if (!input.enabled) return;
    try {
      if (input.hasContent(next)) {
        writeDraft(window.localStorage, { key, projectId: input.projectId, kind: input.kind, context: input.context, value: next });
      } else {
        window.localStorage.removeItem(key);
        if (activeIdentity.current === identity) {
          selected.current = undefined;
        }
      }
      refresh();
    } catch { setNotice("This draft could not be saved in this browser. Your input remains in this tab; copy it before closing."); }
  };
  const restore = (draft: SavedDraft<T>, automatic = false) => {
    try {
      if (input.hasContent(current.current) && JSON.stringify(current.current) !== JSON.stringify(draft.value)) {
        const own = readDrafts(window.localStorage, input.projectId, input.kind, input.schema).find(saved => saved.key === key);
        if (own && JSON.stringify(own.value) === JSON.stringify(current.current)) {
          writeDraft(window.localStorage, { key: draftKey(input.projectId, input.kind, crypto.randomUUID()), projectId: input.projectId, kind: input.kind, context: input.context, value: current.current }, own.updatedAt);
          removeUnchangedDraft(window.localStorage, own);
        }
      }
      writeDraft(window.localStorage, { key, projectId: input.projectId, kind: input.kind, context: input.context, value: draft.value }, automatic ? draft.updatedAt : Date.now());
      selected.current = draft;
      current.current = draft.value; setFrame({ identity, value: draft.value });
      setNotice(draft.context === input.context ? "A local draft was restored. Review it before submitting." : "An earlier-version draft was copied into the editor. Review its context before submitting.");
      refresh();
    } catch {
      selected.current = draft; current.current = draft.value; setFrame({ identity, value: draft.value });
      setNotice("The draft was recovered into this tab, but a separate local copy could not be saved. Copy it before closing; the original is retained.");
    }
  };
  const captureSubmission = (next = input.initial) => {
    const expected = JSON.stringify(current.current);
    const origin = selected.current;
    let acknowledged: SavedDraft<T>[] = [];
    try { if (input.enabled) acknowledged = readDrafts(window.localStorage, input.projectId, input.kind, input.schema).filter(draft => draft.key !== key && draft.context === input.context && JSON.stringify(draft.value) === expected); } catch { /* Storage failure does not prevent explicit submission. */ }
    let raw: string | null = null;
    try { if (input.enabled) raw = window.localStorage.getItem(key); } catch { /* Input remains usable without storage. */ }
    return () => {
      if (activeIdentity.current === identity && JSON.stringify(current.current) === expected) {
        current.current = next; setFrame({ identity, value: next }); selected.current = undefined;
      }
      if (!input.enabled) return;
      try {
        if (raw !== null && window.localStorage.getItem(key) === raw) {
          if (input.hasContent(next)) writeDraft(window.localStorage, { key, projectId: input.projectId, kind: input.kind, context: input.context, value: next });
          else window.localStorage.removeItem(key);
        }
        for (const draft of acknowledged) removeUnchangedDraft(window.localStorage, draft);
        if (origin && JSON.stringify(origin.value) === expected) removeUnchangedDraft(window.localStorage, origin);
        refresh();
      } catch { setNotice("The input was submitted, but its local draft could not be cleared. Review saved drafts before reuse."); }
    };
  };
  useEffect(() => {
    selected.current = undefined;
    setFrame({ identity, value: input.initial });
    setOffers([]); setNotice("");
    if (!input.enabled) return;
    try {
      const drafts = readDrafts(window.localStorage, input.projectId, input.kind, input.schema);
      const matching = [...new Map(drafts.filter(draft => draft.context === input.context).map(draft => [JSON.stringify(draft.value), draft])).values()];
      if (matching.length === 1) restore(matching[0]!, true);
      else { setOffers(drafts); if (matching.length > 1) setNotice("Multiple local drafts are available. Choose one; neither has been overwritten."); }
    } catch { setNotice("Draft recovery is unavailable in this browser. Your input remains in this tab; copy it before closing."); }
    setReady(identity);
  }, [identity, input.enabled]);
  useEffect(() => {
    if (!input.enabled) return;
    const changed = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(draftPrefix)) refresh(); };
    window.addEventListener("storage", changed);
    const timer = window.setInterval(refresh, 60_000);
    return () => { window.removeEventListener("storage", changed); window.clearInterval(timer); };
  }, [identity, input.enabled]);
  const setIfUnchanged = (expected: T, next: T) => {
    if (activeIdentity.current === identity && JSON.stringify(current.current) === JSON.stringify(expected)) set(next);
  };
  return { value, set, setIfUnchanged, restore, captureSubmission, offers: ready === identity ? offers : [], notice: input.enabled ? notice : "", context: input.context };
}

export function DraftRecovery<T>({ label, draft, describe }: { label: string; draft: ReturnType<typeof useLocalDraft<T>>; describe: (value: T) => string }) {
  return <>{draft.notice && <p role="status">{label}: {draft.notice}</p>}{draft.offers.length > 0 && <details className="localDraftRecovery"><summary>Saved {label} drafts ({draft.offers.length})</summary><p>Stored only in this browser for seven days. Choosing a draft never submits it.</p>{draft.offers.map((saved, index) => <section key={saved.key}><strong>{saved.context === draft.context ? "Another local draft" : "Earlier version · review before reuse"}</strong><small> · {new Date(saved.updatedAt).toLocaleString()}</small><pre>{describe(saved.value)}</pre><button className="btn" onClick={() => draft.restore(saved)}>Use saved {label} draft {index + 1}</button></section>)}</details>}</>;
}
