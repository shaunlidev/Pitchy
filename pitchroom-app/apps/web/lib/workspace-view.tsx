import { useEffect, useMemo, useState } from "react";
import type { FixtureState } from "./fixture-store";

type WorkspaceViewProps = {
  state: FixtureState; busy: boolean; error: string; text: string; answer: string; correction: string;
  activeRequest?: AbortController;
  onTextChange: (value: string) => void; onAnswerChange: (value: string) => void; onCorrectionChange: (value: string) => void;
  onChooseFile: (file?: File) => void; onCancelRun: () => void; onAction: (body: Record<string, unknown>) => void;
};

type Destination = "materials" | "clarify";

function sourceName(state: FixtureState, sourceId: string) {
  return state.sources.find((source) => source.sourceId === sourceId)?.name ?? sourceId;
}

function phaseLabel(phase: FixtureState["project"]["phase"]) {
  return phase.replaceAll("_", " ");
}

function phaseCopy(phase: FixtureState["project"]["phase"]) {
  switch (phase) {
    case "empty": return "Start with evidence.";
    case "materials_ready": return "Material is addressable.";
    case "reading": return "Reading source material.";
    case "structuring": return "Validating the proposed understanding.";
    case "cancelled": return "The previous run was cancelled.";
    case "failed": return "The previous run failed safely.";
    default: return "Review the proposed understanding.";
  }
}

export function WorkspaceView(props: WorkspaceViewProps) {
  const { state, busy, error } = props;
  const current = useMemo(() => state.versions.find((version) => version.id === state.currentVersionId), [state]);
  const [destination, setDestination] = useState<Destination>(current || !["empty", "materials_ready"].includes(state.project.phase) ? "clarify" : "materials");

  useEffect(() => {
    if (current) setDestination("clarify");
    else if (state.project.phase === "empty") setDestination("materials");
  }, [current?.id, state.project.phase]);

  return <main className="appShell" aria-busy={busy}>
    <header className="appHeader">
      <div className="brand"><span className="brandDot" />PITCHROOM</div>
      <div className="projectIdentity"><strong>{state.project.name}</strong><span>{state.mode === "live" ? "Live model" : "Local agent"}</span></div>
    </header>
    <nav className="destinationNav" aria-label="Project destinations">
      <div>
        <button className={destination === "materials" ? "active" : ""} onClick={() => setDestination("materials")}>Materials</button>
        <button className={destination === "clarify" ? "active" : ""} disabled={state.sources.length === 0} onClick={() => setDestination("clarify")}>Clarify</button>
        <button disabled title="Available after the understanding is accepted">Positioning</button>
        <button disabled title="Available after a direction creates a draft">Deck</button>
      </div>
      <span>{state.mode === "live" ? "External model · Persistent project" : "Synthetic project · Local session"}</span>
    </nav>
    <div className="announcer" aria-live="polite">{busy ? "Working…" : `Project state: ${phaseLabel(state.project.phase)}`}</div>
    {error && <div className="error" role="alert"><strong>Action stopped.</strong> {error}</div>}
    {destination === "materials" ? <MaterialsView {...props} onContinue={() => setDestination("clarify")} /> : <ClarifyView {...props} current={current} onMaterials={() => setDestination("materials")} />}
    <footer className="appFooter"><span>{state.mode === "live" ? "External AI is enabled for this project." : "Synthetic agent · No external model call"}</span><span>Unknowns can stay open.</span>{state.mode !== "live" && <button className="footerAction" disabled={busy} onClick={() => props.onAction({ action: "reset" })}>Reset synthetic project</button>}</footer>
  </main>;
}

