import { clarificationPending } from "@pitchroom/domain";
import type { FixtureState } from "./fixture-store";

type WorkflowKind = FixtureState["workflowRuns"][number]["kind"];
export type AgentActionKind = "understanding" | WorkflowKind;
export type AgentActivityStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type ActiveAgentRequest = {
  commandId: string;
  startedAt: string;
  startSequence: number;
} & ({ kind: "understanding" } | { kind: WorkflowKind; workflowRunIdsAtStart: string[] });

export type WorkspaceActionError = {
  code: string;
  message: string;
  technicalMessage: string;
  requestId?: string;
  action?: AgentActionKind;
  commandId?: string;
  recovery: "retry" | "refresh" | "review" | "none";
  outcomeUnknown: boolean;
};

export type AgentActivity = {
  kind: AgentActionKind;
  status: AgentActivityStatus;
  title: string;
  events: FixtureState["events"];
};

const actionTitles: Record<AgentActionKind, string> = {
  story: "Developing your story proposal",
  understanding: "Understanding your material",
  positioning: "Developing positioning directions",
  deck: "Building the discussion deck",
};

const workflowLabels: Record<WorkflowKind, { agent: string; result: string; validated: string }> = {
  positioning: { agent: "Positioning", result: "Directions", validated: "Directions validated" },
  deck: { agent: "Deck", result: "Deck draft", validated: "Deck draft validated" },
  story: { agent: "Story", result: "Story proposal", validated: "Story proposal validated" },
};

export function workflowEventLabel(kind: WorkflowKind, type: string): string {
  const labels = workflowLabels[kind];
  const events: Record<string, string> = {
    run_started: `${labels.agent} agent started`,
    context_loaded: "Source context locked",
    inputs_locked: "Approved inputs locked",
    model_requested: "Model generation started",
    proposal_validated: labels.validated,
    draft_validated: labels.validated,
    run_completed: `${labels.result} ready`,
    run_failed: `${labels.agent} agent failed`,
  };
  return events[type] ?? type.replaceAll("_", " ");
}

export function agentActionForCommand(action: unknown): AgentActionKind | undefined {
  return action === "propose_story" ? "story" : action === "run" ? "understanding" : action === "generate_positioning" ? "positioning" : action === "generate_deck" ? "deck" : undefined;
}

function workflowActivity(run: FixtureState["workflowRuns"][number]): AgentActivity {
  return {
    kind: run.kind,
    status: run.status,
    title: actionTitles[run.kind],
    events: run.events.map((event, index) => ({ sequence: index + 1, label: workflowEventLabel(run.kind, event.type), detail: event.detail, at: event.at })),
  };
}

function deriveActivity(state: FixtureState, request?: ActiveAgentRequest): { activity?: AgentActivity } {
  if (request) {
    if (request.kind !== "understanding") {
      const run = [...state.workflowRuns].reverse().find(run => run.kind === request.kind && !request.workflowRunIdsAtStart.includes(run.id));
      return { activity: run ? workflowActivity(run) : { kind: request.kind, status: "queued", title: actionTitles[request.kind], events: [] } };
    }
    const events = state.events.filter(event => event.sequence > request.startSequence);
    const status = !events.length ? "queued"
      : state.project.phase === "failed" ? "failed"
      : state.project.phase === "cancelled" ? "cancelled"
      : ["review_required", "accepted"].includes(state.project.phase) && state.currentVersionId ? "completed"
      : "running";
    return { activity: { kind: request.kind, status, title: actionTitles[request.kind], events } };
  }

  if (["reading", "structuring"].includes(state.project.phase)) {
    const lastStart = state.events.map(event => event.label).lastIndexOf("Agent started");
    return { activity: { kind: "understanding", status: "running", title: actionTitles.understanding, events: lastStart < 0 ? [] : state.events.slice(lastStart) } };
  }
  const running = [...state.workflowRuns].reverse().find((run) => run.status === "running");
  return running ? { activity: workflowActivity(running) } : {};
}

