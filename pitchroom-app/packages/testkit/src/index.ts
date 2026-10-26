import type {
  SourceChunk,
  UnderstandingProposalV1,
} from "@pitchroom/domain";

export * from "./artifacts";

type Input = {
  projectId: string;
  chunks: SourceChunk[];
};

type Result = {
  proposal: UnderstandingProposalV1;
  publicSummary: string;
};

export class FakeUnderstandingAgentRunner {
  readonly inputs: Input[] = [];
  private readonly result: Result;

  constructor(result: Result) {
    this.result = result;
  }

  async run(input: Input): Promise<Result> {
    this.inputs.push(input);
    return structuredClone(this.result);
  }
}
