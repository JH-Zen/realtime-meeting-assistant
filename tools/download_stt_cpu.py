"""Download only the selected CPU model, verifying pinned upstream hashes before use."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.request


def verify(path: Path, entry: dict) -> str | None:
    if not path.is_file() or path.stat().st_size != entry["bytes"]:
        return None
    digest = hashlib.sha256()
    git = hashlib.sha1(f"blob {entry['bytes']}\0".encode())
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
            git.update(block)
    sha256 = digest.hexdigest()
    valid = sha256 == entry["sha256"] if entry.get("sha256") else git.hexdigest() == entry["gitBlobSha1"]
    return sha256 if valid else None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=r"D:\Apps\实时会议助手-STT-CPU")
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1] / "services/stt-worker/cpu-model.json"
    manifest = json.loads(source.read_text(encoding="utf-8-sig"))
    root = Path(args.root).resolve()
    target = root / "models" / manifest["repository"].split("/")[-1]
    target.mkdir(parents=True, exist_ok=True)
    lock = target / ".download.lock"
    try:
        with lock.open("x", encoding="utf-8") as stream:
            stream.write(str(os.getpid()))
    except FileExistsError as error:
        raise SystemExit(f"Another download may be active; inspect {lock} before retrying") from error

    def download(entry: dict) -> dict:
        path = (target / entry["path"]).resolve()
        if not path.is_relative_to(target):
            raise ValueError("Model manifest path escapes the selected directory")
        digest = verify(path, entry)
        if digest:
            print(f"Verified existing: {entry['path']}", flush=True)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            partial = path.with_name(path.name + ".download.part")
            url = f"https://huggingface.co/{manifest['repository']}/resolve/{manifest['revision']}/{entry['path']}"
            for attempt in range(3):
                try:
                    print(f"Downloading {entry['path']} ({entry['bytes'] / 1_000_000:.1f} MB)", flush=True)
                    request = urllib.request.Request(url, headers={"User-Agent": "RCC-STT-CPU-Setup/1"})
                    with urllib.request.urlopen(request, timeout=60) as response, partial.open("wb") as stream:
                        for block in iter(lambda: response.read(1024 * 1024), b""):
                            stream.write(block)
                    digest = verify(partial, entry)
                    if not digest:
                        raise ValueError("Downloaded file does not match the pinned upstream checksum")
                    if path.exists():
                        path.rename(path.with_name(path.name + f".invalid-{time.time_ns()}"))
                    partial.replace(path)
                    print(f"Verified download: {entry['path']}", flush=True)
                    break
                except Exception as error:
                    if attempt == 2:
                        raise RuntimeError(f"Download failed for {entry['path']}: {type(error).__name__}") from error
                    print(f"Retrying {entry['path']} after {type(error).__name__}", flush=True)
                    time.sleep(2 ** attempt)
        return {"path": entry["path"], "bytes": entry["bytes"], "sha256": digest}

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            files = list(pool.map(download, manifest["files"]))
        record = {"repository": manifest["repository"], "revision": manifest["revision"], "license": manifest["license"], "provider": "cpu", "files": files, "totalBytes": sum(row["bytes"] for row in files)}
        (target / "checksums.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"ok": True, "modelDir": str(target), "totalBytes": record["totalBytes"]}, ensure_ascii=False), flush=True)
    finally:
        lock.unlink()


if __name__ == "__main__":
    main()
