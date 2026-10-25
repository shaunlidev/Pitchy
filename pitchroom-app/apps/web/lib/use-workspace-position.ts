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
      setSaved(resolveWorkspacePosition(state, readWorkspacePosition(window.localStorage, state.project.id)));
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
