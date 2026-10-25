"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FixtureState } from "../lib/fixture-store";
import { errorEnvelopeSchema, workspaceStateSchema } from "../lib/api-contract";
import { agentActionForCommand, createWorkspaceActionError, deriveWorkspaceUXState, type ActiveAgentRequest, type WorkspaceActionError } from "../lib/workspace-ux-state";
import { WorkspaceView } from "../lib/workspace-view";
import "./styles.css";
import "./ux-fixes.css";

export default function HomePage() {
  const [state, setState] = useState<FixtureState>();
  const [text, setText] = useState("");
  const [correction, setCorrection] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState<WorkspaceActionError>();
  const [activeAgentRequest, setActiveAgentRequest] = useState<ActiveAgentRequest>();
  const [failedAgentCommand, setFailedAgentCommand] = useState<{ body: Record<string, unknown>; commandId: string }>();
  const submitting = useRef(false);
  const activeRequest = useRef<AbortController | undefined>(undefined);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/workspace", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "The workspace could not be loaded.");
    setState(workspaceStateSchema.parse(result));
  }, []);

  useEffect(() => {
    refresh().catch((cause) => setLoadError(cause instanceof Error ? cause.message : String(cause)));
  }, [refresh]);

  useEffect(() => {
    const stream = new EventSource("/api/workspace/events");
    stream.addEventListener("workspace", () => refresh().catch(() => undefined));
    stream.addEventListener("clarification", () => refresh().catch(() => undefined));
    return () => stream.close();
  }, [refresh]);

  const clarificationRunning = state?.clarifications?.some(task => task.status === "queued" || task.status === "running");
  useEffect(() => {
    if (!clarificationRunning) return;
    const timer = setInterval(() => { void refresh().catch(() => undefined); }, 1000);
    return () => clearInterval(timer);
  }, [clarificationRunning, refresh]);

  async function act(body: Record<string, unknown>, retryCommandId?: string): Promise<boolean> {
    if (submitting.current) return false;
    const feedbackDecision = ["apply_clarification","dismiss_clarification","retry_clarification"].includes(String(body.action));
    if (!retryCommandId && state && deriveWorkspaceUXState(state, activeAgentRequest, { busy, error: actionError }).mutationLocked && !(feedbackDecision && !busy && !actionError)) return false;
    submitting.current = true;
    const agentAction = agentActionForCommand(body.action);
    const commandId = retryCommandId ?? crypto.randomUUID();
    setBusy(true);
    if (agentAction) setActiveAgentRequest({ kind: agentAction, commandId, startedAt: new Date().toISOString(), startSequence: state?.events.at(-1)?.sequence ?? 0, workflowRunIdsAtStart: state?.workflowRuns.map(run => run.id) ?? [] });
    setActionError(undefined);
    const controller = body.action === "run" ? new AbortController() : undefined;
    if (controller) activeRequest.current = controller;
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, commandId }), signal: controller?.signal,
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const parsed = errorEnvelopeSchema.safeParse(result);
        const legacyMessage = result && typeof result === "object" && "error" in result && typeof result.error === "string" ? result.error : undefined;
        const envelope = parsed.success ? parsed.data : { code: response.status >= 500 ? "PERSISTENCE_ERROR" : "INVALID_RESPONSE", error: legacyMessage ?? "The server returned an unreadable error response.", requestId: response.headers.get("x-request-id") ?? undefined };
        setActionError(createWorkspaceActionError({ code: envelope.code, technicalMessage: envelope.error, requestId: envelope.requestId, action: agentAction, commandId }));
        if (agentAction) setFailedAgentCommand({ body, commandId });
        return false;
      }
      setState(workspaceStateSchema.parse(result));
      setFailedAgentCommand(undefined);
      if (body.action === "add_material") setText("");
      if (body.action === "answer" || (body.action === "submit_clarification" && !body.rebaseTaskId)) setAnswer("");
      if (body.action === "correct") setCorrection("");
      if (body.action === "reset") {
        setAnswer("");
        setCorrection("");
      }
      return true;
    } catch (cause) {
      if (controller?.signal.aborted) {
        await refresh().catch(() => undefined);
        return false;
      }
      const technicalMessage = cause instanceof Error ? cause.message : "The request failed before a response was received.";
      setActionError(createWorkspaceActionError({ code: "NETWORK_ERROR", technicalMessage, action: agentAction, commandId, outcomeUnknown: true }));
      if (agentAction) setFailedAgentCommand({ body, commandId });
      return false;
    } finally {
      if (activeRequest.current === controller) activeRequest.current = undefined;
      if (agentAction) setActiveAgentRequest(undefined);
      submitting.current = false;
      setBusy(false);
    }
  }

  async function chooseFile(file?: File) {
    if (!file) return false;
    if (!/\.(md|txt)$/i.test(file.name)) {
      setActionError(createWorkspaceActionError({ code: "INVALID_INPUT", technicalMessage: "Choose a UTF-8 .txt or .md file." }));
      return false;
    }
    try {
      const fileText = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      setActionError(undefined);
      return await act({ action: "add_material", name: file.name, mediaType: file.name.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain", text: fileText });
    } catch {
      setActionError(createWorkspaceActionError({ code: "INVALID_INPUT", technicalMessage: "The selected file could not be read as UTF-8 text." }));
      return false;
    }
  }

  if (!state) return <main className="loading" aria-live="polite">
    <span className="brandDot" aria-hidden="true" />
    <strong>{loadError ? "The workspace did not open." : "Opening your project…"}</strong>
    {loadError && <><p role="alert">{loadError}</p><button onClick={() => { setLoadError(""); void refresh().catch((cause) => setLoadError(cause instanceof Error ? cause.message : String(cause))); }}>Try again</button></>}
  </main>;

  return <WorkspaceView state={state} busy={busy} error={actionError} text={text} answer={answer} correction={correction} activeRequest={activeRequest.current} activeAgentRequest={activeAgentRequest} onTextChange={setText} onAnswerChange={setAnswer} onCorrectionChange={setCorrection} onChooseFile={chooseFile} onCancelRun={() => activeRequest.current?.abort()} onRetryAction={failedAgentCommand ? () => act(failedAgentCommand.body, failedAgentCommand.commandId) : undefined} onRefreshWorkspace={async () => { try { await refresh(); setActionError(undefined); } catch (cause) { setActionError(createWorkspaceActionError({ code: "PERSISTENCE_ERROR", technicalMessage: cause instanceof Error ? cause.message : String(cause) })); } }} onDismissError={() => setActionError(undefined)} onAction={(body) => act(body.action === "add_material" && !body.name ? { ...body, name: "written-brief.md", mediaType: "text/markdown" } : body)} />;
}
