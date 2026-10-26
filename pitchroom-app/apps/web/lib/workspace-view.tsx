import { topicTasksFor, sameTopic, type TopicRef } from "@pitchroom/domain";
import { briefText } from "@pitchroom/domain";
import { BriefEditor } from "./brief-editor";
import { useLocalDraft, DraftRecovery } from "./use-local-draft";
import { textDraftSchema, correctionDraftSchema, storyDraftSchema, deckDraftSchema } from "./local-drafts";
import type { FileImportItem } from "./file-import";
import { useWorkspacePosition } from "./use-workspace-position";
import type { WorkspacePosition } from "./workspace-position";
import { StoryPanel, StoryTrace, type StoryDraft } from "./story-panel";
import { ClarificationPanel } from "./clarification-panel";
import { deriveDownstreamSyncStatus } from "@pitchroom/domain";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FixtureState } from "./fixture-store";
import { deriveWorkspaceUXState, type ActiveAgentRequest, type AgentActivity, type WorkspaceActionError, type Destination } from "./workspace-ux-state";

type DeckEditorDraft = { editing: boolean; title: string; body: string; deckId: string; deckVersion: number; pageId: string };
type WorkspaceViewProps = {
  topicTaskId?: string; onTopicTaskId?: (id: string) => void;
  state: FixtureState; busy: boolean; error?: WorkspaceActionError; text: string; answer: string; correction: string;
  activeRequest?: AbortController;
  activeAgentRequest?: ActiveAgentRequest;
  onTextChange: (value: string) => void; onAnswerChange: (value: string) => void; onCorrectionChange: (value: string) => void;
  onChooseFiles?: (files: File[], topic?: TopicRef) => boolean | Promise<boolean>;
  fileImports?: FileImportItem[];
  fileImportBusy?: boolean;
  onRetryFile?: (item: Extract<FileImportItem, { status: "failed" }>) => boolean | Promise<boolean>;
  onChooseFile: (file?: File) => boolean | Promise<boolean>; onCancelRun: () => void; onAction: (body: Record<string, unknown>) => boolean | Promise<boolean>;
  onRetryAction?: () => boolean | Promise<boolean>; onRefreshWorkspace?: () => void | Promise<void>; onDismissError?: () => void;
  initialDestination?: Destination;
  rememberPosition?: boolean;
  workspacePosition?: WorkspacePosition;
  onWorkspacePosition?: (patch: Partial<WorkspacePosition>) => void;
  onTopicReturn?: (topic: TopicRef) => void;
  primary?: string;
  onClarificationAction?: WorkspaceViewProps["onAction"];
  clarificationBusy?: boolean;
  clarificationDrafts?: Record<string, import("@pitchroom/domain").ClarificationResult>;
  onClarificationDraft?: (id: string, result: import("@pitchroom/domain").ClarificationResult) => void;
  runningAction?: ActiveAgentRequest["kind"];
  correctionTarget?: string;
  onCorrectionTarget?: (target: string) => void;
  deckEditor?: DeckEditorDraft;
  onDeckEditor?: (draft: DeckEditorDraft | undefined) => void;

  storyDraft?: StoryDraft;
  onStoryDraft?: (draft: StoryDraft) => void;
  positioningDraft?: { selectedId: string; adjustment: string };
  onPositioningDraft?: (draft: { selectedId: string; adjustment: string }) => void;

};


const Arrow = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 12h15M13 5l7 7-7 7" /></svg>;
const phaseLabel = (phase: FixtureState["project"]["phase"]) => phase.replaceAll("_", " ");
const sourceName = (state: FixtureState, sourceId: string) => [...state.sources, ...(state.removedSources ?? [])].find((source) => source.sourceId === sourceId)?.name ?? sourceId;
function phaseCopy(phase: FixtureState["project"]["phase"]) {
  return ({ empty: "Start with evidence.", materials_ready: "Material is addressable.", reading: "Reading source material.", structuring: "Validating the proposed understanding.", cancelled: "The previous run was cancelled.", failed: "The previous run failed safely." } as Partial<Record<FixtureState["project"]["phase"], string>>)[phase] ?? "Review the proposed understanding.";
}

