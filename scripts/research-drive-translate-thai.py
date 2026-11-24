#!/usr/bin/env python3
"""
Translate Thai OCR digests in `.data/research-drive/ocr/digests/` to English.

Replaces the ## Extracted text body with English only (per user preference).
Resume via `.data/research-drive/ocr/translate-state.json`.

Usage:
  .venv-monitors/bin/python scripts/research-drive-translate-thai.py
  .venv-monitors/bin/python scripts/research-drive-translate-thai.py --limit 5
  RD_TRANSLATE_MODEL=qwen2.5:14b .venv-monitors/bin/python scripts/research-drive-translate-thai.py --force
"""
from __future__ import annotations

import argparse
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DRIVE = ROOT / ".data" / "research-drive"
DIGESTS = DRIVE / "ocr" / "digests"
STATE_PATH = DRIVE / "ocr" / "translate-state.json"

OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
TRANSLATE_MODEL = os.environ.get("RD_TRANSLATE_MODEL", "qwen2.5:14b")
TIMEOUT = int(os.environ.get("RD_TRANSLATE_TIMEOUT", "300"))
CHUNK = int(os.environ.get("RD_TRANSLATE_CHUNK", "10000"))
MIN_THAI = int(os.environ.get("RD_TRANSLATE_MIN_THAI", "20"))
FORCE = os.environ.get("RD_TRANSLATE_FORCE", "").strip() in ("1", "true", "yes")

THAI_RE = re.compile(r"[\u0E00-\u0E7F]")
EXTRACT_RE = re.compile(
    r"(## Extracted text\s*\n)(.*?)(\n---\s*\n)",
    re.DOTALL | re.IGNORECASE,
)


def log(*a):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), "[rd-th-en]", *a, flush=True)


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text())
        except Exception:
            pass
    return {"version": 1, "files": {}, "updatedAt": None}


