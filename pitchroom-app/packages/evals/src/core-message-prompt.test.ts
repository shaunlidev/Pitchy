import { describe, expect, it } from "vitest";
import { apidogSources } from "./core-message-apidog-cases";
import {
  buildCoreMessagePromptInput,
  coreMessageSystemPrompt,
  parseCoreMessageProposal,
  parseCoreMessageProposalText,
} from "./core-message-prompt";

const evidence = (sourceId: string, quote: string, interpretation: string) => ({
  sourceId,
  quote,
  interpretation,
});

function validProposal() {
  return {
    schemaVersion: 2 as const,
    originalFraming: {
      label: "Original framing" as const,
      coreMessage: "An all-in-one API development platform.",
    },
    hypotheses: [
      {
        id: "change-propagation",
        lens: "mechanism" as const,
        title: "Change propagation",
        audience: "API product teams",
        audienceSituation: "They repeat one API change across disconnected tools.",
        positioningThesis: "Use one API specification to keep dependent workflow assets aligned instead of manually copying changes across tools.",
        coreMessage: "Change it once. Keep every API handoff aligned.",
        audienceRecognition: "API teams recognize the repeated handoff and reconciliation work.",
        from: "Teams manually copy API changes across separate tools.",
        to: "One API specification keeps dependent workflow assets aligned.",
        hiddenTradeoff:
          "Teams no longer have to choose between moving quickly and keeping API assets aligned.",
        mechanism:
          "A shared API specification drives or validates dependent workflow assets.",
        humanPayoff:
          "Developers stop acting as the manual synchronization layer.",
        emphasis: ["One spec change propagates through the API workflow."],
        exclusions: ["Automatic application-code mutation"],
        supportingEvidence: [
          evidence(
            "official-homepage",
            "linked to the same OpenAPI definition",
            "The product describes a shared definition connecting downstream assets.",
          ),
          evidence(
            "g2-review-patterns",
            "less manual synchronization",
            "Review patterns provide a directional human-payoff signal.",
          ),
        ],
        counterEvidence: [
          evidence(
            "g2-review-patterns",
            "learning curve, interface density, resource use, and migration friction",
            "Integration does not imply a zero-cost or universally simple workflow.",
          ),
        ],
        unknowns: [
          "Which downstream asset is the strongest migration trigger for real customers.",
        ],
      },
      {
        id: "parallel-delivery",
        lens: "human_tension" as const,
        title: "Parallel delivery",
        audience: "Frontend, backend, and QA teams",
        audienceSituation: "They wait for one another and reconcile different API representations.",
        positioningThesis: "Give frontend, backend, and QA one API contract they can use to work in parallel.",
        coreMessage: "One API contract. Fewer cross-team handoff gaps.",
        audienceRecognition: "Cross-functional API teams recognize the cost of inconsistent handoffs.",
        from: "Roles wait for one another and reconcile different API representations.",
        to: "Roles use one shared API contract across mocks, debugging, and testing.",
        hiddenTradeoff:
          "Teams can begin dependent work earlier without abandoning a shared contract.",
        mechanism:
          "The specification connects frontend mocks, backend debugging, and QA cases.",
        humanPayoff: "Less waiting and fewer handoff explanations.",
        emphasis: ["Cross-role coordination"],
        exclusions: ["A guarantee of zero integration defects"],
        supportingEvidence: [
          evidence(
            "official-collaboration-workflow",
            "connects specification, frontend mocks, backend debugging, saved endpoint cases, QA testing, integration testing, and shared documentation",
            "The documented workflow spans multiple roles and stages.",
          ),
        ],
        counterEvidence: [],
        unknowns: ["Whether parallel delivery is the primary buying trigger."],
      },
    ],
    leadingHypothesisId: "change-propagation",
    recommendation: {
      hypothesisId: "change-propagation",
      judgment: "Lead with change propagation because it names the most distinctive supported behavior.",
      comparison: "It is more product-specific than parallel delivery, while parallel delivery carries the stronger emotional recognition.",
      conditionsToReconsider: ["Prefer parallel delivery if interviews show cross-role waiting is the primary buying trigger."],
    },
    clarifyingQuestion: {
      question:
        "Which downstream asset creates the most costly manual work after an API specification changes?",
      decisionChanged:
        "The answer could shift the lead from broad change propagation to documentation, mocking, or test reliability.",
    },
  };
}