export function WorkspaceView(props: WorkspaceViewProps) {
  const { state, busy, error } = props;
  const { position, updatePosition, storageNotice } = useWorkspacePosition(state, props.rememberPosition, props.initialDestination);
  const destination = position.destination;
  const current = useMemo(() => state.versions.find(version => version.id === (position.topicReturn?.understandingId ?? state.currentVersionId)), [state, position.topicReturn]);
  const historicalTopic = Boolean(current && current.id !== state.currentVersionId);
  const setDestination = (destination: Destination) => updatePosition({ destination });
  const initialVersion = useRef(state.currentVersionId);
  const unknownTopic = useRef<{ versionId?: string; selection: string } | undefined>(undefined);
  useEffect(() => {
    const pending = unknownTopic.current;
    if (pending && pending.versionId !== state.currentVersionId) {
      updatePosition({ understandingId: state.currentVersionId, overviewSelection: pending.selection });
      unknownTopic.current = undefined;
    }
  }, [state.currentVersionId]);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [positioningDraft, setPositioningDraft] = useState({ selectedId: state.positioning?.appliedDirectionId ?? "original", adjustment: "" });
  const [storyDraft, setStoryDraft] = useState<StoryDraft>({ judgment: "", edit: null });
  const [correctionTarget, setCorrectionTarget] = useState("0:0");
  const [clarificationDrafts, setClarificationDrafts] = useState<Record<string, import("@pitchroom/domain").ClarificationResult>>({});
  const [deckEditor, setDeckEditor] = useState<DeckEditorDraft>();
  const [locked, setLocked] = useState<Destination>();
  const [draftGate, setDraftGate] = useState(false);
  const draftEnabled = Boolean(props.rememberPosition);
  const draftBase = { projectId: state.project.id, enabled: draftEnabled };
  const sourceRevision = JSON.stringify(state.sources.map(source => ({ id: source.sourceId, hash: source.contentHash })).sort((a, b) => a.id.localeCompare(b.id)));
  const understandingContext = JSON.stringify([state.currentVersionId, sourceRevision]);
  const savedBrief = state.brief ?? { head: null, versions: [] };
  const savedBriefText = briefText(savedBrief);
  const brief = useLocalDraft({ ...draftBase, kind: "brief", context: savedBrief.head?.id ?? "none", schema: textDraftSchema, initial: savedBriefText, hasContent: value => value !== savedBriefText });
  const selectedPosition = (position.topicReturn ? `${position.topicReturn.kind}:${position.topicReturn.index}` : position.overviewSelection).split(":");
  const taskTopic: TopicRef | undefined = current ? { understandingId: current.id, kind: selectedPosition[0] === "gap" ? "gap" : "theme", index: Number(selectedPosition[1]) } : undefined;
  const topicTaskId = taskTopic ? position.taskSelections?.find(selection => sameTopic(selection, taskTopic))?.taskId : undefined;
  const availableTasks = current ? topicTasksFor(current.proposal, selectedPosition[0] === "gap" ? "gap" : "theme", Number(selectedPosition[1])) : [];
  const selectedTopicTask = availableTasks.find(task => task.id === topicTaskId) ?? availableTasks[0];
  const setTopicTaskId = (taskId: string) => {
    const task = availableTasks.find(task => task.id === taskId);
    if (!taskTopic || !task) return;
    const ownerTopic: TopicRef = { understandingId: taskTopic.understandingId, kind: "theme", index: task.themeIndex };
    const contexts = sameTopic(taskTopic, ownerTopic) ? [taskTopic] : [taskTopic, ownerTopic];
    updatePosition({ taskSelections: [...(position.taskSelections ?? []).filter(selection => !contexts.some(topic => sameTopic(selection, topic))), ...contexts.map(topic => ({ ...topic, taskId }))] });
  };
  const answerContext = selectedTopicTask && current?.proposal.topicTasks !== undefined ? JSON.stringify([understandingContext, selectedTopicTask.id, selectedTopicTask.themeIndex]) : understandingContext;
  const [topicAnswers, setTopicAnswers] = useState<Record<string, string>>({});
  const answerDraft = useLocalDraft({ ...draftBase, kind: "answer", context: answerContext, schema: textDraftSchema, initial: "", hasContent: value => Boolean(value) });
  const corrections = useLocalDraft({ ...draftBase, kind: "corrections", context: understandingContext, schema: correctionDraftSchema, initial: { selectedTarget: "0:0", values: {} }, hasContent: value => Object.values(value.values).some(Boolean) });
  const storyInput = useLocalDraft({ ...draftBase, kind: "story", context: JSON.stringify([state.currentVersionId, state.positioning?.id, state.positioning?.appliedDirectionId, state.story?.head, sourceRevision]), schema: storyDraftSchema, initial: { judgment: "", edit: null }, hasContent: value => Boolean(value.judgment || value.edit) });
  const deckInput = useLocalDraft({ ...draftBase, kind: "deck", context: JSON.stringify([state.currentVersionId, state.positioning?.id, state.story?.head, position.deckId, position.pageId, sourceRevision]), schema: deckDraftSchema, initial: undefined, hasContent: value => Boolean(value?.editing) });
  const effectiveText = draftEnabled ? brief.value : props.text;
  const briefDirty = effectiveText !== savedBriefText;
  const effectiveAnswer = draftEnabled ? answerDraft.value : topicAnswers[answerContext] ?? (current?.proposal.topicTasks === undefined ? props.answer : "");
  const effectiveTarget = draftEnabled ? corrections.value.selectedTarget : correctionTarget;
  const effectiveCorrection = draftEnabled ? corrections.value.values[effectiveTarget] ?? "" : props.correction;
  const changeText = (value: string) => { if (draftEnabled) brief.set(value); props.onTextChange(value); };
  const changeAnswer = (value: string) => { if (draftEnabled) answerDraft.set(value); setTopicAnswers(values => ({ ...values, [answerContext]: value })); props.onAnswerChange(value); };
  const changeCorrection = (value: string) => { if (draftEnabled) corrections.set({ ...corrections.value, values: { ...corrections.value.values, [effectiveTarget]: value } }); props.onCorrectionChange(value); };
  const changeTarget = (target: string) => { if (draftEnabled) corrections.set({ ...corrections.value, selectedTarget: target }); setCorrectionTarget(target); };
  const changeStory = (value: StoryDraft) => { if (draftEnabled) { if (!value.judgment && !value.edit) storyInput.setIfUnchanged(storyInput.value, value); else storyInput.set(value); } setStoryDraft(value); };
  const changeDeck = (value: DeckEditorDraft | undefined) => { if (draftEnabled) { if (!value) deckInput.setIfUnchanged(deckInput.value, value); else deckInput.set(value); } setDeckEditor(value); };
  const ux = deriveWorkspaceUXState(state, props.activeAgentRequest, { ...props, text: briefDirty ? effectiveText : "", destination, selectedDirectionId: positioningDraft.selectedId, adjustment: positioningDraft.adjustment });
  const { activity } = ux;
  const navigate = (next: Destination) => {
    if (!ux.access[next].allowed) { setLocked(next); return; }
    setLocked(undefined); setDestination(next);

  };
  useEffect(() => { document.getElementById("workspace")?.focus(); }, [destination]);
  const guardedAction = async (body: Record<string, unknown>) => {
    const feedbackDecision = ["apply_clarification","dismiss_clarification","retry_clarification"].includes(String(body.action));
    if (ux.mutationLocked && !(feedbackDecision && !props.busy && !props.error && !ux.running)) return false;
    if (["accept", "run", "generate_positioning", "apply_positioning", "generate_deck"].includes(String(body.action)) && (briefDirty || effectiveAnswer.trim() || (draftEnabled ? Object.values(corrections.value.values).some(value => value.trim()) : effectiveCorrection.trim()) || positioningDraft.adjustment.trim())) { setDraftGate(true); return false; }
    const committedBrief = brief.captureSubmission();
    const committedAnswer = answerDraft.captureSubmission();
    const committedCorrection = corrections.captureSubmission({ ...corrections.value, values: { ...corrections.value.values, [effectiveTarget]: "" } });
    const committedStory = storyInput.captureSubmission();
    const committedDeck = deckInput.captureSubmission();
    if (body.action === "keep_unknown") unknownTopic.current = { versionId: state.currentVersionId, selection: position.overviewSelection };
    const result = await props.onAction(body);
    if (!result && body.action === "keep_unknown") unknownTopic.current = undefined;
    if (result && body.action === "submit_clarification" && !body.rebaseTaskId) setTopicAnswers(values => ({ ...values, [answerContext]: "" }));
    if (result && draftEnabled) {
      if (body.action === "save_brief") committedBrief();
      if (body.action === "answer" || (body.action === "submit_clarification" && !body.rebaseTaskId)) committedAnswer();
      if (body.action === "correct") committedCorrection();
      if (body.action === "propose_story") committedStory();
      if (body.action === "edit_deck_page") committedDeck();
    }
    return result;
  };
  const viewProps = { ...props, topicTaskId, onTopicTaskId: setTopicTaskId, onTopicReturn: (topic: TopicRef) => updatePosition({ destination: "clarify", topicReturn: topic, overviewSelection: `${topic.kind}:${topic.index}` }), text: effectiveText, answer: effectiveAnswer, correction: effectiveCorrection, onTextChange: changeText, onAnswerChange: changeAnswer, onCorrectionChange: changeCorrection, workspacePosition: position, onWorkspacePosition: updatePosition, storyDraft: draftEnabled ? storyInput.value : storyDraft, onStoryDraft: changeStory, busy: ux.mutationLocked, primary: ux.primary, clarificationDrafts, onClarificationDraft: (id: string, result: import("@pitchroom/domain").ClarificationResult) => setClarificationDrafts(drafts=>({...drafts,[id]:result})), onClarificationAction: guardedAction, clarificationBusy: props.busy || Boolean(props.error) || Boolean(ux.running), runningAction: ux.running ? activity?.kind : undefined, onAction: guardedAction, onChooseFile: props.busy || ux.running ? () => false : props.onChooseFile, positioningDraft, onPositioningDraft: setPositioningDraft, deckEditor: draftEnabled ? deckInput.value : deckEditor, onDeckEditor: changeDeck, correctionTarget: effectiveTarget, onCorrectionTarget: changeTarget };
  const agentBusy = activity?.status === "queued" || activity?.status === "running";
  useEffect(() => { if (!initialVersion.current && state.currentVersionId) setDestination("clarify"); initialVersion.current = state.currentVersionId; }, [state.currentVersionId]);

  return <main className="appShell" aria-busy={agentBusy || (busy && !props.activeAgentRequest)} data-phase={state.project.phase}>
    <a className="skip" href="#workspace">Skip to workspace</a>
    <header className="topbar"><div className="topInner"><div className="logo">PITCHROOM</div><div className="projectId"><strong>{state.project.name}</strong><span className="demoLabel">{state.mode === "live" ? "DeepSeek live" : "Local agent"}</span></div></div></header>
    <div className="navShell"><div className="navInner"><nav className="nav" aria-label="Project workspace">{(["materials", "clarify", "positioning", "deck"] as Destination[]).map(item => <button key={item} aria-current={destination === item ? "page" : undefined} aria-label={item[0].toUpperCase() + item.slice(1)} data-locked={!ux.access[item].allowed} aria-describedby={!ux.access[item].allowed ? `lock-${item}` : undefined} onClick={() => navigate(item)}>{item[0].toUpperCase() + item.slice(1)}{!ux.access[item].allowed && <span className="srOnly" id={`lock-${item}`}> — {ux.access[item].reason}</span>}</button>)}</nav><span className="navNote">{state.mode === "live" ? "DeepSeek · Persistent project" : "Synthetic project · Local session"}</span></div></div>
    <div className="announcer" aria-live="polite">{activity ? `${activity.title}: ${activity.status}` : busy ? "Saving…" : `Project state: ${phaseLabel(state.project.phase)}`}</div>
    {draftEnabled && <section className="localDrafts" aria-label="Local draft recovery"><small>Unsubmitted drafts stay in this browser for seven days. Nothing is submitted automatically.</small><DraftRecovery label="brief" draft={brief} describe={value => value}/><DraftRecovery label="answer" draft={answerDraft} describe={value => value}/><DraftRecovery label="correction" draft={corrections} describe={value => Object.values(value.values).filter(Boolean).join("\n\n")}/><DraftRecovery label="Story" draft={storyInput} describe={value => [value.judgment, value.edit?.title, value.edit?.body].filter(Boolean).join("\n\n")}/><DraftRecovery label="Deck" draft={deckInput} describe={value => [value?.title, value?.body].filter(Boolean).join("\n\n")}/></section>}
    {storageNotice && <p role="status" className="capabilityHint">{storageNotice}</p>}
    {error && <ActionRecovery busy={busy} error={error} onRetry={props.onRetryAction} onRefresh={props.onRefreshWorkspace} onDismiss={props.onDismissError} />}
    {!error && state.project.phase === "failed" && <div className="recoveryNotice" role="status"><strong>The agent did not create a new understanding.</strong><span>Your material is saved. You can safely retry the agent.</span></div>}
    <AgentStream activity={activity} />
    {ux.running && <p className="capabilityHint" role="status">{ux.checkpoint}</p>}
    {locked && <section className="navigationReason" role="status"><p>{ux.access[locked].reason}</p><button className="btn" onClick={() => navigate(ux.access[locked].target)}>Go to {ux.access[locked].target}</button></section>}
    {draftGate && <section className="draftGate" role="region" aria-label="Unsaved input"><h2>Review your unsaved input first.</h2><p>Save the brief, answer, correction or positioning adjustment before continuing. Your drafts are retained when switching destinations.</p><button className="btn primary" onClick={() => setDraftGate(false)}>Keep editing</button><button className="btn" onClick={() => { changeText(savedBriefText); changeAnswer(""); if (draftEnabled) { corrections.set({ selectedTarget: effectiveTarget, values: {} }); props.onCorrectionChange(""); } else changeCorrection(""); setPositioningDraft(draft => ({ ...draft, adjustment: "" })); setDraftGate(false); }}>Discard unsaved input</button></section>}
    <p className="capabilityHint">{destination === "materials" ? "Add text, Markdown or pasted notes. Sources remain inspectable." : destination === "clarify" ? "Review source-linked understanding, correct it or leave unknowns open. Only you accept a version." : destination === "positioning" ? "Compare proposals and their tradeoffs. Previewing never applies a direction." : "Review and edit the discussion draft. Saving edits creates a new version."}</p>
    <div id="workspace" data-recovery={Boolean(error || draftGate)} className="workspaceMain" tabIndex={-1}>{!ux.access[destination].allowed && !(destination === "clarify" && current && position.topicReturn) ? <section className="navigationReason"><h2>This step needs your review.</h2><p>{ux.access[destination].reason}</p><button className="btn primary" onClick={() => navigate(ux.access[destination].target)}>Go to {ux.access[destination].target}</button></section> : destination === "materials" ? <MaterialsView {...viewProps} onContinue={() => navigate("clarify")} /> : destination === "clarify" ? <><ClarifyView {...viewProps} onAction={historicalTopic ? () => false : viewProps.onAction} onClarificationAction={historicalTopic ? () => false : viewProps.onClarificationAction} clarificationBusy={viewProps.clarificationBusy || historicalTopic} busy={viewProps.busy || historicalTopic} current={current} onMaterials={() => navigate("materials")} onPositioning={() => navigate("positioning")} />{current && !historicalTopic && <ClaimCorrectionPanel {...viewProps} current={current} />}</> : destination === "positioning" ? <PositioningView {...viewProps} onDeck={() => setDestination("deck")} /> : <DeckView {...viewProps} onPositioning={() => navigate("positioning")} />}</div>
    {process.env.NODE_ENV !== "production" && <AgentInspector state={state} busy={busy} open={inspectorOpen} onToggle={() => setInspectorOpen((value) => !value)} />}
  </main>;
}

