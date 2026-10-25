import { z } from "zod";
import { beforeEach, describe, expect, it } from "vitest";
import { compareStories, validateStory, assertStoryHead, exactStoryEdit, storySchema, storyContentSchema, type StorySnapshot } from "@pitchroom/domain";
import { ResponsesStoryRunner } from "@pitchroom/agent";
import { resetFixtureState, addFixtureMaterial, runFixtureAgent, acceptFixture, generateFixturePositioning, applyFixturePositioning, proposeFixtureStory, decideFixtureStory, undoFixtureStory, createFixtureStoryDeck, readFixtureState, editFixtureDeckPage, submitFixtureClarification, runFixtureClarification, decideFixtureClarification } from "./fixture-store";
function setup(){addFixtureMaterial({name:"brief.md",mediaType:"text/markdown",text:"Consultants check evidence manually before each client discussion. Procurement needs to identify who approved a claim."});const u=runFixtureAgent();acceptFixture(u.project.revision);const p=generateFixturePositioning();return applyFixturePositioning(p.positioning!.proposal.directions[0]!.id,p.project.revision);}
async function propose(){const state=readFixtureState();return proposeFixtureStory({expected:state.story?.head??{generation:0,storyId:null},commandId:crypto.randomUUID(),request:{kind:"develop_direction"}});}
async function adopt(){const s=await propose(),p=s.story!.proposals.at(-1)!;expect(p.state.kind).toBe("ready");return decideFixtureStory({expected:p.baseHead,proposalId:p.id,commandId:crypto.randomUUID(),decision:"apply"});}
beforeEach(()=>resetFixtureState());
async function readyStory() {
  setup();
  const state = await propose(), proposal = state.story!.proposals[0]!;
  if (proposal.state.kind !== "ready") throw Error("No story preview");
  return { story: proposal.state.candidate, snapshot: proposal.snapshot };
}

