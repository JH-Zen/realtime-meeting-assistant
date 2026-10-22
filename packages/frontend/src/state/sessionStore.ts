import { create } from "zustand";
import type { ModuleError, ServerEvent, SttConnection, TranscriptSegment } from "@rcc/shared";

export type LinkState = "connecting" | "open" | "closed";
/** `viewing` is a history opened from an exported file: askable, but not something this tab records. */
export type RecordingState = "idle" | "recording" | "paused" | "viewing";

export interface Citation {
  transcriptId: string;
  startTime: number;
}

export interface Answer {
  questionId: string;
  question: string;
  text: string;
  done: boolean;
  degraded: boolean;
  /** Set instead of `text` when the server refused to answer, so the bubble never hangs. */
  reject?: { reason: "busy" | "rate_limited"; message: string; retryAfterMs: number };
  ttftMs?: number;
  durationMs?: number;
  startedAt?: number;
  citations: Citation[];
}

/**
 * Everything the panels show is a projection of validated server events. The client never holds a
 * second copy of the graph: subtitles, recording state and answers live here, the tree lives in
 * `graphStore`, and both only change through `apply`.
 */
interface SessionStore {
  link: LinkState;
  /** Dials that have failed since the last good connection; the badge says which one this is. */
  reconnectAttempts: number;
  sessionId: string | null;
  recording: RecordingState;
  elapsedSec: number;
  stt: { state: SttConnection; attempts: number; message: string | null };
  /** Only `final` segments land here; partials go to their own display-only map. */
  finals: TranscriptSegment[];
  partials: Record<string, string>;
  errors: ModuleError[];
  bufferedSkips: number;
  answers: Answer[];
  /** When each question was sent, so time-to-first-token is measured from the user's keypress. */
  askedAt: Record<string, number>;
  /** Frames that failed schema validation. Counted, never applied (§48). */
  droppedFrames: number;
  apply(event: ServerEvent): void;
  setLink(link: LinkState, attempts?: number): void;
  noteDroppedFrame(): void;
  ask(questionId: string, text: string): void;
  /** The Q&A a session already recorded, as finished bubbles (§13 OPEN-10). */
  setHistoryAnswers(answers: Answer[]): void;
  clearErrors(): void;
}

