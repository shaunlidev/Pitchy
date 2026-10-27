import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { readPositioning, assertStoryHead, sameStoryOrigin, compareStories, exactStoryEdit, PitchroomError, sourceFingerprint, storyIsFresh, storySchema, storyProposalSchema, storyToDeck, storyVersionSchema, type Story, type StoryHead, type StoryProposal, type StoryRequest, type StorySnapshot, type StoryWorkspace } from "@pitchroom/domain";
import type { Database } from "./repository";
import * as schema from "./schema";

type Store = Pick<Database, "select" | "insert" | "update" | "execute" | "query">;
const headOf = (project: typeof schema.projects.$inferSelect): StoryHead => ({ generation: project.storyGeneration, storyId: project.currentStoryId });
async function context(db: Store, projectId: string) {
  const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
  if (!project) throw new PitchroomError("NOT_FOUND", "Project was not found.");
  const positioning = project.currentPositioningId ? await db.query.positioningVersions.findFirst({ where: and(eq(schema.positioningVersions.id, project.currentPositioningId), eq(schema.positioningVersions.projectId, projectId)) }) : undefined;
  const rows = await db.select().from(schema.sources).where(and(eq(schema.sources.projectId, projectId), isNull(schema.sources.deletedAt)));
  const chunks = rows.length ? await db.select().from(schema.sourceChunks).where(inArray(schema.sourceChunks.sourceId, rows.map(s => s.id))) : [];
  const sources = rows.map(row => ({ id: row.id, projectId, name: row.name, mediaType: row.mediaType, contentHash: row.contentHash, chunks: chunks.filter(c => c.sourceId === row.id).map(c => ({ id: c.id, sourceId: c.sourceId, text: c.text, startOffset: c.startOffset, endOffset: c.endOffset })) }));
  const applied=positioning ? readPositioning(positioning).applied : null;
  return { project, positioning, sources, current: { phase: project.phase, understandingId: project.currentUnderstandingId, positioningId: applied?.positioningId ?? null, positioningDecisionId:applied?.decisionId, directionId: applied?.choice.id ?? null, sources } };
}
async function receipt(db: Store, input: { projectId: string; commandId: string }, type: string, hash: string) {
  const row = await db.query.commandReceipts.findFirst({ where: and(eq(schema.commandReceipts.projectId, input.projectId), eq(schema.commandReceipts.idempotencyKey, input.commandId)) });
  if (row && (row.commandType !== type || row.requestHash !== hash)) throw new PitchroomError("CONFLICT", "This command ID was used for another request.");
  return row;
}
async function saveReceipt(db: Store, input: { projectId: string; commandId: string }, type: string, hash: string, resourceId: string) {
  await db.insert(schema.commandReceipts).values({ projectId: input.projectId, idempotencyKey: input.commandId, commandType: type, requestHash: hash, resourceId });
}
async function saveProposal(db: Store, proposal: StoryProposal) { await db.update(schema.storyProposals).set({ payload: proposal, updatedAt: new Date() }).where(eq(schema.storyProposals.id, proposal.id)); }
export class StoryRepository {
  constructor(readonly db: Database) {}
  async read(projectId: string): Promise<StoryWorkspace> {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select id from projects where id = ${projectId} for update`);
      const ctx = await context(tx, projectId);
      const versions = (await tx.select().from(schema.storyVersions).where(eq(schema.storyVersions.projectId, projectId))).map(r => storyVersionSchema.parse(r.payload)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
      const proposals = (await tx.select().from(schema.storyProposals).where(eq(schema.storyProposals.projectId, projectId))).map(r=>storyProposalSchema.parse(r.payload)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
      for (const proposal of proposals) {
        if (proposal.state.kind === "running" && Date.parse(proposal.state.deadline) < Date.now()) { proposal.state = { kind: "failed", explanation: "The attempt was interrupted or timed out. Your input is saved. Retry explicitly." }; await saveProposal(tx, proposal); await tx.update(schema.workflowRuns).set({status:"failed",failureCode:"INTERRUPTED",failureMessage:"Story attempt interrupted; explicit retry required.",finishedAt:new Date()}).where(and(eq(schema.workflowRuns.projectId,projectId),eq(schema.workflowRuns.idempotencyKey,`story:${proposal.id}`))); }
        if (["running", "ready", "no_change", "failed"].includes(proposal.state.kind) && (JSON.stringify(proposal.baseHead) !== JSON.stringify(headOf(ctx.project)) || !storyIsFresh(proposal.snapshot.origin, ctx.current))) {
          proposal.state = { kind: "stale", explanation: "Story or accepted inputs changed. Keep this result or submit a new judgment against the current story.", savedCandidate: proposal.state.kind === "ready" ? proposal.state.candidate : null }; await saveProposal(tx, proposal);
        }
      }
      const adopted = versions.find(v=>v.id===ctx.project.currentStoryId);
      return { head: headOf(ctx.project), versions, proposals, stale: Boolean(adopted && !storyIsFresh(adopted.story.origin, ctx.current)) };
    });
  }
  async start(input: { projectId: string; expected: StoryHead; commandId: string; request: StoryRequest; model: string; promptVersion?: string; retryOf?: string }) {
    const hash = JSON.stringify({ expected: input.expected, request: input.request, retryOf: input.retryOf });
    return this.db.transaction(async tx => {
      await tx.execute(sql`select id from projects where id = ${input.projectId} for update`);
      const existing = await tx.query.storyProposals.findFirst({ where: and(eq(schema.storyProposals.projectId, input.projectId), eq(schema.storyProposals.commandId, input.commandId)) });
      if (existing) { if (existing.requestHash !== hash) throw new PitchroomError("CONFLICT", "This command ID was used for another story request."); return { proposal: storyProposalSchema.parse(existing.payload), created: false }; }
      if (await tx.query.commandReceipts.findFirst({ where: and(eq(schema.commandReceipts.projectId,input.projectId),eq(schema.commandReceipts.idempotencyKey,input.commandId)) })) throw new PitchroomError("CONFLICT", "This command ID was already used.");
      const ctx = await context(tx, input.projectId); assertStoryHead(input.expected, headOf(ctx.project));
      if (ctx.project.phase !== "accepted" || !ctx.project.currentUnderstandingId || !ctx.positioning?.appliedDirectionId || ctx.positioning.understandingId !== ctx.project.currentUnderstandingId) throw new PitchroomError("CONFLICT", "Accept the current understanding and apply a direction before developing a story.");
      const tasks = await tx.select().from(schema.storyProposals).where(eq(schema.storyProposals.projectId,input.projectId));
      const prior = input.retryOf ? tasks.find(t=>t.id===input.retryOf)?.payload : undefined;
      if (input.retryOf && (!prior || prior.state.kind === "applied" || prior.state.kind === "kept" || prior.state.kind === "running" || !storyIsFresh(prior.snapshot.origin,ctx.current))) throw new PitchroomError("CONFLICT", "This saved attempt cannot be retried. Submit a new judgment against current inputs.");
      if (prior) { assertStoryHead(prior.baseHead, input.expected); if (JSON.stringify(prior.snapshot.request)!==JSON.stringify(input.request)) throw new PitchroomError("CONFLICT", "Retry must preserve the saved request."); }
      for (const row of tasks) {
        const p = storyProposalSchema.parse(row.payload);
        if (p.id !== input.retryOf && (p.state.kind === "running" || p.state.kind === "ready")) throw new PitchroomError("CONFLICT", "Apply or keep the current proposal first.");
        if (p.state.kind !== "applied" && p.state.kind !== "kept") { p.savedResult = p.state; p.state = { kind: "kept", commandId: input.commandId }; await saveProposal(tx,p); }
      }
      const understanding = await tx.query.understandingVersions.findFirst({ where: eq(schema.understandingVersions.id,ctx.project.currentUnderstandingId) });
      if (!understanding) throw new PitchroomError("NOT_FOUND", "Accepted understanding is unavailable.");
      const beforeRow = ctx.project.currentStoryId ? await tx.query.storyVersions.findFirst({ where: eq(schema.storyVersions.id,ctx.project.currentStoryId) }) : undefined;
      const before = beforeRow ? storyVersionSchema.parse(beforeRow.payload).story : null;
      if (input.request.kind !== "develop_direction" && input.request.kind !== "restore" && (!before || !storyIsFresh(before.origin,ctx.current))) throw new PitchroomError("CONFLICT", "Develop a story from the current accepted inputs first.");
      const userText = input.request.kind === "revise_story" ? input.request.judgment : input.request.kind === "exact_edit" ? `${input.request.title}\n${input.request.body}` : undefined;
      const userInput = prior?.snapshot.userInput ?? (userText ? { id: crypto.randomUUID(), text: userText } : null);
      if (userInput && !prior) await tx.insert(schema.userInputs).values({ id:userInput.id, projectId:input.projectId, kind:"story_judgment", text:userInput.text, actorId:"local-user", targetVersion:ctx.project.version, idempotencyKey:input.commandId });
      const applied=readPositioning(ctx.positioning).applied!;
      const snapshot: StorySnapshot = prior ? { ...prior.snapshot, model:input.model, promptVersion:input.promptVersion??"story-v1" } : { origin: { understandingVersionId:understanding.id, positioningVersionId:applied.positioningId, positioningDecisionId:applied.decisionId ?? undefined, directionId:applied.choice.id, sourceFingerprint:sourceFingerprint(ctx.sources) }, understanding:understanding.proposal, positioning:ctx.positioning.proposal, selectedChoice:structuredClone(applied.choice), sources:ctx.sources, before, request:input.request, userInput, model:input.model, promptVersion:input.promptVersion??"story-v1" };
      const id = crypto.randomUUID();
      const proposal: StoryProposal = { id, projectId:input.projectId, commandId:input.commandId, createdAt:new Date().toISOString(), baseHead:input.expected, snapshot, state:{kind:"running",attemptId:crypto.randomUUID(),deadline:new Date(Date.now()+120000).toISOString()} };
      await tx.insert(schema.storyProposals).values({ id, projectId:input.projectId,commandId:input.commandId,requestHash:hash,payload:proposal });
      return { proposal, created:true };
    });
  }
  async localCandidate(proposal: StoryProposal) {
    if (proposal.snapshot.request.kind === "exact_edit") return exactStoryEdit(proposal.snapshot);
    if (proposal.snapshot.request.kind !== "restore") return undefined;
    const row = await this.db.query.storyVersions.findFirst({ where: and(eq(schema.storyVersions.projectId,proposal.projectId),eq(schema.storyVersions.id,proposal.snapshot.request.storyId)) });
    if (!row) throw new PitchroomError("NOT_FOUND", "Saved story is unavailable.");
    const restored = storyVersionSchema.parse(row.payload).story;
    if (!sameStoryOrigin(restored.origin,proposal.snapshot.origin)) throw new PitchroomError("CONFLICT", "Saved story belongs to different accepted inputs or direction.");
    return restored;
  }
  async finish(proposal: StoryProposal, output: { story: Story; responseToJudgment: string } | { error: string }) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select id from projects where id = ${proposal.projectId} for update`);
      const row = await tx.query.storyProposals.findFirst({ where:eq(schema.storyProposals.id,proposal.id) });
      if (!row) throw new PitchroomError("NOT_FOUND", "Story attempt disappeared.");
      const current = storyProposalSchema.parse(row.payload);
      if (current.state.kind !== "running" || proposal.state.kind !== "running" || current.state.attemptId !== proposal.state.attemptId) return current;
      if ("story" in output) output = { ...output, story: storySchema.parse(output.story) };
      const ctx = await context(tx,proposal.projectId);
      const fresh = JSON.stringify(current.baseHead)===JSON.stringify(headOf(ctx.project)) && storyIsFresh(current.snapshot.origin,ctx.current);
      if (!fresh) current.state = { kind:"stale", explanation:"Accepted inputs or the adopted story changed during generation.",savedCandidate:"story" in output ? output.story : null };
      else if ("error" in output) current.state = { kind:"failed",explanation:output.error };
      else {
        const diff = compareStories(current.snapshot.before,output.story);
        if (!diff.blocks.length && !diff.fields.length) current.state = { kind:"no_change",explanation:output.responseToJudgment };
        else { const id=crypto.randomUUID(); current.state={kind:"ready",candidateId:id,candidate:output.story,diff,responseToJudgment:output.responseToJudgment}; await tx.insert(schema.storyVersions).values({id,projectId:proposal.projectId,payload:{id,parentId:proposal.baseHead.storyId,proposalId:proposal.id,story:output.story,snapshot:proposal.snapshot,createdAt:new Date().toISOString()}}); }
      }
      await saveProposal(tx,current); return current;
    });
  }
  async decide(input: { projectId:string; proposalId:string; expected:StoryHead; commandId:string; decision:"apply"|"keep_current" }) {
    const hash=JSON.stringify(input);
    return this.db.transaction(async tx=>{
      await tx.execute(sql`select id from projects where id = ${input.projectId} for update`);
      if (await receipt(tx,input,"decide_story",hash)) return;
      const row=await tx.query.storyProposals.findFirst({where:and(eq(schema.storyProposals.id,input.proposalId),eq(schema.storyProposals.projectId,input.projectId))});
      if(!row) throw new PitchroomError("NOT_FOUND","Story proposal was not found.");
      const proposal=storyProposalSchema.parse(row.payload);
      if(proposal.state.kind==="applied"||proposal.state.kind==="kept") throw new PitchroomError("CONFLICT","This proposal was already resolved.");
      proposal.savedResult = proposal.state;
      if(input.decision==="keep_current") proposal.state={kind:"kept",commandId:input.commandId};
      else {
        const ctx=await context(tx,input.projectId); assertStoryHead(input.expected,headOf(ctx.project)); assertStoryHead(proposal.baseHead,input.expected);
        if(proposal.state.kind!=="ready"||!storyIsFresh(proposal.snapshot.origin,ctx.current)) throw new PitchroomError("CONFLICT","Only a fresh reviewed story can be applied.");
        const generation=ctx.project.storyGeneration+1, id=proposal.state.candidateId;
        await tx.update(schema.projects).set({currentStoryId:id,storyGeneration:generation,updatedAt:new Date()}).where(eq(schema.projects.id,input.projectId));
        proposal.state={kind:"applied",storyId:id,generation,commandId:input.commandId};
      }
      await saveProposal(tx,proposal); await saveReceipt(tx,input,"decide_story",hash,proposal.id);
    });
  }
  async undo(input:{projectId:string;expected:StoryHead;commandId:string}) {
    const hash=JSON.stringify(input);
    return this.db.transaction(async tx=>{
      await tx.execute(sql`select id from projects where id = ${input.projectId} for update`);
      if(await receipt(tx,input,"undo_story",hash)) return;
      const ctx=await context(tx,input.projectId); assertStoryHead(input.expected,headOf(ctx.project));
      const row=ctx.project.currentStoryId?await tx.query.storyVersions.findFirst({where:eq(schema.storyVersions.id,ctx.project.currentStoryId)}):undefined;
      if(!row) throw new PitchroomError("CONFLICT","No adopted story can be undone.");
      const version=storyVersionSchema.parse(row.payload);
      await tx.update(schema.projects).set({currentStoryId:version.parentId,storyGeneration:ctx.project.storyGeneration+1,updatedAt:new Date()}).where(eq(schema.projects.id,input.projectId));
      await saveReceipt(tx,input,"undo_story",hash,version.id);
    });
  }
  async createDeck(input:{projectId:string;expected:StoryHead;commandId:string}) {
    const hash=JSON.stringify(input);
    return this.db.transaction(async tx=>{
      await tx.execute(sql`select id from projects where id = ${input.projectId} for update`);
      const replay=await receipt(tx,input,"story_deck",hash); if(replay) return replay.resourceId;
      const ctx=await context(tx,input.projectId); assertStoryHead(input.expected,headOf(ctx.project));
      const row=ctx.project.currentStoryId?await tx.query.storyVersions.findFirst({where:eq(schema.storyVersions.id,ctx.project.currentStoryId)}):undefined;
      if(!row) throw new PitchroomError("CONFLICT","Apply a story before creating a deck.");
      const version=storyVersionSchema.parse(row.payload);
      if(!storyIsFresh(version.story.origin,ctx.current)) throw new PitchroomError("CONFLICT","The adopted story belongs to earlier accepted inputs. Develop and review a current story first.");
      const proposal=storyToDeck({storyId:version.id,generation:ctx.project.storyGeneration,story:version.story});
      const [latest]=await tx.select({version:sql<number>`coalesce(max(${schema.deckVersions.version}),0)`}).from(schema.deckVersions).where(eq(schema.deckVersions.projectId,input.projectId));
      const [deck]=await tx.insert(schema.deckVersions).values({projectId:input.projectId,understandingId:version.story.origin.understandingVersionId,positioningId:version.story.origin.positioningVersionId,appliedDirectionId:version.story.origin.directionId,storyId:version.id,version:Number(latest?.version??0)+1,createdBy:"agent",proposal}).returning();
      if(!deck) throw new PitchroomError("PERSISTENCE_ERROR","Deck was not saved.");
      await tx.update(schema.projects).set({currentDeckId:deck.id,updatedAt:new Date()}).where(eq(schema.projects.id,input.projectId));
      await saveReceipt(tx,input,"story_deck",hash,deck.id); return deck.id;
    });
  }
}
