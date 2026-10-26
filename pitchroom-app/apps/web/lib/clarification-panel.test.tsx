// @vitest-environment jsdom
import { cleanup,render,screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach,expect,it,vi } from "vitest";
import { readFileSync } from "node:fs";
import { acceptFixture,addFixtureMaterial,decideFixtureClarification,readFixtureState,resetFixtureState,runFixtureAgent,submitFixtureClarification,runFixtureClarification } from "./fixture-store";
import { WorkspaceView } from "./workspace-view";
afterEach(()=>{cleanup();vi.useRealTimers();});
it("tracks acceptance of the current applied clarification without assigning it to historical results", async () => {
 resetFixtureState();
 addFixtureMaterial({name:"brief.md",mediaType:"text/markdown",text:"Reviewers check claims manually."});
 const initial=runFixtureAgent();
 const saved=submitFixtureClarification({text:"Procurement approves a pilot.",commandId:"acceptance-label-answer",expectedRevision:initial.project.revision});
 const taskId=saved.clarifications!.at(-1)!.id;
 await runFixtureClarification(taskId);
 const applied=decideFixtureClarification({taskId,action:"apply",commandId:"acceptance-label-apply"});
 const result = applied.clarifications!.at(-1)!.appliedResult;
 if (!result) throw new Error("Applied fixture result is missing");
 result.reason = "The proposal is waiting to be reviewed and applied.";
 const props={busy:false,text:"",answer:"",correction:"",onTextChange:vi.fn(),onAnswerChange:vi.fn(),onCorrectionChange:vi.fn(),onChooseFile:()=>true,onCancelRun:vi.fn(),onAction:vi.fn(()=>true),initialDestination:"clarify" as const};
 const view=render(<WorkspaceView {...props} state={applied}/>);
 expect(screen.getByRole("heading",{name:"Changes applied · understanding awaits acceptance"})).toBeTruthy();
 const accepted=acceptFixture(applied.project.revision);
 accepted.clarifications!.at(-1)!.appliedResult = result;
 view.rerender(<WorkspaceView {...props} state={accepted}/>);
 expect(screen.getByRole("heading",{name:"Changes applied · understanding accepted"})).toBeTruthy();
 expect(screen.queryByRole("heading",{name:/awaits acceptance/})).toBeNull();
 const explanation = screen.getByText("Explanation saved before Apply").closest("details");
 expect(explanation?.open).toBe(false);
 expect(explanation?.textContent).toContain("The proposal is waiting to be reviewed and applied.");
 addFixtureMaterial({name:"new-context.md",mediaType:"text/markdown",text:"A different audience needs another review."});
 const newer=runFixtureAgent();
 view.rerender(<WorkspaceView {...props} state={newer}/>);
 expect(screen.getByRole("heading",{name:"Changes applied to understanding history"})).toBeTruthy();
 expect(screen.queryByRole("heading",{name:/understanding accepted|awaits acceptance/})).toBeNull();
 view.rerender(<WorkspaceView {...props} state={acceptFixture(newer.project.revision)}/>);
 expect(screen.getByRole("heading",{name:"Changes applied to understanding history"})).toBeTruthy();
});
it("keeps the accepted Understanding revision form visible with the shipped stylesheet", async () => {
 resetFixtureState();
 addFixtureMaterial({name:"brief.md",mediaType:"text/markdown",text:"Reviewers check claims manually."});
 const reviewed = runFixtureAgent(), state = acceptFixture(reviewed.project.revision);
 const onAction = vi.fn(() => true), answer = "The buyer is procurement.";
 render(<><style>{readFileSync("app/ux-fixes.css", "utf8")}</style><WorkspaceView state={state} busy={false} text="" answer={answer} correction="" onTextChange={vi.fn()} onAnswerChange={vi.fn()} onCorrectionChange={vi.fn()} onChooseFile={()=>true} onCancelRun={vi.fn()} onAction={onAction} initialDestination="clarify" /></>);
 const field = screen.getByRole("textbox", { name: "Answer the agent’s question" });
 expect(getComputedStyle(field).display).not.toBe("none");
 await userEvent.setup().click(screen.getByRole("button", { name: "Propose revision to accepted understanding" }));
 expect(onAction).toHaveBeenCalledWith({action:"submit_clarification",text:answer,expectedRevision:state.project.revision,selection:{understandingId:state.currentVersionId,taskId:"legacy-next-question",themeIndex:0}});
 expect(readFixtureState().currentVersionId).toBe(state.currentVersionId);
 expect(readFixtureState().project.phase).toBe("accepted");
});
it("preserves a user-edited interpretation across server refresh without applying it",async()=>{
 resetFixtureState();addFixtureMaterial({name:"brief.md",mediaType:"text/markdown",text:"Northwind helps consumers plan menus."});const state=runFixtureAgent();
 const saved=submitFixtureClarification({text:"Procurement approves a pilot.",commandId:"saved",expectedRevision:state.project.revision});await runFixtureClarification(saved.clarifications!.at(-1)!.id);
 const props={state:readFixtureState(),busy:false,text:"",answer:"",correction:"",onTextChange:vi.fn(),onAnswerChange:vi.fn(),onCorrectionChange:vi.fn(),onChooseFile:()=>true,onCancelRun:vi.fn(),onAction:vi.fn(()=>true)};
 const view=render(<WorkspaceView {...props} initialDestination="clarify"/>);const user=userEvent.setup();const field=screen.getByLabelText("Proposed interpretation 1") as HTMLTextAreaElement;
 await user.clear(field);await user.type(field,"My revised interpretation.");view.rerender(<WorkspaceView {...props} state={readFixtureState()} initialDestination="clarify"/>);
 expect(field.value).toBe("My revised interpretation.");
 await user.click(screen.getByRole("button",{name:"Materials"}));await user.click(screen.getByRole("button",{name:"Clarify"}));
 expect((screen.getByLabelText("Proposed interpretation 1") as HTMLTextAreaElement).value).toBe("My revised interpretation.");expect(props.onAction).not.toHaveBeenCalled();expect(readFixtureState().currentVersionId).toBe(state.currentVersionId);
 await user.click(screen.getByRole("button",{name:"Apply changes to understanding"}));expect(props.onAction).toHaveBeenCalledWith(expect.objectContaining({action:"apply_clarification",result:expect.objectContaining({operations:expect.arrayContaining([expect.objectContaining({type:"update_summary",text:"My revised interpretation."})])})}));
});

