import { describe, expect, it } from "vitest";
import type { AudioCapture, AudioGapInput } from "@rcc/shared";
import { AudioContinuity } from "../src/audio/AudioContinuity.js";

const SESSION = "session-1";

function capture(overrides: Partial<AudioCapture> = {}): AudioCapture {
  return {
    sessionId: SESSION,
    captureId: "capture-1",
    originTime: 0,
    startTime: 0,
    ...overrides,
  };
}

function setup(sessionId = SESSION) {
  const gaps: AudioGapInput[] = [];
  const continuity = new AudioContinuity(sessionId, (gap) => gaps.push(gap));
  return { continuity, gaps };
}

function position(cap: AudioCapture, seq: number, durationSec: number) {
  return { captureId: cap.captureId, seq, startTime: cap.startTime, durationSec };
}

describe("AudioContinuity", () => {
  it("accepts continuous frames without reporting a gap", () => {
    const { continuity, gaps } = setup();
    const first = capture();
    const second = capture({ startTime: 1 });
    const third = capture({ startTime: 2 });

    expect(continuity.accept(first, 0, 1)).toEqual(position(first, 0, 1));
    expect(continuity.accept(second, 1, 1)).toEqual(position(second, 1, 1));
    expect(continuity.accept(third, 2, 0.5)).toEqual(position(third, 2, 0.5));
    expect(gaps).toEqual([]);

    expect(
      continuity.end({
        sessionId: SESSION,
        captureId: "capture-1",
        originTime: 0,
        endTime: 2.5,
        nextSeq: 3,
      }),
    ).toBe(true);
    continuity.finishAt(10);
    expect(gaps).toEqual([]);
  });

  it("reports the missing head and a middle sequence jump as observed gaps", () => {
    const { continuity, gaps } = setup();
    const head = capture({ originTime: 10, startTime: 10.5 });

    expect(continuity.accept(head, 2, 1)).toEqual(position(head, 2, 1));
    expect(gaps).toEqual([
      {
        stage: "capture_backend",
        reason: "sequence_gap",
        certainty: "observed",
        startTime: 10,
        endTime: 10.5,
      },
    ]);

    const contiguous = capture({ originTime: 10, startTime: 11.5 });
    expect(continuity.accept(contiguous, 3, 1)).toEqual(position(contiguous, 3, 1));
    expect(gaps).toHaveLength(1);

    const jumped = capture({ originTime: 10, startTime: 13 });
    expect(continuity.accept(jumped, 5, 1)).toEqual(position(jumped, 5, 1));
    expect(gaps).toEqual([
      {
        stage: "capture_backend",
        reason: "sequence_gap",
        certainty: "observed",
        startTime: 10,
        endTime: 10.5,
      },
      {
        stage: "capture_backend",
        reason: "sequence_gap",
        certainty: "observed",
        startTime: 12.5,
        endTime: 13,
      },
    ]);
  });

  it("rejects duplicate, reversed and overlapping frames without emitting gaps", () => {
    const { continuity, gaps } = setup();

    expect(continuity.accept(capture(), 0, 1)).not.toBeNull();
    expect(continuity.accept(capture({ startTime: 1 }), 1, 1)).not.toBeNull();

    expect(continuity.accept(capture({ startTime: 2 }), 1, 1)).toBeNull();
    expect(continuity.accept(capture({ startTime: 2 }), 0, 1)).toBeNull();
    expect(continuity.accept(capture({ startTime: 1.5 }), 2, 1)).toBeNull();
    expect(gaps).toEqual([]);

    const next = capture({ startTime: 2 });
    expect(continuity.accept(next, 2, 1)).toEqual(position(next, 2, 1));
    expect(gaps).toEqual([]);
  });

  it("accepts a new capture after a normal pause with its sequence reset", () => {
    const { continuity, gaps } = setup();

    expect(continuity.accept(capture(), 0, 1)).not.toBeNull();
    expect(continuity.accept(capture({ startTime: 1 }), 1, 1)).not.toBeNull();

    const resumed = capture({ captureId: "capture-2", originTime: 5, startTime: 5 });
    const resumedNext = capture({ captureId: "capture-2", originTime: 5, startTime: 6 });
    expect(continuity.accept(resumed, 0, 1)).toEqual(position(resumed, 0, 1));
    expect(continuity.accept(resumedNext, 1, 1)).toEqual(position(resumedNext, 1, 1));
    expect(gaps).toEqual([]);
  });

  it("rejects a capture from another session", () => {
    const { continuity, gaps } = setup("session-1");
    const foreign = capture({ sessionId: "session-2" });

    expect(continuity.accept(foreign, 0, 1)).toBeNull();
    expect(gaps).toEqual([]);

    const local = capture();
    expect(continuity.accept(local, 0, 1)).toEqual(position(local, 0, 1));
    expect(gaps).toEqual([]);
  });

  it("reports a capture_tail gap when end() has more frames and time than were accepted", () => {
    const { continuity, gaps } = setup();

    expect(continuity.accept(capture(), 0, 1)).not.toBeNull();
    expect(continuity.accept(capture({ startTime: 1 }), 1, 1)).not.toBeNull();

    expect(
      continuity.end({
        sessionId: SESSION,
        captureId: "capture-1",
        originTime: 0,
        endTime: 2.5,
        nextSeq: 4,
      }),
    ).toBe(true);
    expect(gaps).toEqual([
      {
        stage: "capture_backend",
        reason: "capture_tail",
        certainty: "observed",
        startTime: 2,
        endTime: 2.5,
      },
    ]);
  });

  it("reports a whole capture that end() says arrived even though no frame was accepted", () => {
    const { continuity, gaps } = setup();

    expect(
      continuity.end({
        sessionId: SESSION,
        captureId: "capture-ghost",
        originTime: 20,
        endTime: 23.5,
        nextSeq: 3,
      }),
    ).toBe(true);
    expect(gaps).toEqual([
      {
        stage: "capture_backend",
        reason: "capture_tail",
        certainty: "observed",
        startTime: 20,
        endTime: 23.5,
      },
    ]);
  });

  it("treats a duplicate end() as idempotent and refuses late frames", () => {
    const { continuity, gaps } = setup();

    expect(continuity.accept(capture(), 0, 1)).not.toBeNull();
    expect(continuity.accept(capture({ startTime: 1 }), 1, 1)).not.toBeNull();
    const report = {
      sessionId: SESSION,
      captureId: "capture-1",
      originTime: 0,
      endTime: 2,
      nextSeq: 2,
    };

    expect(continuity.end(report)).toBe(true);
    expect(continuity.accept(capture({ startTime: 2 }), 2, 1)).toBeNull();
    expect(continuity.end(report)).toBe(true);
    expect(gaps).toEqual([]);
  });

  it("reports a possible transport gap at finishAt when nothing follows the loss", () => {
    const { continuity, gaps } = setup();

    expect(continuity.accept(capture(), 0, 1)).not.toBeNull();
    continuity.transportLost(1);
    expect(gaps).toEqual([]);

    continuity.finishAt(4);
    expect(gaps).toEqual([
      {
        stage: "capture_backend",
        reason: "transport_disconnect",
        certainty: "possible",
        startTime: 1,
        endTime: 4,
      },
    ]);
  });

  it("clears transport suspicion when the same capture resumes continuously", () => {
    const { continuity, gaps } = setup();

    expect(continuity.accept(capture(), 0, 1)).not.toBeNull();
    continuity.transportLost(1);

    const resumed = capture({ startTime: 1 });
    expect(continuity.accept(resumed, 1, 1)).toEqual(position(resumed, 1, 1));
    expect(gaps).toEqual([]);

    continuity.finishAt(4);
    expect(gaps).toEqual([]);
  });

  it("rejects invalid sequence and duration values without changing state", () => {
    const { continuity, gaps } = setup();

    expect(continuity.accept(capture(), -1, 1)).toBeNull();
    expect(continuity.accept(capture(), 1.5, 1)).toBeNull();
    expect(continuity.accept(capture(), Number.NaN, 1)).toBeNull();
    expect(continuity.accept(capture(), 0, 0)).toBeNull();
    expect(continuity.accept(capture(), 0, -1)).toBeNull();
    expect(continuity.accept(capture(), 0, Number.NaN)).toBeNull();
    expect(continuity.accept(capture(), 0, Number.POSITIVE_INFINITY)).toBeNull();
    expect(continuity.accept(capture({ startTime: -1 }), 0, 1)).toBeNull();
    expect(continuity.accept(capture({ originTime: Number.NaN }), 0, 1)).toBeNull();
    expect(continuity.accept(capture({ originTime: 5, startTime: 4 }), 0, 1)).toBeNull();
    expect(gaps).toEqual([]);

    const valid = capture();
    expect(continuity.accept(valid, 0, 1)).toEqual(position(valid, 0, 1));
    expect(gaps).toEqual([]);
  });
});
