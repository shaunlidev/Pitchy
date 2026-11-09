import { z } from "zod";
import { workspaceStateSchema } from "@pitchroom/domain";

export { workspaceCommandSchema, workspaceStateSchema, workspaceEventSchema, errorEnvelopeSchema } from "@pitchroom/domain";

export const materialImportReceiptSchema = z.object({
  commandId: z.string().min(1),
  sourceId: z.string().min(1),
  sourceName: z.string().min(1),
  outcome: z.enum(["created", "reused", "restored", "replayed"]),
});
export type MaterialImportReceipt = z.infer<typeof materialImportReceiptSchema>;
const materialImportResponseSchema = workspaceStateSchema.extend({ materialImport: materialImportReceiptSchema });

export function readMaterialImportResponse(value: unknown, commandId: string) {
  const response = materialImportResponseSchema.safeParse(value);
  if (!response.success || response.data.materialImport.commandId !== commandId) return;
  const { sources, removedSources, materialImport } = response.data;
  const matches = (source: (typeof sources)[number]) =>
    source.kind !== "brief" && source.sourceId === materialImport.sourceId && source.name === materialImport.sourceName;
  if (!sources.some(matches) && !removedSources.some(matches)) return;
  return response.data;
}
