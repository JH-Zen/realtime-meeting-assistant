#!/usr/bin/env python3
"""Local streaming STT service — design doc §16, Phase 5.

Runs k2-fsa/sherpa-onnx's `OnlineRecognizer` exactly as published (no fork, no patched source) and
wraps it in the WebSocket protocol the backend's `SherpaSTTProvider` speaks, so no Node module ever
sees a sherpa type. Rule 1 puts a mature engine here; this file is transport plus segment
accounting, which is all the project adds.

Protocol (version 1)
  client -> worker   binary frame = PCM s16le mono @ sampleRate; text frame = JSON control
                     {"type":"flush"}  end the current utterance and emit its final
                     {"type":"ping"}   -> {"type":"pong"}
  worker -> client   {"type":"ready","protocol":1,"sampleRate":..,"model":..,"endpoint":{..}}
                     {"type":"partial","seq":n,"text":..,"startSec":..,"endSec":..}
                     {"type":"final",  "seq":n,"text":..,"startSec":..,"endSec":..}
                     {"type":"error","code":..,"message":..}
                     {"type":"pong"}

`seq` is monotonic per connection, and a partial shares its `seq` with the final that supersedes it —
that is what lets the backend key its display buffer and de-duplicate persisted finals by id.
Times are seconds of audio received since the connection began, the same speech-relative clock the
mock provider and the `[mm:ss]` citations use. A segment starts at the previous endpoint, not at the
recogniser's own `start_time(stream)`: measured on 1.13.8 that value can run ahead of the audio fed
so far, which would cite a segment at a time later than its own end.

Exactly one client at a time: the recogniser holds one decode context, and the backend already
allows exactly one recording, so a second socket is refused rather than silently interleaving two
speakers into one transcript.
"""

from __future__ import annotations

import argparse
import array
import asyncio
import json
import sys
import time
import wave
from pathlib import Path

import sherpa_onnx
import websockets

PROTOCOL_VERSION = 1
BYTES_PER_FRAME = 2  # mono s16le


class SegmentClock:
    """Speech-relative clock: how much audio has been fed, and where the current segment began."""

    def __init__(self, sample_rate: int) -> None:
        self.sample_rate = sample_rate
        self.samples = 0
        self.segment_start_sec = 0.0

    def advance(self, sample_count: int) -> None:
        self.samples += sample_count

    @property
    def now_sec(self) -> float:
        return self.samples / self.sample_rate

    def begin_segment(self) -> None:
        self.segment_start_sec = self.now_sec

    def segment(self, seq: int, kind: str, text: str) -> dict:
        return {
            "type": kind,
            "seq": seq,
            "text": text,
            "startSec": round(self.segment_start_sec, 3),
            # The end is where the audio got to, so an endpoint's trailing silence is inside the
            # segment. Coarse but monotone, which is what the MindMap window and `[mm:ss]` need.
            "endSec": round(max(self.now_sec, self.segment_start_sec), 3),
        }


def pcm16_to_float32(raw: bytes) -> array.array:
    samples = array.array("h")
    samples.frombytes(raw[: len(raw) - (len(raw) % BYTES_PER_FRAME)])
    # s16 -> [-1, 1), the scaling sherpa's own examples use.
    return array.array("f", (value / 32768.0 for value in samples))


def resolve_model_paths(args: argparse.Namespace) -> None:
    """Fill the file arguments from `--model-dir` using sherpa-onnx's own naming convention.

    Operators should be able to point the worker at a downloaded model directory, not at six paths;
    int8 files win because that is the build measured to hold realtime on this machine.
    """
    if not args.model_dir:
        return
    root = Path(args.model_dir)

    def pick(pattern: str) -> str:
        candidates = sorted(root.glob(pattern))
        quantised = [c for c in candidates if ".int8." in c.name]
        chosen = quantised or candidates
        return str(chosen[0]) if chosen else ""

    args.tokens = args.tokens or pick("tokens.txt")
    args.encoder = args.encoder or pick("encoder*.onnx")
    args.decoder = args.decoder or pick("decoder*.onnx")
    args.joiner = args.joiner or pick("joiner*.onnx")
    if not (args.encoder and args.decoder and args.joiner):
        args.encoder = args.decoder = args.joiner = ""
        args.ctc = args.ctc or pick("model*.onnx")
    args.bpe_vocab = args.bpe_vocab or pick("bpe.vocab")
    if not args.modeling_unit:
        args.modeling_unit = "cjkchar+bpe" if args.bpe_vocab else "cjkchar"


def validate_model_paths(args: argparse.Namespace) -> None:
    transducer = args.encoder and args.decoder and args.joiner
    if args.tokens and (transducer or args.ctc):
        return
    raise SystemExit(
        "no usable model: pass --model-dir or --tokens with --encoder/--decoder/--joiner (transducer) "
        f"or --ctc (single-file CTC). Got tokens={args.tokens or '-'} ctc={args.ctc or '-'} "
        f"transducer={'yes' if transducer else 'no'}"
    )