export const useSessionStore = create<SessionStore>()((set, get) => ({
  link: "connecting",
  reconnectAttempts: 0,
  sessionId: null,
  recording: "idle",
  elapsedSec: 0,
  stt: { state: "idle", attempts: 0, message: null },
  finals: [],
  partials: {},
  errors: [],
  bufferedSkips: 0,
  droppedFrames: 0,
  answers: [],
  askedAt: {},

  apply: (event) => {
    switch (event.kind) {
      case "session.snapshot": {
        // The snapshot frame is what every (re)connect begins with. Anything still unanswered here has
        // lost its stream — the server replays transcripts and graphs, never answers — so close it
        // instead of spinning forever. A token that does arrive later still heals the bubble.
        const answers = get().answers.map((answer) => (answer.done ? answer : { ...answer, done: true }));
        set({
          sessionId: event.sessionId ?? null,
          recording: event.state,
          elapsedSec: event.elapsedSec,
          stt: { state: event.stt, attempts: 0, message: null },
          answers,
        });
        return;
      }
      case "graph.snapshot":
      case "mindmap.node.upserted":
        return;
      case "transcript.snapshot":
        set({ finals: event.segments, partials: {} });
        return;
      case "recording.started":
        set({
          sessionId: event.sessionId,
          recording: "recording",
          elapsedSec: 0,
          finals: [],
          partials: {},
          answers: [],
          askedAt: {},
        });
        return;
      case "recording.paused":
        set({ recording: "paused", elapsedSec: event.elapsedSec });
        return;
      case "recording.resumed":
        set({ recording: "recording", elapsedSec: event.elapsedSec });
        return;
      case "recording.stopped":
        set({ recording: "idle", elapsedSec: event.durationSec });
        return;
      case "stt.status": {
        // A recogniser that went away cannot finish the utterance it was mid-way through: the worker
        // re-bases its segment ids on every connection, so that partial would never meet its final and
        // would stay on screen as the live line — speech still being heard, minutes after it stopped.
        const gone = event.state === "reconnecting" || event.state === "failed";
        set({
          stt: { state: event.state, attempts: event.attempts, message: event.message ?? null },
          partials: gone ? {} : get().partials,
        });
        return;
      }
      case "transcript.partial":
        set({ partials: { ...get().partials, [event.segment.id]: event.segment.text } });
        return;
      case "transcript.final": {
        const partials = { ...get().partials };
        delete partials[event.segment.id];
        set({ finals: [...get().finals, event.segment], partials });
        return;
      }
      case "mindmap.skipped":
        set({ bufferedSkips: get().bufferedSkips + event.bufferedSegmentCount });
        return;
      case "summary.updated":
        return;
      case "answer.started":
        set({ answers: upsertAnswer(get().answers, event.questionId, {}) });
        return;
      case "answer.token":
        set({
          answers: upsertAnswer(get().answers, event.questionId, {
            text: event.text,
            ttftMs: event.ttftMs,
            startedAt: get().askedAt[event.questionId] ?? Date.now(),
          }),
        });
        return;
      case "answer.completed":
        set({
          answers: upsertAnswer(get().answers, event.questionId, {
            text: event.text,
            done: true,
            degraded: event.degraded,
            citations: event.citations,
            durationMs: event.durationMs,
          }),
          askedAt: forgetAsked(get().askedAt, event.questionId),
        });
        return;
      case "answer.rejected":
        // Admission control said no. Close the question, and say why — a spinner that never ends is
        // worse than a refusal the user can read.
        set({
          answers: upsertAnswer(get().answers, event.questionId, {
            done: true,
            reject: { reason: event.reason, message: event.message, retryAfterMs: event.retryAfterMs },
          }),
          askedAt: forgetAsked(get().askedAt, event.questionId),
        });
        return;
      case "module.error":
        set({ errors: [...get().errors, event].slice(-20) });
        return;
    }
  },

  setLink: (link, attempts = get().reconnectAttempts) => set({ link, reconnectAttempts: attempts }),

  noteDroppedFrame: () => set({ droppedFrames: get().droppedFrames + 1 }),

  // The client stamps the ask time: time-to-first-token is a client-side perception metric (§47).
  ask: (questionId, text) =>
    set({
      askedAt: { ...get().askedAt, [questionId]: Date.now() },
      answers: upsertAnswer(get().answers, questionId, { question: text }),
    }),

  // A session switch has no question in flight, so the ask times go with the answers they belonged to.
  setHistoryAnswers: (answers) => set({ answers, askedAt: {} }),

  clearErrors: () => set({ errors: [], bufferedSkips: 0 }),
}));

function upsertAnswer(answers: Answer[], questionId: string, patch: Partial<Answer>): Answer[] {
  const existing = answers.find((answer) => answer.questionId === questionId);
  if (existing) {
    return answers.map((answer) =>
      answer.questionId === questionId ? { ...answer, ...patch, question: patch.question ?? answer.question } : answer,
    );
  }
  return [...answers, { questionId, question: "", text: "", done: false, degraded: false, citations: [], ...patch }];
}

/** The in-flight line a subtitle panel shows on top of the settled transcript. */
export function livePartial(partials: Record<string, string>): string {
  const values = Object.values(partials);
  return values.length === 0 ? "" : values[values.length - 1] ?? "";
}

/**
 * The ask time only has to outlive the first token, so a settled answer drops it. Returning the same
 * object when there is nothing to forget keeps this off the subscribers' rerender path.
 */
function forgetAsked(askedAt: Record<string, number>, questionId: string): Record<string, number> {
  if (!(questionId in askedAt)) return askedAt;
  const rest = { ...askedAt };
  delete rest[questionId];
  return rest;
}
