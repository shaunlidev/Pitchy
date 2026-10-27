import {readPositioning} from "@pitchroom/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { type Story, type StoryProposal, type UnderstandingProposalV1, type PositioningProposalV1 } from "@pitchroom/domain";
import { createDatabase, PitchroomRepository } from "./repository";
import { StoryRepository } from "./story-repository";
const url=process.env.DATABASE_URL;
if(!url)throw Error("DATABASE_URL is required for isolated PostgreSQL integration tests.");
const database=createDatabase(url),repo=new PitchroomRepository(database.db),stories=new StoryRepository(database.db);
beforeAll(async()=>migrate(database.db,{migrationsFolder:new URL("../migrations",import.meta.url).pathname}));
afterAll(async()=>database.client.end());
async function setup(){
 const project=await repo.createProject("Isolated Story contract");await repo.addMaterial(project.id,{name:"brief.md",mediaType:"text/markdown",text:"The project has no measured approval-time result."},"source");
 const source=(await repo.listSources(project.id))[0]!,chunk=source.chunks[0]!,evidence={sourceId:source.id,chunkId:chunk.id,quote:chunk.text};
 const proposal:UnderstandingProposalV1={schemaVersion:1,themes:[{title:"Approval",summary:"Evidence is incomplete.",claims:[{statement:chunk.text,evidenceState:"supported",evidence:[evidence],userInputIds:[]}]}],gaps:[{description:"Who approves the result?",whyItMatters:"Accountability",relatedSourceIds:[]}],nextQuestion:{question:"Who approves the result?",whyItMatters:"Accountability",relatedThemeIndexes:[0]}};
 const run=await repo.createRun(project.id,"understanding","test","synthetic");const understanding=await repo.completeRun({projectId:project.id,runId:run.id,expectedRevision:0,proposal});await repo.acceptUnderstanding({projectId:project.id,understandingId:understanding.id,expectedRevision:1,actorId:"test",idempotencyKey:"accept"});
 const direction=(id:string):PositioningProposalV1["directions"][number]=>({id,title:id,coreMessage:"Make review ownership clear",from:"Unclear ownership",to:"An identified reviewer",tradeoff:"No speed promise",excludes:["Performance claims"],evidence:[evidence],userInputIds:[]});
 const pos=await repo.createPositioning({projectId:project.id,understandingId:understanding.id,expectedRevision:1,idempotencyKey:"positioning",proposal:{schemaVersion:1,understandingVersionId:understanding.id,originalFraming:{title:"Original framing",coreMessage:"An approval tool"},directions:[direction("d1"),direction("d2")]}});
 await repo.applyPositioning({ expectedPositioning:readPositioning((await repo.getCurrentPositioning(project.id))!).head,projectId:project.id,directionId:"d1",expectedRevision:1,idempotencyKey:"choose"});return {projectId:project.id,posId:pos.id,evidence};
}
function candidate(p:StoryProposal):Story {
 const e=p.snapshot.positioning.directions[0]!.evidence[0]!;
 return {schemaVersion:1,origin:p.snapshot.origin,audience:"Procurement",coreMessage:"Make review ownership clear",strategicRationale:{choice:"Lead with responsibility",tradeoff:"Avoid unsupported speed promises",exclusions:["Guaranteed savings"],conditionsToReconsider:["Measured evidence arrives"],basisRefs:["source"]},bases:[{kind:"source_excerpt",id:"source",...e,statement:"No measured result",nature:"record"}],unknowns:[{id:"approval",text:"Who approves?"}],blocks:[{id:"lead",role:"promise",title:"Make review ownership clear",body:"A reviewer makes a decision traceable.",basisRefs:["source"],unknownIds:[],emphasis:[],wording:"agent_proposed"},{id:"evidence",role:"evidence",title:"The measurement stays open",body:"No approval-time result has been measured.",basisRefs:["source"],unknownIds:[],emphasis:[],wording:"agent_proposed"},{id:"open",role:"open_questions",title:"Name the decision owner",body:"Who is responsible for approval?",basisRefs:[],unknownIds:["approval"],emphasis:[],wording:"agent_proposed"}]};
}
async function ready(projectId:string,commandId:string){const {head}=await stories.read(projectId);const started=await stories.start({projectId,expected:head,commandId,request:{kind:"develop_direction"},model:"synthetic"});const p=await stories.finish(started.proposal,{story:candidate(started.proposal),responseToJudgment:"Review responsibility leads."});return p;}
describe("Story PostgreSQL transactions",()=>{
 it("reads back an exact edit after all 30 model basis slots are occupied", async () => {
  const {projectId} = await setup();
  const started = await stories.start({projectId,expected:{storyId:null,generation:0},commandId:"full-bases",request:{kind:"develop_direction"},model:"synthetic"});
  const original = candidate(started.proposal), source = original.bases[0]!;
  original.bases = Array.from({length:30},(_,index)=>({...source,id:index===0?source.id:`source-${index}`}));
  const preview = await stories.finish(started.proposal,{story:original,responseToJudgment:"Review all source bases."});
  await stories.decide({projectId,proposalId:preview.id,expected:preview.baseHead,commandId:"adopt-full-bases",decision:"apply"});
  const adopted = await stories.read(projectId);
  const exact = await stories.start({projectId,expected:adopted.head,commandId:"exact",request:{kind:"exact_edit",blockId:"lead",title:"  Literal human title  ",body:"Human wording with its own saved provenance."},model:"local"});
  const edited = await stories.localCandidate(exact.proposal);
  if (!edited) throw Error("No exact candidate");
  await stories.finish(exact.proposal,{story:edited,responseToJudgment:"Review exact human wording."});
  const connection = createDatabase(url!);
  try {
   const readback = await new StoryRepository(connection.db).read(projectId);
   const ready = readback.proposals.find(proposal=>proposal.id===exact.proposal.id)!;
   if (ready.state.kind !== "ready") throw Error("Exact preview was not readable");
   expect(ready.state.candidate.bases).toHaveLength(31);
   expect(ready.state.candidate.bases.slice(0,30)).toEqual(original.bases);
   expect(ready.state.candidate.blocks[0]).toMatchObject({title:"  Literal human title  ",body:"Human wording with its own saved provenance.",wording:"user_edited_unreviewed"});
   expect(ready.state.candidate.bases.at(-1)).toMatchObject({kind:"consultant_judgment",userInputId:exact.proposal.snapshot.userInput!.id});
   expect(readback.head).toEqual(adopted.head);
  } finally { await connection.client.end(); }
 });
 it.each([false,true])("rejects an invalid completion before persisting candidate content, stale=%s", async stale => {
  const {projectId} = await setup();
  const started = await stories.start({projectId,expected:{storyId:null,generation:0},commandId:"invalid-result",request:{kind:"develop_direction"},model:"synthetic"});
  if (stale) await repo.applyPositioning({ expectedPositioning:readPositioning((await repo.getCurrentPositioning(projectId))!).head,projectId,directionId:"d2",expectedRevision:1,idempotencyKey:"change-direction"});
  const invalid = candidate(started.proposal);
  invalid.blocks[0]!.title = "";
  await expect(stories.finish(started.proposal,{story:invalid,responseToJudgment:"Invalid candidate"})).rejects.toThrow();
  const readback = await stories.read(projectId);
  expect(readback.versions).toEqual([]);
  expect(readback.head).toEqual({storyId:null,generation:0});
  expect(readback.proposals[0]!.state).toMatchObject(stale?{kind:"stale",savedCandidate:null}:{kind:"running"});
 });
 it("persists exact previews, serializes concurrent adoption, replays receipts and fences Undo ABA",async()=>{
  const {projectId}=await setup(),p=await ready(projectId,"start");expect((await stories.read(projectId)).head.storyId).toBeNull();
  const action={projectId,proposalId:p.id,expected:p.baseHead,commandId:"apply",decision:"apply" as const};
  await Promise.all([stories.decide(action),stories.decide(action)]);const adopted=await stories.read(projectId);expect(adopted.head.generation).toBe(1);expect(adopted.versions).toHaveLength(1);
  const deckId=await stories.createDeck({projectId,expected:adopted.head,commandId:"deck"});const deck=await repo.getCurrentDeck(projectId);expect(deck?.id).toBe(deckId);expect(deck?.proposal.schemaVersion).toBe(2);
  if(!deck)throw Error("No persisted deck");
  const edited=await repo.editDeckPage({projectId,deckId:deck.id,expectedDeckVersion:deck.version,pageId:deck.proposal.pages[0]!.id,title:"  Exact page words  ",body:"A human edits the presentation.",idempotencyKey:"edit"});
  if(!edited)throw Error("No edited deck");
  expect(edited.proposal.pages[0]).toMatchObject({title:"  Exact page words  ",wording:"user_edited_unreviewed"});
  expect((await repo.listDeckVersions(projectId))[0]!.proposal.pages[0]!.title).toBe(deck.proposal.pages[0]!.title);
  await stories.undo({projectId,expected:adopted.head,commandId:"undo"});await stories.decide(action);expect((await stories.read(projectId)).head).toEqual({storyId:null,generation:2});
  await expect(stories.createDeck({projectId,expected:adopted.head,commandId:"old-head"})).rejects.toThrow("changed");
  const restore=await stories.start({projectId,expected:{storyId:null,generation:2},commandId:"restore",request:{kind:"restore",storyId:adopted.head.storyId!},model:"local"});
  const restored=await stories.localCandidate(restore.proposal);expect(restored).toEqual(adopted.versions[0]!.story);
  await stories.finish(restore.proposal,{story:restored!,responseToJudgment:"Restore exact saved wording."});await stories.decide({projectId,proposalId:restore.proposal.id,expected:{storyId:null,generation:2},commandId:"apply-restore",decision:"apply"});
  const connection=createDatabase(url!);try{const readback=await new StoryRepository(connection.db).read(projectId);expect(readback.head.generation).toBe(3);expect(readback.versions).toHaveLength(2);expect((await new PitchroomRepository(connection.db).getCurrentDeck(projectId))?.id).toBe(edited.id);}finally{await connection.client.end();}
 });
 it("rejects direction changes during generation and lets stale proposals be dismissed",async()=>{
  const {projectId,posId}=await setup();const started=await stories.start({projectId,expected:{storyId:null,generation:0},commandId:"running",request:{kind:"develop_direction"},model:"test"});
  await repo.applyPositioning({ expectedPositioning:readPositioning((await repo.getCurrentPositioning(projectId))!).head,projectId,directionId:"d2",expectedRevision:1,idempotencyKey:"changed"});expect((await repo.getCurrentPositioning(projectId))?.id).toBe(posId);
  const completed=await stories.finish(started.proposal,{story:candidate(started.proposal),responseToJudgment:"Late result"});expect(completed.state.kind).toBe("stale");
  await expect(stories.decide({projectId,proposalId:completed.id,expected:completed.baseHead,commandId:"bad-apply",decision:"apply"})).rejects.toThrow("fresh");await stories.decide({projectId,proposalId:completed.id,expected:completed.baseHead,commandId:"dismiss",decision:"keep_current"});expect((await stories.read(projectId)).proposals[0]!.state.kind).toBe("kept");
 });
 it("keeps failed attempts, retries explicitly with current model metadata and ignores abandoned completion",async()=>{
  const {projectId}=await setup();const first=await stories.start({projectId,expected:{storyId:null,generation:0},commandId:"first",request:{kind:"develop_direction"},model:"old",promptVersion:"old-prompt"});await stories.finish(first.proposal,{error:"Provider failed"});
  const retry=await stories.start({projectId,expected:first.proposal.baseHead,commandId:"retry",retryOf:first.proposal.id,request:first.proposal.snapshot.request,model:"new",promptVersion:"new-prompt"});expect(retry.proposal.snapshot.model).toBe("new");expect(retry.proposal.snapshot.promptVersion).toBe("new-prompt");
  await stories.finish(first.proposal,{story:candidate(first.proposal),responseToJudgment:"Old late response"});expect((await stories.read(projectId)).proposals.find(p=>p.id===first.proposal.id)!.state.kind).toBe("kept");
  await stories.decide({projectId,proposalId:retry.proposal.id,expected:retry.proposal.baseHead,commandId:"dismiss-running",decision:"keep_current"});await stories.finish(retry.proposal,{story:candidate(retry.proposal),responseToJudgment:"Abandoned"});expect((await stories.read(projectId)).head.storyId).toBeNull();
 });
});
