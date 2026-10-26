import { z } from "zod";
import { PitchroomError } from "./errors";
import type { UnderstandingProposalV1 } from "./understanding";

export const topicRefSchema = z.object({
  understandingId: z.string().min(1),
  kind: z.enum(["theme", "gap"]),
  index: z.number().int().nonnegative(),
});
export type TopicRef = z.infer<typeof topicRefSchema>;
export const topicMaterialSchema = topicRefSchema.extend({
  sourceId: z.string().min(1),
  label: z.string().min(1),
  status: z.literal("needs_review"),
});
export type TopicMaterial = z.infer<typeof topicMaterialSchema>;
export function topicLabel(proposal: UnderstandingProposalV1, topic: TopicRef): string {
  const label = topic.kind === "theme" ? proposal.themes[topic.index]?.title : proposal.gaps[topic.index]?.description;
  if (!label) throw new PitchroomError("INVALID_INPUT", "The selected topic does not exist in this Understanding.");
  return label;
}
export function sameTopic(left: TopicRef, right: TopicRef): boolean {
  return left.understandingId === right.understandingId && left.kind === right.kind && left.index === right.index;
}
