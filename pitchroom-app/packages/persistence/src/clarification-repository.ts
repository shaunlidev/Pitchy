import { and, eq, sql } from "drizzle-orm";
import { buildReassessmentContext, startClarificationAttempt, ownsClarificationAttempt, PitchroomError, assertClarificationFresh, buildClarificationCandidate, clarificationPending, newClarification, sourceFingerprint, type ClarificationTask, type ClarificationResult, type ClarificationFailureDiagnostic } from "@pitchroom/domain";
import { PitchroomRepository, type Database } from "./repository";
import * as schema from "./schema";

export class ClarificationRepository {
  constructor(readonly db: Database) {}
  async list(projectId: string) { return (await this.db.select().from(schema.clarificationTasks).where(eq(schema.clarificationTasks.projectId, projectId))).map(row => row.payload).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)); }
  async submit(input: { projectId: string; text: string; expectedRevision: number; commandId: string; actorId: string; runMode?: "synthetic" | "live"; rebaseTaskId?: string }) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select id from projects where id = ${input.projectId} for update`);
      const repository = new PitchroomRepository(tx as unknown as Database);
      const existing = (await tx.select().from(schema.clarificationTasks).where(and(eq(schema.clarificationTasks.projectId,input.projectId),eq(schema.clarificationTasks.commandId,input.commandId))))[0]?.payload;
      if (existing) {
        if (existing.answer !== input.text || existing.baseRevision !== input.expectedRevision || existing.actorId !== input.actorId || existing.reassessment?.rebasedFromTaskId !== input.rebaseTaskId) throw new PitchroomError("CONFLICT", "Command ID was used for a different clarification.");
        return existing;
      }
      const project = await repository.getProject(input.projectId);
      if (!project || (project.phase !== "review_required" && project.phase !== "accepted") || project.version !== input.expectedRevision || !project.currentUnderstandingId) throw new PitchroomError("CONFLICT", "Clarification requires the current review version.");
      const tasks = await tx.select().from(schema.clarificationTasks).where(eq(schema.clarificationTasks.projectId,input.projectId));
      if (tasks.some(row => clarificationPending(row.payload))) throw new PitchroomError("CONFLICT", "Resolve the current clarification first.");
      const version = (await repository.listVersions(input.projectId)).find(v => v.id === project.currentUnderstandingId)!;
      const sourceTask = input.rebaseTaskId ? tasks.find(t => t.id === input.rebaseTaskId)?.payload : undefined;
      if (input.rebaseTaskId && (!sourceTask || sourceTask.status !== "stale" || sourceTask.answer !== input.text)) throw new PitchroomError("CONFLICT", "Only a stale saved answer may be rebased.");
      const id = crypto.randomUUID(); const inputId = sourceTask?.inputId ?? crypto.randomUUID();
      if (!sourceTask) await tx.insert(schema.userInputs).values({ id: inputId, projectId: input.projectId, kind: "clarification_answer", text: input.text, actorId: input.actorId, targetVersion: input.expectedRevision, idempotencyKey: input.commandId });
      const sources = await repository.listSources(input.projectId);
      const task = newClarification({ id, inputId, projectId: input.projectId, commandId: input.commandId, actorId: input.actorId, versionId: version.id, revision: input.expectedRevision, basePhase: project.phase, base: version.proposal, sources, reassessment: sourceTask ? buildReassessmentContext(sourceTask, sources) : undefined, answer: input.text, runMode: input.runMode });
      await tx.insert(schema.clarificationTasks).values({ id, projectId: input.projectId, commandId: input.commandId, payload: task });
      return task;
    });
  }
  async decide(input: { projectId: string; taskId: string; action: "apply" | "dismiss" | "retry"; commandId: string; result?: ClarificationResult }) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select id from projects where id = ${input.projectId} for update`);
      await tx.execute(sql`select id from clarification_tasks where id = ${input.taskId} and project_id = ${input.projectId} for update`);
      const row = (await tx.select().from(schema.clarificationTasks).where(and(eq(schema.clarificationTasks.id,input.taskId),eq(schema.clarificationTasks.projectId,input.projectId))))[0];
      if (!row) throw new PitchroomError("NOT_FOUND", "Clarification was not found.");
      const task = row.payload;
      const repository = new PitchroomRepository(tx as unknown as Database);
      const project = (await repository.getProject(input.projectId))!;
      const save = async () => { await tx.update(schema.clarificationTasks).set({ payload: task, updatedAt: new Date() }).where(eq(schema.clarificationTasks.id,task.id)); return task; };
      const decisionRequest = JSON.stringify({action:input.action,result:input.action === "apply" ? input.result ?? task.result : undefined});
      if (task.status === "applied" || task.status === "dismissed") {
        if (task.decisionCommandId === input.commandId && task.decisionRequest === decisionRequest) return task;
        throw new PitchroomError("CONFLICT", "Clarification was already resolved.");
      }
      const sources = await repository.listSources(input.projectId);
      if (input.action === "dismiss") {
        task.status = "dismissed"; task.decisionCommandId = input.commandId; task.decisionRequest = decisionRequest; return save();
      }
      assertClarificationFresh(task, { phase: project.phase, revision: project.version, understandingId: project.currentUnderstandingId ?? undefined, sources });
      if (input.action === "retry") {
        if (task.attempts.some(a => a.commandId === input.commandId)) return task;
        if (task.status !== "failed") throw new PitchroomError("CONFLICT", "Only a failed analysis can be retried.");
        task.status = "queued"; task.attempts.push({ id: `${task.id}:attempt:${task.attempts.length+1}`, commandId: input.commandId, status: "queued", model: "deterministic-local", promptVersion: "clarify-feedback-v4" }); return save();
      }
      if (task.status !== "proposal_ready" || !task.result) throw new PitchroomError("CONFLICT", "No current proposal is ready to apply.");
      const candidate = buildClarificationCandidate(task, input.result ?? task.result);
      const versionId = crypto.randomUUID();
      await tx.insert(schema.understandingVersions).values({ id: versionId, projectId: task.projectId, runId: null, userInputId: task.inputId, parentUnderstandingId: task.baseUnderstandingId, clarificationTaskId: task.id, createdBy: "user", version: project.version+1, status: "review_required", proposal: candidate });
      await tx.update(schema.projects).set({ phase: "review_required", version: project.version+1, currentUnderstandingId: versionId, currentPositioningId: null, updatedAt: new Date() }).where(eq(schema.projects.id,task.projectId));
      task.appliedResult = input.result ?? task.result; task.resultVersionId = versionId; task.decisionCommandId = input.commandId; task.decisionRequest = decisionRequest; task.status = "applied";
      return save();
    });
  }
  async claim(model: string, runMode: "synthetic" | "live" = "synthetic", projectId?: string) {
    return this.db.transaction(async tx => {
      const rows = await tx.execute<{ id: string; payload: ClarificationTask }>(sql`select id, payload from clarification_tasks where (${projectId ?? null}::uuid is null or project_id = ${projectId ?? null}::uuid) and payload->>'runMode' = ${runMode} and (payload->>'status' = 'queued' or (payload->>'status' = 'running' and (payload->>'leaseUntil')::timestamptz < now())) order by updated_at for update skip locked limit 1`);
      const task = rows[0]?.payload; if (!task) return undefined;
      const started = startClarificationAttempt(task,model);
      await tx.update(schema.clarificationTasks).set({payload: task, updatedAt:new Date()}).where(eq(schema.clarificationTasks.id,task.id)); return started ? task : undefined;
    });
  }
  async finish(task: ClarificationTask, output?: {result: ClarificationResult; candidate: ClarificationTask["base"]}, error?: string, failure?: ClarificationFailureDiagnostic) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select id from projects where id = ${task.projectId} for update`);
      await tx.execute(sql`select id from clarification_tasks where id = ${task.id} for update`);
      const current = (await tx.select().from(schema.clarificationTasks).where(eq(schema.clarificationTasks.id,task.id)))[0]?.payload;
      if (!current || !ownsClarificationAttempt(current,task)) return;
      const repository = new PitchroomRepository(tx as unknown as Database); const project = (await repository.getProject(task.projectId))!;
      const attempt = task.attempts.at(-1)!; attempt.finishedAt = new Date().toISOString(); attempt.status = error ? "failed" : "completed"; attempt.error = error; attempt.failure = failure;
      try { assertClarificationFresh(task,{phase:project.phase,revision:project.version,understandingId:project.currentUnderstandingId??undefined,sources:await repository.listSources(task.projectId)}); task.status = error ? "failed" : output!.result.operations.length ? "proposal_ready" : "no_change"; } catch { task.status = "stale"; }
      if (output) { task.result = output.result; task.candidate = output.candidate; }
      await tx.update(schema.clarificationTasks).set({payload:task,updatedAt:new Date()}).where(eq(schema.clarificationTasks.id,task.id));
    });
  }
  async refresh(projectId: string) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select id from projects where id = ${projectId} for update`);
      const repository = new PitchroomRepository(tx as unknown as Database);
      const project = (await repository.getProject(projectId))!; const sources = await repository.listSources(projectId);
      const rows = await tx.select().from(schema.clarificationTasks).where(eq(schema.clarificationTasks.projectId,projectId));
      for (const row of rows) if (clarificationPending(row.payload)) {
        try { assertClarificationFresh(row.payload,{phase:project.phase,revision:project.version,understandingId:project.currentUnderstandingId??undefined,sources}); }
        catch { await tx.update(schema.clarificationTasks).set({payload:sql`jsonb_set(payload, '{status}', '"stale"'::jsonb)`,updatedAt:new Date()}).where(and(eq(schema.clarificationTasks.id,row.id),sql`payload->>'status' not in ('applied','dismissed')`)); row.payload.status = "stale"; }
      }
      return rows.map(row=>row.payload).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
    });
  }
}