def build_recognizer(args: argparse.Namespace) -> sherpa_onnx.OnlineRecognizer:
    common = dict(
        provider="cpu",
        num_threads=args.num_threads,
        sample_rate=args.sample_rate,
        enable_endpoint_detection=True,
        rule1_min_trailing_silence=args.rule1,
        rule2_min_trailing_silence=args.rule2,
        rule3_min_utterance_length=args.rule3,
        decoding_method=args.decoding_method,
        debug=args.debug,
    )
    if args.ctc:
        # The CTC entry point takes no beam width: it decodes greedily by construction.
        return sherpa_onnx.OnlineRecognizer.from_zipformer2_ctc(tokens=args.tokens, model=args.ctc, **common)
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=args.tokens,
        encoder=args.encoder,
        decoder=args.decoder,
        joiner=args.joiner,
        bpe_vocab=args.bpe_vocab,
        modeling_unit=args.modeling_unit,
        max_active_paths=args.max_active_paths,
        **common,
    )


class Session:
    """One connection's decode state. `emit` is how it talks to whoever owns it."""

    def __init__(self, recognizer: sherpa_onnx.OnlineRecognizer, args: argparse.Namespace, emit) -> None:
        self.recognizer = recognizer
        self.args = args
        self.emit = emit
        self.clock = SegmentClock(args.sample_rate)
        self.stream = recognizer.create_stream()
        self.finals = 0
        self.last_partial = ""

    async def feed(self, raw: bytes) -> None:
        samples = pcm16_to_float32(raw)
        if len(samples) == 0:
            return
        self.stream.accept_waveform(self.args.sample_rate, samples)
        self.clock.advance(len(samples))
        # Decode runs on the loop thread. At the measured RTF this is a few ms per 100 ms chunk and
        # there is exactly one client, so a thread hop would cost more than it saves.
        while self.recognizer.is_ready(self.stream):
            self.recognizer.decode_stream(self.stream)
        text = self.recognizer.get_result(self.stream).strip()
        seq = self.finals + 1
        # Only a changed hypothesis deserves a frame: the recogniser is polled on every audio chunk,
        # and re-emitting the same partial would put dead traffic on the bus and the subtitles.
        if text and text != self.last_partial:
            self.last_partial = text
            await self.emit(self.clock.segment(seq, "partial", text))
        if self.recognizer.is_endpoint(self.stream):
            await self.close_utterance(seq)

    async def flush(self) -> None:
        """End the recording: pop the final hypothesis instead of waiting for silence that never comes."""
        if self.clock.now_sec > self.clock.segment_start_sec:
            # The upstream online-decode example supplies 0.66 s of right context before input_finished.
            # Without it a clipped stop loses spoken tail words. Padding is decoder context only and
            # must not advance the clock that represents audio actually accepted from the microphone.
            self.stream.accept_waveform(self.args.sample_rate, array.array("f", [0.0]) * int(0.66 * self.args.sample_rate))
        self.stream.input_finished()
        while self.recognizer.is_ready(self.stream):
            self.recognizer.decode_stream(self.stream)
        await self.close_utterance(self.finals + 1)
        # `input_finished` marks this stream as spent, so the next recording needs a new one.
        self.stream = self.recognizer.create_stream()
        self.last_partial = ""

    async def close_utterance(self, seq: int) -> None:
        text = self.recognizer.get_result(self.stream).strip()
        # An endpoint with nothing in it is silence, and silence must not become a stored segment:
        # Transcript Core would persist an empty final and MindMap would count it toward its window.
        if text:
            self.finals += 1
            await self.emit(self.clock.segment(seq, "final", text))
        self.recognizer.reset(self.stream)
        self.last_partial = ""
        self.clock.begin_segment()


def ready_message(args: argparse.Namespace) -> dict:
    return {
        "type": "ready",
        "protocol": PROTOCOL_VERSION,
        "sampleRate": args.sample_rate,
        "model": args.model_name,
        "provider": "cpu",
        "numThreads": args.num_threads,
        "endpoint": {"rule1": args.rule1, "rule2": args.rule2, "rule3": args.rule3},
    }


async def serve(recognizer: sherpa_onnx.OnlineRecognizer, args: argparse.Namespace) -> None:
    active: Session | None = None

    async def handler(connection) -> None:
        nonlocal active
        if active is not None:
            await connection.send(json.dumps({"type": "error", "code": "busy",
                                              "message": "another STT client is already connected"}))
            await connection.close()
            return
        session = Session(recognizer, args, lambda payload: connection.send(json.dumps(payload, ensure_ascii=False)))
        active = session
        try:
            await connection.send(json.dumps(ready_message(args), ensure_ascii=False))
            print(f"[stt] client connected — {args.model_name}", flush=True)
            async for message in connection:
                if isinstance(message, (bytes, bytearray)):
                    await session.feed(bytes(message))
                    continue
                control = json.loads(message)
                if control.get("type") == "flush":
                    await session.flush()
                    await connection.send(json.dumps({"type": "flushed", "finals": session.finals}))
                elif control.get("type") == "ping":
                    await connection.send(json.dumps({"type": "pong"}))
        except websockets.ConnectionClosed:
            pass
        finally:
            active = None
            print("[stt] client disconnected", flush=True)

    # The managed Node backend and command-line tools send no Origin. Browsers must use the protected
    # application backend, rather than occupy this single-client decoder directly from another page.
    async with websockets.serve(handler, args.host, args.port, origins=[None], max_size=4 * 1024 * 1024) as server:
        port = server.sockets[0].getsockname()[1]
        print(f"[stt] listening ws://{args.host}:{port} model={args.model_name} threads={args.num_threads} provider=cpu", flush=True)
        await asyncio.Future()


