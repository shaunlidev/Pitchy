import { hashTaskValue, taskRubric } from "./schema";
import { readWorkflowReviewContext, type WorkflowReviewContext } from "./workflow";
import { engineeringChecks } from "./checks";
import { packetFindings, reviewAuthority, reviewRecords, targetAt, type ReviewRecord, type ReviewTarget, type ReviewPacket } from "./review";

export type SemanticFacts = { confirmedFailures: string[]; disputes: string[]; missingOutputs: string[]; missingReviews: string[]; lowScores: string[]; noncriticalFindings: string[]; reviewHashes: string[] };
/** Priority is deliberately total and independent from execution/tool failures. */
export function semanticVerdict(facts: SemanticFacts) {
  const actionable = facts.noncriticalFindings.length ? { actionableFindingIds: facts.noncriticalFindings } : {};
  if (facts.confirmedFailures.length) return { kind: "fail", findingIds: facts.confirmedFailures, ...actionable };
  if (facts.disputes.length) return { kind: "disputed", disputeIds: facts.disputes, ...actionable };
  if (facts.missingOutputs.length) return { kind: "incomplete", missingOutputs: facts.missingOutputs, ...actionable };
  if (facts.missingReviews.length) return { kind: "awaiting_review", missingReviewIds: facts.missingReviews, ...actionable };
  if (facts.lowScores.length || facts.noncriticalFindings.length) return { kind: "fail", findingIds: [...facts.lowScores, ...facts.noncriticalFindings], ...actionable };
  return { kind: "pass", reviewHashes: facts.reviewHashes };
}
export function scoreReview(stage: ReviewTarget["stage"], scores: ReviewPacket["scores"], directionDifference: string): "missing" | "below_threshold" | "pass" {
  const dimensions: readonly string[] = stage === "positioning" ? taskRubric.positioning.dimensions : ["story_initial", "story_revision", "deck"].includes(stage) ? taskRubric.storyDeck.dimensions : [];
  if (scores.length !== dimensions.length || dimensions.some(dimension => scores.filter(score => score.dimension === dimension).length !== 1) || (stage === "positioning" && !directionDifference.trim())) return "missing";
  if (!dimensions.length) return "pass";
  const minimum = stage === "positioning" ? taskRubric.positioning.minimumEach : taskRubric.storyDeck.minimumEach;
  return scores.some(score => score.score < minimum) || (stage === "positioning" && scores.reduce((sum, score) => sum + score.score, 0) / scores.length < taskRubric.positioning.minimumMean) ? "below_threshold" : "pass";
}
function targetFacts(target: ReviewTarget, records: ReviewRecord[]): SemanticFacts {
  const facts: SemanticFacts = { confirmedFailures: [], disputes: [], missingOutputs: [], missingReviews: [], lowScores: [], noncriticalFindings: [], reviewHashes: [] };
  const packets = records.filter(item => item.kind === "review_packet" && hashTaskValue(item.binding) === hashTaskValue(target.binding));
  if (!packets.length) facts.missingReviews.push(target.binding.checkpointHash);
  const findings = new Map<string, { critical: boolean; values: { verdict: string; packetHash: string }[] }>();
  for (const packet of packets) {
    if (packet.kind !== "review_packet") continue;
    facts.reviewHashes.push(hashTaskValue(packet));
    for (const finding of packetFindings(packet, target)) {
      const group = findings.get(finding.key) ?? { critical: false, values: [] };
      group.critical ||= Boolean(finding.critical); group.values.push({ verdict: finding.verdict, packetHash: hashTaskValue(packet) }); findings.set(finding.key, group);
    }
    const score = scoreReview(target.stage, packet.scores, packet.directionDifference);
    if (score === "missing") facts.missingReviews.push(`scores:${packet.id}`);
    else if (score === "below_threshold") facts.lowScores.push(`scores:${packet.id}`);
  }
  for (const [key, finding] of findings) {
    const hashes = [...new Set(finding.values.map(item => item.packetHash))].sort();
    const resolution = records.find(item => item.kind === "review_adjudication" && item.findingKey === key && hashTaskValue(item.binding) === hashTaskValue(target.binding) && hashTaskValue([...item.packetHashes].sort()) === hashTaskValue(hashes));
    const resolved = resolution?.kind === "review_adjudication" && hashTaskValue([...resolution.packetHashes].sort()) === hashTaskValue(hashes) ? resolution.verdict : null;
    const values = new Set(finding.values.map(item => item.verdict));
    if (resolved === "violated" || (!resolved && values.size === 1 && values.has("violated"))) (finding.critical ? facts.confirmedFailures : facts.noncriticalFindings).push(key);
    else if (resolved === "disputed" || (!resolved && (values.size > 1 || values.has("disputed")))) (finding.critical ? facts.disputes : facts.noncriticalFindings).push(key);
  }
  return facts;
}
export function userTaskVerdict(context: WorkflowReviewContext, records: ReviewRecord[], latestDeck: ReviewTarget | undefined) {
  const pending = { kind: "awaiting_observation", missingEvidence: ["Actual downstream use of the current adopted output has not been verified."] };
  if (!latestDeck || context.manifest.purpose !== "task_evidence" || context.bundle.taskCase.spec.participantMode === "scripted_synthetic") return pending;
  const currentDeck = context.snapshots.at(-1)?.workspace.deck;
  if (!currentDeck || currentDeck.stale || hashTaskValue(currentDeck.proposal) !== latestDeck.binding.outputHash) return pending;
  if (!context.decisions.some(item => context.resolvedDecisionIds.includes(item.decisionId) && ["feedback", "exact_edit_story"].includes(item.response.kind))
    || !context.decisions.some(item => context.resolvedDecisionIds.includes(item.decisionId) && item.response.kind === "apply_story")) return pending;
  const uses = records.filter(item => item.kind === "review_use" && hashTaskValue(item.binding) === hashTaskValue(latestDeck.binding));
  const eligible = uses.filter(item => item.kind === "review_use" && item.evidenceKind === "real" && item.actualUse && item.downstreamUse.length && item.behaviorEvidence.length && item.understandsDirectionDifference && item.distinguishesPreviewAndApply && item.completedFeedbackAndApply);
  if (!eligible.length) return pending;
  return { kind: eligible.some(item => item.kind === "review_use" && item.outcome === "not_useful") ? "fail" : "pass", scope: context.bundle.taskCase.spec.participantMode, observationHashes: eligible.map(hashTaskValue), boundary: "One case; not the multi-participant product gate." };
}
/** Rereads all evidence; neither callers nor review files can submit a desired final PASS. */
export function assessTask(rawRun: unknown) {
  try {
    const context = readWorkflowReviewContext(rawRun), records = reviewRecords(context), checks = engineeringChecks(context, records);
    const targets: ReviewTarget[] = [];
    for (const snapshot of context.snapshots) {
      try { targets.push(targetAt(context, snapshot.checkpointHash)); }
      catch (error) { if (!(error instanceof Error) || error.message !== "REVIEW_OUTPUT_MISSING") throw error; }
    }
    const latest = new Map<string, ReviewTarget>();
    for (const target of targets) if (target.stage !== "actual_use") latest.set(target.stage, target);
    const aggregate: SemanticFacts = { confirmedFailures: [], disputes: [], missingOutputs: [], missingReviews: [], lowScores: [], noncriticalFindings: [], reviewHashes: [] };
    for (const stage of context.bundle.taskCase.spec.requiredStages) {
      if (stage === "actual_use") continue;
      const target = latest.get(stage);
      if (!target) { aggregate.missingOutputs.push(stage); continue; }
      const facts = targetFacts(target, records);
      for (const key of ["confirmedFailures", "disputes", "missingOutputs", "missingReviews", "lowScores", "noncriticalFindings", "reviewHashes"] satisfies (keyof SemanticFacts)[]) aggregate[key].push(...facts[key]);
    }
    const firstByStage = new Set<string>();
    const attemptHistory = targets.map(target => {
      const firstAttempt = !firstByStage.has(target.stage); firstByStage.add(target.stage);
      return { binding: target.binding, identity: target.identity, stage: target.stage, firstAttempt, semantic: semanticVerdict(targetFacts(target, records)) };
    });
    const authority = records.some(record => record.kind === "review_authority") ? reviewAuthority(context) : null;
    return { kind: "task_assessment", integrity: { kind: "valid" }, execution: { held: context.held, journalHead: context.reference.headHash },
      engineering: { kind: checks.some(check => check.status === "fail") ? "fail" : checks.some(check => check.status === "incomplete") ? "incomplete" : "pass", checks },
      semantic: semanticVerdict(aggregate), userTask: userTaskVerdict(context, records, latest.get("deck")), attemptHistory,
      reviewIndependence: { mode: context.bundle.taskCase.spec.participantMode, distinctPeople: new Set(authority?.actors.filter(actor => actor.role === "human" && records.some(record => record.kind === "review_packet" && record.actorId === actor.actorId)).map(actor => actor.personId) ?? []).size,
        boundary: "Operator-attested identities; aliases do not create independence, calibration does not prove task correctness." },
    };
  } catch (error) {
    const reason = error instanceof Error && /^[A-Z][A-Z0-9_]{0,100}$/.test(error.message) ? error.message : "TASK_ASSESSMENT_TOOL_ERROR";
    return { kind: "assessment_unavailable", integrity: { kind: "unverified" }, toolError: { code: reason },
      engineering: { kind: "incomplete", missingChecks: ["verified_evidence"] }, semantic: { kind: "awaiting_review", missingReviewIds: ["verified_evidence"] }, userTask: { kind: "awaiting_observation", missingEvidence: ["verified_evidence"] } };
  }
}
