import { z } from "zod";
import type { FixtureState } from "./fixture-store";
import { deriveWorkspaceUXState } from "./workspace-ux-state";

export const workspacePositionSchema = z.object({
  schemaVersion: z.literal(1),
  destination: z.enum(["materials", "clarify", "positioning", "deck"]),
  understandingId: z.string().optional(),
  overviewSelection: z.string(),
  deckId: z.string().optional(),
  pageId: z.string().optional(),
});
export type WorkspacePosition = z.infer<typeof workspacePositionSchema>;
export const workspacePositionKey = (projectId: string) => `pitchroom:workspace-position:v1:${projectId}`;

export function resolveWorkspacePosition(state: FixtureState, saved?: WorkspacePosition): WorkspacePosition {
  const access = deriveWorkspaceUXState(state).access;
  const requested = saved?.destination ?? "materials";
  const destination = access[requested].allowed ? requested : access[requested].target;
  const understanding = state.versions.find(version => version.id === state.currentVersionId);
  let overviewSelection = "theme:0";
  if (saved && saved.understandingId === understanding?.id) {
    const match = /^(theme|gap):(\d+)$/.exec(saved?.overviewSelection ?? "");
    if (match) {
      const index = Number(match[2]);
      const entries = match[1] === "theme" ? understanding?.proposal.themes : understanding?.proposal.gaps;
      if (entries?.[index]) overviewSelection = saved.overviewSelection;
    }
  }
  const deck = state.deckVersions.find(version => version.id === saved?.deckId) ?? state.deck;
  const page = deck?.proposal.pages.find(candidate => candidate.id === saved?.pageId) ?? deck?.proposal.pages[0];
  return { schemaVersion: 1, destination, understandingId: understanding?.id, overviewSelection, deckId: deck?.id, pageId: page?.id };
}

export function readWorkspacePosition(storage: Pick<Storage, "getItem">, projectId: string): WorkspacePosition | undefined {
  const raw = storage.getItem(workspacePositionKey(projectId));
  if (!raw) return undefined;
  const parsed = workspacePositionSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : undefined;
}
