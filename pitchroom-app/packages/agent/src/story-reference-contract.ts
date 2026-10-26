import { z } from "zod";
import { storyBasisSchema, storyBlockSchema, storyContentSchema, type StorySnapshot } from "@pitchroom/domain";

export function storyReferenceContract(snapshot: Pick<StorySnapshot, "before" | "understanding">) {
  const existing = snapshot.before?.bases.map(basis => basis.id) ?? [];
  const external = snapshot.understanding.themes.flatMap(theme => theme.summaryInterpretation?.groundingV4?.bases.map(basis => basis.id) ?? []);
  const occupied = [...existing, ...external];
  let namespace = "story-basis";
  while (occupied.some(id => id.startsWith(`${namespace}:`))) namespace += ":new";
  const localBasisIds = [...existing, ...Array.from({ length: 30 }, (_, index) => `${namespace}:${index + 1}`)];
  const localId = z.enum(localBasisIds);
  const [understanding, source, consultant, interpretation] = storyBasisSchema.options;
  storyBasisSchema.options.length satisfies 4;
  const basis = z.discriminatedUnion("kind", [
    understanding.extend({ id: localId }),
    source.extend({ id: localId }),
    consultant.extend({ id: localId }),
    interpretation.extend({ id: localId, supportingBasisRefs: z.array(localId) }),
  ]);
  const generatedBody = z.string().min(1).regex(/^\s*\S+(?:\s+\S+){0,44}\s*$/).describe("Generated body: at most 45 whitespace-separated words.");
  const exactHumanBodies = snapshot.before?.blocks.filter(block => block.wording === "user_edited_unreviewed").map(block => block.body) ?? [];
  const body = exactHumanBodies.length ? z.union([generatedBody, z.enum(exactHumanBodies)]) : generatedBody;
  const content = storyContentSchema.extend({
    bases: z.array(basis).max(30),
    strategicRationale: storyContentSchema.shape.strategicRationale.extend({ basisRefs: z.array(localId) }),
    blocks: z.array(storyBlockSchema.extend({ body, basisRefs: z.array(localId) })).min(3).max(8),
  });
  return {
    resultSchema: z.object({ story: content, responseToJudgment: z.string().min(1) }).strict(),
    referenceContract: {
      localBasisIds,
      understandingBasisIds: external,
      rule: "Every Story basis id, basisRefs and supportingBasisRefs uses only localBasisIds. Preserve existing local IDs when reusing a basis. External Understanding IDs belong only in understanding_basis.understandingBasisId, never directly in a Story reference. Define every referenced local ID in story.bases; unused slots need no definition.",
    },
  };
}