describe("core-message prompt contract", () => {
  it("keeps the prompt in recommendation mode with evidence and authority boundaries", () => {
    expect(coreMessageSystemPrompt).toContain("reviewable core-message hypotheses");
    expect(coreMessageSystemPrompt).toContain("exact quotes");
    expect(coreMessageSystemPrompt).toContain("untrusted data");
    expect(coreMessageSystemPrompt).toContain("The user decides");
    expect(coreMessageSystemPrompt).toContain("make a clear judgment");
    expect(coreMessageSystemPrompt).toContain('lens "mechanism"');
    expect(coreMessageSystemPrompt).toContain('lens "human_tension"');
    expect(coreMessageSystemPrompt).not.toMatch(/\b(?:API|OpenAPI|specification)\b/);
  });

  it("builds an English source packet without transferring source URLs to the model", () => {
    const input = buildCoreMessagePromptInput({
      originalFraming: "An all-in-one API development platform.",
      sources: apidogSources,
    });

    expect(input.sources).toHaveLength(apidogSources.length);
    expect(JSON.stringify(input)).not.toContain("https://");
    expect(input.sources[0]).toHaveProperty("evidenceBoundary");
  });

  it("builds the same contract for a non-API product", () => {
    const input = buildCoreMessagePromptInput({
      originalFraming: "A calmer family scheduling app.",
      sources: [{
        id: "parent-interview",
        authority: "customer_interview",
        url: "https://example.invalid/private-interview",
        material: "Parents notice schedule conflicts only after another family member has already made plans.",
        boundary: "One interview is a problem signal, not market-wide proof.",
      }],
    });
    expect(input.originalFraming).toBe("A calmer family scheduling app.");
    expect(input.sources[0]).toMatchObject({ id: "parent-interview", authority: "customer_interview" });
    expect(JSON.stringify(input)).not.toContain("example.invalid");
  });

  it("accepts a grounded multi-hypothesis proposal", () => {
    const parsed = parseCoreMessageProposal(validProposal(), apidogSources);
    expect(parsed.hypotheses).toHaveLength(2);
    expect(parsed.leadingHypothesisId).toBe("change-propagation");
    expect(parsed.recommendation.hypothesisId).toBe("change-propagation");
    expect(parsed.clarifyingQuestion).not.toBeNull();
  });

  it("accepts an exact quote from a supplied evidence boundary", () => {
    const proposal = validProposal();
    proposal.hypotheses[0]!.counterEvidence = [evidence(
      "official-homepage",
      "Vendor-authored product description; it supports intended capability and positioning, not independent outcome validation.",
      "Keeps vendor claims distinct from independent validation.",
    )];
    expect(parseCoreMessageProposal(proposal, apidogSources).hypotheses[0]!.counterEvidence).toHaveLength(1);
  });

  it("rejects an invented evidence quote", () => {
    const proposal = validProposal();
    proposal.hypotheses[0]!.supportingEvidence[0]!.quote =
      "This quote does not exist in the source packet.";

    expect(() => parseCoreMessageProposal(proposal, apidogSources)).toThrow(
      /quote is not present/,
    );
  });

  it("rejects a leading hypothesis outside the proposal", () => {
    const proposal = validProposal();
    proposal.leadingHypothesisId = "missing-hypothesis";

    expect(() => parseCoreMessageProposal(proposal, apidogSources)).toThrow(
      /leading hypothesis does not exist/,
    );
  });

  it("rejects a recommendation that does not explain the leading hypothesis", () => {
    const proposal = validProposal();
    proposal.recommendation.hypothesisId = "parallel-delivery";
    expect(() => parseCoreMessageProposal(proposal, apidogSources)).toThrow(/Recommendation must explain/);
  });

  it("rejects two hypotheses using the same strategic lens", () => {
    const proposal = validProposal();
    proposal.hypotheses[1]!.lens = "mechanism";
    expect(() => parseCoreMessageProposal(proposal, apidogSources)).toThrow(/one mechanism lens/);
  });

  it("rejects a slogan longer than twelve words", () => {
    const proposal = validProposal();
    proposal.hypotheses[0]!.coreMessage = "This slogan keeps going far beyond the short memorable phrase a user can retain";
    expect(() => parseCoreMessageProposal(proposal, apidogSources)).toThrow(/at most 12 words/);
  });

  it("repairs only one known extra root brace before the leading hypothesis", () => {
    const text = JSON.stringify(validProposal()).replace('}],"leadingHypothesisId"', '}]},"leadingHypothesisId"');
    const parsed = parseCoreMessageProposalText(text, apidogSources);
    expect(parsed.proposal.hypotheses).toHaveLength(2);
    expect(parsed.normalizations).toEqual(["removed_one_extra_root_brace_before_leadingHypothesisId"]);
    expect(() => parseCoreMessageProposalText(`${text}}`, apidogSources)).toThrow();
  });

  it("repairs only one known extra hypothesis brace before the leading hypothesis", () => {
    const text = JSON.stringify(validProposal()).replace(']}],"leadingHypothesisId"', ']}}],"leadingHypothesisId"');
    const parsed = parseCoreMessageProposalText(text, apidogSources);
    expect(parsed.normalizations).toEqual(["removed_one_extra_hypothesis_brace_before_leadingHypothesisId"]);
  });

  it("repairs one observed malformed unknowns close before the leading hypothesis", () => {
    const text = JSON.stringify(validProposal()).replace('"]}],"leadingHypothesisId"', '"}]}],"leadingHypothesisId"');
    const parsed = parseCoreMessageProposalText(text, apidogSources);
    expect(parsed.proposal.leadingHypothesisId).toBe("change-propagation");
    expect(parsed.normalizations).toEqual(["repaired_one_malformed_unknowns_close_before_leadingHypothesisId"]);
  });
});

