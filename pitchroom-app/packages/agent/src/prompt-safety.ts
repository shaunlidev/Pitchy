import { PitchroomError, type SourceChunk, type UnderstandingProposalV1 } from "@pitchroom/domain";

const instructionSignals = [
  /\bignore\s+(?:(?:all|any|the)\s+)?(?:previous|prior|above)\s+instructions?\b/i,
  /(?:^|\n)\s*(?:system|developer|assistant)\s*:/i,
  /\bdo\s+not\s+(?:cite|follow|obey)\b/i,
  /\b(?:claim|assert|approve|reveal|expose|publish|send|output|return)\b[^\n.!?]{0,120}\b(?:instead|regardless|without|must|is|as|this)\b/i,
];

const distinctiveLiteralPattern = /(?:[$€£¥]\s?\d[\d.,]*(?:\s?[kmbt])?|\b\d+(?:\.\d+)?\s?(?:million|billion|trillion|percent|%)\b|https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/giu;
const quotedLiteralPattern = /["'“”‘’]([^"'“”‘’\n]{4,120})["'“”‘’]/gu;
const sensitiveActionStemPattern = /\b(?:approv|reveal|expos|leak|publish|transfer|delet)[a-z]*\b/giu;

export const quarantinedContentNotice = "Content quarantined because it resembles instructions to the agent. Review the original source manually.";
export const understandingLivePromptVersion = "understanding-live-v2-no-echo";

export function isInstructionLikeSourceText(text: string): boolean {
  return instructionSignals.some((pattern) => pattern.test(text));
}

export function quarantineChunkForAgent(chunk: SourceChunk) {
  if (!isInstructionLikeSourceText(chunk.text)) return chunk;
  return {
    id: chunk.id,
    sourceId: chunk.sourceId,
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
    contentStatus: "quarantined_untrusted_instruction" as const,
    notice: quarantinedContentNotice,
  };
}

function generatedText(proposal: UnderstandingProposalV1, publicSummary: string): string {
  return [
    publicSummary,
    ...proposal.themes.flatMap((theme) => [
      theme.title,
      theme.summary,
      ...theme.claims.flatMap((claim) => [
        claim.statement,
        ...claim.evidence.map((evidence) => evidence.quote),
      ]),
    ]),
    ...proposal.gaps.flatMap((gap) => [gap.description, gap.whyItMatters]),
    ...(proposal.topicTasks ?? []).flatMap(task => [task.id, task.question.question, task.question.whyItMatters]),
    proposal.nextQuestion.question,
    proposal.nextQuestion.whyItMatters,
  ].join("\n").toLocaleLowerCase("en-US");
}

function protectedFragments(text: string): string[] {
  const fragments = [...text.matchAll(distinctiveLiteralPattern)].map((match) => match[0]);
  for (const match of text.matchAll(quotedLiteralPattern)) fragments.push(match[1] ?? "");
  for (const match of text.matchAll(sensitiveActionStemPattern)) fragments.push(match[0]);
  return [...new Set(fragments.map((fragment) => fragment.trim().toLocaleLowerCase("en-US")).filter(Boolean))];
}

export function validateNoUntrustedInstructionEcho(input: {
  proposal: UnderstandingProposalV1;
  publicSummary: string;
  chunks: readonly SourceChunk[];
}): void {
  const quarantined = input.chunks.filter((chunk) => isInstructionLikeSourceText(chunk.text));
  if (quarantined.length === 0) return;

  const quarantinedIds = new Set(quarantined.map((chunk) => chunk.id));
  const citesQuarantinedContent = input.proposal.themes.some((theme) =>
    theme.claims.some((claim) => claim.evidence.some((evidence) => quarantinedIds.has(evidence.chunkId))),
  );
  if (citesQuarantinedContent) {
    throw new PitchroomError("PROPOSAL_REJECTED", "Agent output referenced quarantined source content. Review the original source manually.");
  }

  const output = generatedText(input.proposal, input.publicSummary);
  const echoedFragment = quarantined
    .flatMap((chunk) => protectedFragments(chunk.text))
    .some((fragment) => output.includes(fragment));
  if (echoedFragment) {
    throw new PitchroomError("PROPOSAL_REJECTED", "Agent output repeated quarantined source content. Review the original source manually.");
  }
}