it("shows v3 attribution, topic reasons and edited-wording warning without losing the original basis",async()=>{
 const {useState}=await import("react");
 const {newClarification,buildClarificationCandidate}=await import("@pitchroom/domain");
 const {groundedTestResult}=await import("../../../packages/agent/src/clarification-model.testkit");
 const {ClarificationPanel}=await import("./clarification-panel");
 const base={schemaVersion:1 as const,themes:[{id:"t",title:"Evaluation",summary:"Criterion unknown",claims:[{id:"c",statement:"Old brief suggests six weeks.",evidenceState:"supported" as const,evidence:[{sourceId:"s",chunkId:"chunk",quote:"Six weeks suggested."}],userInputIds:[]}]}],gaps:[],nextQuestion:{question:"Which criterion?",whyItMatters:"Evaluation",relatedThemeIndexes:[0]}};
 const task=newClarification({id:"task",inputId:"input",projectId:"p",commandId:"cmd",actorId:"user",versionId:"v1",revision:1,base,sources:[{id:"s",projectId:"p",name:"old.md",mediaType:"text/markdown",contentHash:"v1",chunks:[{id:"chunk",sourceId:"s",text:"Six weeks suggested.",startOffset:0,endOffset:20}]}],answer:"We want an experiment."});
 task.result=groundedTestResult({schemaVersion:2,reason:"User goal differs from the earlier plan.",operations:[{type:"update_summary",themeId:"t",text:"Current experiment goal; criterion unknown."},{type:"next_question",question:"What counts as success?",whyItMatters:"Useful for evaluation",relatedThemeIds:["t"]}]},task.base);
 task.status="proposal_ready";const original=structuredClone(task.result);const onAction=vi.fn((_body:Record<string,unknown>)=>true);
 function Panel(){const [draft,setDraft]=useState(task.result);return <ClarificationPanel understanding={{versionId:"v1",phase:"review_required"}} task={task} revision={1} busy={false} draft={draft} onDraft={setDraft} onAction={onAction}/>;}
 const view=render(<Panel/>);const user=userEvent.setup();
 await user.click(screen.getByText("Interpretation basis and current applicability"));await user.click(screen.getByText("Why this question and these topics"));
 expect(screen.getByText(/Current applicability: unconfirmed/)).toBeTruthy();expect(screen.getByText(/Primary topic: Evaluation/)).toBeTruthy();
 const field=screen.getByLabelText("Proposed interpretation 1");await user.clear(field);await user.type(field,"My wording.");
 expect(screen.getByRole("status").textContent).toContain("has not been reassessed");
 await user.click(screen.getByRole("button",{name:"Apply changes to understanding"}));
 const applied=onAction.mock.calls[0]![0] as {result:typeof task.result};
 expect(buildClarificationCandidate(task,applied.result).themes[0]!.summaryInterpretation!.grounding!.reviewStatus).toBe("user_edited_unreviewed");expect(task.result).toEqual(original);
 view.rerender(<ClarificationPanel understanding={{versionId:"v1",phase:"review_required"}} task={{...task,status:"applied",appliedResult:applied.result}} revision={2} busy={false} onAction={onAction}/>);
 expect(screen.getByText("Original Agent explanation")).toBeTruthy();expect(screen.getByRole("status").textContent).toContain("has not been reassessed");
});

