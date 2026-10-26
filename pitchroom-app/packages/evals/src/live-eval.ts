import type { UnderstandingEvalCase } from "./index";

export function selectLiveEvalCases(cases: UnderstandingEvalCase[], mode: "smoke" | "all") {
  const modelCases = cases.filter((item) => item.category !== "user_correction");
  if (mode === "all") return modelCases;
  const priority = ["supported", "missing", "conflicting", "prompt_injection", "long_material"];
  return priority.map((category) => modelCases.find((item) => item.category === category)).filter((item): item is UnderstandingEvalCase => Boolean(item));
}
