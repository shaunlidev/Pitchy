import { PitchroomError,positioningChoices,samePositioningChoice, type PositioningChoice, type PositioningProposalV1, type SourceChunk } from "@pitchroom/domain";
import { isInstructionLikeSourceText } from "./prompt-safety";

export function assertPositioningChoiceForAgent(choice:PositioningChoice,chunks:readonly SourceChunk[]) {
  if(isInstructionLikeSourceText(choice.text))throw new PitchroomError("PROPOSAL_REJECTED","The selected wording requires Agent review. Its exact text remains saved; it was not sent to the provider.");
  if(choice.kind==="ai_direction") {
    for(const evidence of [...choice.direction.evidence,...(choice.direction.counterEvidence ?? [])]) {
      const chunk=chunks.find(chunk=>chunk.id===evidence.chunkId&&chunk.sourceId===evidence.sourceId);
      if(!chunk||!chunk.text.includes(evidence.quote)||isInstructionLikeSourceText(chunk.text))throw new PitchroomError("PROPOSAL_REJECTED","The selected direction references an unavailable or isolated source passage.");
    }
    if(choice.direction.judgmentNote&&isInstructionLikeSourceText(choice.direction.judgmentNote))throw new PitchroomError("PROPOSAL_REJECTED","The saved judgment requires Agent review before generation.");
    return;
  }
  if(choice.kind!=="source_quote")return;
  const chunk=chunks.find(chunk=>chunk.id===choice.chunkId&&chunk.sourceId===choice.sourceId);
  if(!chunk||chunk.text!==choice.passage||chunk.text.slice(choice.start,choice.end)!==choice.text||isInstructionLikeSourceText(chunk.text))throw new PitchroomError("PROPOSAL_REJECTED","The selected source passage is unavailable or isolated for Agent review. Its exact wording remains saved.");
}
export function positioningAgentContext(proposal:PositioningProposalV1,choice:PositioningChoice) {
  return {understandingVersionId:proposal.understandingVersionId,selectedChoice:structuredClone(choice),recommendation:choice.kind==="ai_direction"&&samePositioningChoice(choice,positioningChoices(proposal).find(candidate=>candidate.id===choice.id))?proposal.recommendation:undefined};
}