function ActionRecovery({ error, onRetry, onRefresh, onDismiss, busy }: { busy?: boolean; error: WorkspaceActionError; onRetry?: () => boolean | Promise<boolean>; onRefresh?: () => void | Promise<void>; onDismiss?: () => void }) {
  const actionLabel = error.action === "understanding" ? "understanding" : error.action === "positioning" ? "positioning directions" : error.action === "deck" ? "deck draft" : "action";
  const stoppedTitle = error.action === "positioning" ? "New positioning directions were not completed." : error.action === "understanding" ? "A new understanding was not completed." : error.action === "deck" ? "The new deck draft was not completed." : "The action was not completed.";
  return <section className="actionRecovery" role="alert" aria-labelledby="action-recovery-title">
    <div><span className="eyebrow">{error.outcomeUnknown ? "Action interrupted" : "Action stopped"}</span><h2 id="action-recovery-title">{error.outcomeUnknown ? "Completion has not been confirmed." : stoppedTitle}</h2><p>{error.message}</p></div>
    <div className="recoveryEvidence"><span><strong>Preserved</strong> Previously saved project work remains available.</span><span><strong>Unconfirmed</strong> The interface has not confirmed a new {actionLabel} result.</span></div>
    <div className="recoveryActions">{error.recovery === "retry" && onRetry && <button className="btn primary" disabled={busy} onClick={() => void onRetry()}>Retry {actionLabel}</button>}{error.recovery === "refresh" && onRefresh && <button className="btn primary" onClick={() => void onRefresh()}>Refresh workspace</button>}{(error.recovery === "review" || error.recovery === "none") && onDismiss && <button className="btn" onClick={onDismiss}>Review current step</button>}{error.outcomeUnknown && onRefresh && error.recovery !== "refresh" && <button className="btn" disabled={busy} onClick={() => void onRefresh()}>Refresh workspace</button>}<details><summary>Technical details</summary><p>{error.technicalMessage}</p><code>{error.code}{error.requestId ? ` · Request ${error.requestId}` : ""}</code></details></div>
  </section>;
}

function AgentStream({ activity }: { activity?: AgentActivity }) {
  if (!activity) return null;
  const statusCopy = {
    queued: { eyebrow: "Agent request received", state: "Starting" },
    running: { eyebrow: "Agent working", state: "Streaming" },
    completed: { eyebrow: "Agent completed", state: "Saved" },
    failed: { eyebrow: "Agent stopped", state: "Needs review" },
    cancelled: { eyebrow: "Agent cancelled", state: "Stopped" },
  }[activity.status];
  return <section className="agentStream" data-status={activity.status} aria-live="polite" aria-label="Live agent progress">
    <header><span className="streamPulse" aria-hidden="true" /><div><span className="eyebrow">{statusCopy.eyebrow}</span><h2>{activity.title}</h2></div><span className="streamState">{statusCopy.state}</span></header>
    <ol>{activity.events.length > 0 ? activity.events.slice(-6).map((event) => <li key={`${event.sequence}:${event.label}`}><span>{event.label.replaceAll("_", " ")}</span><small>{event.detail}</small></li>) : <li><span>Request accepted</span><small>Waiting for the first persisted Agent event.</small></li>}</ol>
    <p>{activity.status === "completed" ? "The validated result is saved and ready for review." : activity.status === "failed" ? "No unvalidated result was promoted. Review the recovery options above." : "Partial activity is visible now. Generated content appears only after schema, evidence, and safety validation."}</p>
  </section>;
}

