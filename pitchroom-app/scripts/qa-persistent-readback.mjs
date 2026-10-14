const baseUrl = process.env.PITCHROOM_BASE_URL ?? "http://127.0.0.1:3001";
const response = await fetch(`${baseUrl}/api/workspace`);
if (!response.ok) throw new Error(`Workspace GET failed after restart: ${response.status}`);
const state = await response.json();
if (state.mode !== "postgres-fake" || state.project.phase !== "accepted" || state.versions.length !== 2) throw new Error(`Persistent restart readback failed: ${JSON.stringify({ mode: state.mode, phase: state.project?.phase, versions: state.versions?.length })}`);
console.log(JSON.stringify({ status: "PASS", restartReadback: true, projectId: state.project.id, phase: state.project.phase, versions: state.versions.length, events: state.events.length }, null, 2));
