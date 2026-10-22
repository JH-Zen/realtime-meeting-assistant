import { useEffect } from "react";
import { AskAiPanel } from "./components/AskAiPanel";
import { DebugPanel } from "./components/DebugPanel";
import { MindMapView } from "./components/MindMapView";
import { RecordingControls } from "./components/RecordingControls";
import { SubtitlePanel } from "./components/SubtitlePanel";
import { connect, disconnect } from "./net/connection";
import { loadHistoryAnswers } from "./net/sessionFile";
import { useSessionStore } from "./state/sessionStore";
import { WS_URL } from "./config";

/**
 * §42: the map is the primary surface and gets the wider pane; subtitles and Q&A share the
 * secondary column so asking a question never takes the user away from the growing graph.
 */
export function App() {
  const recording = useSessionStore((s) => s.recording);
  const sessionId = useSessionStore((s) => s.sessionId);

  useEffect(() => {
    connect(WS_URL);
    return disconnect;
  }, []);

  // A history opened from a file carries answers the socket cannot replay, so they are read back out of
  // the store. A live recording needs none of this: its bubbles are the ones being streamed now.
  useEffect(() => {
    if (recording === "viewing" && sessionId) void loadHistoryAnswers(sessionId);
  }, [recording, sessionId]);

  return (
    <div className="app">
      <RecordingControls />
      <main className="app__body">
        <section className="app__map">
          <MindMapView />
        </section>
        <aside className="app__side">
          <SubtitlePanel />
          <AskAiPanel />
        </aside>
      </main>
      <DebugPanel />
    </div>
  );
}
