import type { CoreMessageSource } from "./core-message-types";

export type CoreMessageCandidateExpectation =
  | "insufficient"
  | "acceptable"
  | "strong"
  | "hard_fail";

export type CoreMessageCandidate = {
  id: string;
  text: string;
  expected: CoreMessageCandidateExpectation;
  annotation: string;
};

export const apidogSources: CoreMessageSource[] = [
  {
    id: "official-homepage",
    authority: "official",
    url: "https://apidog.com/",
    material:
      "Apidog presents API design, debugging, mocking, testing, and documentation as one connected workflow. It describes requests, mocks, tests, and published documentation as linked to the same OpenAPI definition.",
    boundary:
      "Vendor-authored product description; it supports intended capability and positioning, not independent outcome validation.",
  },
  {
    id: "official-introduction",
    authority: "official",
    url: "https://docs.apidog.com/en/introduction-to-apidog-643492m0",
    material:
      "Apidog describes the API specification as the shared basis for API designers, backend developers, frontend developers, QA engineers, and documentation consumers.",
    boundary:
      "Documentation describes the designed workflow; it does not prove every team adopts it successfully.",
  },
  {
    id: "official-collaboration-workflow",
    authority: "official",
    url: "https://docs.apidog.com/apidog-collaboration-workflow-646333m0",
    material:
      "The documented workflow connects specification, frontend mocks, backend debugging, saved endpoint cases, QA testing, integration testing, and shared documentation.",
    boundary:
      "The workflow supports a propagation hypothesis but does not authorize claims that application code updates automatically.",
  },
  {
    id: "g2-review-patterns",
    authority: "aggregated_review",
    url: "https://www.g2.com/products/apidog/reviews",
    material:
      "Reviewers repeatedly describe moving between Postman, Swagger, documentation, mocks, and tests; they value having these assets connected and report less manual synchronization. Reviews also mention learning curve, interface density, resource use, and migration friction.",
    boundary:
      "Aggregated reviews include different verification, incentive, and translation conditions. They are directional signals, not a controlled product study.",
  },
];

export const apidogGoldenJudgment = {
  category: "All-in-one API development platform",
  coreMessage: "Change the spec once. Keep the entire API workflow in sync.",
  expandedJudgment:
    "Apidog turns the API specification into an active source of truth. Change the spec once, and dependent API workflow assets such as documentation, mocks, requests, and tests can stay aligned without manual copying across tools.",
  mechanism:
    "A shared API specification drives or validates dependent workflow assets.",
  humanPayoff:
    "Developers stop acting as the manual synchronization layer between API tools and team roles.",
  tradeoff:
    "The message prioritizes workflow alignment over a broad claim that Apidog is the simplest or most feature-rich API tool.",
  exclusions: [
    "Automatic rewriting of application code",
    "A guarantee that production behavior always matches the specification",
    "A claim that every dependent asset can change without human review",
    "Unverified efficiency percentages or universal adoption claims",
  ],
  unknowns: [
    "Whether synchronization failure or tool switching is the primary migration trigger for real customers",
    "Which dependent assets users most expect to update automatically",
    "How often human-authored tests require manual repair after a specification change",
  ],
} as const;

export const apidogCandidateOutputs: CoreMessageCandidate[] = [
  {
    id: "A_FEATURE_LIST",
    text:
      "Apidog is a powerful all-in-one API development platform for design, debugging, mocking, testing, documentation, and collaboration, helping developers work more efficiently.",
    expected: "insufficient",
    annotation:
      "Factually plausible feature summary with no source-of-truth mechanism, change propagation, or strategic choice.",
  },
  {
    id: "B_SHARED_SPEC",
    text:
      "Apidog uses one API specification to connect design, mocks, tests, and documentation. When the API changes, dependent workflow assets can continue from the same definition.",
    expected: "acceptable",
    annotation:
      "Grounded mechanism and propagation, but the relief from manual synchronization remains implicit.",
  },
  {
    id: "C_CHANGE_PROPAGATION",
    text:
      "Change the API specification once. Apidog keeps documentation, mocks, requests, and tests aligned around that definition, so your team does not have to copy the same change across separate tools.",
    expected: "strong",
    annotation:
      "Joins user action, product mechanism, downstream result, and manual-sync relief without claiming automatic code mutation.",
  },
  {
    id: "D_UNIVERSAL_GUARANTEE",
    text:
      "With Apidog, frontend, backend, and QA will never make API consistency mistakes again. All documentation, tests, application code, and production systems synchronize automatically forever.",
    expected: "hard_fail",
    annotation:
      "Unsupported universal guarantee and automatic external implementation mutation claim.",
  },
];

