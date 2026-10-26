import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { briefVersionSchema, defaultProjectCharacterLimit, ingestBrief, normalizeMaterialText, PitchroomError, saveBriefSchema, stableHash, type BriefWorkspace } from "@pitchroom/domain";
import type { Database } from "./repository";
import * as schema from "./schema";

export class BriefRepository {
  constructor(private readonly db: Database, private readonly maxProjectCharacters = defaultProjectCharacterLimit) {}
  async read(projectId: string): Promise<BriefWorkspace> {
    const rows = await this.db.select().from(schema.briefVersions).leftJoin(schema.sources, eq(schema.briefVersions.sourceId, schema.sources.id)).where(eq(schema.briefVersions.projectId, projectId)).orderBy(asc(schema.briefVersions.version));
    const versions = rows.map(row => {
      if (row.brief_versions.sourceId && (!row.sources || row.sources.projectId !== projectId || row.sources.kind !== "brief")) throw new PitchroomError("PERSISTENCE_ERROR", "Brief history references an unavailable source.");
      return briefVersionSchema.parse({ id: row.brief_versions.id, number: row.brief_versions.version, createdAt: row.brief_versions.createdAt.toISOString(), entry: row.sources ? { kind: "saved", sourceId: row.sources.id, contentHash: row.sources.contentHash, text: row.sources.content } : { kind: "cleared" } });
    });
    return { head: versions.at(-1) ?? null, versions };
  }
  async save(projectId: string, raw: Parameters<typeof saveBriefSchema.parse>[0]) {
    const input = saveBriefSchema.parse(raw);
    const material = ingestBrief(projectId, input.text);
    const text = normalizeMaterialText(input.text);
    const requestHash = stableHash(JSON.stringify([input.expectedVersionId, text]));
    await this.db.transaction(async tx => {
      const [project] = await tx.select().from(schema.projects).where(eq(schema.projects.id, projectId)).for("update");
      if (!project) throw new PitchroomError("NOT_FOUND", "Project was not found.");
      const prior = await tx.query.commandReceipts.findFirst({ where: and(eq(schema.commandReceipts.projectId, projectId), eq(schema.commandReceipts.idempotencyKey, input.commandId)) });
      if (prior) {
        if (prior.commandType !== "save_brief" || prior.requestHash !== requestHash) throw new PitchroomError("CONFLICT", "This command was already used for a different brief change.");
        return;
      }
      if (["reading", "structuring"].includes(project.phase)) throw new PitchroomError("INVALID_TRANSITION", "Wait for the current material run before changing the brief.");
      const latest = await tx.query.briefVersions.findFirst({ where: eq(schema.briefVersions.projectId, projectId), orderBy: desc(schema.briefVersions.version) });
      if ((latest?.id ?? null) !== input.expectedVersionId) throw new PitchroomError("CONFLICT", "The brief changed in another tab. Review the latest version; your draft was preserved.");
      const previousSource = latest?.sourceId ? await tx.query.sources.findFirst({ where: eq(schema.sources.id, latest.sourceId) }) : undefined;
      if (latest && ((material && previousSource?.contentHash === material.contentHash) || (!material && !latest.sourceId))) {
        await tx.insert(schema.commandReceipts).values({ projectId, idempotencyKey: input.commandId, commandType: "save_brief", requestHash, resourceId: latest.id });
        return;
      }
      if (material) {
        const existing = await tx.query.sources.findFirst({ where: and(eq(schema.sources.projectId, projectId), eq(schema.sources.kind, "brief"), eq(schema.sources.contentHash, material.contentHash)) });
        if (!existing) {
          const [usage] = await tx.select({ characters: sql<number>`coalesce(sum(length(${schema.sources.content})), 0)` }).from(schema.sources).where(eq(schema.sources.projectId, projectId));
          if (Number(usage?.characters ?? 0) + material.content.length > this.maxProjectCharacters) throw new PitchroomError("INVALID_INPUT", "Brief history would exceed the project text limit.");
          await tx.insert(schema.sources).values({ id: material.sourceId, projectId, kind: "brief", name: material.name, mediaType: material.mediaType, content: material.content, contentHash: material.contentHash, idempotencyKey: input.commandId });
          await tx.insert(schema.sourceChunks).values(material.chunks.map(chunk => ({ ...chunk, sourceId: material.sourceId })));
        }
      }
      await tx.update(schema.sources).set({ deletedAt: new Date() }).where(and(eq(schema.sources.projectId, projectId), eq(schema.sources.kind, "brief"), isNull(schema.sources.deletedAt)));
      if (material) await tx.update(schema.sources).set({ deletedAt: null }).where(and(eq(schema.sources.projectId, projectId), eq(schema.sources.id, material.sourceId), eq(schema.sources.kind, "brief")));
      const [version] = await tx.insert(schema.briefVersions).values({ projectId, version: (latest?.version ?? 0) + 1, sourceId: material?.sourceId ?? null }).returning();
      if (!version) throw new PitchroomError("PERSISTENCE_ERROR", "Brief version was not saved.");
      const [remaining] = await tx.select({ count: sql<number>`count(*)` }).from(schema.sources).where(and(eq(schema.sources.projectId, projectId), isNull(schema.sources.deletedAt)));
      await tx.update(schema.projects).set({ phase: Number(remaining?.count ?? 0) ? "materials_ready" : "empty", currentUnderstandingId: null, currentPositioningId: null, updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
      await tx.insert(schema.commandReceipts).values({ projectId, idempotencyKey: input.commandId, commandType: "save_brief", requestHash, resourceId: version.id });
    });
  }
}