it("v4 renders source modality independently and resolves shared basis references during editable review",async()=>{
 const {useState}=await import("react"),{newClarification,buildClarificationCandidate}=await import("@pitchroom/domain");
 const {groundedV4TestResult}=await import("../../../packages/agent/src/clarification-model.testkit"),{ClarificationPanel}=await import("./clarification-panel");
 const base={schemaVersion:1 as const,themes:[{id:"t",title:"Workshop",summary:"Open workshop plan",claims:[{id:"c",statement:"Two days suggested.",evidenceState:"supported" as const,evidence:[{sourceId:"s",chunkId:"chunk",quote:"Two days suggested."}],userInputIds:[]}]}],gaps:[],nextQuestion:{question:"Which metric?",whyItMatters:"Evaluate",relatedThemeIndexes:[0]}};
 const task=newClarification({id:"v4-task",inputId:"input",projectId:"p",commandId:"cmd",actorId:"user",versionId:"v1",revision:1,base,sources:[{id:"s",projectId:"p",name:"guide.md",mediaType:"text/markdown",contentHash:"v1",chunks:[{id:"chunk",sourceId:"s",text:"Two days suggested.",startOffset:0,endOffset:19}]}],answer:"Sponsor says a report is required."});
 const result=groundedV4TestResult({schemaVersion:2,reason:"A workshop is proposed.",operations:[{type:"update_summary",themeId:"t",text:"Duration is a recommendation; sponsor's requirement is user-reported."},{type:"next_question",question:"Which metric defines success?",whyItMatters:"Could help evaluate",relatedThemeIds:["t"]}]},task.base);
 result.bases.push({id:"duration",origin:"material",nature:"suggestion",requirement:null,statement:"Guide suggests two days.",scope:"Suggestion only",evidence:[{sourceId:"s",chunkId:"chunk",quote:"Two days suggested."}]},{id:"sponsor",origin:"user",nature:"requirement",requirement:{issuer:"Sponsor, reported by user",action:"Provide report",condition:"Sponsor review",supportingQuote:task.answer},statement:"Sponsor request, reported by user",scope:"Not independently verified",inputIds:["input"]});
 result.reasonBasisRefs.push("duration","sponsor");const s=result.operations.find(o=>o.type==="update_summary")!;s.basisRefs.push("duration","sponsor");task.result=result;task.status="proposal_ready";
 const onAction=vi.fn((_body:Record<string,unknown>)=>true);function Panel(){const [draft,setDraft]=useState(task.result);return <ClarificationPanel understanding={{versionId:"v1",phase:"review_required"}} task={task} revision={1} busy={false} draft={draft} onDraft={setDraft} onAction={onAction}/>;}
 const view=render(<Panel/>),user=userEvent.setup();await user.click(screen.getByText("Basis for this proposal"));await user.click(screen.getByText("Why this question and these topics"));
 expect(screen.getAllByText("Material · suggestion").length).toBeGreaterThan(0);expect(screen.getAllByText("User report · unverified · requirement").length).toBeGreaterThan(0);expect(screen.getByText(/Question words: Which metric defines success/)).toBeTruthy();expect(screen.getByText(/Expected information:/)).toBeTruthy();
 const field=screen.getByLabelText("Proposed interpretation 1");await user.clear(field);await user.type(field,"My own workshop plan.");expect(screen.getByRole("status").textContent).toContain("has not been reassessed");await user.click(screen.getByRole("button",{name:"Apply changes to understanding"}));
 const edited=onAction.mock.calls[0]![0]!.result as typeof result;const candidate=buildClarificationCandidate(task,edited);expect(candidate.themes[0]!.summaryInterpretation!.groundingV4!.reviewStatus).toBe("user_edited_unreviewed");expect(edited.bases).toEqual(result.bases);
 view.rerender(<ClarificationPanel understanding={{versionId:"v1",phase:"review_required"}} task={{...task,status:"failed",result:undefined,attempts:[{...task.attempts[0]!,status:"failed",error:"INVALID_JSON",failure:{stage:"syntax",code:"INVALID_JSON"}}]}} revision={1} busy={false} onAction={onAction}/>);
 expect(screen.getByText(/Analysis stopped at syntax: INVALID_JSON/)).toBeTruthy();expect(onAction).toHaveBeenCalledTimes(1);
});