function MaterialsView({ state, busy, text, onTextChange, onChooseFile, onAction, onContinue }: WorkspaceViewProps & { onContinue: () => void }) {
  const canRun = state.project.phase === "materials_ready" || state.project.phase === "cancelled" || state.project.phase === "failed";
  if (state.sources.length === 0) return <section className="intake pageFrame">
    <p className="eyebrow">Your next client conversation</p>
    <h1>Start with<br />what you have.</h1>
    <p className="stateContract">{phaseCopy(state.project.phase)}</p>
    <p className="lede">A brief, interview notes, or a half-finished deck.<br />We’ll help you find the story inside.</p>
    <label className="dropzone" htmlFor="material-file"><span>+</span><strong>Choose a text material</strong><small>UTF-8 .txt or .md</small></label>
    <input id="material-file" className="visuallyHidden" type="file" accept=".txt,.md,text/plain,text/markdown" onChange={(event) => onChooseFile(event.target.files?.[0])} />
    <details className="pasteBrief" open><summary>Or paste what you know</summary><textarea id="material" aria-label="Paste source text" value={text} onChange={(event) => onTextChange(event.target.value)} /><button disabled={busy || !text.trim()} onClick={() => onAction({ action: "add_material", text })}>Add material <span>→</span></button></details>
    <p className="boundaryNote">This build reads text and Markdown. Every claim stays linked to its source.</p>
  </section>;

  return <section className="materialLibrary pageFrame">
    <div className="libraryHeading"><div><h1>Your project materials.</h1><p>Add to the project without restarting the conversation.</p></div><label className="outlineButton" htmlFor="material-file">Add files <span>→</span></label></div>
    <p className="stateContract">{phaseCopy(state.project.phase)}</p>
    <input id="material-file" className="visuallyHidden" type="file" accept=".txt,.md,text/plain,text/markdown" onChange={(event) => onChooseFile(event.target.files?.[0])} />
    <div className="inventoryHead"><h2>Source files</h2><span>{state.sources.length} file{state.sources.length === 1 ? "" : "s"}</span></div>
    <div className="inventory">{state.sources.map((source) => <details className="fileRow" key={source.sourceId}><summary><span className="fileBadge">{source.mediaType === "text/markdown" ? "MD" : "TXT"}</span><span><strong>{source.name}</strong><small>{source.chunks.length} citeable passage{source.chunks.length === 1 ? "" : "s"}</small></span><span className="disclosure">View source</span></summary><ol>{source.chunks.map((chunk) => <li key={chunk.id}><code>{chunk.id}</code><p>{chunk.text}</p></li>)}</ol></details>)}</div>
    <details className="pasteBrief"><summary>Add another source <span>Optional</span></summary><textarea aria-label="Written brief" value={text} onChange={(event) => onTextChange(event.target.value)} /><button disabled={busy || !text.trim()} onClick={() => onAction({ action: "add_material", text })}>Add material</button></details>
    <div className="libraryActions"><p>Material remains inspectable. The agent cannot promote a guess into evidence.</p><div>{canRun && <button disabled={busy} onClick={() => onAction({ action: "run" })}>{busy ? "Reading material…" : state.project.phase === "materials_ready" ? "Run understanding agent" : "Retry agent"}</button>}<button className="outlineButton" disabled={!state.currentVersionId} onClick={onContinue}>Back to Clarify <span>→</span></button></div></div>
  </section>;
}