export function createWorkspaceActionError(input: {
  code: string;
  technicalMessage: string;
  requestId?: string;
  action?: AgentActionKind;
  commandId?: string;
  outcomeUnknown?: boolean;
}): WorkspaceActionError {
  const outcomeUnknown = input.outcomeUnknown ?? ["NETWORK_ERROR", "PERSISTENCE_ERROR"].includes(input.code);
  const message = input.code === "CONFLICT"
    ? "This workspace changed since the action began. Refresh before continuing."
    : input.code === "PROVIDER_TIMEOUT"
      ? "The generation service timed out. Your existing work was preserved. Retry when you are ready."
    : input.code === "PROPOSAL_REJECTED"
      ? "The generated draft did not pass the evidence or safety checks. Your existing work was preserved."
      : input.code === "PERSISTENCE_ERROR"
        ? "The workspace could not confirm the save. Your previously saved work remains available."
        : input.code === "INVALID_INPUT" || input.code === "INVALID_REQUEST" || input.code === "INVALID_TRANSITION"
          ? "This action cannot use the current input or project state. Review the current step before continuing."
          : input.code === "NETWORK_ERROR"
            ? "The connection ended before completion could be confirmed."
            : "The action could not be completed. Your previously saved work remains available.";

  const recovery = input.code === "CONFLICT"
    ? "refresh"
    : input.action && ["PERSISTENCE_ERROR", "NETWORK_ERROR", "PROPOSAL_REJECTED", "PROVIDER_TIMEOUT"].includes(input.code)
      ? "retry"
      : ["INVALID_INPUT", "INVALID_REQUEST", "INVALID_TRANSITION"].includes(input.code)
        ? "review"
        : input.code === "PERSISTENCE_ERROR"
          ? "refresh"
          : "none";

  return { ...input, message, recovery, outcomeUnknown };
}

export type Destination = "materials" | "clarify" | "positioning" | "deck";
export function deriveWorkspaceUXState(state: FixtureState, request?: ActiveAgentRequest, context: {
  destination?: Destination; busy?: boolean; error?: WorkspaceActionError;
  answer?: string; correction?: string; text?: string; selectedDirectionId?: string; adjustment?: string;
} = {}) {
  const { activity } = deriveActivity(state, request);
  const running = activity?.status === "queued" || activity?.status === "running" || state.workflowRuns.some(run => run.status === "running");
  const clarification = state.clarifications?.find(clarificationPending);
  const mutationLocked = Boolean(context.busy || running || context.error || clarification);
  const access = {
    materials: { allowed: true, reason: "", target: "materials" as Destination },
    clarify: { allowed: state.sources.length > 0, reason: "Add material before inspecting the understanding.", target: "materials" as Destination },
    positioning: { allowed: state.project.phase === "accepted", reason: "Review and accept the current understanding first.", target: (state.sources.length ? "clarify" : "materials") as Destination },
    deck: { allowed: Boolean(state.deck), reason: "Apply a positioning direction, then create a deck draft.", target: (state.project.phase === "accepted" ? "positioning" : state.sources.length ? "clarify" : "materials") as Destination },
  };
  const checkpoints: Record<AgentActionKind, string> = {
    deck: "Next: review the saved deck. Existing drafts remain available.",
    positioning: "Next: compare directions and explicitly apply your choice.",
    story: "Next: review the story proposal and explicitly apply or keep your current story.",
    understanding: "Next: review and accept the understanding. Unknowns can stay open.",
  };
  const checkpoint = checkpoints[activity?.kind ?? "understanding"];
  const destination = context.destination ?? "materials";
  let primary = "none";
  if (!mutationLocked) {
    if (destination === "materials") primary = context.text?.trim() ? "add_material" : !state.sources.length ? "upload" : ["materials_ready", "failed", "cancelled"].includes(state.project.phase) ? "run" : "clarify";
    if (destination === "clarify") primary = state.project.phase === "review_required"
      ? context.correction?.trim() ? "correct" : context.answer?.trim() ? "answer" : "accept"
      : state.project.phase === "accepted" ? "positioning" : ["materials_ready", "failed", "cancelled"].includes(state.project.phase) ? "run" : "none";
    if (destination === "positioning" && access.positioning.allowed) primary = !state.positioning ? "generate_positioning"
      : context.adjustment?.trim() ? "adjust_positioning"
      : state.positioning.appliedDirectionId !== (context.selectedDirectionId ?? state.positioning.appliedDirectionId ?? "original") ? "apply_positioning" : "generate_deck";
    if (destination === "deck") primary = state.deck?.stale ? "positioning" : "review_deck";
  }
  return { activity, running, mutationLocked, access, checkpoint, primary };
}
