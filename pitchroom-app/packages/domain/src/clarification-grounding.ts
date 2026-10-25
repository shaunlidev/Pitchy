import { z } from "zod";

const text = z.string().trim().min(1).max(2000);
export const clarificationBasisSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("material"), statement: text, force: z.enum(["requirement", "report"]), scope: text,
    evidence: z.array(z.object({ sourceId: text, chunkId: text, quote: text }).strict()).min(1).max(8) }).strict(),
  z.object({ kind: z.literal("user_report"), statement: text, force: z.literal("report"), scope: text,
    inputIds: z.array(text).min(1).max(8) }).strict(),
  z.object({ kind: z.literal("agent_inference"), statement: text, force: z.enum(["suggestion", "interpretation"]), scope: text }).strict(),
]);
export const clarificationBasesSchema = z.array(clarificationBasisSchema).min(1).max(8);
export const applicabilitySchema = z.object({
  claimId: text, status: z.enum(["confirmed", "differs", "unconfirmed"]),
  currentInterpretation: text, explanation: text, basis: clarificationBasesSchema,
}).strict();
export const summaryGroundingSchema = z.object({
  basis: clarificationBasesSchema, applicability: z.array(applicabilitySchema).max(12),
  reviewStatus: z.enum(["agent_proposed", "user_edited_unreviewed"]),
}).strict();
export const questionGroundingSchema = z.object({
  objective: text, primaryThemeId: text,
  associations: z.array(z.object({ themeId: text, unresolvedIssue: text, rationale: text }).strict()).min(1).max(5),
  basis: clarificationBasesSchema,
}).strict();
export type ClarificationBasis = z.infer<typeof clarificationBasisSchema>;
