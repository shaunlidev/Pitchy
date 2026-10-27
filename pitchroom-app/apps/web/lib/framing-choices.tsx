import { useLocalDraft, DraftRecovery } from "./use-local-draft";
import { z } from "zod";
import { positioningChoiceLabel, readPositioning, samePositioningChoice, type PositioningChoice, type PositioningWordingInput } from "@pitchroom/domain";
import type { FixtureState } from "./fixture-store";

type Action = (body: Record<string,unknown>) => boolean | Promise<boolean>;
export function framingApplyLabel(choice:PositioningChoice) {
  switch(choice.kind) {
    case "accepted_understanding":return "Keep accepted interpretation";
    case "legacy_wording":return "Keep saved wording";
    case "source_quote":return "Use source wording";
    case "manual_exact":return "Use your exact words";
    case "ai_direction":return "Choose this direction";
  }
}
export function SourceWordingAvailability({state}:{state:FixtureState}) {
  return state.positioning && !readPositioning(state.positioning).choices.some(choice=>choice.kind==="source_quote") ? <p>No original source wording has been selected. Accepted interpretation and your exact wording are separate options.</p> : null;
}
export function FramingChoiceDetails({choice,state}:{choice:PositioningChoice;state:FixtureState}) {
  switch(choice.kind) {
    case "source_quote": {
      const source=[...state.sources,...(state.removedSources ?? [])].find(source=>source.sourceId===choice.sourceId);
      const current=source && state.sources.includes(source) && source.contentHash===choice.sourceHash && source.chunks.some(chunk=>chunk.id===choice.chunkId&&chunk.text===choice.passage);
      return <><p>Source wording selected by you · not an independently verified fact.</p><small>{choice.sourceName} · saved for understanding {choice.understandingId} · passage {choice.chunkId} · saved range {choice.start}–{choice.end}. {current ? "Current source" : "Historical source · review availability before applying"}</small><details><summary>Inspect saved wording and source</summary><pre>{choice.text}</pre><pre>{choice.passage}</pre>{!current&&<p>The current source is unavailable or changed. This passage is the saved historical snapshot.</p>}</details>{source && "agentReview" in source && source.agentReview && <p role="status">This source contains passages isolated from the Agent. The full selected passage is checked again before generation; its original text remains readable.</p>}</>;
    }
    case "manual_exact": return <><p>Your exact words · user input, not verified material or an AI rewrite.</p><small>Saved input {choice.userInputId} · understanding {choice.understandingId}</small></>;
    case "accepted_understanding": return <p>Interpretation from accepted understanding {choice.understandingId}. This is separate from original source wording.</p>;
    case "legacy_wording": return <p>Historical wording. Its original provenance was not recorded; it is not labelled as a source quotation.</p>;
    case "ai_direction": return <><small>{choice.direction.coreMessageOrigin ? "AI-proposed strategy · opening is your saved exact wording, unverified." : choice.direction.userInputIds.length ? "AI-proposed strategy with saved user changes; wording origin was not separately recorded." : "AI-proposed direction · not verified market evidence."}</small><p>{choice.direction.tradeoff}</p><details><summary>Source support</summary>{choice.direction.evidence.map((e,index)=><blockquote key={index}>{e.quote}<small>{state.sources.find(source=>source.sourceId===e.sourceId)?.name ?? e.sourceId}</small></blockquote>)}</details></>;
  }
}
export function FramingChoiceCards({state,busy,onAction}:{state:FixtureState;busy:boolean;onAction:Action}) {
  if(!state.positioning)return null;
  const view=readPositioning(state.positioning);
  return <><SourceWordingAvailability state={state}/>{view.choices.map(choice=>{
    const applied=samePositioningChoice(view.applied?.choice,choice);
    return <article key={choice.id}><h3>{positioningChoiceLabel(choice)}</h3><pre>{choice.text}</pre><FramingChoiceDetails choice={choice} state={state}/><button className="btn" disabled={busy||applied} onClick={()=>onAction({action:"apply_positioning",expectedRevision:state.project.revision,expectedPositioning:view.head,directionId:choice.id})}>{applied ? "Chosen direction" : framingApplyLabel(choice)}</button></article>;
  })}</>;
}
const draftSchema=z.object({mode:z.enum(["manual_exact","source_quote"]),manualText:z.string(),sourceText:z.string(),chunkId:z.string()});
const emptyDraft: z.infer<typeof draftSchema>={mode:"manual_exact",manualText:"",sourceText:"",chunkId:""};
export function FramingWordingEditor({state,busy,onAction}:{state:FixtureState;busy:boolean;onAction:Action}) {
  const current=state.positioning;
  const context=JSON.stringify([current?.proposal.understandingVersionId,state.sources.map(source=>[source.sourceId,source.contentHash])]);
  const edits=useLocalDraft({projectId:state.project.id,enabled:true,kind:"positioning-wording",context,schema:draftSchema,initial:emptyDraft,hasContent:value=>Boolean(value.manualText||value.sourceText)});
  if(!current)return null;
  const passages=state.sources.flatMap(source=>source.chunks.map((chunk,index)=>({source,chunk,passageNumber:index+1})));
  const selected=passages.find(item=>item.chunk.id===edits.value.chunkId);
  const start=selected?.chunk.text.indexOf(edits.value.sourceText) ?? -1;
  const text=edits.value.mode==="manual_exact"?edits.value.manualText:edits.value.sourceText;
  const valid=Boolean(text.trim()&&text.length<=10000&&(edits.value.mode==="manual_exact"||selected&&start>=0));
  const save=async()=>{
    if(!valid)return;
    let wording:PositioningWordingInput;
    if(edits.value.mode==="manual_exact")wording={kind:"manual_exact",text:edits.value.manualText};
    else {if(!selected||start<0)return;wording={kind:"source_quote",sourceId:selected.source.sourceId,chunkId:selected.chunk.id,start,end:start+edits.value.sourceText.length,text:edits.value.sourceText};}
    const clear=edits.captureSubmission(edits.value.mode==="manual_exact" ? {...edits.value,manualText:""} : {...edits.value,sourceText:"",chunkId:""});
    if(await onAction({action:"save_positioning_wording",wording,expectedRevision:state.project.revision,expectedPositioning:readPositioning(current).head}))clear();
  };
  return <details><summary>Keep source wording or your exact words</summary><p>Save a candidate first, then explicitly choose it. Saving does not change the applied expression, Story or Deck.</p><DraftRecovery label="positioning wording" draft={edits} describe={value=>[value.manualText,value.sourceText].filter(Boolean).join("\n\n")}/><label>Wording type<select aria-label="Wording type" value={edits.value.mode} onChange={event=>edits.set({...edits.value,mode:event.target.value==="source_quote"?"source_quote":"manual_exact"})}><option value="manual_exact">Your exact words</option><option value="source_quote">Exact source quote</option></select></label>{edits.value.mode==="manual_exact"?<><label htmlFor="framing-manual">Your exact positioning wording</label><textarea id="framing-manual" value={edits.value.manualText} onChange={event=>edits.set({...edits.value,manualText:event.target.value})}/><small>Saved literally, including spaces and line breaks. It is not labelled as original client wording or AI output.</small></>:<><label>Source passage<select aria-label="Source passage for wording" value={edits.value.chunkId} onChange={event=>{const passage=passages.find(item=>item.chunk.id===event.target.value);edits.set({...edits.value,chunkId:event.target.value,sourceText:passage?.chunk.text ?? edits.value.sourceText});}}><option value="">Choose a current source passage</option>{passages.map(({source,chunk,passageNumber})=><option key={chunk.id} value={chunk.id}>{source.name} · passage {passageNumber}</option>)}</select></label>{selected&&<details><summary>Read full source passage</summary><pre>{selected.chunk.text}</pre></details>}<label htmlFor="framing-source">Exact words from this passage</label><textarea id="framing-source" value={edits.value.sourceText} onChange={event=>edits.set({...edits.value,sourceText:event.target.value})}/>{text&&start<0&&<p role="status">The words must match a continuous part of the selected source exactly.</p>}</>}{text.length>10000&&<p role="status">The candidate is limited to 10,000 characters. Your draft is retained.</p>}<button className="btn" disabled={busy||!valid} onClick={save}>Save wording candidate</button></details>;
}

