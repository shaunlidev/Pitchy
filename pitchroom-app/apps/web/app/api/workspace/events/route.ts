import { readFixtureState } from "../../../../lib/fixture-store";
import { readPersistentState } from "../../../../lib/persistent-workspace";
import { workspaceEventSchema } from "../../../../lib/api-contract";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  let cursor = Number(request.headers.get("last-event-id") ?? "0");
  if (!Number.isFinite(cursor)) cursor = 0;
  const runtime = process.env.PITCHROOM_RUNTIME ?? "fixture";
  const read = async () => runtime === "fixture" ? readFixtureState() : readPersistentState(runtime === "live" ? "live" : "postgres-fake");
  const encode = (events: ReturnType<typeof workspaceEventSchema.parse>[]) => events.map((event) => `id: ${event.sequence}\nevent: workspace\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const initial = (await read()).events.filter((event) => event.sequence > cursor).map((event) => workspaceEventSchema.parse(event));
  if (new URL(request.url).searchParams.get("once") === "1") return new Response(encode(initial), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" } });
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const close = () => { if (!closed) { closed = true; controller.close(); } };
      const run = async () => {
        controller.enqueue(encoder.encode("retry: 2000\n\n"));
        for (const event of initial) { controller.enqueue(encoder.encode(encode([event]))); cursor = event.sequence; }
        const deadline = Date.now() + 25_000;
        while (!request.signal.aborted && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (request.signal.aborted || closed) break;
          const events = (await read()).events.filter((event) => event.sequence > cursor).map((event) => workspaceEventSchema.parse(event));
          for (const event of events) { controller.enqueue(encoder.encode(encode([event]))); cursor = event.sequence; }
        }
        close();
      };
      run().catch((error) => { if (!closed) controller.error(error); });
      request.signal.addEventListener("abort", close, { once: true });
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