describe("story boundary regressions", () => {
  it("keeps exact wording and all provenance beyond the model's 30-basis limit", async () => {
    const { story, snapshot } = await readyStory();
    const source = story.bases.find(b => b.kind === "source_excerpt");
    if (!source) throw Error("No source basis");
    story.bases = Array.from({ length: 30 }, (_, index) => ({ ...source, id: index === 0 ? source.id : `source-${index}` }));
    expect(storySchema.safeParse(story).success).toBe(true);
    const exactSnapshot: StorySnapshot = { ...snapshot, before: story, request: { kind: "exact_edit", blockId: story.blocks[0]!.id, title: "  My literal title  ", body: "My exact human words." }, userInput: { id: "edit-1", text: "  My literal title  \nMy exact human words." } };
    const edited = exactStoryEdit(exactSnapshot);
    expect(edited.blocks[0]).toMatchObject({ title: "  My literal title  ", body: "My exact human words.", wording: "user_edited_unreviewed" });
    expect(edited.bases.slice(0, 30)).toEqual(story.bases);
    expect(edited.bases.at(-1)).toMatchObject({ kind: "consultant_judgment", userInputId: "edit-1", statement: exactSnapshot.userInput!.text });
    expect(storySchema.safeParse(edited).success).toBe(true);
    const { schemaVersion, origin, ...modelContent } = edited;
    expect(storyContentSchema.safeParse(modelContent).success).toBe(false);
    const editedAgain = exactStoryEdit({ ...exactSnapshot, before: edited, userInput: { id: "edit-2", text: exactSnapshot.userInput!.text } });
    expect(editedAgain.bases).toHaveLength(32);
    expect(storySchema.safeParse(editedAgain).success).toBe(true);
  });

  it("carries current Understanding gaps into a model story even when the model omits unknowns", async () => {
    const { story, snapshot } = await readyStory();
    snapshot.understanding.gaps = [{ description: "Who can approve the purchase?", whyItMatters: "Decision ownership", relatedSourceIds: [] }];
    const { schemaVersion, origin, ...content } = story;
    content.unknowns = [];
    content.blocks.forEach(block => { block.unknownIds = []; });
    const validated = validateStory(content, snapshot);
    expect(validated.unknowns).toContainEqual({ id: `understanding-gap:${snapshot.origin.understandingVersionId}:0`, text: "Who can approve the purchase?" });
    const saved = validated.unknowns[0]!;
    expect(validated.blocks.some(block => block.unknownIds.includes(saved.id))).toBe(true);
    const { schemaVersion: version, origin: savedOrigin, ...again } = validated;
    expect(validateStory(again, snapshot).unknowns).toEqual(validated.unknowns);
    again.unknowns[0]!.text = "The buyer has already approved.";
    expect(() => validateStory(again, snapshot)).toThrow("cannot be rewritten");
  });

  it("rebuilds gaps for a new Understanding but forbids removing unknowns in a same-origin judgment", async () => {
    const { story, snapshot } = await readyStory();
    expect(story.unknowns.length).toBeGreaterThan(0);
    story.unknowns.push({ id: "earlier-story-question", text: "What evidence would change this direction?" });
    story.blocks.at(-1)!.unknownIds.push("earlier-story-question");
    const { schemaVersion, origin, ...content } = structuredClone(story);
    content.unknowns = [];
    content.blocks.forEach(block => { block.unknownIds = []; });
    const revised: StorySnapshot = { ...snapshot, before: story, request: { kind: "revise_story", judgment: "Make the opening sharper." }, userInput: { id: "judgment", text: "Make the opening sharper." } };
    expect(() => validateStory(content, revised)).toThrow("remove or resolve");
    const next: StorySnapshot = { ...snapshot, before: story, origin: { ...snapshot.origin, understandingVersionId: "accepted-v2", positioningVersionId: "positioning-v2" }, understanding: { ...snapshot.understanding, gaps: [] } };
    expect(validateStory(content, next).unknowns).toEqual([]);
  });
});
describe("first human judgment loop",()=>{
 it("saves a preview without adoption and creates a deck only after explicit Apply",async()=>{setup();const preview=await propose(),p=preview.story!.proposals[0]!;expect(preview.story!.head.storyId).toBeNull();expect(()=>createFixtureStoryDeck({expected:preview.story!.head,commandId:"too-soon"})).toThrow();const applied=decideFixtureStory({expected:p.baseHead,proposalId:p.id,commandId:"apply",decision:"apply"});const deck=createFixtureStoryDeck({expected:applied.story!.head,commandId:"deck"});const story=applied.story!.versions.find(v=>v.id===applied.story!.head.storyId)!.story;expect(deck.deck!.proposal.schemaVersion).toBe(2);expect(deck.deck!.proposal.pages.map(p=>[p.title,p.body])).toEqual(story.blocks.map(b=>[b.title,b.body]));});
 it("preserves exact words, review diff, Undo generation and local restore without another model call",async()=>{setup();const initial=await adopt(),work=initial.story!,original=work.versions[0]!;const edited=await proposeFixtureStory({expected:work.head,commandId:"exact",request:{kind:"exact_edit",blockId:original.story.blocks[0]!.id,title:"  My exact wording  ",body:"A very specific human sentence."}});const p=edited.story!.proposals.at(-1)!;expect(p.state.kind).toBe("ready");if(p.state.kind!=="ready")throw Error("Missing preview");expect(p.state.diff.blocks[0]!.before?.title).toBe(original.story.coreMessage);expect(p.state.candidate.coreMessage).toBe("  My exact wording  ");const changed=decideFixtureStory({expected:p.baseHead,proposalId:p.id,commandId:"apply-edit",decision:"apply"});const undo=undoFixtureStory({expected:changed.story!.head,commandId:"undo"});expect(undo.story!.head.storyId).toBe(original.id);expect(undo.story!.head.generation).toBe(3);expect(()=>assertStoryHead(work.head,undo.story!.head)).toThrow();const restored=await proposeFixtureStory({expected:undo.story!.head,commandId:"restore",request:{kind:"restore",storyId:changed.story!.head.storyId!}});expect(restored.story!.proposals.at(-1)!.state.kind).toBe("ready");});
 it("replays adoption before present freshness and rejects changed command payload",async()=>{setup();const s=await propose(),p=s.story!.proposals[0]!;const input={expected:p.baseHead,proposalId:p.id,commandId:"apply-once",decision:"apply" as const};const applied=decideFixtureStory(input);undoFixtureStory({expected:applied.story!.head,commandId:"undo"});expect(decideFixtureStory(input).story!.head.generation).toBe(2);expect(()=>decideFixtureStory({...input,decision:"keep_current"})).toThrow("reused");});
 it("fences a changed selection on the same positioning id and permits stale dismissal",async()=>{const s=setup();const preview=await propose(),p=preview.story!.proposals[0]!;const next=applyFixturePositioning(s.positioning!.proposal.directions[1]!.id,s.project.revision);expect(next.positioning!.id).toBe(s.positioning!.id);expect(next.story!.proposals[0]!.state.kind).toBe("stale");expect(()=>decideFixtureStory({expected:p.baseHead,proposalId:p.id,commandId:"stale-apply",decision:"apply"})).toThrow();expect(decideFixtureStory({expected:p.baseHead,proposalId:p.id,commandId:"dismiss",decision:"keep_current"}).story!.proposals[0]!.state.kind).toBe("kept");});
 it("keeps old decks immutable and stale after Undo and exact manual page editing",async()=>{setup();const s=await adopt(),deck=createFixtureStoryDeck({expected:s.story!.head,commandId:"deck"});undoFixtureStory({expected:s.story!.head,commandId:"undo"});const p=deck.deck!.proposal.pages[0]!;const edited=editFixtureDeckPage(deck.deck!.id,deck.deck!.number,p.id,"  exact page  ","My literal words.");expect(edited.deck!.stale).toBe(true);expect(edited.deckVersions[0]!.proposal.pages[0]!.title).toBe(p.title);expect(edited.deck!.proposal.pages[0]!.title).toBe("  exact page  ");expect(edited.deck!.proposal.pages[0]).toMatchObject({wording:"user_edited_unreviewed"});});
 it("accepts a revision proposal while accepted and Apply creates review-required state",async()=>{const s=setup();const submitted=submitFixtureClarification({text:"The audience is procurement, not delivery consultants.",expectedRevision:s.project.revision,commandId:"revise"});expect(submitted.project.phase).toBe("accepted");const task=submitted.clarifications!.at(-1)!;expect(task.basePhase).toBe("accepted");await runFixtureClarification(task.id);const ready=readFixtureState().clarifications!.at(-1)!;expect(ready.status).toBe("proposal_ready");const applied=decideFixtureClarification({taskId:task.id,action:"apply",commandId:"apply-revision"});expect(applied.project.phase).toBe("review_required");expect(applied.versions).toHaveLength(2);expect(applied.positioning).toBeUndefined();});
 it("computes moves locally and rejects invented quotations and forged Chinese human edits",async()=>{setup();const s=await propose(),p=s.story!.proposals[0]!;if(p.state.kind!=="ready")throw Error("No story");const story=p.state.candidate,after=structuredClone(story);[after.blocks[0],after.blocks[1]]=[after.blocks[1]!,after.blocks[0]!];expect(compareStories(story,after).blocks.map(b=>b.kind)).toEqual(["moved","moved"]);const {schemaVersion,origin,...content}=structuredClone(story);content.blocks[0]!.wording="user_edited_unreviewed";const snapshot=structuredClone(p.snapshot);snapshot.understanding.nextQuestion.question="谁负责？";expect(()=>validateStory(content,snapshot)).toThrow("human edit");content.blocks[0]!.wording="agent_proposed";const basis=content.bases.find(b=>b.kind==="source_excerpt");if(basis?.kind==="source_excerpt")basis.quote="Fabricated quote";expect(()=>validateStory(content,snapshot)).toThrow("quotation");});
 it("reads successful DeepSeek error:null responses and sends arbitrary judgment literally",async()=>{setup();const s=await propose(),p=s.story!.proposals[0]!;if(p.state.kind!=="ready")throw Error("No story");const snapshot=structuredClone(p.snapshot);snapshot.before=p.state.candidate;snapshot.request={kind:"revise_story",judgment:"Open with a procurement dispute, show who owns approval."};snapshot.userInput={id:"input-x",text:snapshot.request.judgment};const {schemaVersion,origin,...content}=structuredClone(p.state.candidate);content.blocks[1]!.body="Procurement needs a named owner before trusting an approval.";let request="";const transport:typeof fetch=async(_url,init)=>{request=String(init?.body);return new Response(JSON.stringify({status:"completed",error:null,output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({story:content,responseToJudgment:"The scene now makes ownership concrete."})}]}]}));};const output=await new ResponsesStoryRunner({apiKey:"test",model:"test",baseURL:"https://example.test",fetch:transport}).run(snapshot);expect(request).toContain(snapshot.request.judgment);expect(output.story.blocks[1]!.body).toContain("named owner");});
});

