import { z } from "zod";
import { PitchroomError } from "./errors";

const text = z.string().trim().min(1).max(2000);
const refs = z.array(text).min(1).max(12);
const nature = z.enum(["record", "suggestion", "requirement", "interpretation", "uncertain"]);
const requirement = z.object({ issuer: text, action: text, condition: text, supportingQuote: text }).strict().nullable();
const common = { id: text, nature, statement: text, scope: text, requirement };
// Provenance and modality are independent: material can contain a suggestion,
// and a user can report a requirement without independently verifying it.
export const clarificationBasisV4Schema = z.discriminatedUnion("origin", [
  z.object({ ...common, origin: z.literal("material"), evidence: z.array(z.object({ sourceId: text, chunkId: text, quote: text }).strict()).min(1).max(8) }).strict(),
  z.object({ ...common, origin: z.literal("user"), inputIds: z.array(text).min(1).max(8) }).strict(),
  z.object({ ...common, origin: z.literal("agent") }).strict(),
]);
export const basisTableV4Schema = z.array(clarificationBasisV4Schema).min(1).max(16);
export const applicabilityV4Schema = z.object({ claimId: text, status: z.enum(["confirmed", "differs", "unconfirmed"]), currentInterpretation: text, explanation: text, basisRefs: refs }).strict();
export const questionGroundingV4Schema = z.object({
  objective: text, primaryThemeId: text,
  associations: z.array(z.object({ themeId: text, unresolvedIssue: text, rationale: text, questionSpan: text, expectedAnswer: text }).strict()).min(1).max(5),
  basisRefs: refs,
}).strict();
export const persistedSummaryGroundingV4Schema = z.object({ bases: basisTableV4Schema, basisRefs: refs, applicability: z.array(applicabilityV4Schema).max(12), reviewStatus: z.enum(["agent_proposed", "user_edited_unreviewed"]) }).strict();
export const persistedQuestionGroundingV4Schema = questionGroundingV4Schema.extend({ bases: basisTableV4Schema }).strict();
export type ClarificationBasisV4 = z.infer<typeof clarificationBasisV4Schema>;

export const clarificationFailureSchema = z.object({
  stage: z.enum(["provider", "syntax", "schema", "reference", "judgment", "budget", "execution"]),
  code: text,
  // Controlled paths/codes only, never arbitrary provider or Zod messages.
  issues: z.array(z.object({ path: z.string().max(160), code: z.string().max(80) }).strict()).max(12).optional(),
  position: z.number().int().nonnegative().optional(), excerpt: z.string().max(240).optional(),
  providerStatus: z.enum(["completed", "incomplete", "failed"]).optional(),
}).strict();
export type ClarificationFailureDiagnostic = z.infer<typeof clarificationFailureSchema>;
export class ClarificationValidationError extends PitchroomError {
  readonly diagnostic: ClarificationFailureDiagnostic;
  constructor(stage: "reference" | "judgment", code: string) {
    super("PROPOSAL_REJECTED", code);
    this.diagnostic = { stage, code };
  }
}
export function clarificationBasisV4Label(basis: ClarificationBasisV4): string {
  const source = basis.origin === "material" ? "Material" : basis.origin === "user" ? "User report · unverified" : "Agent";
  return `${source} · ${basis.nature}`;
}
