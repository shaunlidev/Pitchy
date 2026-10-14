import { useMemo } from "react";
import type { FixtureState } from "./fixture-store";

type WorkspaceViewProps = {
  state: FixtureState;
  busy: boolean;
  error: string;
  text: string;
  answer: string;
  correction: string;
  activeRequest?: AbortController;
  onTextChange: (value: string) => void;
  onAnswerChange: (value: string) => void;
  onCorrectionChange: (value: string) => void;
  onChooseFile: (file?: File) => void;
  onCancelRun: () => void;
  onAction: (body: Record<string, unknown>) => void;
};

function sourceName(state: FixtureState, sourceId: string) {
  return state.sources.find((source) => source.sourceId === sourceId)?.name ?? sourceId;
}

export function WorkspaceView({ state, busy, error, text, answer, correction, activeRequest, onTextChange, onAnswerChange, onCorrectionChange, onChooseFile, onCancelRun, onAction }: WorkspaceViewProps) {
  const current = useMemo(() => state.versions.find((version) => version.id === state.currentVersionId), [state]);
  return <main className="shell" aria-busy={busy}>
    <header className="topbar"><div><span className="mark">P</span><strong>Pitchroom</strong></div><div className="mode"><i />{state.mode === "live" ? "Live external model" : state.mode === "postgres-fake" ? "Persistent synthetic agent · no external model" : "Synthetic fixture · no external model"}</div></header>
    <section className="projectHeader"><div><p>{state.project.name}</p><h1>Build a trustworthy understanding before the deck.</h1></div><div className={`phase phase-${state.project.phase}`}>{state.project.phase.replace("_", " ")}</div></section>
    <div className="announcer" aria-live="polite">{busy ? "Working…" : `Project state: ${state.project.phase.replace("_", " ")}`}</div>
    {error && <div className="error" role="alert"><strong>Action stopped.</strong> {error}</div>}
    <div className="workspace">
      <aside className="rail">
        <section><h2>Material</h2>
          {state.sources.map((source) => <details className="source" key={source.sourceId}><summary><span className="fileIcon">{source.mediaType === "text/markdown" ? "md" : "txt"}</span><span><strong>{source.name}</strong><small>{source.chunks.length} chunk{source.chunks.length === 1 ? "" : "s"} · {source.content.length} characters</small></span></summary><ol className="chunkList">{source.chunks.map((chunk) => <li key={chunk.id}><div><strong>Chunk {chunk.ordinal + 1}</strong><span>{chunk.startOffset}–{chunk.endOffset}</span></div><code>{chunk.id}</code><p>{chunk.text}</p></li>)}</ol></details>)}
          {(state.project.phase === "empty" || state.project.phase === "materials_ready") && <details className="materialAdder" open={state.sources.length === 0}><summary>{state.sources.length === 0 ? "Add the first source" : "Add another source"}</summary><div><label htmlFor="material-file">Open a UTF-8 text file</label><input id="material-file" className="fileInput" type="file" accept=".txt,.md,text/plain,text/markdown" onChange={(event) => onChooseFile(event.target.files?.[0])} /><label htmlFor="material">Or paste the source text</label><textarea id="material" value={text} onChange={(event) => onTextChange(event.target.value)} /><button disabled={busy || !text.trim()} onClick={() => onAction({ action: "add_material", name: "atelier-brief.md", mediaType: "text/markdown", text })}>Add material</button></div></details>}
        </section>
        <section><h2>Run trace</h2>{state.events.length === 0 ? <p className="muted">No run yet. The trace will show every meaningful state and tool action.</p> : <ol className="trace">{state.events.map((item) => <li key={item.sequence}><span>{item.sequence}</span><div><strong>{item.label}</strong><small>{item.detail}</small></div></li>)}</ol>}</section>
        {state.mode === "synthetic-fixture" && <button className="quiet" disabled={busy} onClick={() => onAction({ action: "reset" })}>Reset synthetic project</button>}
      </aside>
      <article className="document">
        {(state.project.phase === "materials_ready" || state.project.phase === "cancelled" || state.project.phase === "failed") && <div className="empty"><div className="pulse">◌</div><h2>{state.project.phase === "cancelled" ? "The previous run was cancelled." : state.project.phase === "failed" ? "The previous run failed safely." : "Material is addressable."}</h2><p>{state.project.phase === "failed" ? "No proposal was committed. Inspect the trace, repair the cause, and retry as a new run." : "The deterministic chunker has made every passage citeable. Expand the source to inspect chunk IDs and offsets before the agent runs."}</p><div className="runActions"><button disabled={busy} onClick={() => onAction({ action: "run" })}>{busy ? "Running…" : state.project.phase === "cancelled" || state.project.phase === "failed" ? "Retry as a new run" : "Run understanding agent"}</button>{busy && activeRequest && <button className="secondary" onClick={onCancelRun}>Cancel run</button>}</div></div>}
        {(state.project.phase === "reading" || state.project.phase === "structuring") && !current && <div className="empty" role="status"><div className="pulse">…</div><h2>{state.project.phase === "reading" ? "Reading source material." : "Validating the proposed understanding."}</h2><p>The agent remains bounded. Tool and state events will appear in the trace; no version exists until validation succeeds.</p>{activeRequest && <button className="secondary" onClick={onCancelRun}>Cancel run</button>}</div>}
        {state.project.phase === "empty" && <div className="empty"><div className="pulse">+</div><h2>Start with evidence.</h2><p>Add one source on the left. Nothing is inferred until the material is stored and chunked.</p></div>}
        {current && <>
          <div className="documentMeta"><span>Understanding v{current.number}</span><span>{current.createdBy === "agent" ? "proposed by agent" : "corrected by user"}</span></div>
          {current.proposal.themes.map((theme, themeIndex) => <section className="theme" key={`${theme.title}-${themeIndex}`}><h2>{theme.title}</h2><p className="summary">{theme.summary}</p>{theme.claims.map((claim, claimIndex) => <section className="claimBlock" key={`${claim.statement}-${claimIndex}`}><div className="claimLabel"><span className={`status status-${claim.evidenceState}`}>{claim.evidenceState.replace("_", " ")}</span><span>Claim {claimIndex + 1}</span></div><p>{claim.statement}</p>{claim.evidence.map((evidence) => <blockquote key={`${evidence.chunkId}:${evidence.quote}`}><span>Exact source quote</span>“{evidence.quote}”<small>{sourceName(state, evidence.sourceId)} · {evidence.chunkId}</small></blockquote>)}{claim.evidenceState === "user_asserted" && <small className="attribution">User input · {claim.userInputIds.join(", ")}</small>}{claim.evidenceState === "unknown" && <small className="attribution">No source evidence was inferred.</small>}</section>)}</section>)}
          <section className="gap"><h3>What remains unresolved</h3>{current.proposal.gaps.map((gap, index) => <div key={`${gap.description}-${index}`}><p>{gap.description}</p><small>{gap.whyItMatters}</small></div>)}</section>
          <section className="question"><h3>{current.proposal.nextQuestion.question}</h3><p>{current.proposal.nextQuestion.whyItMatters}</p></section>
          {state.project.phase === "review_required" && <section className="review"><h3>Your review is the gate</h3><p>Answer the open question, correct the first claim, preserve the unresolved gap, or accept this exact version. User input never becomes source evidence.</p><label htmlFor="answer">Answer the agent’s question</label><textarea id="answer" placeholder="Add information you know…" value={answer} onChange={(event) => onAnswerChange(event.target.value)} /><button className="secondary" disabled={busy || !answer.trim()} onClick={() => onAction({ action: "answer", text: answer, expectedRevision: state.project.revision })}>Record answer</button><label htmlFor="correction">Correct the first claim</label><textarea id="correction" placeholder="Write a corrected claim…" value={correction} onChange={(event) => onCorrectionChange(event.target.value)} /><div className="actions"><button className="secondary" disabled={busy} onClick={() => onAction({ action: "keep_unknown", expectedRevision: state.project.revision })}>Keep unknown</button><button className="secondary" disabled={busy || !correction.trim()} onClick={() => onAction({ action: "correct", text: correction, expectedRevision: state.project.revision })}>Record correction</button><button disabled={busy} onClick={() => onAction({ action: "accept", expectedRevision: state.project.revision })}>Accept version {current.number}</button></div></section>}
          {state.project.phase === "accepted" && <div className="accepted" role="status"><strong>Understanding accepted.</strong><span>The agent is stopped. Positioning and Deck remain outside this slice.</span></div>}
          <details><summary>Version history</summary><ul className="history">{[...state.versions].reverse().map((version) => <li key={version.id}><strong>v{version.number}</strong><span>{version.createdBy}</span><time dateTime={version.createdAt}>{new Date(version.createdAt).toLocaleTimeString()}</time></li>)}</ul></details>
        </>}
      </article>
    </div>
  </main>;
}
