import { z } from "zod";

export const sourceChunkSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  text: z.string().min(1),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
});

export type SourceChunk = z.infer<typeof sourceChunkSchema>;

const evidenceSchema = z.object({
  sourceId: z.string().min(1),
  chunkId: z.string().min(1),
  quote: z.string().min(1),
});

const claimSchema = z
  .object({
    statement: z.string().min(1),
    evidenceState: z.enum([
      "supported",
      "conflicting",
      "user_asserted",
      "unknown",
    ]),
    evidence: z.array(evidenceSchema),
    userInputIds: z.array(z.string().min(1)).default([]),
  })
  .superRefine((claim, context) => {
    if (claim.evidenceState === "supported" && claim.evidence.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A supported claim requires source evidence.",
      });
    }

    if (claim.evidenceState === "conflicting" && claim.evidence.length < 2) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A conflicting claim requires at least two evidence references.",
      });
    }

    if (claim.evidenceState === "conflicting" && new Set(claim.evidence.map((item) => item.sourceId)).size < 2) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A conflicting claim requires evidence from at least two sources.",
      });
    }

    if (
      (claim.evidenceState === "user_asserted" ||
        claim.evidenceState === "unknown") &&
      claim.evidence.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: `${claim.evidenceState} claims cannot use source evidence.`,
      });
    }

    if (
      claim.evidenceState === "user_asserted" &&
      claim.userInputIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["userInputIds"],
        message: "A user-asserted claim requires a user input reference.",
      });
    }

    if (
      claim.evidenceState !== "user_asserted" &&
      claim.userInputIds.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["userInputIds"],
        message: "Only user-asserted claims may reference user inputs.",
      });
    }
  });

export const understandingProposalV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    themes: z
      .array(
        z.object({
          title: z.string().min(1),
          summary: z.string().min(1),
          claims: z.array(claimSchema).min(1),
        }),
      )
      .min(1)
      .max(5),
    gaps: z.array(
      z.object({
        description: z.string().min(1),
        whyItMatters: z.string().min(1),
        relatedSourceIds: z.array(z.string().min(1)),
      }),
    ),
    nextQuestion: z.object({
      question: z.string().min(1),
      whyItMatters: z.string().min(1),
      relatedThemeIndexes: z.array(z.number().int().nonnegative()).min(1),
    }),
  })
  .superRefine((proposal, context) => {
    const indexes = proposal.nextQuestion.relatedThemeIndexes;
    if (new Set(indexes).size !== indexes.length) {
      context.addIssue({
        code: "custom",
        path: ["nextQuestion", "relatedThemeIndexes"],
        message: "Related theme indexes must be unique.",
      });
    }

    for (const [index, themeIndex] of indexes.entries()) {
      if (themeIndex >= proposal.themes.length) {
        context.addIssue({
          code: "custom",
          path: ["nextQuestion", "relatedThemeIndexes", index],
          message: `Theme index ${themeIndex} does not exist.`,
        });
      }
    }
  });

export type UnderstandingProposalV1 = z.infer<
  typeof understandingProposalV1Schema
>;

export class ProposalEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalEvidenceError";
  }
}

export function validateProposalEvidence(
  proposal: UnderstandingProposalV1,
  chunks: readonly SourceChunk[],
): void {
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));

  for (const theme of proposal.themes) {
    for (const claim of theme.claims) {
      for (const evidence of claim.evidence) {
        const chunk = chunksById.get(evidence.chunkId);
        if (!chunk) {
          throw new ProposalEvidenceError(
            `Evidence references missing chunk: ${evidence.chunkId}`,
          );
        }
        if (chunk.sourceId !== evidence.sourceId) {
          throw new ProposalEvidenceError(
            `Chunk ${evidence.chunkId} does not belong to source ${evidence.sourceId}`,
          );
        }
        if (!chunk.text.includes(evidence.quote)) {
          throw new ProposalEvidenceError(
            `Quote is not present in chunk ${evidence.chunkId}`,
          );
        }
      }
    }
  }
}