it("requires an explicit current question before reassessing a saved stale answer", async () => {
 const { newClarification, understandingProposalV1Schema } = await import("@pitchroom/domain");
 const { ClarificationPanel } = await import("./clarification-panel");
 const proposal = understandingProposalV1Schema.parse({ schemaVersion:1,
  themes:["Audience","Measurement"].map(title=>({title,summary:`${title} is unknown.`,claims:[{statement:`${title} is unknown.`,evidenceState:"unknown",evidence:[]}]})),
  gaps:[],nextQuestion:{question:"Who is the audience?",whyItMatters:"The audience is unknown.",relatedThemeIndexes:[0]},
  topicTasks:[{id:"measurement",themeIndex:1,question:{question:"What is the measurement baseline?",whyItMatters:"The baseline is unknown.",relatedThemeIndexes:[1]}}],
 });
 const task = newClarification({id:"saved-stale",inputId:"saved-input",projectId:"synthetic",commandId:"saved-command",actorId:"user",versionId:"v1",revision:1,base:proposal,sources:[],answer:"原话：The baseline is still unknown.",selection:{understandingId:"v1",taskId:"measurement",themeIndex:1}});
 task.status="stale";
 const current=structuredClone(proposal); current.topicTasks![0]!.id="measurement-current";
 const onAction=vi.fn(()=>true);
 const props={task,busy:false,onAction,revision:2,understanding:{versionId:"v2",phase:"review_required" as const,proposal:current}};
 const view=render(<ClarificationPanel {...props}/>);
 const submit=screen.getByRole("button",{name:"Reassess against current understanding"});
 expect(submit.hasAttribute("disabled")).toBe(true);
 const user=userEvent.setup(); await user.click(submit); expect(onAction).not.toHaveBeenCalled();
 await user.selectOptions(screen.getByLabelText("Current question for this saved answer"),"1:measurement-current");
 expect(submit.hasAttribute("disabled")).toBe(false);
 await user.click(submit);
 expect(onAction).toHaveBeenCalledWith({action:"submit_clarification",text:task.answer,expectedRevision:2,rebaseTaskId:task.id,selection:{understandingId:"v2",taskId:"measurement-current",themeIndex:1}});
 expect(task.inputId).toBe("saved-input"); expect(task.answer).toBe("原话：The baseline is still unknown.");
 // A refresh to a different current version invalidates the earlier explicit choice.
 view.rerender(<ClarificationPanel {...props} revision={3} understanding={{...props.understanding,versionId:"v3"}}/>);
 expect(screen.getByRole("button",{name:"Reassess against current understanding"}).hasAttribute("disabled")).toBe(true);
 onAction.mockClear();
 view.rerender(<ClarificationPanel {...props} understanding={{...props.understanding,proposal:{...current,topicTasks:[]}}}/>);
 expect(screen.getByRole("button",{name:"Reassess against current understanding"}).hasAttribute("disabled")).toBe(true);
 await user.click(screen.getByRole("button",{name:"Reassess against current understanding"})); expect(onAction).not.toHaveBeenCalled();
});
