import type { ServerEvent } from "@rcc/shared";
import { useGraphStore } from "../state/graphStore";
import { belongsToSession, useSessionStore } from "../state/sessionStore";

/**
 * One place decides which store a validated frame writes to. The graph reducer is shared with the
 * backend, so `mindmap.updated` is the only path that can change the tree on screen.
 */
export function dispatchEvent(event: ServerEvent): void {
  const graph = useGraphStore.getState();
  const session = useSessionStore.getState();
  if (!belongsToSession(event, session.sessionId)) return;

  if ((event.kind === "recording.started" && event.sessionId !== session.sessionId) ||
      (event.kind === "session.snapshot" && ((event.sessionId ?? null) !== session.sessionId || event.state === "idle"))) {
    graph.reset();
  }

  switch (event.kind) {
    case "graph.snapshot":
      graph.hydrate(event.nodes, event.edges, event.positions);
      break;
    case "mindmap.updated":
      graph.applyOps(event.operations);
      break;
    default:
      break;
  }

  session.apply(event);
}