it("keeps English story instructions with Chinese saved context and feedback without mutating history", async () => {
 const {story,snapshot}=await readyStory();
 const before=structuredClone(story);
 snapshot.understanding.nextQuestion.question="还缺什么信息？";
 snapshot.before=story;
 snapshot.request={kind:"revise_story",judgment:"请强调审批责任，保持英文。"};
 snapshot.userInput={id:"feedback-cn",text:snapshot.request.judgment};
 const {schemaVersion,origin,...content}=structuredClone(story);
 const transport:typeof fetch=async(_url,init)=>{
   const request=JSON.parse(String(init?.body));
   expect(request.input[0].content).toContain("Pitchroom is English-only");
   expect(request.input[0].content).not.toContain("Use the language of accepted Understanding nextQuestion");
   expect(JSON.parse(request.input[1].content).userInput.text).toBe(snapshot.userInput!.text);
   return new Response(JSON.stringify({status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({story:content,responseToJudgment:"The saved wording remains available for review."})}]}]}));
 };
 const output=await new ResponsesStoryRunner({apiKey:"offline",model:"offline",baseURL:"https://example.test",fetch:transport}).run(snapshot);
 expect(output.story.coreMessage).toBe(story.coreMessage);
 expect(story).toEqual(before);
});

it("advertises a wire contract that rejects external IDs while preserving saved local links", async () => {
 const {story,snapshot}=await readyStory(); snapshot.before=story;
 const {schemaVersion,origin,...content}=structuredClone(story);
 const transport: typeof fetch = async (_url, init) => {
  const request=z.object({text:z.object({format:z.object({schema:z.record(z.string(),z.unknown())})})}).parse(JSON.parse(String(init?.body)));
  const wire=z.fromJSONSchema(request.text.format.schema);
  const valid={story:content,responseToJudgment:"Saved local links remain available."};
  expect(wire.safeParse(valid).success).toBe(true);
  const confused=structuredClone(valid);
  confused.story.strategicRationale.basisRefs=["external-understanding-basis"];
  expect(wire.safeParse(confused).success).toBe(false);
  const blockConfusion=structuredClone(valid);
  blockConfusion.story.blocks[1]!.basisRefs=["external-understanding-basis"];
  expect(wire.safeParse(blockConfusion).success).toBe(false);
  const identityConfusion=structuredClone(valid);
  identityConfusion.story.bases[0]!.id="external-understanding-basis";
  expect(wire.safeParse(identityConfusion).success).toBe(false);
  return new Response(JSON.stringify({status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify(valid)}]}]}));
 };
 const result=await new ResponsesStoryRunner({apiKey:"offline",model:"offline",baseURL:"https://example.test",fetch:transport}).run(snapshot);
 expect(result.story.bases).toEqual(story.bases);
 expect(result.story.strategicRationale.basisRefs).toEqual(story.strategicRationale.basisRefs);
});