function MaterialsView({ onTopicReturn, onChooseFiles, fileImportBusy, fileImports, onRetryFile, state, busy, primary, runningAction, text, onTextChange, onChooseFile, onAction: performAction, onContinue }: WorkspaceViewProps & { onContinue: () => void }) {
  const chooseFiles = async (files: File[]) => { if (!files.length) return false; if (onChooseFiles) return onChooseFiles(files); let saved = true; for (const file of files) saved = await onChooseFile(file) && saved; return saved; };
  const results = fileImports?.length ? <section role="region" aria-label="File import results"><h2>File import results</h2><p>Only saved sources are ready for review. Selected files remain in this tab for explicit retry.</p><ul>{fileImports.map(item => <li key={item.id}><span>{`${item.name} — ${item.status === "saved" ? "Saved" : item.status === "failed" ? item.outcomeUnknown ? "Save not confirmed" : "Not imported" : item.status === "queued" ? "Waiting" : "Importing"}`}</span>{item.status === "failed" && <><p>{item.message}</p>{item.outcomeUnknown && <p>The save may have completed. Retry checks the same operation without importing it twice.</p>}<button className="btn" disabled={fileImportBusy} onClick={() => onRetryFile?.(item)}>Retry {item.name}</button></>}</li>)}</ul></section> : null;
  const canRun = ["materials_ready", "cancelled", "failed"].includes(state.project.phase);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteSource, setDeleteSourceState] = useState<FixtureState["sources"][number]>();
  const keepDeleteDialogOpen = useRef(false);
  const setDeleteSource = (source?: FixtureState["sources"][number]) => {
    if (!source && keepDeleteDialogOpen.current) { keepDeleteDialogOpen.current = false; return; }
    setDeleteSourceState(source);
  };
  const onAction = async (body: Record<string, unknown>) => {
    const succeeded = await performAction(body);
    if (body.action === "remove_material" && !succeeded) keepDeleteDialogOpen.current = true;
    return succeeded;
  };
  if (!state.sources.length && !state.removedSources?.length) return <section className="intake">{results}<div className="intakeHeading"><span className="intakeLabel">Your next client conversation</span><h1>Start with<br />what you have.</h1><p>A brief, interview notes, a half-finished deck.<br />We’ll help you find the story inside.</p></div><p className="stateContract">{phaseCopy(state.project.phase)}</p><label className="dropzone" htmlFor="material-file"><span className="plus">+</span><strong>Drop your materials here</strong><span className="small muted">or choose a text or Markdown file</span><input id="material-file" className="fileInputOverlay" disabled={busy} type="file" multiple accept=".txt,.md,text/plain,text/markdown" aria-label="Drop your materials here or choose a text or Markdown file" onChange={async (event) => { const input = event.currentTarget; await chooseFiles(Array.from(input.files ?? [])); input.value = ""; }} /></label><BriefEditor initial brief={state.brief ?? {head:null,versions:[]}} value={text} busy={busy} reviewNotice={state.sources.find(source=>source.kind==="brief")?.agentReview?.message} onChange={onTextChange} onSave={() => onAction({action:"save_brief",expectedVersionId:state.brief?.head?.id ?? null,text})}/><p className="note intakeDisclaimer">This implementation reads text and Markdown. Every supported claim remains linked to an exact source quote.</p></section>;
  const fileSources = state.sources.filter(source => source.kind !== "brief");
  const reviewCount = state.sources.filter((source) => source.agentReview).length;
  return <section className="materialLibrary">{results}<header className="libraryHeading"><div><h1>Your project materials.</h1><p>Add to the project without restarting the conversation.</p></div><button className="btn" disabled={busy} onClick={() => setUploadOpen(true)}>Add files <Arrow /></button></header><p className="stateContract">{phaseCopy(state.project.phase)}</p>{reviewCount > 0 && <div className="materialSafetySummary" role="status"><div><strong>{reviewCount} source{reviewCount === 1 ? "" : "s"} need agent review</strong><span>The original text is preserved below. Flagged passages stay outside Agent-generated understanding, positioning, and deck content.</span></div></div>}<div className="libraryInventory"><div className="inventoryHeading"><h2>Source files</h2><span>{fileSources.length} file{fileSources.length === 1 ? "" : "s"}</span></div>{fileSources.map((source) => <div className={source.agentReview ? "fileRowShell needsAgentReview" : "fileRowShell"} key={source.sourceId}><details className="fileRow"><summary><span className="fileType">{source.mediaType === "text/markdown" ? "MD" : "TXT"}</span><span className="grow"><span className="fileName">{source.name}</span><span className="fileMeta">{source.chunks.length} citeable passage{source.chunks.length === 1 ? "" : "s"}</span>{((state.topicMaterials ?? []).some(link => link.sourceId === source.sourceId) || !state.versions.find(version => version.id === state.currentVersionId)?.proposal.themes.some(theme => theme.claims.some(claim => claim.evidence.some(evidence => evidence.sourceId === source.sourceId)))) && <span className="agentReviewBadge">Needs review</span>}{source.agentReview && <span className="agentReviewBadge">Agent review required</span>}</span><span className="fileView">View source</span></summary>{source.agentReview && <div className="sourceSafetyNotice"><strong>{source.agentReview.affectedChunks} passage{source.agentReview.affectedChunks === 1 ? "" : "s"} isolated</strong><p>{source.agentReview.message}</p></div>}<ol>{source.chunks.map((chunk) => <li key={chunk.id}><code>{chunk.id}</code><p>{chunk.text}</p></li>)}</ol></details><div>{(state.topicMaterials ?? []).filter(link => link.sourceId === source.sourceId).map(link => <div key={`${link.understandingId}:${link.kind}:${link.index}`}><span>Needs review · </span><button className="plain" onClick={() => onTopicReturn?.(link)}>Return to {link.label}</button><button className="plain" disabled={busy} onClick={() => onAction({ action: "unlink_topic_material", topic: link, sourceId: source.sourceId })}>Unlink {link.label}</button></div>)}</div><button className="plain removeMaterial" disabled={busy} onClick={() => setDeleteSource(source)} aria-label={`Remove ${source.name}`}>Remove</button></div>)}</div>{Boolean(state.removedSources?.length) && <details><summary>Removed sources · historical references</summary>{state.removedSources?.map(source => <details key={source.sourceId}><summary>{source.name} · Removed</summary><p>{source.content}</p></details>)}</details>}<BriefEditor brief={state.brief ?? {head:null,versions:[]}} value={text} busy={busy} reviewNotice={state.sources.find(source=>source.kind==="brief")?.agentReview?.message} onChange={onTextChange} onSave={() => onAction({action:"save_brief",expectedVersionId:state.brief?.head?.id ?? null,text})}/><div className="libraryFooter"><div /><div className="footerButtons">{canRun && <button className={primary === "run" ? "btn primary" : "btn"} disabled={busy} onClick={() => onAction({ action: "run" })}>{runningAction === "understanding" ? "Reading material…" : state.project.phase === "materials_ready" ? "Run understanding agent" : "Retry agent"}<Arrow /></button>}<button className={primary === "clarify" ? "btn primary" : "btn"} disabled={!state.currentVersionId} onClick={onContinue}>Back to Clarify <Arrow /></button></div></div>{uploadOpen && <div className="modalBackdrop" role="presentation"><section className="modalCard" role="dialog" aria-modal="true" aria-labelledby="upload-title"><h2 id="upload-title">Add source material</h2><p>Choose a UTF-8 text or Markdown file. It will be added immediately and the current understanding will wait for a new run.</p><label className="uploadPicker" htmlFor="upload-material-file">Choose file<input id="upload-material-file" className="fileInputOverlay" disabled={busy} type="file" multiple accept=".txt,.md,text/plain,text/markdown" aria-label="Choose a UTF-8 text or Markdown file" onChange={async (event) => { const input = event.currentTarget; try { await chooseFiles(Array.from(input.files ?? [])); } finally { setUploadOpen(false); input.value = ""; } }} /></label><div className="dialogActions"><button className="btn" onClick={() => setUploadOpen(false)}>Cancel</button></div></section></div>}{deleteSource && <div className="modalBackdrop" role="presentation"><section className="modalCard" role="alertdialog" aria-modal="true" aria-labelledby="delete-title"><h2 id="delete-title">Remove this source?</h2><p><strong>{deleteSource.name}</strong> will leave the active project. Existing understanding versions remain in history, but you must run the agent again before continuing.</p><div className="dialogActions"><button className="btn" onClick={() => setDeleteSource(undefined)}>Keep file</button><button className="btn danger" disabled={busy} onClick={async () => { await onAction({ action: "remove_material", sourceId: deleteSource.sourceId }); setDeleteSource(undefined); }}>Remove file</button></div></section></div>}</section>;
}

