import { z } from "zod";
import { ingestMaterial, normalizeMaterialText } from "./materials";

export const briefVersionSchema = z.object({
  id: z.string().min(1), number: z.number().int().positive(), createdAt: z.string().datetime(),
  entry: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("saved"), sourceId: z.string().min(1), contentHash: z.string().min(1), text: z.string().min(1) }),
    z.object({ kind: z.literal("cleared") }),
  ]),
});
export const briefWorkspaceSchema = z.object({ head: briefVersionSchema.nullable(), versions: z.array(briefVersionSchema) });
export type BriefVersion = z.infer<typeof briefVersionSchema>;
export type BriefWorkspace = z.infer<typeof briefWorkspaceSchema>;
export const saveBriefSchema = z.object({ expectedVersionId: z.string().min(1).nullable(), text: z.string().max(1_048_576), commandId: z.string().min(1).max(200) });
export function ingestBrief(projectId: string, text: string) {
  const normalized = normalizeMaterialText(text);
  return normalized.trim() ? ingestMaterial(`${projectId}:brief`, { name: "written-brief.md", mediaType: "text/markdown", text: normalized }) : null;
}
export function briefText(brief?: BriefWorkspace): string { return brief?.head?.entry.kind === "saved" ? brief.head.entry.text : ""; }
