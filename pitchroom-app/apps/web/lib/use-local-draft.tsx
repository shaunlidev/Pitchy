import { useEffect, useMemo, useRef, useState } from "react";
import type { z } from "zod";
import { draftKey, draftPrefix, readDrafts, removeUnchangedDraft, writeDraft, type SavedDraft } from "./local-drafts";

export function useLocalDraft<T>(input: { projectId: string; kind: string; context: string; schema: z.ZodType<T>; initial: T; hasContent: (value: T) => boolean; enabled: boolean }) {
  const identity = JSON.stringify([input.projectId, input.kind, input.context]);
  const branch = useMemo(() => crypto.randomUUID(), [identity]);
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
    try { setOffers(readDrafts(window.localStorage, input.projectId, input.kind, input.schema).filter(draft => draft.key !== key && draft.key !== selected.current?.key)); }
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
          if (selected.current) removeUnchangedDraft(window.localStorage, selected.current);
          selected.current = undefined;
        }
      }
      refresh();
    } catch { setNotice("This draft could not be saved in this browser. Your input remains in this tab; copy it before closing."); }
  };
  const restore = (draft: SavedDraft<T>, automatic = false) => {
    try {
      if (input.hasContent(current.current) && JSON.stringify(current.current) !== JSON.stringify(draft.value)) {
        writeDraft(window.localStorage, { key: draftKey(input.projectId, input.kind, crypto.randomUUID()), projectId: input.projectId, kind: input.kind, context: input.context, value: current.current });
      }
      writeDraft(window.localStorage, { key, projectId: input.projectId, kind: input.kind, context: input.context, value: draft.value }, automatic ? draft.updatedAt : Date.now());
      if (draft.key !== key && draft.context === input.context) removeUnchangedDraft(window.localStorage, draft);
      selected.current = draft;
      current.current = draft.value; setFrame({ identity, value: draft.value });
      setNotice(draft.context === input.context ? "A local draft was restored. Review it before submitting." : "An earlier-version draft was copied into the editor. Review its context before submitting.");
      refresh();
    } catch { setNotice("The saved draft could not be restored. It has not been removed."); }
  };
  const captureSubmission = (next = input.initial) => {
    const expected = JSON.stringify(current.current);
    const origin = selected.current;
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
        if (origin) removeUnchangedDraft(window.localStorage, origin);
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
      const matching = drafts.filter(draft => draft.context === input.context);
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
