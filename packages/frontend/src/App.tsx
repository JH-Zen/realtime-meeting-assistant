import { useEffect } from "react";
import { AskAiPanel } from "./components/AskAiPanel";
import { DebugPanel } from "./components/DebugPanel";
import { MindMapView } from "./components/MindMapView";
import { RecordingControls } from "./components/RecordingControls";
import { SubtitlePanel } from "./components/SubtitlePanel";
import { RetrievalRecovery } from "./components/RetrievalRecovery";
import { AudioGaps } from "./components/AudioGaps";
import { RecoveryTasks } from "./components/RecoveryTasks";
import { connect, disconnect } from "./net/connection";
import { useSessionStore } from "./state/sessionStore";
import { API_BASE, WS_URL } from "./config";
import { authorizeBrowser } from "./net/api";
import { stopAllMicrophones } from "./audio/microphone";

/**
 * §42: the map is the primary surface and gets the wider pane; subtitles and Q&A share the
 * secondary column so asking a question never takes the user away from the growing graph.
 */
export function App() {
  const recording = useSessionStore((s) => s.recording);

  useEffect(() => {
    connect(WS_URL, () => authorizeBrowser(API_BASE));
    return disconnect;
  }, []);

  useEffect(() => {
    const prepare = () => { stopAllMicrophones(); disconnect(); };
    const unsubscribe = window.rccDesktop?.onPrepareQuit(prepare);
    window.addEventListener("beforeunload", prepare);
    return () => { unsubscribe?.(); window.removeEventListener("beforeunload", prepare); };
  }, []);

  useEffect(() => {
    window.rccDesktop?.setCaptureActive(recording === "recording" || recording === "paused");
  }, [recording]);

  return (
    <div className="app">
      <RecordingControls />
      <RetrievalRecovery />
      <RetrievalRecovery mode="mindmap" />
      <AudioGaps />
      <RecoveryTasks />
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
