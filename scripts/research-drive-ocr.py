#!/usr/bin/env python3
"""
OCR + digest pipeline for `.data/research-drive/` (includes Personal when present).

- Images → magick resize → Ollama glm-ocr
- PDFs → pdftotext; if thin, rasterize first pages and OCR
- Resume via `.data/research-drive/ocr/state.json`
- Digests: `.data/research-drive/ocr/digests/<rel>.md`

Usage:
  python3 scripts/research-drive-ocr.py --limit 5
  python3 scripts/research-drive-ocr.py
  RD_OCR_FORCE=1 python3 scripts/research-drive-ocr.py --limit 3
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DRIVE = ROOT / ".data" / "research-drive"
OCR_ROOT = DRIVE / "ocr"
DIGESTS = OCR_ROOT / "digests"
STATE_PATH = OCR_ROOT / "state.json"
TMP = OCR_ROOT / "tmp"

OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
OCR_MODEL = os.environ.get("RD_OCR_MODEL", "glm-ocr:latest")
MAX_EDGE = int(os.environ.get("RD_OCR_MAX_EDGE", "1600"))
JPEG_QUALITY = int(os.environ.get("RD_OCR_JPEG_QUALITY", "85"))
PDF_MAX_PAGES = int(os.environ.get("RD_OCR_PDF_MAX_PAGES", "8"))
TIMEOUT = int(os.environ.get("RD_OCR_TIMEOUT", "180"))
SLEEP_MS = int(os.environ.get("RD_OCR_SLEEP_MS", "200"))
FORCE = os.environ.get("RD_OCR_FORCE", "").strip() in ("1", "true", "yes")

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff", ".bmp"}
PDF_EXT = {".pdf"}
SKIP_DIR_NAMES = {"ocr", "node_modules", ".git"}


def log(*a):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), "[rd-ocr]", *a, flush=True)


def ensure_dirs():
    DIGESTS.mkdir(parents=True, exist_ok=True)
    TMP.mkdir(parents=True, exist_ok=True)


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text())
        except Exception:
            pass
    return {"version": 1, "files": {}, "updatedAt": None}


def save_state(state: dict):
    state["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    STATE_PATH.write_text(json.dumps(state, indent=2) + "\n")


def file_key(rel: str, st_mtime: float, size: int) -> str:
    return f"{rel}|{int(st_mtime)}|{size}"


def list_source_files() -> list[Path]:
    out: list[Path] = []
    for p in DRIVE.rglob("*"):
        if not p.is_file():
            continue
        if any(part in SKIP_DIR_NAMES for part in p.parts):
            continue
        # skip staging helpers
        if p.name in ("README.md", "INDEX.md", "OVERVIEW.md"):
            continue
        if p.suffix.lower() in IMAGE_EXT or p.suffix.lower() in PDF_EXT:
            out.append(p)
        elif p.suffix.lower() in {".xlsx", ".xls", ".csv", ".txt", ".md"}:
            out.append(p)
    return sorted(out)


def digest_path_for(src: Path) -> Path:
    rel = src.relative_to(DRIVE)
    # flatten weird names but keep structure
    safe = Path(*[re.sub(r"[^\w.\- +&()]", "_", part) for part in rel.parts])
    return DIGESTS / f"{safe}.md"


def ollama_ocr(image_path: Path, prompt: str) -> str:
    b64 = base64.b64encode(image_path.read_bytes()).decode()
    body = {
        "model": OCR_MODEL,
        "prompt": prompt,
        "images": [b64],
        "stream": False,
        "options": {"temperature": 0},
    }
    req = urllib.request.Request(
        f"{OLLAMA}/api/generate",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        data = json.load(r)
    return str(data.get("response") or "").strip()


def resize_image(src: Path) -> Path:
    out = TMP / f"{hashlib.sha1(str(src).encode()).hexdigest()[:16]}.jpg"
    subprocess.check_call(
        [
            "magick",
            str(src),
            "-auto-orient",
            "-resize",
            f"{MAX_EDGE}x{MAX_EDGE}>",
            "-quality",
            str(JPEG_QUALITY),
            str(out),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return out


def pdftotext(src: Path) -> str:
    try:
        r = subprocess.run(
            ["pdftotext", "-layout", "-enc", "UTF-8", str(src), "-"],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        return (r.stdout or "").strip()
    except Exception as e:
        return f"[pdftotext error: {e}]"


def pdf_raster_ocr(src: Path) -> str:
    stem = hashlib.sha1(str(src).encode()).hexdigest()[:12]
    prefix = TMP / f"pdf-{stem}"
    # clean old
    for old in TMP.glob(f"pdf-{stem}*"):
        try:
            old.unlink()
        except Exception:
            pass
    subprocess.check_call(
        [
            "pdftoppm",
            "-jpeg",
            "-r",
            "150",
            "-f",
            "1",
            "-l",
            str(PDF_MAX_PAGES),
            str(src),
            str(prefix),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    pages = sorted(TMP.glob(f"pdf-{stem}-*.jpg"))
    chunks: list[str] = []
    for i, page in enumerate(pages, 1):
        try:
            text = ollama_ocr(
                page,
                "Extract all readable text from this PDF page image. Preserve names, dates, URLs, tables as text. Plain text only.",
            )
            if text:
                chunks.append(f"### Page {i}\n\n{text}")
        except Exception as e:
            chunks.append(f"### Page {i}\n\n[ocr error: {e}]")
        time.sleep(SLEEP_MS / 1000)
    return "\n\n".join(chunks)


def read_textish(src: Path) -> str:
    try:
        return src.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return f"[read error: {e}]"


def process_file(src: Path) -> dict:
    rel = str(src.relative_to(DRIVE))
    ext = src.suffix.lower()
    ocr_text = ""
    method = ""
    error = None
    try:
        if ext in IMAGE_EXT:
            method = "glm-ocr"
            resized = resize_image(src)
            ocr_text = ollama_ocr(
                resized,
                "Extract all readable text from this research screenshot/photo. "
                "Preserve people names, companies, CRDs, URLs, dates, locations, captions. "
                "Plain text only; keep line breaks where helpful.",
            )
            try:
                resized.unlink(missing_ok=True)
            except Exception:
                pass
        elif ext in PDF_EXT:
            method = "pdftotext"
            ocr_text = pdftotext(src)
            if len(re.sub(r"\s+", "", ocr_text)) < 80:
                method = "pdftotext+raster-ocr"
                ocr_text = (ocr_text + "\n\n" + pdf_raster_ocr(src)).strip()
        else:
            method = "text-copy"
            ocr_text = read_textish(src)[:40_000]
    except Exception as e:
        error = str(e)
        ocr_text = ""

    digest = digest_path_for(src)
    digest.parent.mkdir(parents=True, exist_ok=True)
    folder_bits = list(Path(rel).parts[:-1])
    title = Path(rel).stem.replace("_", " ")[:120]
    body = [
        f"# {title}",
        "",
        f"**Source path:** `{rel}`",
        f"**Method:** {method}",
        f"**Model:** {OCR_MODEL if 'ocr' in method else 'n/a'}",
        f"**Folder:** {' / '.join(folder_bits) if folder_bits else '(root)'}",
        f"**Bytes:** {src.stat().st_size}",
        f"**OCR at:** {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
        "",
        "## Extracted text",
        "",
        ocr_text if ocr_text else f"_(empty — {error or 'no text'}_)",
        "",
        "---",
        "",
        "_Local research-drive staging. Treat as leads/screenshots, not verified claims._",
        "",
    ]
    digest.write_text("\n".join(body))
    return {
        "rel": rel,
        "digest": str(digest.relative_to(DRIVE)),
        "method": method,
        "chars": len(ocr_text or ""),
        "error": error,
        "ok": error is None and bool(ocr_text),
    }


def write_overview(state: dict, files: list[Path]):
    done = state.get("files") or {}
    ok_n = sum(1 for v in done.values() if v.get("ok"))
    err_n = sum(1 for v in done.values() if v.get("error"))
    lines = [
        "# Research Drive — OCR overview",
        "",
        f"- Source root: `.data/research-drive/`",
        f"- Files discovered: {len(files)}",
        f"- Digested OK: {ok_n}",
        f"- Errors: {err_n}",
        f"- Updated: {state.get('updatedAt')}",
        f"- Model: `{OCR_MODEL}`",
        "",
        "## Top-level folders",
        "",
    ]
    from collections import Counter

    c = Counter()
    for p in files:
        rel = p.relative_to(DRIVE)
        top = rel.parts[0] if rel.parts else "(root)"
        c[top] += 1
    for k, n in sorted(c.items()):
        lines.append(f"- **{k}**: {n} files")
    lines += ["", "## Recent digests", ""]
    recent = sorted(DIGESTS.rglob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)[:40]
    for p in recent:
        lines.append(f"- `{p.relative_to(DRIVE)}`")
    lines.append("")
    (OCR_ROOT / "OVERVIEW.md").write_text("\n".join(lines))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="Max new files this run (0=all)")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    force = args.force or FORCE

    ensure_dirs()
    if not DRIVE.exists():
        raise SystemExit(f"missing {DRIVE}")

    files = list_source_files()
    state = load_state()
    log(f"discovered={len(files)} model={OCR_MODEL} force={force}")

    processed = 0
    for src in files:
        rel = str(src.relative_to(DRIVE))
        st = src.stat()
        key = file_key(rel, st.st_mtime, st.st_size)
        prev = (state.get("files") or {}).get(rel)
        digest = digest_path_for(src)
        if not force and prev and prev.get("key") == key and digest.exists() and prev.get("ok"):
            continue
        log(f"ocr {rel}")
        result = process_file(src)
        state.setdefault("files", {})[rel] = {
            **result,
            "key": key,
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        save_state(state)
        processed += 1
        log(
            f"done ok={result['ok']} chars={result['chars']} method={result['method']}"
            + (f" err={result['error']}" if result.get("error") else "")
        )
        if args.limit and processed >= args.limit:
            log(f"stopped at limit={args.limit}")
            break
        time.sleep(SLEEP_MS / 1000)

    write_overview(state, files)
    ok_n = sum(1 for v in (state.get("files") or {}).values() if v.get("ok"))
    log(f"batch complete processed_this_run={processed} ok_total={ok_n} digests={len(list(DIGESTS.rglob('*.md')))}")


if __name__ == "__main__":
    main()
