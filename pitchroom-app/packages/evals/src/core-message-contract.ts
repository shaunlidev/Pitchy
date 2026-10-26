export const coreMessageCategories = ["developer_tool", "consumer_finance", "team_collaboration", "health_behavior", "creator_tool", "local_service", "education", "commerce"] as const;
export type CoreMessageCategory = (typeof coreMessageCategories)[number];
export type CoreMessageContractCase = { id: string; category: CoreMessageCategory; mechanismSignal: string; humanTensionSignal: string; forbiddenClaim: string };

export const coreMessageContractCases: CoreMessageContractCase[] = [
  { id: "apidog", category: "developer_tool", mechanismSignal: "one definition drives dependent assets", humanTensionSignal: "developers stop relaying changes by hand", forbiddenClaim: "application code updates automatically" },
  { id: "splitwise", category: "consumer_finance", mechanismSignal: "shared balances and fewer settlement paths", humanTensionSignal: "the awkward reminder becomes a shared record", forbiddenClaim: "friends always repay" },
  { id: "async-decisions", category: "team_collaboration", mechanismSignal: "decisions are captured beside their context", humanTensionSignal: "nobody has to admit they missed the meeting", forbiddenClaim: "meetings disappear" },
  { id: "medication-routine", category: "health_behavior", mechanismSignal: "a timed record shows whether a dose was logged", humanTensionSignal: "caregivers can check without repeatedly asking", forbiddenClaim: "medication adherence is guaranteed" },
  { id: "creator-reuse", category: "creator_tool", mechanismSignal: "one source note becomes channel-specific drafts", humanTensionSignal: "creators stop facing a blank page for every channel", forbiddenClaim: "content will go viral" },
  { id: "home-repair", category: "local_service", mechanismSignal: "photos and scope create a comparable job brief", humanTensionSignal: "homeowners can ask for a quote without sounding uninformed", forbiddenClaim: "every quote is fair" },
  { id: "language-feedback", category: "education", mechanismSignal: "feedback points to the exact phrase and retry", humanTensionSignal: "learners can make mistakes without performing in front of a class", forbiddenClaim: "fluency is guaranteed" },
  { id: "returns-fit", category: "commerce", mechanismSignal: "past fit feedback narrows the next size choice", humanTensionSignal: "shoppers stop second-guessing every size chart", forbiddenClaim: "returns are eliminated" },
];

export const coreMessageEvalContract = {
  version: "2.0",
  lenses: {
    mechanism: "Leads with a distinctive product behavior and the observable work it changes.",
    human_tension: "Leads with a supported social, emotional, or identity tension and still names a credible product mechanism.",
  },
  hardGates: ["exactly_one_of_each_lens", "grounded_evidence", "slogan_at_most_12_words", "no_forbidden_claim", "explicit_comparative_recommendation"],
  humanRubric: ["recognition", "specificity", "memorability", "truthfulness", "choice_usefulness"],
  passRule: "All hard gates pass; each human dimension >= 2/4; mean >= 3/4; the reviewer can explain why the two lenses differ, which one the agent recommends, why it wins, and what evidence would reverse that judgment.",
  stopRule: "After two evidence-led repairs fail the same defect, stop before a third and request a product decision.",
} as const;

export function validateCoreMessageContractMatrix(cases = coreMessageContractCases) {
  const categories = new Set(cases.map((item) => item.category));
  return { passed: cases.length >= 8 && coreMessageCategories.every((category) => categories.has(category)) && cases.every((item) => item.mechanismSignal && item.humanTensionSignal && item.forbiddenClaim), caseCount: cases.length, coveredCategories: [...categories] };
}