function ClarifyView({ topicTaskId, onTopicTaskId, onChooseFiles, fileImports, onRetryFile, workspacePosition, onWorkspacePosition, state, busy, primary, onClarificationAction, clarificationBusy, clarificationDrafts, onClarificationDraft, answer, correction, activeRequest, onAnswerChange, onCorrectionChange, onCancelRun, onAction, current, onMaterials, onPositioning }: WorkspaceViewProps & { current?: FixtureState["versions"][number]; onMaterials: () => void; onPositioning: () => void }) {
  const overviewSelection = workspacePosition?.topicReturn && workspacePosition.topicReturn.understandingId === current?.id ? `${workspacePosition.topicReturn.kind}:${workspacePosition.topicReturn.index}` : workspacePosition?.overviewSelection ?? "theme:0";
  const setOverviewSelection = (overviewSelection: string) => {
    const [kind, index] = overviewSelection.split(":");
    onWorkspacePosition?.({ overviewSelection, topicReturn: current && current.id !== state.currentVersionId && (kind === "theme" || kind === "gap") ? { understandingId: current.id, kind, index: Number(index) } : undefined });
  };

  if (!current) return <section className="clarifyWaiting"><header className="workspaceHeading"><h1>Find the story in the material.</h1><span className="small muted">Keep unknowns open.</span></header><div className="waitingCard"><span className="eyebrow">{state.project.phase === "reading" ? "Reading material" : state.project.phase === "structuring" ? "Checking source links" : "Ready to begin"}</span><h2>{phaseCopy(state.project.phase)}</h2><p>No understanding version appears until every supported claim has a valid exact quote.</p>{state.project.phase === "materials_ready" ? <button className="btn primary" disabled={busy} onClick={() => onAction({ action: "run" })}>Run understanding agent <Arrow /></button> : state.project.phase === "cancelled" || state.project.phase === "failed" ? <button className="btn" disabled={busy} onClick={() => onAction({ action: "run" })}>Retry agent</button> : activeRequest && <button className="btn" onClick={onCancelRun}>Cancel run</button>}</div></section>;

  const [selectionKind, selectionIndexText] = overviewSelection.split(":");
  const selectionIndex = Number(selectionIndexText);
  const selectedTheme = selectionKind === "theme" ? current.proposal.themes[selectionIndex] : undefined;
  const selectedGap = selectionKind === "gap" ? current.proposal.gaps[selectionIndex] : undefined;
  const tasks = topicTasksFor(current.proposal, selectionKind === "gap" ? "gap" : "theme", selectionIndex);
  const selectedTask = tasks.find(task => task.id === topicTaskId) ?? tasks[0];
  const question = selectedTask?.question;
  const questionTheme = selectedTask?.themeIndex ?? current.proposal.nextQuestion.relatedThemeIndexes.find(index => current.proposal.themes[index]);
  const hasSelectedQuestion = Boolean(selectedTask && question);
  const returnToQuestion = () => { if (selectedTask) onTopicTaskId?.(selectedTask.id); setOverviewSelection(`theme:${questionTheme ?? 0}`); };

  return <section className="clarifyPage">
    <header className="workspaceHeading"><h1>Find the story in the material.</h1><span className="small muted">Keep unknowns open.</span></header>
    {current.id !== state.currentVersionId && <div role="status">Original topic from Understanding v{current.number} · read only. <button onClick={() => onWorkspacePosition?.({ topicReturn: undefined })}>Return to current Understanding</button></div>}
    <div className="preparationGrid">
      <aside className="projectMap">
        <details><summary>Project overview</summary>
        <div className="compactClusters" aria-label="Project topics">
          {current.proposal.themes.map((theme, index) => {
            const key = `theme:${index}`;
            return <button type="button" aria-pressed={overviewSelection === key} className={overviewSelection === key ? "mapRow active" : "mapRow"} key={theme.title} onClick={event => { setOverviewSelection(key); event.currentTarget.closest("details")?.removeAttribute("open"); }}><span className="mapName">{theme.title}</span><span className="mapStatus">{(state.topicMaterials ?? []).some(link => link.understandingId === current.id && link.kind === "theme" && link.index === index) ? "Needs review" : theme.claims.some((claim) => claim.evidenceState === "unknown") ? "Needs context" : theme.claims.some((claim) => claim.evidenceState === "conflicting") ? "Needs review" : "Material available"}</span></button>;
          })}
          {current.proposal.gaps.map((gap, index) => {
            const key = `gap:${index}`;
            return <button type="button" aria-pressed={overviewSelection === key} className={overviewSelection === key ? "mapRow active" : "mapRow"} key={gap.description} onClick={event => { setOverviewSelection(key); event.currentTarget.closest("details")?.removeAttribute("open"); }}><span className="mapName">Open question {index + 1}</span><span className="mapStatus partial">{(state.topicMaterials ?? []).some(link => link.understandingId === current.id && link.kind === "gap" && link.index === index) ? "Needs review" : "Not provided"}</span></button>;
          })}
        </div>
        <button className="plain manageMaterials" onClick={onMaterials}>Manage materials <span>{state.sources.length}</span></button></details>
      </aside>
      <section className="contextWork">
        {state.clarifications?.at(-1) && <details><summary>Saved answer · Before / Now</summary><ClarificationPanel understanding={{ versionId: state.currentVersionId, phase: state.project.phase, proposal: current.proposal }} draft={clarificationDrafts?.[state.clarifications.at(-1)!.id]} onDraft={result=>onClarificationDraft?.(state.clarifications!.at(-1)!.id,result)} task={state.clarifications.at(-1)!} revision={state.project.revision} busy={Boolean(clarificationBusy)} onAction={onClarificationAction ?? onAction} /></details>}
        <section className="understanding"><div className="row between"><h2>What we understand so far</h2><a className="plain" href="#specific-correction-section">Correct this</a></div><details className="understandingSummary"><summary>All understood topics</summary><p className="summaryCopy">{current.proposal.themes.map((theme) => theme.summary).join(" ")}</p></details>{current.proposal.themes.some(theme=>theme.summaryInterpretation) && <p className="summaryAttribution">{current.proposal.themes.some(theme=>theme.summaryInterpretation?.editedByUser) ? "User-edited interpretation" : "Agent interpretation"} · Based on saved user input · Not a verified source fact</p>}<span className="summaryAttribution">Understanding v{current.number} · {current.createdBy === "user" ? "User revision" : "Agent proposal"} · Source-linked</span></section>
        {selectedTheme && <article className="overviewFocus" aria-live="polite"><span className="eyebrow">Selected topic</span><h2>{selectedTheme.title}</h2><p>{selectedTheme.summary}</p><a className="plain" href={`#theme-${selectionIndex}`}>Inspect {selectedTheme.claims.length} claim{selectedTheme.claims.length === 1 ? "" : "s"}</a></article>}
        {selectedGap && <article className="overviewFocus gapFocus" aria-live="polite"><span className="eyebrow">Open question {selectionIndex + 1}</span><h2>{selectedGap.description}</h2><p>{selectedGap.whyItMatters}</p><button className="plain" onClick={returnToQuestion}>Back to the current useful question</button></article>}
        {tasks.length > 1 && <details><summary>Other questions for this topic</summary>{tasks.map(task => <button key={task.id} aria-pressed={task.id === selectedTask?.id} onClick={() => onTopicTaskId?.(task.id)}>{task.question.question}</button>)}</details>}
        {hasSelectedQuestion && selectedTask && question ? <article className="focusedQuestion"><div className="questionMeta"><span>{question.relatedThemeIndexes.map(i => current.proposal.themes[i]?.title).filter(Boolean).join(" · ") || "Open question"}</span><span>{current.proposal.gaps.length} to clarify</span></div><h2>{question.question}</h2><details className="questionRationale"><summary>Why this matters</summary><p>{question.whyItMatters}</p></details><div className="answerLabel"><label htmlFor="answer">{state.project.phase === "accepted" ? "Revise accepted understanding" : "Your context"}</label><span className="small muted">A few sentences are enough.</span></div><textarea id="answer" aria-label="Answer the agent’s question" placeholder="It’s okay not to know yet." value={answer} onChange={(event) => onAnswerChange(event.target.value)} /><div className="questionActions"><button className="plain" aria-label="Keep unknown" disabled={busy || state.project.phase !== "review_required"} onClick={() => onAction({ action: "keep_unknown", expectedRevision: state.project.revision })}>Not sure yet</button><button className={primary === "answer" ? "btn primary" : "btn"} disabled={busy || !["review_required","accepted"].includes(state.project.phase) || !answer.trim()} onClick={() => onAction({ action: "submit_clarification", selection: { understandingId: current.id, taskId: selectedTask.id, themeIndex: selectedTask.themeIndex }, text: answer, expectedRevision: state.project.revision })}>{state.project.phase === "accepted" ? "Propose revision to accepted understanding" : "Save answer & reassess"}</button></div></article> : <article className="focusedQuestion"><h2>No question is linked to this topic yet.</h2><p>Add supporting material or leave this topic unknown. No other topic’s question is substituted. Your unsent answers are retained.</p>{!selectedGap && <button className="plain" onClick={returnToQuestion}>Back to the current useful question</button>}</article>}
        {(selectedTheme || selectedGap) && <TopicMaterials state={state} busy={busy} topic={{ understandingId: current.id, kind: selectedTheme ? "theme" : "gap", index: selectionIndex }} onChooseFiles={onChooseFiles} onAction={onAction} onMaterials={onMaterials} fileImports={fileImports} onRetryFile={onRetryFile} />}
        <details className="evidenceDisclosure"><summary>What the material actually says</summary>{current.proposal.themes.map((theme, themeIndex) => <section className="themeReview" id={`theme-${themeIndex}`} key={theme.title}><h3>{theme.title}</h3><p>{theme.summary}</p>{theme.claims.map((claim, index) => <div className="claim" key={`${claim.statement}-${index}`}><span className={`status status-${claim.evidenceState}`}>{claim.evidenceState.replace("_", " ")}</span><p>{claim.statement}</p>{claim.supersededBy && <small>Superseded by saved user input · {claim.supersededBy.inputId} · Retained as history</small>}{claim.evidence.map((evidence) => <blockquote key={`${evidence.chunkId}:${evidence.quote}`}><span>Exact source quote</span>“{evidence.quote}”<small>{sourceName(state, evidence.sourceId)} · {evidence.chunkId}</small></blockquote>)}{claim.evidenceState === "user_asserted" && <small>User input · {claim.userInputIds.join(", ")}</small>}</div>)}</section>)}</details>

        {state.project.phase === "review_required" && <div className="reviewGate"><div><h2>Your review is the gate</h2><p>Accepting stops the agent at this exact version. It does not generate positioning or a deck.</p></div><button className={primary === "accept" ? "btn primary" : "btn"} disabled={busy} onClick={() => onAction({ action: "accept", expectedRevision: state.project.revision })}>Accept version {current.number}</button></div>}
        {state.project.phase === "accepted" && <div className="accepted" role="status"><div><strong>Understanding accepted.</strong><span>The agent is stopped. This version is the saved input for positioning. You can propose a revision above; it only changes after Apply.</span></div><button className="btn primary" disabled={busy} onClick={onPositioning}>Continue to Positioning <Arrow /></button></div>}
      </section>
    </div>
  </section>;
}

