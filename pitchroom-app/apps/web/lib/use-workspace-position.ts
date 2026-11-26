import { useEffect, useState } from "react";
import { sameTopic } from "@pitchroom/domain";
import type { FixtureState } from "./fixture-store";
import type { Destination } from "./workspace-ux-state";
import { resolveWorkspacePosition, workspacePositionKey, workspacePositionSchema, type WorkspacePosition } from "./workspace-position";

type Question = NonNullable<WorkspacePosition["taskSelections"]>[number];
type Reason = { kind: "destination" | "deck" | "page" | "topic"; text: string } | { kind: "question"; question: Question; text: string };
type Recovery = { requested: WorkspacePosition; fallback: WorkspacePosition; reasons: Reason[] };
type Navigation = { key: string; position: WorkspacePosition; recovery?: Recovery; readNotice?: string; readFailed?: boolean; pending?: Partial<WorkspacePosition>; ready?: boolean };

function validPosition(state: FixtureState, requested?: WorkspacePosition): WorkspacePosition {
  const topic = requested?.topicReturn;
  if (topic) {
    const version = state.versions.find(item => item.id === topic.understandingId);
    const entries = topic.kind === "theme" ? version?.proposal.themes : version?.proposal.gaps;
    if (!entries?.[topic.index]) return resolveWorkspacePosition(state, { ...requested!, topicReturn: undefined });
  }
  return resolveWorkspacePosition(state, requested);
}

function getRecovery(requested: WorkspacePosition, fallback: WorkspacePosition): Recovery | undefined {
  const reasons: Reason[] = [];
  if (requested.destination !== fallback.destination) reasons.push({ kind: "destination", text: "The saved " + requested.destination + " destination is unavailable; opened " + fallback.destination + "." });
  if (requested.deckId && requested.deckId !== fallback.deckId) reasons.push({ kind: "deck", text: fallback.deckId ? "The saved Deck is unavailable; selected the current Deck." : "The saved Deck is unavailable; no Deck is selected." });
  if (requested.pageId && requested.pageId !== fallback.pageId) reasons.push({ kind: "page", text: fallback.pageId ? "The saved page is unavailable; selected the first page." : "The saved page is unavailable; no page is selected." });
  if (requested.understandingId !== fallback.understandingId || requested.overviewSelection !== fallback.overviewSelection || (requested.topicReturn && !fallback.topicReturn)) {
    reasons.push({ kind: "topic", text: "The saved topic is unavailable in the current understanding; selected the current default topic." });
  }
  for (const question of requested.taskSelections ?? []) {
    if (!fallback.taskSelections?.some(item => sameTopic(item, question) && item.taskId === question.taskId)) {
      reasons.push({ kind: "question", question, text: "An unavailable saved question was not restored. Your saved project work is unchanged." });
    }
  }
  return reasons.length ? { requested, fallback, reasons } : undefined;
}

function remainingRecovery(recovery: Recovery | undefined, state: FixtureState, current: WorkspacePosition, patch?: Partial<WorkspacePosition>): Recovery | undefined {
  if (!recovery) return;
  const { requested, fallback } = recovery;
  const available = validPosition(state, requested);
  const remaining = recovery.reasons.filter(reason => {
    switch (reason.kind) {
      case "destination":
        return available.destination !== requested.destination;
      case "deck":
        return available.deckId !== requested.deckId && !(current.deckId && (current.deckId !== fallback.deckId || patch?.deckId === current.deckId));
      case "page":
        return available.pageId !== requested.pageId && !(current.pageId && (current.pageId !== fallback.pageId || current.deckId !== fallback.deckId || patch?.pageId === current.pageId));
      case "topic": {
        const originalAvailable = available.understandingId === requested.understandingId && available.overviewSelection === requested.overviewSelection && (!requested.topicReturn || available.topicReturn);
        const selectedValidTopic = (current.understandingId && patch?.overviewSelection === current.overviewSelection && (!patch.understandingId || patch.understandingId === current.understandingId)) || (patch?.topicReturn && current.topicReturn && sameTopic(patch.topicReturn, current.topicReturn));
        return !originalAvailable && !selectedValidTopic;
      }
      case "question": {
        const originalAvailable = available.taskSelections?.some(item => sameTopic(item, reason.question) && item.taskId === reason.question.taskId);
        const selectedValidQuestion = patch?.taskSelections?.some(item => sameTopic(item, reason.question) && current.taskSelections?.some(valid => sameTopic(valid, item) && valid.taskId === item.taskId));
        return !originalAvailable && !selectedValidQuestion;
      }
    }
  });
  if (remaining.length === recovery.reasons.length) return recovery;
  return remaining.length ? { ...recovery, reasons: remaining } : undefined;
}