function ClarifyView({ state, busy, answer, correction, activeRequest, onAnswerChange, onCorrectionChange, onCancelRun, onAction, current, onMaterials }: WorkspaceViewProps & { current?: FixtureState["versions"][number]; onMaterials: () => void }) {
  if (!current) return <section className="pageFrame clarifyWaiting"><div className="sectionHeading"><h1>Find the story in the material.</h1><span>Keep unknowns open.</span></div><div className="waitingCard"><p className="eyebrow">{state.project.phase === "reading" ? "READING MATERIAL" : state.project.phase === "structuring" ? "CHECKING SOURCE LINKS" : "READY TO BEGIN"}</p><h2>{phaseCopy(state.project.phase)}</h2><p>No understanding version appears until every supported claim has a valid exact quote.</p>{state.project.phase === "materials_ready" ? <button disabled={busy} onClick={() => onAction({ action: "run" })}>Run understanding agent</button> : state.project.phase === "cancelled" || state.project.phase === "failed" ? <button disabled={busy} onClick={() => onAction({ action: "run" })}>Retry agent</button> : activeRequest && <button className="outlineButton" onClick={onCancelRun}>Cancel run</button>}</div></section>;

  return <section className="pageFrame clarifyPage">
    <div className="sectionHeading"><h1>Find the story in the material.</h1><span>Keep unknowns open.</span></div>
    <div className="clarifyGrid">
      <aside className="topicMap"><h2>Project overview</h2>{current.proposal.themes.map((theme, index) => <div className={index === 0 ? "topic active" : "topic"} key={theme.title}><strong>{theme.title}</strong><span>{theme.claims.some((claim) => claim.evidenceState === "unknown") ? "Needs context" : theme.claims.some((claim) => claim.evidenceState === "conflicting") ? "Needs review" : "Material available"}</span></div>)}{current.proposal.gaps.map((gap) => <div className="topic" key={gap.description}><strong>{gap.description}</strong><span>Not provided</span></div>)}<button className="manageMaterials" onClick={onMaterials}>Manage materials <span>{state.sources.length}</span></button></aside>
      <article className="clarifyWork">
        <div className="understandingHead"><div><p>Understanding v{current.number}</p><strong>{current.proposal.themes.map((theme) => theme.summary).join(" ")}</strong><small>Agent proposal · Source-linked · Version {current.number}</small></div><a href="#correction-section">Correct this</a></div>
        <section className="currentQuestion"><div className="questionMeta"><span>{current.proposal.themes[0]?.title ?? "Open question"}</span><span>{current.proposal.gaps.length} unresolved</span></div><h2>{current.proposal.nextQuestion.question}</h2><details><summary>Why this matters</summary><p>{current.proposal.nextQuestion.whyItMatters}</p></details>
          <label htmlFor="answer">Your context</label><textarea id="answer" aria-label="Answer the agent’s question" placeholder="A few sentences are enough. It’s okay not to know yet." value={answer} onChange={(event) => onAnswerChange(event.target.value)} />
          <div className="questionActions"><button className="plainButton" aria-label="Keep unknown" disabled={busy} onClick={() => onAction({ action: "keep_unknown", expectedRevision: state.project.revision })}>Not sure yet</button><button disabled={busy || !answer.trim()} onClick={() => onAction({ action: "answer", text: answer, expectedRevision: state.project.revision })}>Record answer</button></div>
        </section>
        <details className="evidenceDisclosure" open><summary>View understanding and supporting material</summary>{current.proposal.themes.map((theme) => <section className="themeReview" key={theme.title}><h3>{theme.title}</h3><p>{theme.summary}</p>{theme.claims.map((claim, index) => <div className="claim" key={`${claim.statement}-${index}`}><span className={`status status-${claim.evidenceState}`}>{claim.evidenceState.replace("_", " ")}</span><p>{claim.statement}</p>{claim.evidence.map((evidence) => <blockquote key={`${evidence.chunkId}:${evidence.quote}`}><span>Exact source quote</span>“{evidence.quote}”<small>{sourceName(state, evidence.sourceId)} · {evidence.chunkId}</small></blockquote>)}{claim.evidenceState === "user_asserted" && <small>User input · {claim.userInputIds.join(", ")}</small>}</div>)}</section>)}</details>
        <details className="correctionDisclosure" id="correction-section" open><summary>Correct the current understanding</summary><label htmlFor="correction">Correct the first claim</label><textarea id="correction" value={correction} onChange={(event) => onCorrectionChange(event.target.value)} /><button className="outlineButton" disabled={busy || !correction.trim()} onClick={() => onAction({ action: "correct", text: correction, expectedRevision: state.project.revision })}>Record correction</button></details>
        {state.project.phase === "review_required" && <div className="reviewGate"><div><h2>Your review is the gate</h2><p>Accepting stops the agent at this exact version. It does not generate positioning or a deck.</p></div><button disabled={busy} onClick={() => onAction({ action: "accept", expectedRevision: state.project.revision })}>Accept version {current.number}</button></div>}
        {state.project.phase === "accepted" && <div className="accepted" role="status"><strong>Understanding accepted.</strong><span>The agent is stopped. Positioning and Deck remain outside this slice.</span></div>}
        <details className="technicalDisclosure"><summary>Run trace and version history</summary><ol className="trace">{state.events.map((item) => <li key={item.sequence}><span>{item.sequence}</span><div><strong>{item.label}</strong><small>{item.detail}</small></div></li>)}</ol><ul className="history">{[...state.versions].reverse().map((version) => <li key={version.id}>v{version.number} · {version.createdBy}</li>)}</ul></details>
      </article>
    </div>
  </section>;
}