it("rejects a confused response without remapping references or exposing schema value lists", async () => {
 const {story,snapshot}=await readyStory(); snapshot.before=story;
 const {schemaVersion,origin,...content}=structuredClone(story);
 content.strategicRationale.basisRefs=["external-understanding-basis"];
 const transport: typeof fetch = async () => new Response(JSON.stringify({status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({story:content,responseToJudgment:"Review this candidate."})}]}]}));
 await expect(new ResponsesStoryRunner({apiKey:"offline",model:"offline",baseURL:"https://example.test",fetch:transport}).run(snapshot)).rejects.toMatchObject({code:"PROPOSAL_REJECTED",message:"The generated story contained invalid structure or evidence links. Your saved story was preserved."});
 expect(content.strategicRationale.basisRefs).toEqual(["external-understanding-basis"]);
 expect(snapshot.before).toEqual(story);
});

it("still rejects an allowed local reference that has no defined Story basis", async () => {
 const {story,snapshot}=await readyStory(); snapshot.before=story;
 const {schemaVersion,origin,...content}=structuredClone(story);
 const transport: typeof fetch = async (_url,init) => {
  const request=z.object({input:z.array(z.object({content:z.string()}))}).parse(JSON.parse(String(init?.body)));
  const input=z.object({referenceContract:z.object({localBasisIds:z.array(z.string())})}).parse(JSON.parse(request.input[1]!.content));
  const undefinedId=input.referenceContract.localBasisIds.find(id=>!content.bases.some(basis=>basis.id===id));
  if(!undefinedId) throw Error("Missing unused local slot");
  content.strategicRationale.basisRefs=[undefinedId];
  return new Response(JSON.stringify({status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({story:content,responseToJudgment:"Review this candidate."})}]}]}));
 };
 await expect(new ResponsesStoryRunner({apiKey:"offline",model:"offline",baseURL:"https://example.test",fetch:transport}).run(snapshot)).rejects.toThrow("Story has an unknown or duplicate basis reference.");
 expect(snapshot.before).toEqual(story);
});
