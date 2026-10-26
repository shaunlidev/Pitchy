import { useEffect, useState } from "react";
import type { FixtureState } from "./fixture-store";
import type { Destination } from "./workspace-ux-state";
import { readWorkspacePosition, resolveWorkspacePosition, workspacePositionKey, type WorkspacePosition } from "./workspace-position";

export function useWorkspacePosition(state: FixtureState, enabled = false, initialDestination: Destination = "materials") {
  const key = workspacePositionKey(state.project.id);
  const [saved, setSaved] = useState<WorkspacePosition>(() => resolveWorkspacePosition(state, { schemaVersion: 1, destination: initialDestination, overviewSelection: "theme:0" }));
  const [readyKey, setReadyKey] = useState<string>();
  const [storageNotice, setStorageNotice] = useState<string>();
  useEffect(() => {
    if (!enabled) return;
    try {
      const previous = readWorkspacePosition(window.localStorage, state.project.id);
      const restored = resolveWorkspacePosition(state, previous);
      const reasons: string[] = [];
      if (previous) {
        if (previous.destination !== restored.destination) reasons.push(`The saved ${previous.destination} destination is unavailable; opened ${restored.destination}.`);
        if (previous.deckId && previous.deckId !== restored.deckId) reasons.push(restored.deckId ? "The saved Deck is unavailable; selected the current Deck." : "The saved Deck is unavailable; no Deck is selected.");
        if (previous.pageId && previous.pageId !== restored.pageId) reasons.push(restored.pageId ? "The saved page is unavailable; selected the first page." : "The saved page is unavailable; no page is selected.");
        if (previous.understandingId !== restored.understandingId || previous.overviewSelection !== restored.overviewSelection) reasons.push("The saved topic is unavailable in the current understanding; selected the current default topic.");
      }
      setStorageNotice(reasons.length ? reasons.join(" ") : undefined);
      setSaved(restored);
    } catch {
      setSaved(resolveWorkspacePosition(state));
      setStorageNotice("Your working position could not be restored in this browser. Saved project work is unchanged.");
    }
    setReadyKey(key);
  }, [enabled, key]);
  const position = resolveWorkspacePosition(state, saved);
  const serialized = JSON.stringify(position);
  useEffect(() => {
    if (!enabled || readyKey !== key) return;
    try { window.localStorage.setItem(key, serialized); }
    catch { setStorageNotice("Your working position could not be saved in this browser. Saved project work is unchanged."); }
  }, [enabled, readyKey, key, serialized]);
  const updatePosition = (patch: Partial<WorkspacePosition>) => setSaved(previous => ({ ...resolveWorkspacePosition(state, previous), ...patch }));
  return { position, updatePosition, storageNotice };
}
