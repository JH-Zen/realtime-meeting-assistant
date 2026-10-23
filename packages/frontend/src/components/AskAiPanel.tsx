import { useEffect, useState } from "react";
import { useSessionStore } from "../state/sessionStore";
import { sendCommand } from "../net/connection";
import { formatClock, answerBody } from "../format";

/**
 * Asking never touches the recording path: the question leaves as one command and the answer
 * streams back over the same socket the subtitles use. There is nothing to ask about before a
 * recording exists, so the panel waits for one rather than sending a question that cannot be
 * answered. The panel renders four endings, and they must stay distinguishable: a gate refusal, a
 * model failure, an answer lost to an outage, and a question still in flight.
 */
export function AskAiPanel() {
  const [draft, setDraft] = useState("");
  const link = useSessionStore((s) => s.link);
  const recording = useSessionStore((s) => s.recording);
  const answers = useSessionStore((s) => s.answers);
  const sessionId = useSessionStore((s) => s.sessionId);
  const ask = useSessionStore((s) => s.ask);
  const idle = recording === "idle";
  // biome-ignore lint/correctness/useExhaustiveDependencies: selection is the reset trigger
  useEffect(() => { setDraft(""); }, [sessionId]);

  const submit = () => {
    const text = draft.trim();
    if (!text || idle || !sessionId) return;
    const questionId = crypto.randomUUID();
    if (!sendCommand({ cmd: "question.ask", sessionId, questionId, text })) return;
    ask(questionId, text);
    setDraft("");
  };

  return (
    <section className="panel">
      <h2>问答</h2>
      <div className="ask">
        <textarea
          value={draft}
          rows={2}
          placeholder={recording === "viewing" ? "就当前会议的已保存内容提问" : "就刚才的内容提问，录音不会中断"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
          }}
        />
        <button type="button" onClick={submit} disabled={link !== "open" || idle || draft.trim() === ""}>
          提问
        </button>
      </div>
      {idle && <p className="notice">先开始记录，或从“本机会议”打开已保存的内容，再进行提问。</p>}
      <div className="panel__body answers">
        {answers.length === 0 && !idle && <p className="empty">还没有提问。</p>}
        {answers.map((answer) => {
          const body = answerBody(answer);
          return (
            <article key={answer.questionId} className="answer">
              <p className="answer__q">{answer.question}</p>
              <p className="answer__a">
                {body.tone === "answer" ? (
                  body.text
                ) : (
                  <span className={body.tone === "notice" ? "notice" : "empty"}>{body.text}</span>
                )}
                {!answer.done && <span className="cursor">▍</span>}
              </p>
              {(answer.ttftMs !== undefined || answer.citations.length > 0) && (
                <footer className="answer__meta">
                  {answer.ttftMs !== undefined && <span>首 token {answer.ttftMs}ms</span>}
                  {answer.durationMs !== undefined && <span>总耗时 {answer.durationMs}ms</span>}
                  {answer.degraded && <span className="tag-bad">降级</span>}
                  {answer.citations.map((citation) => (
                    <span key={citation.transcriptId} className="citation">
                      [{formatClock(citation.startTime)}]
                    </span>
                  ))}
                </footer>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