export function FramingChoiceHistory({ state }: { state: FixtureState }) {
  if (!state.positioning || state.positioningVersions.length === 0) return null;
  return <section className="coreMessageHistory" aria-labelledby="core-message-history-title">
    <header>
      <div><span className="eyebrow">Version history</span><h2 id="core-message-history-title">Core message decisions</h2></div>
      <span className="small muted">{state.positioningVersions.length} saved version{state.positioningVersions.length === 1 ? "" : "s"}</span>
    </header>
    <p>Earlier wording stays read-only. Undo reverses the latest applied choice; editing creates another version.</p>
    <div className="coreMessageHistoryList">{[...state.positioningVersions].reverse().map((version) => {
      const applied=readPositioning(version).applied?.choice;
      return <details key={version.id} open={version.id === state.positioning?.id}>
        <summary><strong>Version {version.number}</strong><span>{version.id === state.positioning?.id ? "Current" : "Read only"}</span></summary>
        <p><strong>Applied decision:</strong> {applied ? positioningChoiceLabel(applied) : "None yet"}</p>
        {applied && <p className="historyMessage">{applied.text}</p>}
        <details><summary>Saved options and provenance</summary>{readPositioning(version).choices.map(choice=><section key={choice.id}><h3>{positioningChoiceLabel(choice)}</h3><pre>{choice.text}</pre><FramingChoiceDetails choice={choice} state={state}/></section>)}</details>
        {version.proposal.decisionJournal?.length ? <details><summary>Decision history</summary><ol>{version.proposal.decisionJournal.map(decision=><li key={decision.id}><p>{decision.action === "undo" ? "Undo" : decision.action === "legacy_snapshot" ? "Historical applied choice" : "Applied choice"} · decision {decision.id}</p>{decision.after ? <><strong>{positioningChoiceLabel(decision.after.choice)}</strong><pre>{decision.after.choice.text}</pre><FramingChoiceDetails choice={decision.after.choice} state={state}/></> : <p>No applied choice.</p>}</li>)}</ol></details> : null}
        <small>Saved {new Date(version.createdAt).toLocaleString()}</small>
      </details>;
    })}</div>
  </section>;
}

