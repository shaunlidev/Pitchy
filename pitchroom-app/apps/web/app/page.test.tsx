import { PitchroomError } from "@pitchroom/domain";
// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveFixtureBrief, submitFixtureClarification, decideFixtureClarification, runFixtureClarification, acceptFixture, applyFixturePositioning, generateFixturePositioning, generateFixtureDeck, addFixtureMaterial, answerFixtureQuestion, correctFixtureClaim, readFixtureState, removeFixtureMaterial, resetFixtureState, runFixtureAgent } from "../lib/fixture-store";
import HomePage from "./page";
import { WorkspaceView } from "../lib/workspace-view";
import { workspaceCommandSchema } from "../lib/api-contract";

beforeEach(() => localStorage.clear());

class FakeEventSource {
  addEventListener() {}
  close() {}
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("HomePage review interactions", () => {
  beforeEach(() => {
    resetFixtureState();
    addFixtureMaterial({ name: "brief.md", mediaType: "text/markdown", text: "Atelier helps design teams prepare client presentations." });
    runFixtureAgent();
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return jsonResponse(readFixtureState());
      const body = workspaceCommandSchema.parse(JSON.parse(String(init.body)));
      if (body.action === "save_brief") {
        try { return jsonResponse(saveFixtureBrief(body)); }
        catch (error) { if (error instanceof PitchroomError) return jsonResponse({code:error.code,error:error.message,requestId:"qa-brief"},409); throw error; }
      }
      if (body.action === "add_material") return jsonResponse(addFixtureMaterial({ name: body.name ?? "pasted-material.md", mediaType: body.mediaType ?? "text/markdown", text: body.text ?? "" }));
      if (body.action === "submit_clarification") { const saved=submitFixtureClarification({text:body.text!,expectedRevision:body.expectedRevision!,commandId:body.commandId!}); await runFixtureClarification(saved.clarifications!.at(-1)!.id); return jsonResponse(readFixtureState(),202); }
      if (body.action === "apply_clarification") return jsonResponse(decideFixtureClarification({taskId:body.taskId!,commandId:body.commandId!,action:"apply",result:body.result}));
      if (body.action === "answer") return jsonResponse(answerFixtureQuestion(body.text ?? "", body.expectedRevision ?? -1));
      if (body.action === "correct") return jsonResponse(correctFixtureClaim(body.text ?? "", body.themeIndex ?? -1, body.claimIndex ?? -1, body.expectedRevision ?? -1));
      if (body.action === "remove_material") return jsonResponse(removeFixtureMaterial(body.sourceId ?? ""));
      return jsonResponse({ error: "Unexpected test action" }, 400);
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("restores an unsubmitted answer after reopening and removes it only after successful submission", async () => {
    const user=userEvent.setup();
    const first=render(<HomePage/>);
    await user.click(await screen.findByRole("button",{name:"Clarify"}));
    await user.type(await screen.findByLabelText("Answer the agent’s question"),"Saved locally, never submitted on reopen.");
    first.unmount();
    const callsBefore=vi.mocked(fetch).mock.calls.filter(([,init])=>init?.method==="POST").length;
    const reopened=render(<HomePage/>);
    const field=await screen.findByLabelText("Answer the agent’s question");
    await waitFor(()=>expect(field).toHaveProperty("value","Saved locally, never submitted on reopen."));
    expect(vi.mocked(fetch).mock.calls.filter(([,init])=>init?.method==="POST")).toHaveLength(callsBefore);
    await user.click(screen.getByRole("button",{name:"Save answer & reassess"}));
    await waitFor(()=>expect(field).toHaveProperty("value",""));
    reopened.unmount(); render(<HomePage/>);
    await waitFor(()=>expect(screen.getByLabelText("Answer the agent’s question")).toHaveProperty("value",""));
  });

  it("offers an old answer instead of auto-filling it after source material changes", async () => {
    const user=userEvent.setup();
    const props={state:readFixtureState(),busy:false,text:"",answer:"",correction:"",rememberPosition:true,initialDestination:"clarify",onTextChange:vi.fn(),onAnswerChange:vi.fn(),onCorrectionChange:vi.fn(),onChooseFile:vi.fn(),onCancelRun:vi.fn(),onAction:vi.fn()} satisfies Parameters<typeof WorkspaceView>[0];
    const view=render(<WorkspaceView {...props}/>);
    await user.click(screen.getByRole("button",{name:"Clarify"}));
    await user.type(screen.getByLabelText("Answer the agent’s question"),"Still tied to the original material.");
    const changed=addFixtureMaterial({name:"new-context.md",mediaType:"text/markdown",text:"Synthetic new material changes the input context."});
    view.rerender(<WorkspaceView {...props} state={{...props.state,sources:changed.sources}}/>);
    await waitFor(()=>expect(screen.getByLabelText("Answer the agent’s question")).toHaveProperty("value",""));
    expect(screen.getByText(/Saved answer drafts/)).toBeTruthy();
    expect(props.onAction).not.toHaveBeenCalled();
  });

  it.each([["brief", "Original saved brief"], ["answer", "Original saved brief"], ["answer", ""]])("discards an unsaved %s against saved brief '%s' without blocking continuation", async (dirtyInput, savedText) => {
    if (savedText) saveFixtureBrief({ expectedVersionId: null, text: savedText, commandId: crypto.randomUUID() });
    const state = runFixtureAgent();
    const before = structuredClone(readFixtureState());
    const onAction = vi.fn();
    const input = { state, busy: false, text: savedText, answer: "", correction: "", rememberPosition: true, initialDestination: "clarify", onTextChange: vi.fn(), onAnswerChange: vi.fn(), onCorrectionChange: vi.fn(), onChooseFile: vi.fn(), onCancelRun: vi.fn(), onAction } satisfies Parameters<typeof WorkspaceView>[0];
    const user = userEvent.setup();
    const view = render(<WorkspaceView {...input} />);
    await user.click(screen.getByRole("button", { name: "Clarify" }));
    if (dirtyInput === "brief") {
      await user.click(screen.getByRole("button", { name: "Materials" }));
      await user.click(screen.getByText(/Written brief/, { selector: "summary" }));
      await user.clear(screen.getByLabelText("Written brief"));
      await user.type(screen.getByLabelText("Written brief"), "Unsent revision");
      await user.click(screen.getByRole("button", { name: "Clarify" }));
    } else {
      await user.type(screen.getByLabelText("Answer the agent’s question"), "Unsent answer");
    }
    await user.click(screen.getByRole("button", { name: /Accept version/ }));
    expect(screen.getByRole("region", { name: "Unsaved input" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Discard unsaved input" }));
    expect(onAction).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(readFixtureState()).toEqual(before);
    await user.click(screen.getByRole("button", { name: /Accept version/ }));
    expect(screen.queryByRole("region", { name: "Unsaved input" })).toBeNull();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]?.[0]).toMatchObject({ action: "accept" });
    await user.click(screen.getByRole("button", { name: "Materials" }));
    await user.click(screen.getByText(/Written brief/, { selector: "summary" }));
    expect(screen.getByLabelText("Written brief")).toHaveProperty("value", savedText);
    expect(screen.getByRole("button", { name: savedText ? "Save brief" : "Save cleared brief" })).toHaveProperty("disabled", true);
    view.unmount();
    render(<WorkspaceView {...input} initialDestination="materials" />);
    await user.click(screen.getByText(/Written brief/, { selector: "summary" }));
    expect(screen.getByLabelText("Written brief")).toHaveProperty("value", savedText);
    expect(readFixtureState().brief).toEqual(before.brief);
  });

  it("maintains one brief and restores an intentional unsaved clear before versioned removal", async () => {
    const user=userEvent.setup(); const first=render(<HomePage/>);
    await user.click(await screen.findByText(/Written brief/,{selector:"summary"}));
    const editor=screen.getByLabelText("Written brief");await user.type(editor,"Single brief 原话.");await user.click(screen.getByRole("button",{name:"Save brief"}));
    await waitFor(()=>expect(readFixtureState().brief?.versions).toHaveLength(1));expect(editor).toHaveProperty("value","Single brief 原话.");
    expect(screen.getByRole("button",{name:"Save brief"})).toHaveProperty("disabled",true);
    await user.click(screen.getByRole("button",{name:"Clear brief"}));expect(readFixtureState().sources).toHaveLength(2);
    first.unmount();render(<HomePage/>);const restored=await screen.findByLabelText("Written brief");await waitFor(()=>expect(restored).toHaveProperty("value",""));
    expect(screen.getByRole("button",{name:"Save cleared brief"})).toHaveProperty("disabled",false);
    await user.click(screen.getByRole("button",{name:"Save cleared brief"}));await waitFor(()=>expect(readFixtureState().brief?.head?.entry).toEqual({kind:"cleared"}));
    expect(readFixtureState().sources.map(source=>source.name)).toEqual(["brief.md"]);expect(readFixtureState().versions).toHaveLength(1);expect(readFixtureState().brief?.versions).toHaveLength(2);
  });

  it("preserves stale-tab brief input and requires explicit recovery before a new save", async () => {
    saveFixtureBrief({expectedVersionId:null,text:"Original brief",commandId:crypto.randomUUID()});
    const user=userEvent.setup();render(<HomePage/>);const editor=await screen.findByLabelText("Written brief");await user.clear(editor);await user.type(editor,"My unsent revision");
    saveFixtureBrief({expectedVersionId:readFixtureState().brief!.head!.id,text:"Other tab revision",commandId:crypto.randomUUID()});
    await user.click(screen.getByRole("button",{name:"Save brief"}));await screen.findByText(/This workspace changed since the action began/);expect(editor).toHaveProperty("value","My unsent revision");expect(readFixtureState().brief?.versions).toHaveLength(2);
    await user.click(screen.getByRole("button",{name:"Refresh workspace"}));await waitFor(()=>expect(editor).toHaveProperty("value","Other tab revision"));
    const count=vi.mocked(fetch).mock.calls.filter(([,init])=>init?.method==="POST").length;
    await user.click(screen.getByText(/Saved brief drafts/));await user.click(screen.getByRole("button",{name:/Use saved brief draft/}));expect(editor).toHaveProperty("value","My unsent revision");expect(vi.mocked(fetch).mock.calls.filter(([,init])=>init?.method==="POST")).toHaveLength(count);
    await user.click(screen.getByRole("button",{name:"Save brief"}));await waitFor(()=>expect(readFixtureState().brief?.versions).toHaveLength(3));
  });

  it("clears a committed answer and disables repeat submission", async () => {
    const user = userEvent.setup();
    render(<HomePage />);
    await user.click(await screen.findByRole("button", { name: "Clarify" }));
    const answer = await screen.findByLabelText("Answer the agent’s question") as HTMLTextAreaElement;
    await user.type(answer, "Approve the twelve-team pilot.");
    await user.click(screen.getByRole("button", { name: "Save answer & reassess" }));
    await waitFor(() => expect(answer.value).toBe(""));
    expect((screen.getByRole("button", { name: "Save answer & reassess" }) as HTMLButtonElement).disabled).toBe(true);
    expect(readFixtureState().versions).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Clarification feedback" }).textContent).toContain("Approve the twelve-team pilot.");
    await user.click(screen.getByRole("button", { name: "Apply changes to understanding" }));
    await waitFor(()=>expect(readFixtureState().versions).toHaveLength(2));
    expect(screen.getByText(/Agent interpretation · Based/)).toBeTruthy();
  });

  it("clears a committed correction and keeps it user-attributed", async () => {
    const user = userEvent.setup();
    render(<HomePage />);
    await user.click(await screen.findByRole("button", { name: "Clarify" }));
    const correction = await screen.findByLabelText("Your correction") as HTMLTextAreaElement;
    await user.type(correction, "Atelier shortens client-deck preparation.");
    const correctionPanel = screen.getByRole("region", { name: "Correct a specific claim" });
    await user.click(within(correctionPanel).getByRole("button", { name: "Record correction" }));
    await waitFor(() => expect(correction.value).toBe(""));
    expect((within(correctionPanel).getByRole("button", { name: "Record correction" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText("Atelier shortens client-deck preparation.").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/^User input ·/)).toBeTruthy();
  });

  it("lets the project overview change the inspected topic", async () => {
    const user = userEvent.setup();
    render(<HomePage />);
    await user.click(await screen.findByRole("button", { name: "Clarify" }));

    const topicList = await screen.findByLabelText("Project topics");
    const openQuestion = within(topicList).getAllByRole("button").find((button) => button.textContent?.includes("Open question 1"));
    expect(openQuestion).toBeTruthy();
    if (!openQuestion) throw new Error("Open question control was not rendered");
    await user.click(openQuestion);

    expect(openQuestion.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Open question 1", { selector: ".overviewFocus .eyebrow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to the current useful question" })).toBeTruthy();
  });

  it("recovers from an invalid file in an existing-project modal without reload or losing material", async()=>{
    const user=userEvent.setup({applyAccept:false});render(<HomePage />);
    await screen.findByRole("heading",{name:"Your project materials."});
    await user.click(screen.getByRole("button",{name:/Add files/}));
    await user.upload(screen.getByLabelText("Choose a UTF-8 text or Markdown file"),new File(['{}'],'bad.json',{type:'application/json'}));
    await waitFor(()=>expect(screen.queryByRole("dialog",{name:"Add source material"})).toBeNull());
    expect(readFixtureState().sources).toHaveLength(1);
    await user.click(screen.getByRole("button",{name:"Review current step"}));
    await user.click(screen.getByRole("button",{name:/Add files/}));
    await user.upload(screen.getByLabelText("Choose a UTF-8 text or Markdown file"),new File(['A second source.'],'recovered.md',{type:'text/markdown'}));
    await screen.findByText('recovered.md');expect(readFixtureState().sources).toHaveLength(2);
    expect(readFixtureState().sources[0]!.name).toBe('brief.md');
  });

  it("uploads a file into the visible inventory and removes a source", async () => {
    const user = userEvent.setup();
    render(<HomePage />);
    expect(await screen.findByRole("heading", { name: "Your project materials." })).toBeTruthy();
    expect((screen.getByLabelText("Written brief") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByText("External AI is enabled for this project.")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Add files/ }));
    expect(screen.getByRole("dialog", { name: "Add source material" })).toBeTruthy();
    const input = document.querySelector("#upload-material-file") as HTMLInputElement;
    await user.upload(input, new File(["# New evidence\nA new cited fact."], "new-evidence.md", { type: "text/markdown" }));
    expect(await screen.findByText("new-evidence.md")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Add source material" })).toBeNull();
    expect(screen.getByText("2 files")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Back to Clarify/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Remove brief.md" }));
    expect(screen.getByRole("alertdialog", { name: "Remove this source?" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove file" }));
    await waitFor(() => expect(screen.queryByText("brief.md")).toBeNull());
  });

  it("saves valid files in a mixed batch and reports the rejected item separately", async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<HomePage />);
    await screen.findByRole("heading", { name: "Your project materials." });
    await user.click(screen.getByText(/Written brief/, {selector:"summary"}));
    await user.type(screen.getByLabelText("Written brief"), "Keep this unsent written brief.");
    await user.click(await screen.findByRole("button", { name: /Add files/ }));
    await user.upload(screen.getByLabelText("Choose a UTF-8 text or Markdown file"), [
      new File(["First source."], "first.txt", { type: "text/plain" }),
      new File(["{}"], "rejected.json", { type: "application/json" }),
      new File(["Last source."], "last.md", { type: "text/markdown" }),
    ]);
    await waitFor(() => expect(readFixtureState().sources.map(source => source.name)).toEqual(["brief.md", "first.txt", "last.md"]));
    const results = screen.getByRole("region", { name: "File import results" });
    expect(results.textContent).toContain("first.txt — Saved");
    expect(results.textContent).toContain("last.md — Saved");
    expect(results.textContent).toContain("rejected.json — Not imported");
    expect(results.textContent).toContain("UTF-8");
    expect((screen.getByLabelText("Written brief") as HTMLTextAreaElement).value).toBe("Keep this unsent written brief.");
  });

  it("retries only the uncertain file with its original operation identity", async () => {
    const normalFetch = vi.mocked(fetch).getMockImplementation()!;
    const commands: { name: string; commandId: string | undefined }[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (!init?.method) return normalFetch(input, init);
      const body = workspaceCommandSchema.parse(JSON.parse(String(init.body)));
      if (body.action !== "add_material") return normalFetch(input, init);
      commands.push({ name: body.name, commandId: body.commandId });
      if (body.name === "uncertain.md") {
        if (commands.filter(command => command.name === body.name).length === 1) {
          await normalFetch(input, init);
          throw new Error("Response lost after save");
        }
        return jsonResponse(readFixtureState());
      }
      return normalFetch(input, init);
    });
    const user = userEvent.setup(); render(<HomePage />);
    await user.click(await screen.findByRole("button", { name: /Add files/ }));
    await user.upload(screen.getByLabelText("Choose a UTF-8 text or Markdown file"), [
      new File(["Saved first."], "saved.txt", { type: "text/plain" }),
      new File(["Save before response loss."], "uncertain.md", { type: "text/markdown" }),
    ]);
    const retry = await screen.findByRole("button", { name: "Retry uncertain.md" });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    await user.click(retry);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry uncertain.md" })).toBeNull());
    expect(commands.filter(command => command.name === "saved.txt")).toHaveLength(1);
    const attempts = commands.filter(command => command.name === "uncertain.md");
    expect(attempts).toHaveLength(2); expect(attempts[1]!.commandId).toBe(attempts[0]!.commandId);
    expect(readFixtureState().sources.map(source => source.name)).toEqual(["brief.md", "saved.txt", "uncertain.md"]);
  });

  it("continues after a file read failure and retries only that file after reopening Materials", async () => {
    const file = new File(["Recovered source."], "read-retry.md", { type: "text/markdown" });
    const read = file.arrayBuffer.bind(file);
    const reader = vi.spyOn(file, "arrayBuffer").mockImplementation(read).mockRejectedValueOnce(new Error("Transient read failure"));
    const user = userEvent.setup(); render(<HomePage />);
    await user.click(await screen.findByRole("button", { name: /Add files/ }));
    await user.upload(screen.getByLabelText("Choose a UTF-8 text or Markdown file"), [
      new File(["First saved."], "before.txt", { type: "text/plain" }), file,
      new File(["Last saved."], "after.txt", { type: "text/plain" }),
    ]);
    await waitFor(() => expect(readFixtureState().sources.map(source => source.name)).toEqual(["brief.md", "before.txt", "after.txt"]));
    await user.click(screen.getByRole("button", { name: "Clarify" }));
    await user.click(screen.getByRole("button", { name: "Materials" }));
    await user.click(screen.getByRole("button", { name: "Retry read-retry.md" }));
    await waitFor(() => expect(readFixtureState().sources.map(source => source.name)).toEqual(["brief.md", "before.txt", "after.txt", "read-retry.md"]));
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("uploads the first file from the designed dropzone and refreshes the inventory", async () => {
    resetFixtureState();
    const user = userEvent.setup();
    render(<HomePage />);

    const input = await screen.findByLabelText("Drop your materials here or choose a text or Markdown file") as HTMLInputElement;
    expect(input.parentElement?.classList.contains("dropzone")).toBe(true);
    await user.upload(input, new File(["# First evidence\nA cited fact."], "first-evidence.md", { type: "text/markdown" }));

    expect(await screen.findByText("first-evidence.md")).toBeTruthy();
    expect(screen.getByText("1 file")).toBeTruthy();
    expect(screen.getByText("Project state: materials ready")).toBeTruthy();
  });

  it("keeps the remove confirmation open when deletion fails", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    const workingFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { action?: string } : undefined;
      if (body?.action === "remove_material") return jsonResponse({ error: "Removal failed" }, 500);
      if (!workingFetch) throw new Error("Missing test fetch implementation");
      return workingFetch(input, init);
    });

    render(<HomePage />);
    await user.click(await screen.findByRole("button", { name: "Remove brief.md" }));
    await user.click(screen.getByRole("button", { name: "Remove file" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Removal failed");
    expect(screen.getByRole("alertdialog", { name: "Remove this source?" })).toBeTruthy();
  });

  it("retries an uncertain Agent action with the original command id", async () => {
    resetFixtureState();
    addFixtureMaterial({ name: "brief.md", mediaType: "text/markdown", text: "Atelier prepares client presentations." });
    const commandIds: string[] = [];
    let attempts = 0;
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return jsonResponse(readFixtureState());
      const body = JSON.parse(String(init.body)) as { action: string; commandId: string };
      if (body.action !== "run") return jsonResponse({ code: "INVALID_REQUEST", error: "Unexpected action", requestId: "unexpected" }, 400);
      commandIds.push(body.commandId);
      attempts += 1;
      if (attempts === 1) return jsonResponse({ code: "PERSISTENCE_ERROR", error: "connection reset", requestId: "request-1" }, 500);
      return jsonResponse(runFixtureAgent());
    });

    const user = userEvent.setup();
    render(<HomePage />);
    await user.click(await screen.findByRole("button", { name: /Run understanding agent/ }));
    await user.click(await screen.findByRole("button", { name: "Retry understanding" }));

    await screen.findByRole("heading", { name: "Find the story in the material." });
    expect(commandIds).toHaveLength(2);
    expect(commandIds[1]).toBe(commandIds[0]);
  });

  it("starts a new attempt only after explicitly retrying a confirmed timeout", async () => {
    const reviewed = readFixtureState();
    acceptFixture(reviewed.project.revision);
    const commandIds: string[] = [];
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return jsonResponse(readFixtureState());
      const body = JSON.parse(String(init.body));
      if (body.action !== "generate_positioning") throw new Error("Unexpected test action");
      commandIds.push(body.commandId);
      if (commandIds.length === 1) return jsonResponse({ code: "PROVIDER_TIMEOUT", error: "Positioning timed out.", requestId: "timeout" }, 504);
      return jsonResponse(generateFixturePositioning(body.expectedRevision));
    });
    const user = userEvent.setup();
    render(<HomePage />);
    await user.click(await screen.findByRole("button", { name: "Positioning" }));
    await user.click(screen.getByRole("button", { name: "Create positioning directions" }));
    await screen.findByRole("button", { name: "Retry positioning directions" });
    expect(commandIds).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Retry positioning directions" }));
    await waitFor(() => expect(commandIds).toHaveLength(2));
    expect(commandIds[1]).not.toBe(commandIds[0]);
  });
});

// These fixtures never open a browser or call a model.
describe("P1 steering and continuity", () => {
  beforeEach(() => {
    resetFixtureState();
    addFixtureMaterial({ name: "brief.md", mediaType: "text/markdown", text: "Atelier prepares client presentations." });
    const review = runFixtureAgent(); acceptFixture(review.project.revision); generateFixturePositioning();
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (!init?.method) return jsonResponse(readFixtureState());
      const body = JSON.parse(String(init.body));
      if (body.action === "apply_positioning") return jsonResponse(applyFixturePositioning(body.directionId, body.expectedRevision));
      if (body.action === "generate_deck") return jsonResponse(generateFixtureDeck(body.expectedRevision));
      return jsonResponse({ code: "INVALID_REQUEST", error: "Unexpected action", requestId: "unexpected" }, 400);
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  const posts = () => vi.mocked(fetch).mock.calls.filter(call => call[1]?.method === "POST").map(call => JSON.parse(String(call[1]?.body)));

  it("requires Apply for the preview and explicit deck confirmation, cancel sends nothing", async () => {
    const user = userEvent.setup(); render(<HomePage />);
    await user.click(await screen.findByRole("button", { name: "Positioning" }));
    await user.click(screen.getByRole("button", { name: "Keep original" }));
    await user.click(await screen.findByRole("button", { name: "Review deck inputs" }));
    await user.click(screen.getByRole("button", { name: "Cancel deck creation" }));
    expect(posts().map(body => body.action)).toEqual(["apply_positioning"]);
    const direction = readFixtureState().positioning!.proposal.directions[0]!;
    await user.click(screen.getByRole("button", { name: new RegExp(direction.title) }));
    expect(screen.queryByRole("button", { name: "Review deck inputs" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Use this direction" }));
    await user.click(await screen.findByRole("button", { name: "Review deck inputs" }));
    expect(screen.getByRole("region", { name: "Confirm deck generation" }).textContent).toContain(direction.title);
    await user.dblClick(screen.getByRole("button", { name: "Confirm & create deck" }));
    await screen.findByText("Discussion deck", { selector: ".eyebrow" });
    expect(posts().filter(body => body.action === "generate_deck")).toHaveLength(1);
  });

  it("keeps positioning adjustment and deck edits across destinations", async () => {
    const state = readFixtureState(); applyFixturePositioning(state.positioning!.proposal.directions[0]!.id, state.project.revision); generateFixtureDeck(state.project.revision);
    const user = userEvent.setup(); render(<HomePage />);
    await user.click(await screen.findByRole("button", { name: "Positioning" }));
    await user.type(screen.getByLabelText("Adjust this direction"), "My preferred framing");
    await user.click(screen.getByRole("button", { name: "Materials" }));
    await user.click(screen.getByRole("button", { name: "Positioning" }));
    expect((screen.getByLabelText("Adjust this direction") as HTMLTextAreaElement).value).toBe("My preferred framing");
    await user.click(screen.getByRole("button", { name: "Deck" }));
    await user.click(screen.getByRole("button", { name: /2\s*The shift/ }));
    await user.click(screen.getByRole("button", { name: "Edit this page" }));
    await user.clear(screen.getByLabelText("Page title")); await user.type(screen.getByLabelText("Page title"), "Unsaved title");
    await user.click(screen.getByRole("button", { name: "Materials" }));
    await user.click(screen.getByRole("button", { name: "Deck" }));
    expect((screen.getByLabelText("Page title") as HTMLInputElement).value).toBe("Unsaved title");
    expect(screen.getByRole("heading", { name: "The shift" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /2\s*The shift/ }).getAttribute("aria-current")).toBe("page");
    expect(posts()).toHaveLength(0);
  });
});

describe("P1 authoritative state boundaries", () => {
  afterEach(() => cleanup());
  const props = (state: ReturnType<typeof readFixtureState>) => ({ state, busy: false, text: "", answer: "", correction: "", onTextChange: vi.fn(), onAnswerChange: vi.fn(), onCorrectionChange: vi.fn(), onChooseFile: vi.fn(() => true), onCancelRun: vi.fn(), onAction: vi.fn(() => true) });
  const ready = () => {
    resetFixtureState(); addFixtureMaterial({ name: "brief.md", mediaType: "text/markdown", text: "Atelier prepares client presentations." });
    const reviewed = runFixtureAgent(); acceptFixture(reviewed.project.revision);
    const proposed = generateFixturePositioning(); return { ...applyFixturePositioning("original", proposed.project.revision), deck: undefined, deckVersions: [] };
  };
  it("invalidates an open confirmation after upstream state changes", async () => {
    const user = userEvent.setup(); const state = ready(); const input = props(state);
    const view = render(<WorkspaceView {...input} initialDestination="positioning" />);
    await user.click(screen.getByRole("button", { name: "Review deck inputs" }));
    view.rerender(<WorkspaceView {...input} state={{ ...state, positioning: { ...state.positioning!, appliedDirectionId: state.positioning!.proposal.directions[0]!.id } }} initialDestination="positioning" />);
    expect(screen.getByText(/Inputs changed/)).toBeTruthy();
    expect(view.container.querySelectorAll("#workspace .btn.primary")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Cancel deck creation" }).classList.contains("primary")).toBe(true);
    expect((screen.getByRole("button", { name: "Confirm & create deck" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Confirm & create deck" })); expect(input.onAction).not.toHaveBeenCalled();
  });
  it("keeps stopped generation labels distinct from mutation locks", () => {
    const state = ready(); state.positioning = undefined;
    const input = props(state);
    render(<WorkspaceView {...input} initialDestination="positioning" error={{ code: "INVALID_INPUT", message: "Review current input.", technicalMessage: "No supported claims", recovery: "review", outcomeUnknown: false }} />);
    const button = screen.getByRole("button", { name: "Create positioning directions" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryByText("Creating directions…")).toBeNull();
  });

  it("explains locked navigation and locks mutations after a persisted running refresh", async () => {
    const user = userEvent.setup(); const state = ready(); state.positioning = undefined;
    state.workflowRuns.push({ id: "running", kind: "positioning", status: "running", events: [] });
    const input = props(state); render(<WorkspaceView {...input} initialDestination="positioning" />);
    expect((screen.getByRole("button", { name: /Creating directions/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Next: compare directions/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Deck" }));
    expect(screen.getByText(/Apply a positioning direction, then create a deck draft/, { selector: ".navigationReason p" })).toBeTruthy();
    expect(input.onAction).not.toHaveBeenCalled();
  });
  it("does not accept a version over an unsaved answer and retains it when navigating", async () => {
    resetFixtureState(); addFixtureMaterial({ name: "brief.md", mediaType: "text/markdown", text: "Atelier prepares presentations." });
    const state = runFixtureAgent(); const input = { ...props(state), answer: "Unsaved answer" };
    const user = userEvent.setup(); const view = render(<WorkspaceView {...input} initialDestination="clarify" />);
    expect(view.container.querySelectorAll("#workspace .btn.primary")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /Accept version/ }));
    expect(screen.getByRole("region", { name: "Unsaved input" })).toBeTruthy();
    expect(input.onAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    await user.click(screen.getByRole("button", { name: "Materials" }));
    await user.click(screen.getByRole("button", { name: "Clarify" }));
    expect((screen.getByLabelText("Answer the agent’s question") as HTMLTextAreaElement).value).toBe("Unsaved answer");
  });
});