def resample(raw: bytes, source_rate: int, target_rate: int) -> bytes:
    if source_rate <= 0 or target_rate <= 0:
        raise ValueError("sample rates must be positive")
    if source_rate == target_rate:
        return raw
    samples = array.array("h")
    samples.frombytes(raw)
    # Linear interpolation exists only so an 8 kHz test clip can be replayed; the microphone path
    # never lands here, because the AudioWorklet resamples before it encodes.
    out = array.array("h", [0]) * int(len(samples) * target_rate / source_rate)
    step = source_rate / target_rate
    for index in range(len(out)):
        position = index * step
        lower = int(position)
        upper = min(lower + 1, len(samples) - 1)
        weight = position - lower
        out[index] = int(samples[lower] * (1 - weight) + samples[upper] * weight)
    return out.tobytes()


async def selftest(recognizer: sherpa_onnx.OnlineRecognizer, args: argparse.Namespace) -> None:
    """Feed a wav as if it were a live microphone and print every message the backend would receive."""
    with wave.open(args.selftest, "rb") as reader:
        if reader.getnchannels() != 1 or reader.getsampwidth() != 2:
            raise SystemExit("selftest wav must be mono 16-bit PCM")
        rate = reader.getframerate()
        emitted: list[dict] = []

        async def emit(payload: dict) -> None:
            emitted.append(payload)
            print(json.dumps(payload, ensure_ascii=False), flush=True)

        session = Session(recognizer, args, emit)
        await emit(ready_message(args))
        chunk_frames = max(1, int(rate * args.chunk_ms / 1000))
        wall_start = time.monotonic()
        frames = 0
        while True:
            raw = reader.readframes(chunk_frames)
            if not raw:
                break
            frames += len(raw) // BYTES_PER_FRAME
            await session.feed(resample(raw, rate, args.sample_rate))
            if args.speed > 0:
                due = wall_start + frames / rate / args.speed
                delay = due - time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
        await session.flush()
        audio_sec = frames / rate
        wall_sec = time.monotonic() - wall_start
        await emit({
            "type": "summary",
            "audioSec": round(audio_sec, 3),
            "wallSec": round(wall_sec, 3),
            "rtf": round(wall_sec / audio_sec, 4) if audio_sec > 0 else None,
            "finals": session.finals,
            "messages": len(emitted),
        })


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="sherpa-onnx streaming STT worker")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=6006)
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--num-threads", type=int, default=4)
    parser.add_argument("--model-name", default="")
    parser.add_argument("--model-dir", default="", help="a downloaded sherpa-onnx model directory")
    parser.add_argument("--tokens", default="")
    parser.add_argument("--encoder", default="")
    parser.add_argument("--decoder", default="")
    parser.add_argument("--joiner", default="")
    parser.add_argument("--ctc", default="", help="single-file zipformer2-CTC model; overrides the transducer")
    parser.add_argument("--bpe-vocab", default="")
    parser.add_argument("--modeling-unit", default="", help="cjkchar | bpe | cjkchar+bpe; empty = detect")
    parser.add_argument("--decoding-method", default="greedy_search")
    parser.add_argument("--max-active-paths", type=int, default=4)
    parser.add_argument("--rule1", type=float, default=2.0, help="trailing silence (s) that ends a long utterance")
    parser.add_argument("--rule2", type=float, default=0.8, help="trailing silence (s) after any token -> final")
    parser.add_argument("--rule3", type=float, default=20.0, help="hard cap (s) on one utterance")
    parser.add_argument("--chunk-ms", type=int, default=100, help="selftest only")
    parser.add_argument("--speed", type=float, default=0.0, help="selftest realtime factor; 0 = as fast as possible")
    parser.add_argument("--selftest", default="", help="wav to stream through the recognizer instead of serving")
    parser.add_argument("--debug", action="store_true")
    return parser.parse_args(argv)


def main() -> None:
    # A Windows console starts on a legacy codepage, which would print every Chinese transcript as
    # mojibake. The WebSocket path sends UTF-8 JSON regardless; this only fixes what an operator sees.
    sys.stdout.reconfigure(encoding="utf-8")
    args = parse_args(sys.argv[1:])
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("STT worker must listen on a loopback address")
    if not 0 <= args.port <= 65535 or args.num_threads < 1 or args.sample_rate < 1:
        raise SystemExit("Invalid port, thread count, or sample rate")
    resolve_model_paths(args)
    validate_model_paths(args)
    args.model_name = args.model_name or Path(args.model_dir or args.tokens).name
    recognizer = build_recognizer(args)
    if args.selftest:
        asyncio.run(selftest(recognizer, args))
    else:
        try:
            asyncio.run(serve(recognizer, args))
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