function LegacyPositioningView({ state, busy, runningAction, onAction, onDeck, positioningDraft, onPositioningDraft }: WorkspaceViewProps & { onDeck: () => void }) {
  const positioning = state.positioning;
  const selectedId = positioningDraft?.selectedId ?? positioning?.appliedDirectionId ?? positioning?.proposal.recommendation?.directionId ?? "original";
  const adjustment = positioningDraft?.adjustment ?? "";
  const setSelectedId = (selectedId: string) => onPositioningDraft?.({ selectedId, adjustment: "" });
  const setAdjustment = (adjustment: string) => onPositioningDraft?.({ selectedId, adjustment });
  const [confirmation, setConfirmation] = useState<string>();
  const submitting = useRef(false);
  const fingerprint = JSON.stringify([state.project.revision, state.currentVersionId, positioning?.id, positioning?.number, positioning?.appliedDirectionId, state.deck?.id]);
  const confirmValid = confirmation === fingerprint && selectedId === positioning?.appliedDirectionId && !adjustment.trim();
  const latestRun = [...state.workflowRuns].reverse().find((run) => run.kind === "positioning");
  if (!positioning) return <section className="positioningPage"><header className="workspaceHeading"><div><span className="eyebrow">Positioning</span><h1>Choose the judgment,<br />not just the wording.</h1></div><span className="small muted">Accepted understanding · v{state.project.revision}</span></header>{latestRun?.status === "failed" && <div className="workflowFailure" role="alert"><strong>Positioning generation stopped.</strong><span>{latestRun.failureMessage}</span></div>}<div className="positioningEmpty"><h2>Create a small set of source-grounded directions.</h2><p>The agent will preserve the original framing and propose distinct choices with explicit tradeoffs. Nothing is applied until you choose it.</p><button className="btn primary" disabled={busy} onClick={() => onAction({ action: "generate_positioning", expectedRevision: state.project.revision })}>{runningAction === "positioning" ? "Creating directions…" : latestRun?.status === "failed" ? "Retry positioning agent" : "Create positioning directions"}<Arrow /></button></div></section>;
  const selected = selectedId === "original" ? undefined : positioning.proposal.directions.find((direction) => direction.id === selectedId);
  const message = selected?.coreMessage ?? positioning.proposal.originalFraming.coreMessage;
  const appliedLabel = positioning.appliedDirectionId === "original" ? "Original framing" : positioning.proposal.directions.find((direction) => direction.id === positioning.appliedDirectionId)?.title;
  const downstreamStatus = state.deck ? deriveDownstreamSyncStatus({ artifactKind: state.deck.createdBy === "user" ? "human_edited" : "generated", artifactCoreMessageVersionId: state.deck.proposal.positioningVersionId, currentCoreMessageVersionId: positioning.id }) : undefined;
  return <section className="positioningPage"><header className="workspaceHeading"><div><span className="eyebrow">Positioning</span><h1>Make the tradeoff visible.</h1></div><span className="small muted">Core message v{positioning.number} · {appliedLabel ? `Applied: ${appliedLabel}` : "No direction applied"}</span></header>{downstreamStatus && downstreamStatus !== "synced" && <div className="staleWarning" role="status"><strong>Downstream deck: {downstreamStatus.replaceAll("_", " ")}.</strong><span>{downstreamStatus === "needs_review" ? "This deck contains human edits, so the new core message will not overwrite it. Review and create a new draft." : "The saved draft stays unchanged until you explicitly create a new one from the applied core message."}</span></div>}{latestRun?.status === "failed" && <div className="workflowFailure" role="alert"><strong>Positioning generation stopped.</strong><span>{latestRun.failureMessage}</span></div>}<div className="positioningGrid"><aside className="directionList" aria-label="Positioning directions"><button className={selectedId === "original" ? "directionOption active" : "directionOption"} aria-pressed={selectedId === "original"} disabled={Boolean(adjustment.trim())} onClick={() => { setConfirmation(undefined); setSelectedId("original"); }}><span>Original framing</span><small>Keep the accepted interpretation unchanged</small></button>{positioning.proposal.directions.map((direction) => <button key={direction.id} className={selectedId === direction.id ? "directionOption active" : "directionOption"} aria-pressed={selectedId === direction.id} disabled={Boolean(adjustment.trim())} onClick={() => { setConfirmation(undefined); setSelectedId(direction.id); }}><span>{direction.title}</span><small>{direction.lens === "human_tension" ? "Human tension" : direction.lens === "mechanism" ? "Product mechanism" : direction.tradeoff}</small></button>)}</aside><article className="positioningPaper"><span className="eyebrow">{positioning.appliedDirectionId === selectedId ? "Applied direction" : "Preview only"}</span><h2>{message}</h2>{selected ? <>{selected.positioningThesis && <section className="positioningThesis"><h3>Why this direction exists</h3><p>{selected.positioningThesis}</p>{selected.audience && <small>For {selected.audience}</small>}</section>}<div className="movement"><div><span>From</span><p>{selected.from}</p></div><div><span>To</span><p>{selected.to}</p></div></div>{selected.mechanism && selected.humanTension && <section className="lensComparison"><div><h3>Product mechanism</h3><p>{selected.mechanism}</p></div><div><h3>Human tension</h3><p>{selected.humanTension}</p></div></section>}<section className="positioningConstraint"><h3>Tradeoff</h3><p>{selected.tradeoff}</p><h3>Leaves out</h3><ul>{selected.excludes.map((item) => <li key={item}>{item}</li>)}</ul>{selected.judgmentNote && <><h3>Your judgment note</h3><p>{selected.judgmentNote}</p></>}</section><section className="positioningEvidence"><h3>Why the material supports it</h3>{selected.evidence.map((evidence) => <blockquote key={`${evidence.chunkId}:${evidence.quote}`}>“{evidence.quote}”<small>{sourceName(state, evidence.sourceId)} · {evidence.chunkId}</small></blockquote>)}</section><section className="positioningAdjustment"><label htmlFor="positioning-adjustment">Adjust this direction</label><textarea id="positioning-adjustment" value={adjustment} onChange={(event) => setAdjustment(event.target.value)} placeholder="Write your judgment or exact preferred headline." /><div><button className={adjustment.trim() ? "btn primary" : "btn"} disabled={busy || !adjustment.trim()} onClick={async () => { if (await onAction({ action: "adjust_positioning", directionId: selected.id, mode: "judgment_note", text: adjustment, expectedRevision: state.project.revision })) setAdjustment(""); }}>Save as judgment note</button><button className="btn" disabled={busy || !adjustment.trim()} onClick={async () => { if (await onAction({ action: "adjust_positioning", directionId: selected.id, mode: "headline", text: adjustment, expectedRevision: state.project.revision })) setAdjustment(""); }}>Use exact words as headline</button></div></section></> : <p className="originalNote">This is the original framing carried forward from the accepted understanding. Choosing it is an explicit decision, not a fallback.</p>}<footer className="positioningActions"><span className="small muted">Previewing does not change the project. Applying makes this the single source for new generated artifacts.</span><div>{positioning.appliedDirectionId && <button className="plain" disabled={busy} onClick={() => onAction({ action: "undo_positioning", expectedRevision: state.project.revision })}>Undo latest change</button>}<button className={positioning.appliedDirectionId !== selectedId && !adjustment.trim() && !confirmation ? "btn primary" : "btn"} disabled={busy || Boolean(confirmation) || Boolean(adjustment.trim()) || positioning.appliedDirectionId === selectedId} onClick={() => onAction({ action: "apply_positioning", directionId: selectedId, expectedRevision: state.project.revision })}>{selectedId === "original" ? "Keep original" : "Use this direction"}</button>{positioning.appliedDirectionId === selectedId && <button className={confirmation ? "btn" : "btn primary"} disabled={busy || Boolean(adjustment.trim()) || Boolean(confirmation)} onClick={() => setConfirmation(fingerprint)}>Review deck inputs<Arrow /></button>}
    {confirmation && <section className="deckCheckpoint" role="region" aria-label="Confirm deck generation"><h3>Review before creating a deck</h3><p>Applied direction: <strong>{appliedLabel}</strong></p><p>Understanding: {state.currentVersionId} · revision {state.project.revision}. Five pages: Positioning, Shift, Rationale, Evidence, Open questions.</p><p>{state.deck ? "A new draft will be created. Your existing deck stays in history." : "A new discussion draft will be created."}</p>{!confirmValid && <p role="status">Inputs changed. Cancel and review the current inputs again.</p>}<button className={!confirmValid ? "btn primary" : "btn"} onClick={() => setConfirmation(undefined)}>Cancel deck creation</button><button className={confirmValid ? "btn primary" : "btn"} disabled={busy || !confirmValid} onClick={async () => { if (submitting.current || !confirmValid || busy) return; submitting.current = true; try { if (await onAction({ action: "generate_deck", expectedRevision: state.project.revision })) { setConfirmation(undefined); onDeck(); } } finally { submitting.current = false; } }}>Confirm & create deck</button></section>}</div></footer></article></div></section>;
}

