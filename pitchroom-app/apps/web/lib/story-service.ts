import { createLiveStoryRunner, SyntheticStoryRunner, storyPromptVersion } from "@pitchroom/agent";
import { PitchroomError, type StoryHead, type StoryRequest } from "@pitchroom/domain";
import { StoryRepository, PitchroomRepository } from "@pitchroom/persistence";

export async function proposeStory(repository: PitchroomRepository, input: { projectId:string;expected:StoryHead;commandId:string;request:StoryRequest;retryOf?:string }, mode:"postgres-fake"|"live") {
  if(mode==="live" && !["exact_edit","restore"].includes(input.request.kind) && process.env.PITCHROOM_LIVE_TRANSFER_ACK!=="authorized") throw new PitchroomError("INVALID_INPUT","External model transfer must be authorized.");
  const stories=new StoryRepository(repository.db);
  const started=await stories.start({...input,promptVersion:storyPromptVersion,model:mode==="live"?process.env.OPENAI_MODEL??"unconfigured":"synthetic-story"});
  if(!started.created) return started.proposal;
  const proposal=started.proposal;
  const run=await repository.startWorkflowRun({projectId:input.projectId,kind:"story",targetRevision:(await repository.getProject(input.projectId))!.version,model:proposal.snapshot.model,idempotencyKey:`story:${proposal.id}`});
  try {
    await repository.appendWorkflowEvent(run.run.id,"inputs_locked","Accepted understanding, direction, sources and adopted story saved");
    const local=await stories.localCandidate(proposal);
    const runner=local?undefined:mode==="live"?createLiveStoryRunner({apiKey:process.env.OPENAI_API_KEY,model:process.env.OPENAI_MODEL,baseURL:process.env.OPENAI_BASE_URL}):new SyntheticStoryRunner();
    await repository.appendWorkflowEvent(run.run.id,local?"exact_candidate":"model_requested",local?"Preparing exact saved wording for review":"Developing a story proposal for explicit review");
    const result=local?{story:local,responseToJudgment:input.request.kind==="restore"?"This saved story is proposed again without another model call.":"Your exact words are preserved. Prior evidence does not endorse the edited wording."}:await runner!.run(proposal.snapshot);
    const saved=await stories.finish(proposal,result);
    await repository.completeWorkflowRun(run.run.id,proposal.id);
    return saved;
  } catch(error) {
    const message=error instanceof Error?error.message:"Story generation failed.";
    const saved=await stories.finish(proposal,{error:message});
    await repository.failWorkflowRun(run.run.id,error); return saved;
  }
}