def save_state(state: dict):
    state["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2) + "\n")


def thai_count(text: str) -> int:
    return len(THAI_RE.findall(text or ""))


def looks_like_ocr_loop(text: str) -> bool:
    """Detect glm-ocr collapse into repeated Thai phrases (not worth translating)."""
    t = re.sub(r"\s+", "", text or "")
    if len(t) < 80:
        return False
    # high trigram repetition
    grams = [t[i : i + 12] for i in range(0, min(len(t), 2000) - 12)]
    if not grams:
        return False
    from collections import Counter

    c = Counter(grams)
    top_n, top_count = c.most_common(1)[0]
    if top_count >= 8 and top_count / max(len(grams), 1) > 0.15:
        return True
    # same long token repeated
    if re.search(r"(.{10,40})\1\1\1", t):
        return True
    return False


def ollama_translate(text: str) -> str:
    prompt = (
        "Translate the following document OCR text from Thai (and any mixed English) "
        "to clear, accurate English. Preserve people names, company names, ID numbers, "
        "dates, addresses, and paragraph breaks. Fix obvious OCR garble when the intended "
        "meaning is clear. Output ONLY the English translation.\n\n"
        f"{text}"
    )
    body = {
        "model": TRANSLATE_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.1},
    }
    req = urllib.request.Request(
        f"{OLLAMA}/api/generate",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        data = json.load(r)
    return str(data.get("response") or "").strip()


def translate_long(text: str) -> str:
    text = text.strip()
    if not text:
        return ""
    if len(text) <= CHUNK:
        return ollama_translate(text)
    parts: list[str] = []
    buf: list[str] = []
    size = 0
    for para in re.split(r"\n{2,}", text):
        p = para.strip()
        if not p:
            continue
        if size + len(p) + 2 > CHUNK and buf:
            parts.append(ollama_translate("\n\n".join(buf)))
            buf = [p]
            size = len(p)
        else:
            buf.append(p)
            size += len(p) + 2
    if buf:
        parts.append(ollama_translate("\n\n".join(buf)))
    return "\n\n".join(parts).strip()


def extract_body(md: str) -> tuple[str, str, str] | None:
    m = EXTRACT_RE.search(md)
    if not m:
        return None
    return m.group(1), m.group(2), m.group(3)


def file_key(path: Path) -> str:
    st = path.stat()
    return f"{path.relative_to(DIGESTS)}|{int(st.st_mtime)}|{st.st_size}"


def process_digest(path: Path, force: bool, state: dict) -> dict | None:
    rel = str(path.relative_to(DIGESTS))
    key = file_key(path)
    prev = (state.get("files") or {}).get(rel)
    if not force and prev and prev.get("key") == key and prev.get("ok"):
        return None

    md = path.read_text(errors="replace")
    extracted = extract_body(md)
    if not extracted:
        return {"rel": rel, "ok": False, "error": "no Extracted text section", "thai": 0}

    head, body, tail = extracted
    n_thai = thai_count(body)
    if n_thai < MIN_THAI:
        return {"rel": rel, "ok": True, "skipped": True, "thai": n_thai, "reason": "below-threshold"}

    # Already translated and little Thai remains
    if "**Translated:**" in md and n_thai < MIN_THAI and not force:
        return {"rel": rel, "ok": True, "skipped": True, "thai": n_thai, "reason": "already-en"}

    if looks_like_ocr_loop(body) and not force:
        log(f"skip ocr-loop {rel} thai_chars={n_thai}")
        # Mark soft so we don't retry forever
        if "**Translated:**" not in md:
            md2 = md.replace(
                "**OCR at:**",
                "**Translated:** skipped (OCR repeat-loop / unreadable Thai)  \n**OCR at:**",
                1,
            )
            path.write_text(md2)
        return {
            "rel": rel,
            "ok": True,
            "skipped": True,
            "thai": n_thai,
            "reason": "ocr-loop",
        }

    log(f"translate {rel} thai_chars={n_thai}")
    try:
        en = translate_long(body)
        if not en:
            raise RuntimeError("empty translation")
    except Exception as e:
        return {"rel": rel, "ok": False, "error": str(e), "thai": n_thai}

    new_body = en.strip() + "\n"

    def repl(m: re.Match) -> str:
        return m.group(1) + new_body + "\n" + m.group(3)

    new_md = EXTRACT_RE.sub(repl, md, count=1)
    if "**Translated:**" not in new_md:
        new_md = new_md.replace(
            "**OCR at:**",
            f"**Translated:** Thai→English via `{TRANSLATE_MODEL}`  \n**OCR at:**",
            1,
        )
    path.write_text(new_md)
    return {
        "rel": rel,
        "ok": True,
        "thai": n_thai,
        "chars_in": len(body),
        "chars_out": len(en),
        "model": TRANSLATE_MODEL,
    }


def list_thai_digests() -> list[Path]:
    out: list[Path] = []
    for p in DIGESTS.rglob("*.md"):
        try:
            t = p.read_text(errors="replace")
        except Exception:
            continue
        body = extract_body(t)
        sample = body[1] if body else t
        if thai_count(sample) >= MIN_THAI:
            out.append(p)

    def rank(p: Path) -> tuple:
        rel = str(p.relative_to(DIGESTS)).replace("\\", "/")
        # Prefer real Thai docs (leases/IDs) over noisy screenshots
        if rel.startswith("Landlord/Bangkok/"):
            pri = 0
        elif rel.startswith("Research death history/Thailand/"):
            pri = 1
        elif rel.startswith("Family/"):
            pri = 2
        else:
            pri = 3
        return (pri, rel)

    return sorted(out, key=rank)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--force", action="store_true")
    ap.add_argument(
        "--prefix",
        action="append",
        default=[],
        help="Only digests under these prefixes (e.g. Landlord/Bangkok)",
    )
    args = ap.parse_args()
    force = args.force or FORCE
    prefixes = [p.rstrip("/") + "/" for p in (args.prefix or []) if p.strip()]

    if not DIGESTS.exists():
        raise SystemExit(f"missing {DIGESTS}")

    files = list_thai_digests()
    if prefixes:
        files = [
            p
            for p in files
            if any(str(p.relative_to(DIGESTS)).startswith(pref) for pref in prefixes)
        ]
    state = load_state()
    log(f"thai_digests={len(files)} model={TRANSLATE_MODEL} force={force}")

    processed = 0
    for path in files:
        rel = str(path.relative_to(DIGESTS))
        result = process_digest(path, force=force, state=state)
        if result is None:
            continue
        if result.get("skipped"):
            continue
        state.setdefault("files", {})[rel] = {
            **result,
            "key": file_key(path) if path.exists() else None,
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        # refresh key after write
        if path.exists() and result.get("ok"):
            state["files"][rel]["key"] = file_key(path)
        save_state(state)
        processed += 1
        log(
            f"done ok={result.get('ok')} out={result.get('chars_out')} "
            + (f"err={result.get('error')}" if result.get("error") else "")
        )
        if args.limit and processed >= args.limit:
            log(f"stopped at limit={args.limit}")
            break

    ok_n = sum(1 for v in (state.get("files") or {}).values() if v.get("ok"))
    log(f"batch complete processed_this_run={processed} ok_total={ok_n}")


if __name__ == "__main__":
    main()