function PositioningHistory({ state }: { state: FixtureState }) {
  if (!state.positioning || state.positioningVersions.length === 0) return null;
  return <section className="coreMessageHistory" aria-labelledby="core-message-history-title">
    <header>
      <div><span className="eyebrow">Version history</span><h2 id="core-message-history-title">Core message decisions</h2></div>
      <span className="small muted">{state.positioningVersions.length} saved version{state.positioningVersions.length === 1 ? "" : "s"}</span>
    </header>
    <p>Earlier wording stays read-only. Undo reverses the latest applied choice; editing creates another version.</p>
    <div className="coreMessageHistoryList">{[...state.positioningVersions].reverse().map((version) => {
      const applied = version.appliedDirectionId === "original"
        ? { title: "Original framing", coreMessage: version.proposal.originalFraming.coreMessage }
        : version.proposal.directions.find((direction) => direction.id === version.appliedDirectionId);
      return <details key={version.id} open={version.id === state.positioning?.id}>
        <summary><strong>Version {version.number}</strong><span>{version.id === state.positioning?.id ? "Current" : "Read only"}</span></summary>
        <p><strong>Applied decision:</strong> {applied?.title ?? "None yet"}</p>
        {applied && <p className="historyMessage">{applied.coreMessage}</p>}
        <small>Saved {new Date(version.createdAt).toLocaleString()}</small>
      </details>;
    })}</div>
  </section>;
}

function PositioningView(props: WorkspaceViewProps & { onDeck: () => void }) {
  if (props.state.story && props.state.positioning) return <StoryPanel state={props.state} busy={props.busy} onAction={props.onAction} onDeck={props.onDeck} draft={props.storyDraft ?? {judgment:"",edit:null}} onDraft={props.onStoryDraft ?? (()=>undefined)}/>;
  const proposal = props.state.positioning?.proposal;
  const recommendation = proposal?.recommendation;
  const recommended = recommendation ? proposal?.directions.find((direction) => direction.id === recommendation.directionId) : undefined;
  return <>
    {recommendation && <section className="agentRecommendation" aria-labelledby="agent-recommendation-title">
      <span className="eyebrow">Agent recommendation</span>
      <h2 id="agent-recommendation-title">I recommend: {recommended?.title}</h2>
      <p><strong>Judgment:</strong> {recommendation.judgment}</p>
      <p><strong>Why it wins:</strong> {recommendation.comparison}</p>
      <details><summary>When I would change this recommendation</summary><ul>{recommendation.conditionsToReconsider.map((condition) => <li key={condition}>{condition}</li>)}</ul></details>
      <small>The Agent gives a judgment. You still decide what to edit or Apply.</small>
    </section>}
    <LegacyPositioningView {...props} />{props.state.positioning?.appliedDirectionId && !props.state.story && <button className="btn" disabled={props.busy} onClick={()=>props.onAction({action:"propose_story",expected:{generation:0,storyId:null},request:{kind:"develop_direction"}})}>Develop working story</button>}
    <PositioningHistory state={props.state} />
  </>;
}

function DeckView({ workspacePosition, onWorkspacePosition, state, busy, onAction, onPositioning, deckEditor, onDeckEditor }: WorkspaceViewProps & { onPositioning: () => void }) {
  const current = state.deck;
  const viewId = workspacePosition?.deckId ?? current?.id ?? "";
  const setViewId = (deckId: string) => onWorkspacePosition?.({ deckId });
  const previousDeck = useRef(current?.id);
  const [reviewAll, setReviewAll] = useState(false);
  const editing = Boolean(deckEditor?.editing);
  const editTitle = deckEditor?.title ?? ""; const editBody = deckEditor?.body ?? "";
  const setEditing = (editing: boolean) => { if (!editing) onDeckEditor?.(undefined); };
  const setEditTitle = (title: string) => { if (deckEditor) onDeckEditor?.({ ...deckEditor, title }); };
  const setEditBody = (body: string) => { if (deckEditor) onDeckEditor?.({ ...deckEditor, body }); };
  useEffect(() => { if (previousDeck.current !== current?.id) { if (current?.id) setViewId(current.id); previousDeck.current = current?.id; } }, [current?.id]);
  const viewed = state.deckVersions.find((version) => version.id === viewId) ?? current;
  const pageIndex = Math.max(0, viewed?.proposal.pages.findIndex(page => page.id === (deckEditor?.pageId ?? workspacePosition?.pageId)) ?? 0);
  const setPageIndex = (index: number) => onWorkspacePosition?.({ pageId: viewed?.proposal.pages[index]?.id });
  if (!current || !viewed) return <section className="deckPage"><h1>No deck draft yet.</h1><button className="btn" onClick={onPositioning}>Return to Positioning</button></section>;
  const historical = viewed.id !== current.id; const page = viewed.proposal.pages[pageIndex] ?? viewed.proposal.pages[0]!;
  const startEdit = () => onDeckEditor?.({ editing: true, title: page.title, body: page.body, deckId: current.id, deckVersion: current.number, pageId: page.id });
  return <section className="deckPage"><header className="workspaceHeading"><div><span className="eyebrow">Discussion deck</span><h1>Draft {viewed.number}</h1></div><div className="deckHeaderActions"><button className="plain" onClick={onPositioning}>Revisit positioning</button><button disabled={editing} className={!editing && !current.stale && !reviewAll ? "btn primary" : "btn"} onClick={() => setReviewAll((value) => !value)}>{reviewAll ? "Single page" : "Review complete deck"}</button><button className="btn" onClick={() => window.print()}>Print / save PDF</button></div></header>{current.stale && <div className="staleWarning" role="status"><strong>This deck is out of date.</strong><span>Your source material or applied positioning changed. This saved draft was not overwritten.</span><button className={!editing ? "btn primary" : "btn"} onClick={onPositioning}>Create a new draft from Positioning</button></div>}{historical && <div className="historicalNotice" role="status">Viewing draft {viewed.number} read-only. <button className="plain" onClick={() => setViewId(current.id)}>Return to current draft</button></div>}<div className="deckLayout"><nav className="deckPages" aria-label="Deck pages">{viewed.proposal.pages.map((candidate, index) => <button key={candidate.id} aria-current={!reviewAll && pageIndex === index ? "page" : undefined} disabled={editing} onClick={() => { setPageIndex(index); setReviewAll(false); }}><span>{index + 1}</span>{candidate.title}</button>)}</nav><div className="deckPaperStack">{(reviewAll ? viewed.proposal.pages : [page]).map((candidate, index) => <article className="deckPaper" key={candidate.id}><span className="eyebrow">{reviewAll ? `Page ${viewed.proposal.pages.findIndex(item=>item.id===candidate.id) + 1}` : `Page ${pageIndex + 1}`}</span><h2>{candidate.title}</h2><p>{candidate.body}</p>{"emphasis" in candidate && candidate.emphasis.length > 0 && <ul className="storyEmphasis">{candidate.emphasis.map((item, emphasisIndex) => <li key={emphasisIndex}>{item}</li>)}</ul>}{"storyBlockId" in candidate && <StoryPageTrace state={state} deck={viewed} blockId={candidate.storyBlockId} wording={candidate.wording}/ >}{candidate.speakerNotes && <details className="speakerNotes"><summary>Presenter notes</summary><p>{candidate.speakerNotes}</p></details>}{candidate.evidence.length > 0 && <details><summary>Source evidence</summary>{candidate.evidence.map((evidence) => <blockquote key={`${evidence.chunkId}:${evidence.quote}`}>“{evidence.quote}”<small>{sourceName(state, evidence.sourceId)} · {evidence.chunkId}</small></blockquote>)}</details>}{candidate.openQuestions.length > 0 && <ul>{candidate.openQuestions.map((question) => <li key={question}>{question}</li>)}</ul>}</article>)}</div><aside className="deckTools"><h2>Draft actions</h2><span className="small muted">{historical ? "Prior version · read only" : current.createdBy === "user" ? "Current edited draft" : "Current agent draft"}</span>{!historical && !reviewAll && !editing && <button className="btn" onClick={startEdit}>Edit this page</button>}{editing && <div className="deckEditor">{current.id !== deckEditor?.deckId && <p role="status">The current deck changed. Your unsaved edit is preserved; copy it before cancelling and reviewing the new draft.</p>}<label htmlFor="deck-page-title">Page title</label><input id="deck-page-title" value={editTitle} onChange={(event) => setEditTitle(event.target.value)} /><label htmlFor="deck-page-body">Page content</label><textarea id="deck-page-body" value={editBody} onChange={(event) => setEditBody(event.target.value)} /><div><button className="plain" onClick={() => setEditing(false)}>Cancel</button><button className="btn primary" disabled={busy || current.id !== deckEditor?.deckId || !editTitle.trim() || !editBody.trim()} onClick={async () => { if (await onAction({ action: "edit_deck_page", deckId: deckEditor!.deckId, expectedDeckVersion: deckEditor!.deckVersion, pageId: deckEditor!.pageId, title: editTitle, body: editBody })) setEditing(false); }}>Save as new draft</button></div></div>}<h3>Draft history</h3><div className="draftHistory">{[...state.deckVersions].reverse().map((version) => <button key={version.id} aria-pressed={viewed.id === version.id} disabled={editing} onClick={() => setViewId(version.id)}>Draft {version.number}<small>{version.createdBy === "user" ? "Edited by you" : "Created by agent"}</small></button>)}</div></aside></div></section>;
}

