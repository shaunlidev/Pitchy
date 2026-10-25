import { clarificationBasisV4Label, type ClarificationBasisV4 } from "@pitchroom/domain";
import type { ClarificationTask, ClarificationResult, ClarificationBasis, ProjectPhase } from "@pitchroom/domain";

function Basis({ items, task }: { items: ClarificationBasis[]; task: ClarificationTask }) {
  return <ul>{items.map((item, i) => <li key={i}>
    <strong>{item.kind === "material" ? (item.force === "requirement" ? "Material requirement" : "Material record") : item.kind === "user_report" ? "User report · unverified" : "Agent interpretation or suggestion"}</strong>: {item.statement}
    <span> Scope: {item.scope}.</span>
    {item.kind === "material" && item.evidence.map((e, j) => <blockquote key={j}>{e.quote}<small>{task.sources.find(s => s.id === e.sourceId)?.name ?? e.sourceId} · {e.chunkId}</small></blockquote>)}
    {item.kind === "user_report" && <small> Inputs: {item.inputIds.join(" · ")}</small>}
  </li>)}</ul>;
}

function BasisV4({ bases, refs, task }: { bases: ClarificationBasisV4[]; refs: string[]; task: ClarificationTask }) {
  return <ul>{refs.map(id => { const b=bases.find(b=>b.id===id);return b ? <li key={id}><strong>{clarificationBasisV4Label(b)}</strong>: {b.statement}<span> Scope: {b.scope}.</span>
    {b.requirement && <p>Reported issuer: {b.requirement.issuer}. Action: {b.requirement.action}. Condition: {b.requirement.condition}. Supporting words: {b.requirement.supportingQuote}</p>}
    {b.origin === "material" && b.evidence.map((e,i)=><blockquote key={i}>{e.quote}<small>{task.sources.find(s=>s.id===e.sourceId)?.name ?? e.sourceId} · {e.chunkId}</small></blockquote>)}
    {b.origin === "user" && <small>Inputs: {b.inputIds.join(" · ")}. This report is not independently verified.</small>}
  </li> : <li key={id}>Basis unavailable: {id}</li>;})}</ul>;
}

