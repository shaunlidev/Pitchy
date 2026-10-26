import { and, eq, isNull, sql } from "drizzle-orm";
import { ingestMaterial, defaultProjectCharacterLimit, PitchroomError, stableHash, topicLabel, topicRefSchema, type TopicMaterial, type TopicRef } from "@pitchroom/domain";
import type { Database } from "./repository";
import * as schema from "./schema";

type Material = { name: string; mediaType: "text/plain" | "text/markdown"; text: string };
export class TopicMaterialRepository {
  constructor(private readonly db: Database) {}
  async list(projectId: string): Promise<TopicMaterial[]> {
    const rows = await this.db.select().from(schema.topicMaterials).where(eq(schema.topicMaterials.projectId, projectId));
    return rows.map(row => ({ sourceId: row.sourceId, understandingId: row.understandingId, kind: topicRefSchema.shape.kind.parse(row.topicKind), index: row.topicIndex, label: row.label, status: "needs_review" }));
  }
  async change(projectId: string, input: { topic: TopicRef; commandId: string } & ({ action: "attach"; material: Material } | { action: "link" | "unlink"; sourceId: string })) {
    const topic = topicRefSchema.parse(input.topic);
    const material = input.action === "attach" ? ingestMaterial(projectId, input.material) : undefined;
    const requestHash = stableHash(JSON.stringify([input.action, topic, input.action === "attach" ? material?.contentHash : input.sourceId]));
    await this.db.transaction(async tx => {
      const [project] = await tx.select().from(schema.projects).where(eq(schema.projects.id, projectId)).for("update");
      if (!project) throw new PitchroomError("NOT_FOUND", "Project was not found.");
      const prior = await tx.query.commandReceipts.findFirst({ where: and(eq(schema.commandReceipts.projectId, projectId), eq(schema.commandReceipts.idempotencyKey, input.commandId)) });
      if (prior) {
        if (prior.commandType !== "topic_material" || prior.requestHash !== requestHash) throw new PitchroomError("CONFLICT", "Command already used for another material change.");
        return;
      }
      if (["reading", "structuring"].includes(project.phase)) throw new PitchroomError("CONFLICT", "Wait for the current material run.");
      const version = await tx.query.understandingVersions.findFirst({ where: and(eq(schema.understandingVersions.projectId, projectId), eq(schema.understandingVersions.id, topic.understandingId)) });
      if (!version) throw new PitchroomError("NOT_FOUND", "The original Understanding was not found.");
      const label = topicLabel(version.proposal, topic);
      if (input.action !== "unlink" && project.currentUnderstandingId !== topic.understandingId) throw new PitchroomError("CONFLICT", "This topic belongs to an older Understanding. Refresh before attaching material.");
      let sourceId: string;
      if (input.action === "attach" && material) {
        const existing = await tx.query.sources.findFirst({ where: and(eq(schema.sources.projectId, projectId), eq(schema.sources.kind, "file"), eq(schema.sources.contentHash, material.contentHash)) });
        sourceId = existing?.id ?? material.sourceId;
        if (!existing) {
          const [usage] = await tx.select({ characters: sql<number>`coalesce(sum(length(${schema.sources.content})), 0)` }).from(schema.sources).where(eq(schema.sources.projectId, projectId));
          if (Number(usage?.characters ?? 0) + material.content.length > defaultProjectCharacterLimit) throw new PitchroomError("INVALID_INPUT", "Material would exceed the project text limit.");
          await tx.insert(schema.sources).values({ id: sourceId, projectId, name: material.name, mediaType: material.mediaType, content: material.content, contentHash: material.contentHash, idempotencyKey: input.commandId });
          await tx.insert(schema.sourceChunks).values(material.chunks.map(chunk => ({ ...chunk, sourceId })));
        } else if (existing.deletedAt) {
          await tx.update(schema.sources).set({ deletedAt: null }).where(eq(schema.sources.id, sourceId));
        }
      } else if (input.action !== "attach") {
        sourceId = input.sourceId;
        const source = await tx.query.sources.findFirst({ where: and(eq(schema.sources.id, sourceId), eq(schema.sources.projectId, projectId), eq(schema.sources.kind, "file"), isNull(schema.sources.deletedAt)) });
        if (!source) throw new PitchroomError("NOT_FOUND", "The source is not in the active project.");
      } else throw new PitchroomError("INVALID_INPUT", "Missing material.");
      const relation = and(eq(schema.topicMaterials.projectId, projectId), eq(schema.topicMaterials.sourceId, sourceId), eq(schema.topicMaterials.understandingId, topic.understandingId), eq(schema.topicMaterials.topicKind, topic.kind), eq(schema.topicMaterials.topicIndex, topic.index));
      if (input.action === "unlink") await tx.delete(schema.topicMaterials).where(relation);
      else await tx.insert(schema.topicMaterials).values({ projectId, sourceId, understandingId: topic.understandingId, topicKind: topic.kind, topicIndex: topic.index, label }).onConflictDoNothing();
      await tx.insert(schema.commandReceipts).values({ projectId, idempotencyKey: input.commandId, commandType: "topic_material", requestHash, resourceId: sourceId });
    });
  }
}
