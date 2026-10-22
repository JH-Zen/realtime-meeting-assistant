import { useEffect, useRef } from "react";
import { livePartial, useSessionStore } from "../state/sessionStore";
import { formatClock } from "../format";

/**
 * Subtitles are the only consumer of `partial`. Nothing here is a knowledge input: the settled
 * lines are the finals the backend also persisted.
 */
export function SubtitlePanel() {
  const finals = useSessionStore((s) => s.finals);
  const partials = useSessionStore((s) => s.partials);
  const live = livePartial(partials);
  const body = useRef<HTMLDivElement>(null);
  /**
   * Whether the reader is at the bottom, which is what makes following them safe. Scrolling up in a
   * live transcript means "I am reading something above" — the previous behaviour yanked that reader
   * back down on every new line, so the only way to read a sentence was to stop the recording.
   */
  const atBottom = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the deps are new-line signals; the body only reads the scrolled container
  useEffect(() => {
    const el = body.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [finals.length, live]);

  return (
    <section className="panel">
      <h2>实时字幕</h2>
      <div
        className="panel__body subtitles"
        ref={body}
        onScroll={(event) => {
          const el = event.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {finals.map((segment) => (
          <p key={segment.id} className="subtitle">
            <span className="subtitle__clock">{formatClock(segment.startTime)}</span>
            <span>{segment.text}</span>
          </p>
        ))}
        {live && (
          <p className="subtitle subtitle--live">
            <span className="subtitle__clock">··</span>
            <span>{live}</span>
          </p>
        )}
        {finals.length === 0 && !live && <p className="empty">等待语音输入。</p>}
      </div>
    </section>
  );
}
