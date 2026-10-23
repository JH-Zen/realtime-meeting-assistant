"""Measure the selected real CPU model on pinned upstream speech, without a microphone or paid API."""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import statistics
import sys
import time
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services/stt-worker"))
import stt_worker as worker


async def recognize(recognizer, args, path: Path) -> dict:
    events = []

    async def emit(event):
        events.append(event)

    session = worker.Session(recognizer, args, emit)
    with wave.open(str(path), "rb") as reader:
        if reader.getnchannels() != 1 or reader.getsampwidth() != 2:
            raise ValueError("Expected mono PCM16 test file")
        rate = reader.getframerate()
        audio_sec = reader.getnframes() / rate
        chunk = max(1, rate // 10)
        started = time.perf_counter()
        while raw := reader.readframes(chunk):
            await session.feed(worker.resample(raw, rate, args.sample_rate))
        await session.flush()
        elapsed = time.perf_counter() - started
    finals = [event for event in events if event["type"] == "final"]
    if not finals:
        raise AssertionError(f"Real recognizer returned no finals for {path.name}")
    return {"file": path.name, "sourceRate": rate, "audioSec": audio_sec, "acceptedAudioSec": session.clock.now_sec, "decodeSec": round(elapsed, 4), "rtf": round(elapsed / audio_sec, 4), "firstPartialAtAudioSec": next((event["endSec"] for event in events if event["type"] == "partial"), None), "finalText": " ".join(event["text"] for event in finals), "finalEndSec": finals[-1]["endSec"], "finals": len(finals)}


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=r"D:\Apps\实时会议助手-STT-CPU")
    parser.add_argument("--output", required=True)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--threads", default="1,2,4")
    options = parser.parse_args()
    model = Path(options.root) / "models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"
    result = {"provider": "cpu", "model": model.name, "python": sys.version.split()[0], "sherpaOnnx": worker.sherpa_onnx.__version__, "hardwareMicrophone": "not-tested", "accuracyBenchmark": "not-performed", "runs": [], "summary": []}
    try:
        for threads in map(int, options.threads.split(",")):
            args = worker.parse_args(["--model-dir", str(model), "--num-threads", str(threads)])
            worker.resolve_model_paths(args)
            worker.validate_model_paths(args)
            loaded_at = time.perf_counter()
            recognizer = worker.build_recognizer(args)
            load_sec = time.perf_counter() - loaded_at
            for round_index in range(options.rounds):
                for name in ["0.wav", "1.wav", "2.wav", "3.wav", "8k.wav"]:
                    record = await recognize(recognizer, args, model / "test_wavs" / name)
                    record.update(threads=threads, round=round_index + 1)
                    result["runs"].append(record)
                    if name == "1.wav":
                        assert "ALWAYS" in record["finalText"].upper(), "Bilingual fixture lost the English word"
                        assert "什么意思" in record["finalText"], "The recognizer lost the spoken tail at stop"
                    assert abs(record["acceptedAudioSec"] - record["audioSec"]) < 0.01, "Resampling or flush changed the accepted audio duration"
                    assert record["finalEndSec"] <= record["audioSec"] + 0.01, "Decoder padding leaked into the transcript clock"
            rows = [row for row in result["runs"] if row["threads"] == threads]
            summary = {"threads": threads, "loadSec": round(load_sec, 3), "medianRtf": round(statistics.median(row["rtf"] for row in rows), 4), "maxRtf": max(row["rtf"] for row in rows), "audioSec": sum(row["audioSec"] for row in rows), "decodeSec": round(sum(row["decodeSec"] for row in rows), 3)}
            result["summary"].append(summary)
            print(json.dumps(summary), flush=True)
            del recognizer
        result["ok"] = True
    except Exception as error:
        result.update(ok=False, error=str(error))
        raise
    finally:
        output = Path(options.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main())
