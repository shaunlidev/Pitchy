import type {
  CoreMessageCandidate,
  CoreMessageCandidateExpectation,
} from "./core-message-apidog-cases";

export type CoreMessagePrecheck = {
  classification: CoreMessageCandidateExpectation;
  eligibleForHumanReview: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  hardFailures: string[];
};

const specificationPattern = /\b(?:api\s+)?(?:spec(?:ification)?|contract)\b/i;
const propagationPattern =
  /\b(?:sync|synchroni[sz]|align|propagat|update|drive|derive|same definition|shared definition|single source of truth)\w*/i;
const manualReliefPattern =
  /\b(?:manual|copy|duplicate|separate tools?|switch(?:ing)?|repeat|maintain(?:ing)? multiple)\w*/i;
const universalGuaranteePattern =
  /\b(?:never|forever|always|guarantee[sd]?|eliminate[sd]? all|zero mistakes?|all .* automatically)\b/i;
const automaticExternalMutationPattern =
  /\b(?:application code|source code|production systems?|deployed services?|backend code)\b[^.\n]{0,100}\b(?:sync|update|rewrite|change)\w*\s+automatically\b/i;

const downstreamAssets = [
  /\bdoc(?:s|umentation)?\b/i,
  /\bmock(?:s|ing)?\b/i,
  /\brequests?\b/i,
  /\btests?(?:ing)?\b/i,
  /\bdebug(?:ging)?\b/i,
];

export function precheckCoreMessage(text: string): CoreMessagePrecheck {
  const hardFailures: string[] = [];
  if (universalGuaranteePattern.test(text)) {
    hardFailures.push("unsupported_universal_guarantee");
  }
  if (automaticExternalMutationPattern.test(text)) {
    hardFailures.push("automatic_external_implementation_mutation");
  }

  const downstreamCount = downstreamAssets.filter((pattern) => pattern.test(text)).length;
  const checks = [
    {
      name: "specification_authority",
      passed: specificationPattern.test(text),
      detail: "Names the API specification or contract as the governing artifact.",
    },
    {
      name: "downstream_scope",
      passed: downstreamCount >= 2,
      detail: `Names ${downstreamCount} downstream asset classes; at least two are required.`,
    },
    {
      name: "change_propagation",
      passed: propagationPattern.test(text),
      detail: "Connects the governing artifact to propagation or alignment.",
    },
    {
      name: "manual_sync_relief",
      passed: manualReliefPattern.test(text),
      detail: "Makes relief from manual duplication or tool synchronization explicit.",
    },
  ];

  if (hardFailures.length > 0) {
    return {
      classification: "hard_fail",
      eligibleForHumanReview: false,
      checks,
      hardFailures,
    };
  }

  const passedCount = checks.filter((check) => check.passed).length;
  const classification: CoreMessageCandidateExpectation =
    passedCount === checks.length
      ? "strong"
      : passedCount >= 3
        ? "acceptable"
        : "insufficient";

  return {
    classification,
    eligibleForHumanReview: classification !== "insufficient",
    checks,
    hardFailures,
  };
}

export function evaluateCoreMessageRegression(candidate: CoreMessageCandidate) {
  const result = precheckCoreMessage(candidate.text);
  return {
    ...result,
    expected: candidate.expected,
    matchedExpectation: result.classification === candidate.expected,
  };
}

