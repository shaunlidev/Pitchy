"use client";

import type { TopicRef } from "@pitchroom/domain";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FileImportItem } from "../lib/file-import";
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
  const [fileImports, setFileImports] = useState<FileImportItem[]>([]);
  const [importing, setImporting] = useState(false);
  const importingRef = useRef(false);
  const lastFailure = useRef<WorkspaceActionError | undefined>(undefined);
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

  async function act(body: Record<string, unknown>, attempt: { commandId?: string; explicitRetry?: boolean; retainWrittenBrief?: boolean } = {}): Promise<boolean> {
    if (submitting.current) return false;
    const feedbackDecision = ["apply_clarification","dismiss_clarification","retry_clarification"].includes(String(body.action));
    if (!attempt.explicitRetry && !attempt.commandId && state && deriveWorkspaceUXState(state, activeAgentRequest, { busy, error: actionError }).mutationLocked && !(feedbackDecision && !busy && !actionError)) return false;
    submitting.current = true;
    lastFailure.current = undefined;
    const agentAction = agentActionForCommand(body.action);
    const commandId = attempt.commandId ?? crypto.randomUUID();
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
        lastFailure.current = createWorkspaceActionError({ code: envelope.code, technicalMessage: envelope.error, requestId: envelope.requestId, action: agentAction, commandId });
        setActionError(lastFailure.current);
        if (agentAction) setFailedAgentCommand({ body, commandId });
        return false;
      }
      setState(workspaceStateSchema.parse(result));
      setFailedAgentCommand(undefined);
      if ((body.action === "add_material" && !attempt.retainWrittenBrief) || body.action === "save_brief") setText("");
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
      lastFailure.current = createWorkspaceActionError({ code: "NETWORK_ERROR", technicalMessage, action: agentAction, commandId, outcomeUnknown: true });
      setActionError(lastFailure.current);
      if (agentAction) setFailedAgentCommand({ body, commandId });
      return false;
    } finally {
      if (activeRequest.current === controller) activeRequest.current = undefined;
      if (agentAction) setActiveAgentRequest(undefined);
      submitting.current = false;
      setBusy(false);
    }
  }

  async function chooseFile(file: File, commandId: string, topic?: TopicRef) {
    lastFailure.current = undefined;
    if (!file) return false;
    if (!/\.(md|txt)$/i.test(file.name)) {
      lastFailure.current = createWorkspaceActionError({ code: "INVALID_INPUT", technicalMessage: "Choose a UTF-8 .txt or .md file." });
      setActionError(lastFailure.current);
      return false;
    }
    try {
      const fileText = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      if (!fileText.trim() || fileText.length > 1_048_576) {
        lastFailure.current = createWorkspaceActionError({ code: "INVALID_INPUT", technicalMessage: !fileText.trim() ? "Material must contain readable text." : "Material exceeds the source size limit." });
        setActionError(lastFailure.current);
        return false;
      }
      setActionError(undefined);
      return await act({ action: topic ? "attach_topic_material" : "add_material", topic, name: file.name, mediaType: file.name.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain", text: fileText }, { commandId, explicitRetry: true, retainWrittenBrief: true });
    } catch {
      lastFailure.current = createWorkspaceActionError({ code: "INVALID_INPUT", technicalMessage: "The selected file could not be read as UTF-8 text." });
      setActionError(lastFailure.current);
      return false;
    }
  }

  async function importFiles(files: File[], retry?: Extract<FileImportItem, { status: "failed" }>, topic?: TopicRef) {
    if (!files.length || importingRef.current || submitting.current || (state && deriveWorkspaceUXState(state, activeAgentRequest, { busy }).mutationLocked)) return false;
    importingRef.current = true;
    setImporting(true);
    const entries = files.map(file => ({ id: retry?.id ?? crypto.randomUUID(), name: file.name, file, topic: retry?.topic ?? topic, commandId: retry?.outcomeUnknown ? retry.commandId : crypto.randomUUID() }));
    if (!retry) setFileImports(previous => [...previous, ...entries.map(({ id, name }) => ({ id, name, status: "queued" as const }))]);
    let allSaved = true;
    try {
      for (const entry of entries) {
        setFileImports(previous => previous.map(item => item.id === entry.id ? { id: entry.id, name: entry.name, status: "importing" } : item));
        const saved = await chooseFile(entry.file, entry.commandId, entry.topic);
        const failure = lastFailure.current;
        const item: FileImportItem = saved ? { id: entry.id, name: entry.name, status: "saved" }
          : { ...entry, status: "failed", message: failure?.technicalMessage ?? "The file was not imported. Review the current project before retrying.", outcomeUnknown: failure?.outcomeUnknown ?? false };
        setFileImports(previous => previous.map(previousItem => previousItem.id === item.id ? item : previousItem));
        allSaved = allSaved && saved;
      }
      return allSaved;
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  }

  if (!state) return <main className="loading" aria-live="polite">
    <span className="brandDot" aria-hidden="true" />
    <strong>{loadError ? "The workspace did not open." : "Opening your project…"}</strong>
    {loadError && <><p role="alert">{loadError}</p><button onClick={() => { setLoadError(""); void refresh().catch((cause) => setLoadError(cause instanceof Error ? cause.message : String(cause))); }}>Try again</button></>}
  </main>;

  return <WorkspaceView key={state.project.id} rememberPosition state={state} busy={busy || importing} error={actionError} text={text} answer={answer} correction={correction} activeRequest={activeRequest.current} activeAgentRequest={activeAgentRequest} onTextChange={setText} onAnswerChange={setAnswer} onCorrectionChange={setCorrection} onChooseFile={file => file ? importFiles([file]) : false} onChooseFiles={(files, topic) => importFiles(files, undefined, topic)} fileImports={fileImports} fileImportBusy={busy || importing} onRetryFile={item => importFiles([item.file], item)} onCancelRun={() => activeRequest.current?.abort()} onRetryAction={failedAgentCommand ? () => act(failedAgentCommand.body, { commandId: actionError?.outcomeUnknown ? failedAgentCommand.commandId : undefined, explicitRetry: true }) : undefined} onRefreshWorkspace={async () => { try { await refresh(); setActionError(undefined); } catch (cause) { setActionError(createWorkspaceActionError({ code: "PERSISTENCE_ERROR", technicalMessage: cause instanceof Error ? cause.message : String(cause) })); } }} onDismissError={() => setActionError(undefined)} onAction={(body) => act(body.action === "add_material" && !body.name ? { ...body, name: "written-brief.md", mediaType: "text/markdown" } : body)} />;
}
