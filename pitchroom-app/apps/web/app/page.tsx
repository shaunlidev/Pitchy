"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FixtureState } from "../lib/fixture-store";
import { WorkspaceView } from "../lib/workspace-view";
import "./styles.css";
import "./ux-fixes.css";

export default function HomePage() {
  const [state, setState] = useState<FixtureState>();
  const [text, setText] = useState("");
  const [correction, setCorrection] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const activeRequest = useRef<AbortController | undefined>(undefined);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/workspace", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "The workspace could not be loaded.");
    setState(result);
  }, []);

  useEffect(() => {
    refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [refresh]);

  useEffect(() => {
    const stream = new EventSource("/api/workspace/events");
    stream.addEventListener("workspace", () => refresh().catch(() => undefined));
    return () => stream.close();
  }, [refresh]);

  async function act(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError("");
    const controller = body.action === "run" ? new AbortController() : undefined;
    if (controller) activeRequest.current = controller;
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: crypto.randomUUID(), ...body }), signal: controller?.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "The action failed.");
      setState(result);
      if (body.action === "answer") setAnswer("");
      if (body.action === "correct") setCorrection("");
      if (body.action === "reset") {
        setAnswer("");
        setCorrection("");
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The action failed.");
      return false;
    } finally {
      if (activeRequest.current === controller) activeRequest.current = undefined;
      setBusy(false);
    }
  }

  async function chooseFile(file?: File) {
    if (!file) return false;
    if (!/\.(md|txt)$/i.test(file.name)) {
      setError("Choose a UTF-8 .txt or .md file.");
      return false;
    }
    try {
      const fileText = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      setError("");
      return await act({ action: "add_material", name: file.name, mediaType: file.name.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain", text: fileText });
    } catch {
      setError("The selected file could not be read as UTF-8 text.");
      return false;
    }
  }

  if (!state) return <main className="loading" aria-live="polite">
    <span className="brandDot" aria-hidden="true" />
    <strong>{error ? "The workspace did not open." : "Opening your project…"}</strong>
    {error && <><p role="alert">{error}</p><button onClick={() => { setError(""); void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }}>Try again</button></>}
  </main>;

  return <WorkspaceView state={state} busy={busy} error={error} text={text} answer={answer} correction={correction} activeRequest={activeRequest.current} onTextChange={setText} onAnswerChange={setAnswer} onCorrectionChange={setCorrection} onChooseFile={chooseFile} onCancelRun={() => activeRequest.current?.abort()} onAction={(body) => act(body.action === "add_material" && !body.name ? { ...body, name: "written-brief.md", mediaType: "text/markdown" } : body)} />;
}