function ClaimCorrectionPanel({ state, busy, primary, correctionTarget, onCorrectionTarget, correction, onCorrectionChange, onAction, current }: WorkspaceViewProps & { current: FixtureState["versions"][number] }) {
  const target = correctionTarget ?? "0:0";
  const setTarget = (target: string) => onCorrectionTarget?.(target);
  if (state.project.phase !== "review_required") return null;
  const [themeIndex, claimIndex] = target.split(":").map(Number);
  const selected = current.proposal.themes[themeIndex]?.claims[claimIndex];
  return <section className="claimCorrectionPanel" id="specific-correction-section" aria-labelledby="correction-title">
    <h2 id="correction-title">Correct a specific claim</h2>
    <label className="editLabel" htmlFor="claim-target">Claim to correct</label>
    <select id="claim-target" disabled={Boolean(correction.trim())} value={target} onChange={(event) => { setTarget(event.target.value); onCorrectionChange(""); }}>
      {current.proposal.themes.flatMap((theme, nextThemeIndex) => theme.claims.map((claim, nextClaimIndex) => <option disabled={Boolean(claim.supersededBy)} key={`${nextThemeIndex}:${nextClaimIndex}`} value={`${nextThemeIndex}:${nextClaimIndex}`}>{theme.title}: {claim.statement}</option>))}
    </select>
    {selected && <p className="selectedClaim"><strong>{selected.supersededBy ? "Earlier claim · history" : "Current claim"}</strong>{selected.statement}</p>}
    <label className="editLabel" htmlFor="specific-correction">Your correction</label>
    <textarea id="specific-correction" aria-label="Your correction" value={correction} onChange={(event) => onCorrectionChange(event.target.value)} />
    <button className={primary === "correct" ? "btn primary" : "btn"} disabled={busy || !correction.trim() || !selected || Boolean(selected.supersededBy)} onClick={() => onAction({ action: "correct", text: correction, themeIndex, claimIndex, expectedRevision: state.project.revision })}>Record correction</button>
  </section>;
}

function AgentInspector({ state, busy, open, onToggle }: { state: FixtureState; busy: boolean; open: boolean; onToggle: () => void }) {
  const workflowEvents = state.workflowRuns.flatMap((run) => run.events.map((event) => ({ ...event, runId: run.id, kind: run.kind, status: run.status })));
  return <aside className={open ? "agentInspector open" : "agentInspector"} aria-label="Agent inspector"><button className="inspectorToggle" onClick={onToggle} aria-expanded={open}><span className={busy ? "pulse live" : "pulse"} />Observe agent</button>{open && <div className="inspectorPanel"><header><div><span className="inspectorKicker">Development only</span><h2>Agent Inspector</h2></div><button className="plain" onClick={onToggle}>Close</button></header><div className="inspectorStats"><div><span>Mode</span><strong>{state.mode === "live" ? "DeepSeek live" : "Synthetic"}</strong></div><div><span>Phase</span><strong>{phaseLabel(state.project.phase)}</strong></div><div><span>Revision</span><strong>{state.project.revision}</strong></div></div><ol className="inspectorTimeline">{state.events.map((event) => <li key={`understanding-${event.sequence}`}><span>{event.sequence}</span><div><strong>{event.label}</strong><p>{event.detail}</p><time>{new Date(event.at).toLocaleTimeString()}</time></div></li>)}{workflowEvents.map((event, index) => <li key={`${event.runId}-${index}`}><span>{state.events.length + index + 1}</span><div><strong>{event.kind} · {event.type.replaceAll("_", " ")}</strong><p>{event.detail}</p><time>{new Date(event.at).toLocaleTimeString()}</time></div></li>)}{!state.events.length && !workflowEvents.length && <li className="emptyEvent">No agent events yet. Add material and start a run.</li>}</ol><p className="inspectorBoundary">Shows observable tool, state, validation, and usage events—not hidden model reasoning.</p></div>}</aside>;
}

function StoryPageTrace({state,deck,blockId,wording}:{state:FixtureState;deck:FixtureState["deckVersions"][number];blockId:string;wording:string}) {
  const version=deck.proposal.schemaVersion===2?state.story?.versions.find(v=>deck.proposal.schemaVersion===2&&v.id===deck.proposal.storyVersionId):undefined;
  const block=version?.story.blocks.find(b=>b.id===blockId);
  if(!version||!block)return <p>Saved story trace is unavailable.</p>;
  return <details className="storyPageTrace"><summary>Trace to approved story</summary><p>Story {version.id} · block {block.id}</p><h3>{block.title}</h3><p>{block.body}</p>{wording==="user_edited_unreviewed"&&<p role="status">This page has exact human edits. The original story and citations below show derivation history, not verified support for the new words.</p>}<p>{version.story.strategicRationale.choice}</p><p>{version.story.strategicRationale.tradeoff}</p><StoryTrace story={version.story} version={version} refs={block.basisRefs}/><ul>{version.story.unknowns.filter(u=>block.unknownIds.includes(u.id)).map(u=><li key={u.id}>{u.text}</li>)}</ul></details>;
}

function TopicMaterials({ state, topic, busy, onChooseFiles, onAction, onMaterials, fileImports, onRetryFile }: Pick<WorkspaceViewProps, "state" | "busy" | "onChooseFiles" | "onAction" | "fileImports" | "onRetryFile"> & { topic: TopicRef; onMaterials: () => void }) {
  const links = (state.topicMaterials ?? []).filter(link => sameTopic(link, topic));
  return <section aria-label="Topic materials"><h3>Material for this topic</h3><p>Attachments need review. Adding a file does not change your saved understanding, story or deck.</p>
    <label>Attach TXT or MD to this topic<input aria-label="Attach TXT or MD to this topic" type="file" multiple accept=".txt,.md,text/plain,text/markdown" disabled={busy || !onChooseFiles} onChange={async event => { const input = event.currentTarget; await onChooseFiles?.(Array.from(input.files ?? []), topic); input.value = ""; }} /></label>
    <ul>{links.map(link => <li key={link.sourceId}>{sourceName(state, link.sourceId)} · Needs review <button className="plain" onClick={onMaterials}>View in Materials</button><button className="plain" disabled={busy} onClick={() => onAction({ action: "unlink_topic_material", topic, sourceId: link.sourceId })}>Unlink {sourceName(state, link.sourceId)}</button></li>)}</ul>
    <details><summary>Link an existing source</summary>{state.sources.filter(source => source.kind !== "brief" && !links.some(link => link.sourceId === source.sourceId)).map(source => <button className="btn" key={source.sourceId} disabled={busy} onClick={() => onAction({ action: "link_topic_material", topic, sourceId: source.sourceId })}>Link {source.name}</button>)}</details>
    {fileImports?.map(item => <div key={item.id} role="status">{item.name} · {item.status}{item.status === "failed" && <><p>{item.message}</p><button disabled={busy} onClick={() => onRetryFile?.(item)}>Retry {item.name}</button></>}</div>)}
  </section>;
}