function restoreNavigation(state: FixtureState, key: string): Navigation {
  let raw: string | null;
  try { raw = window.localStorage.getItem(key); }
  catch {
    return { key, ready: true, readFailed: true, position: validPosition(state), readNotice: "Your working position could not be restored in this browser. The next navigation retries storage. Saved project work is unchanged." };
  }
  let requested: WorkspacePosition | undefined;
  if (raw !== null) {
    try { requested = workspacePositionSchema.parse(JSON.parse(raw)); }
    catch { return { key, ready: true, position: validPosition(state), readNotice: "The saved working position could not be read; opened the default view. Saved project work is unchanged." }; }
  }
  const restored = validPosition(state, requested);
  return { key, ready: true, position: restored, recovery: requested && getRecovery(requested, restored) };
}

export function useWorkspacePosition(state: FixtureState, enabled = false, initialDestination: Destination = "materials") {
  const key = workspacePositionKey(state.project.id);
  const [navigation, setNavigation] = useState<Navigation>(() => ({
    key, position: validPosition(state, { schemaVersion: 1, destination: initialDestination, overviewSelection: "theme:0" }),
  }));
  const [writeFailureKey, setWriteFailureKey] = useState<string>();

  useEffect(() => {
    if (enabled) setNavigation(restoreNavigation(state, key));
  }, [enabled, key]);

  const position = validPosition(state, navigation.key === key ? navigation.position : undefined);
  useEffect(() => {
    setNavigation(previous => {
      if (!enabled || previous.key !== key || !previous.recovery) return previous;
      const recovery = remainingRecovery(previous.recovery, state, validPosition(state, previous.position));
      return recovery === previous.recovery ? previous : { ...previous, recovery };
    });
  }, [state, key, enabled]);

  const serialized = JSON.stringify(position);
  useEffect(() => {
    if (!enabled || !navigation.ready || navigation.key !== key || navigation.readFailed) return;
    try {
      window.localStorage.setItem(key, serialized);
      setWriteFailureKey(undefined);
    } catch { setWriteFailureKey(key); }
  }, [enabled, navigation.ready, navigation.key, navigation.readFailed, key, serialized]);

  const updatePosition = (patch: Partial<WorkspacePosition>) => {
    const retry = enabled && navigation.key === key && navigation.readFailed ? restoreNavigation(state, key) : undefined;
    setNavigation(previous => {
      const sameProject = previous.key === key;
      const base = sameProject && previous.readFailed && retry && !retry.readFailed ? retry : previous;
      const changes = sameProject && previous.pending ? { ...previous.pending, ...patch } : patch;
      const saved = { ...validPosition(state, sameProject ? base.position : undefined), ...changes };
      if (!sameProject) return { key, position: saved };
      return { ...base, position: saved, pending: base.readFailed ? changes : undefined,
        recovery: remainingRecovery(base.recovery, state, validPosition(state, saved), changes) };
    });
  };

  const messages = new Set(navigation.key === key ? navigation.recovery?.reasons.map(reason => reason.text) : []);
  if (navigation.key === key && navigation.readNotice) messages.add(navigation.readNotice);
  if (writeFailureKey === key) messages.add("Your working position could not be saved in this browser. Saved project work is unchanged.");
  return { position, updatePosition, storageNotice: enabled ? [...messages].join(" ") || undefined : undefined };
}
