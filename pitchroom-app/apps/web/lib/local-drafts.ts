import { z } from "zod";

export const draftLifetimeMs = 7 * 24 * 60 * 60 * 1000;
export const draftPrefix = "pitchroom:local-draft:v1:";
const envelope = z.object({ schemaVersion: z.literal(1), projectId: z.string(), kind: z.string(), context: z.string(), updatedAt: z.number(), expiresAt: z.number(), value: z.unknown() });
export type DraftStore = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;
export type SavedDraft<T> = { key: string; raw: string; context: string; updatedAt: number; expiresAt: number; value: T };
export function draftKey(projectId: string, kind: string, branch: string) { return `${draftPrefix}${encodeURIComponent(projectId)}:${encodeURIComponent(kind)}:${branch}`; }
export function readDrafts<T>(store: DraftStore, projectId: string, kind: string, schema: z.ZodType<T>, now = Date.now()): SavedDraft<T>[] {
  const prefix = draftKey(projectId, kind, "");
  const keys = Array.from({ length: store.length }, (_, i) => store.key(i)).filter((key): key is string => key !== null && key.startsWith(draftPrefix));
  const drafts: SavedDraft<T>[] = [];
  for (const key of keys) {
    const raw = store.getItem(key); if (!raw) continue;
    let data: unknown; try { data = JSON.parse(raw); } catch { continue; }
    const parsed = envelope.safeParse(data); if (!parsed.success) continue;
    if (parsed.data.expiresAt <= now) { store.removeItem(key); continue; }
    if (parsed.data.updatedAt > now || parsed.data.expiresAt > parsed.data.updatedAt + draftLifetimeMs) continue;
    if (!key.startsWith(prefix) || parsed.data.projectId !== projectId || parsed.data.kind !== kind) continue;
    const value = schema.safeParse(parsed.data.value); if (!value.success) continue;
    drafts.push({ key, raw, context: parsed.data.context, updatedAt: parsed.data.updatedAt, expiresAt: parsed.data.expiresAt, value: value.data });
  }
  return drafts.sort((a, b) => b.updatedAt - a.updatedAt);
}
export function writeDraft<T>(store: DraftStore, input: { key: string; projectId: string; kind: string; context: string; value: T }, now = Date.now()) {
  const raw = JSON.stringify({ schemaVersion: 1, projectId: input.projectId, kind: input.kind, context: input.context, value: input.value, updatedAt: now, expiresAt: now + draftLifetimeMs });
  store.setItem(input.key, raw);
  return { key: input.key, raw, context: input.context, updatedAt: now, expiresAt: now + draftLifetimeMs, value: input.value };
}
export function removeUnchangedDraft(store: DraftStore, draft: Pick<SavedDraft<unknown>, "key" | "raw">) {
  if (store.getItem(draft.key) === draft.raw) store.removeItem(draft.key);
}
export const correctionDraftSchema = z.object({ selectedTarget: z.string(), values: z.record(z.string(), z.string()) });
export const storyDraftSchema = z.object({ judgment: z.string(), edit: z.object({ blockId: z.string(), title: z.string(), body: z.string() }).nullable() });
export const deckDraftSchema = z.object({ editing: z.boolean(), title: z.string(), body: z.string(), deckId: z.string(), deckVersion: z.number(), pageId: z.string() }).optional();
export const textDraftSchema = z.string();