export function ClarificationPanel({ task, understanding, busy, onAction, revision, draft, onDraft }: { task: ClarificationTask; understanding: { versionId: string | undefined; phase: ProjectPhase }; busy: boolean; revision: number; draft?: ClarificationResult; onDraft?: (result: ClarificationResult) => void; onAction: (body: Record<string,unknown>) => boolean | Promise<boolean> }) {
  const result = draft ?? (task.status === "applied" ? task.appliedResult ?? task.result : task.result);
  const appliedHeading = task.resultVersionId && task.resultVersionId === understanding.versionId
    ? understanding.phase === "accepted" ? "Changes applied · understanding accepted"
      : understanding.phase === "review_required" ? "Changes applied · understanding awaits acceptance" : "Changes applied"
    : "Changes applied to understanding history";
  const editedInterpretation = Boolean(result && task.result && result.operations.some(op => op.type === "update_summary" && task.result!.operations.some(original => original.type === "update_summary" && original.themeId === op.themeId && original.text !== op.text)));
  const setEdited = (result: ClarificationResult) => onDraft?.(result);
  const editSummary = (index: number, text: string) => {
    // Drafts may be temporarily empty; validate only when applying, not on each keystroke.
    if (result?.schemaVersion === 4) setEdited({ ...result, operations: result.operations.map((item,i) => i === index && item.type === "update_summary" ? { ...item, text } : item) });
    else if (result?.schemaVersion === 3) setEdited({ ...result, operations: result.operations.map((item,i) => i === index && item.type === "update_summary" ? { ...item, text } : item) });
    else if (result?.schemaVersion === 2) setEdited({ ...result, operations: result.operations.map((item,i) => i === index && item.type === "update_summary" ? { ...item, text } : item) });
    else if (result) setEdited({ ...result, operations: result.operations.map((item,i) => i === index && item.type === "update_summary" ? { ...item, text } : item) });
  };
  const submit = (action: string) => onAction({ action, taskId: task.id });
  return <section className="clarificationPanel" aria-label="Clarification feedback" aria-live="polite">
    <h2>{task.status === "queued" ? "Answer saved · waiting for analysis" : task.status === "running" ? "Reconsidering your understanding" : task.status === "proposal_ready" ? "Review the proposed changes" : task.status === "no_change" ? "No change needed" : task.status === "failed" ? "Analysis stopped · your answer is saved" : task.status === "stale" ? "This proposal uses earlier inputs" : task.status === "applied" ? appliedHeading : "Current understanding kept"}</h2>
    <p><strong>Your saved answer</strong>: {task.answer}</p>
    <p>Based on understanding {task.baseUnderstandingId}. {task.status !== "applied" && "The current understanding has not been replaced by this proposal."}</p>
    {task.reassessment && <p>Reassessing saved answer from {task.reassessment.originalUnderstandingId}. Original question: {task.reassessment.originalQuestion.question}. Material changes: {task.reassessment.sourceChanges.added.length} added, {task.reassessment.sourceChanges.changed.length} changed, {task.reassessment.sourceChanges.removed.length} removed.</p>}
    {result && <p><strong>{editedInterpretation ? "Original Agent explanation" : "Why"}</strong>: {result.reason}</p>}
    {editedInterpretation && <p role="status">You edited this interpretation. The original Agent basis has not been reassessed for your wording.</p>}
    {result?.schemaVersion === 4 && <details><summary>Basis for this proposal</summary><BasisV4 bases={result.bases} refs={result.reasonBasisRefs} task={task}/></details>}
    {result?.schemaVersion === 3 && <details><summary>Basis for this proposal</summary><Basis items={result.reasonBasis} task={task}/></details>}
    {task.status === "proposal_ready" && result && <>
      {result.operations.map((op,index) => <div className="clarificationChange" key={`${task.id}:${index}`}>
        {op.type === "update_summary" ? <><p><strong>Before</strong>: {task.base.themes.find(t=>t.id===op.themeId)?.summary}</p><label htmlFor={`clarify-change-${index}`}>Proposed interpretation {index+1}</label><textarea id={`clarify-change-${index}`} value={op.text} onChange={event=>editSummary(index,event.target.value)}/><small>Agent interpretation based on your answer. Applying it does not verify it as a source fact.</small>
        {"basisRefs" in op && result.schemaVersion === 4 && <details><summary>Interpretation basis and current applicability</summary>
          <BasisV4 bases={result.bases} refs={op.basisRefs} task={task}/>
          {op.applicability.map(item=><div key={item.claimId}><p>Preserved material record: {task.base.themes.find(t=>t.id===op.themeId)?.claims.find(c=>c.id===item.claimId)?.statement}</p><p>Current applicability: {item.status}. {item.currentInterpretation}</p><p>{item.explanation}</p><BasisV4 bases={result.bases} refs={item.basisRefs} task={task}/></div>)}
        </details>}
        {"basis" in op && <details><summary>Interpretation basis and current applicability</summary>
          <Basis items={op.basis} task={task}/>
          {op.applicability.map(item => <div key={item.claimId}><p>Preserved material record: {task.base.themes.find(t => t.id === op.themeId)?.claims.find(c => c.id === item.claimId)?.statement}</p><p>Current applicability: {item.status}. {item.currentInterpretation}</p><p>{item.explanation}</p><Basis items={item.basis} task={task}/></div>)}
        </details>}</> : op.type === "add_answer" ? <p><strong>User input to retain</strong>: {task.answer}</p> : op.type === "supersede_user_assertion" ? <p><strong>Correct earlier user statement</strong>: {task.base.themes.find(t=>t.id===op.themeId)?.claims.find(c=>c.id===op.claimId)?.statement} <small>The original remains in history; your new answer replaces it as the current assertion.</small></p> : <><p><strong>Next useful question</strong>: {op.question}</p>{"relatedThemeIds" in op && <small>Topics: {op.relatedThemeIds.map(id=>task.base.themes.find(t=>t.id===id)?.title ?? id).join(" · ")}</small>}<p>{op.whyItMatters}</p>{"groundingV4" in op && result.schemaVersion === 4 && <details><summary>Why this question and these topics</summary><p>Objective: {op.groundingV4.objective}</p><p>Primary topic: {task.base.themes.find(t=>t.id===op.groundingV4.primaryThemeId)?.title}</p>{op.groundingV4.associations.map(a=><div key={a.themeId}><p>{task.base.themes.find(t=>t.id===a.themeId)?.title}: {a.unresolvedIssue}</p><p>Question words: {a.questionSpan}</p><p>Expected information: {a.expectedAnswer}</p><p>{a.rationale}</p></div>)}<BasisV4 bases={result.bases} refs={op.groundingV4.basisRefs} task={task}/></details>}{"grounding" in op && <details><summary>Why this question and these topics</summary><p>Objective: {op.grounding.objective}</p><p>Primary topic: {task.base.themes.find(t => t.id === op.grounding.primaryThemeId)?.title}</p>{op.grounding.associations.map(a => <p key={a.themeId}>{task.base.themes.find(t => t.id === a.themeId)?.title}: {a.unresolvedIssue} — {a.rationale}</p>)}<Basis items={op.grounding.basis} task={task}/></details>}</>}
      </div>)}
      <button className="btn primary" disabled={busy || result.operations.some(op=>op.type === "update_summary" && !op.text.trim())} onClick={()=>onAction({action:"apply_clarification",taskId:task.id,result})}>Apply changes to understanding</button>
    </>}
    {task.status === "failed" && <><p>{task.attempts.at(-1)?.error}</p>{task.attempts.at(-1)?.failure && <p>Analysis stopped at {task.attempts.at(-1)!.failure!.stage}: {task.attempts.at(-1)!.failure!.code}. Your answer is saved.</p>}<button className="btn primary" disabled={busy} onClick={()=>submit("retry_clarification")}>Retry saved answer</button></>}
    {task.status === "stale" && <button className="btn primary" disabled={busy} onClick={()=>onAction({action:"submit_clarification",text:task.answer,expectedRevision:revision,rebaseTaskId:task.id})}>Reassess against current understanding</button>}
    {["queued","running","proposal_ready","no_change","failed","stale"].includes(task.status) && <button className={task.status === "no_change" ? "btn primary" : "btn"} disabled={busy} onClick={()=>submit("dismiss_clarification")}>{task.status === "no_change" ? "Acknowledge and continue" : "Keep current understanding"}</button>}
    {(task.status === "queued" || task.status === "running") && <p>The saved task can be reopened after refresh. A worker must be running to process persistent projects.</p>}
  </section>;
}
