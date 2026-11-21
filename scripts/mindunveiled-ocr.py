#!/usr/bin/env python3
"""
MindUnveiled on-screen OCR + period tagging pipeline.

Downloads video, samples frames, OCRs with Ollama glm-ocr, diffs against
captions, and samples vision model for art/era guesses.

Usage:
  python3 scripts/mindunveiled-ocr.py --once --limit 1
  python3 scripts/mindunveiled-ocr.py --priority-first   # high-signal then rest
  MU_OCR_LIMIT=20 python3 scripts/mindunveiled-ocr.py
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MU = ROOT / ".data/concealment-scrubs/channel-MindUnveiled"
OCR_ROOT = MU / "ocr"
YTDLP = ROOT / ".venv-monitors/bin/yt-dlp"
FFMPEG = ROOT / ".tools/ffmpeg"
FFPROBE = ROOT / ".tools/ffprobe"
OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
OCR_MODEL = os.environ.get("MU_OCR_MODEL", "glm-ocr:latest")
VISION_MODEL = os.environ.get("MU_VISION_MODEL", "qwen3-vl:8b")
MAX_HEIGHT = int(os.environ.get("MU_OCR_MAX_HEIGHT", "720"))
VISION_EVERY_N = int(os.environ.get("MU_OCR_VISION_EVERY", "12"))  # every Nth frame
CAPTION_WINDOW_S = float(os.environ.get("MU_OCR_CAPTION_WINDOW", "8"))
COOKIES_FROM_BROWSER = os.environ.get("MU_OCR_COOKIES_FROM_BROWSER", "").strip()
COOKIES_FILE = os.environ.get("MU_OCR_COOKIES", "").strip()


def log(*a):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), "[mu-ocr]", *a, flush=True)


def ensure_dir(p: Path):
    p.mkdir(parents=True, exist_ok=True)


def ollama_generate(model: str, prompt: str, image_path: Path | None = None, timeout: int = 180) -> str:
    body: dict = {"model": model, "prompt": prompt, "stream": False}
    if image_path is not None:
        body["images"] = [base64.b64encode(image_path.read_bytes()).decode()]
    req = urllib.request.Request(
        f"{OLLAMA}/api/generate",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.load(r)
    return str(data.get("response") or "").strip()


def load_queue(priority_first: bool) -> list[dict]:
    rank = json.loads((MU / "cards-rank.json").read_text())
    by_id = {c["id"]: c for c in rank}
    index = json.loads((MU / "channel-index.json").read_text())
    if priority_first:
        ordered = sorted(rank, key=lambda c: (-float(c.get("score") or 0), c.get("i") or 0))
        seen = {c["id"] for c in ordered}
        for row in index:
            if row["id"] not in seen:
                ordered.append(
                    {
                        "id": row["id"],
                        "i": row.get("i"),
                        "title": row.get("title"),
                        "duration": row.get("dur"),
                        "score": 0,
                        "tab": row.get("tab"),
                    }
                )
        return ordered
    # channel order
    out = []
    for row in index:
        c = by_id.get(row["id"], {})
        out.append(
            {
                "id": row["id"],
                "i": row.get("i"),
                "title": row.get("title") or c.get("title"),
                "duration": row.get("dur") or c.get("duration"),
                "score": c.get("score") or 0,
                "tab": row.get("tab"),
            }
        )
    return out


def sample_interval(duration_s: float) -> float:
    if duration_s <= 0:
        return 15.0
    if duration_s < 45 * 60:
        return 12.0
    if duration_s < 120 * 60:
        return 25.0
    if duration_s < 240 * 60:
        return 45.0
    return 60.0


def parse_vtt_cues(vtt_path: Path) -> list[dict]:
    if not vtt_path.exists():
        return []
    text = vtt_path.read_text(errors="replace")
    cues = []
    # simple WEBVTT parser
    blocks = re.split(r"\n\n+", text)
    ts_re = re.compile(
        r"(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})\s-->\s(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})"
    )

    def to_s(h, m, s, ms):
        return int(h or 0) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0

    for block in blocks:
        lines = [l for l in block.splitlines() if l.strip() and not l.strip().startswith("WEBVTT") and not l.strip().startswith("NOTE")]
        if not lines:
            continue
        m = ts_re.search(lines[0])
        if not m:
            continue
        start = to_s(m.group(1), m.group(2), m.group(3), m.group(4))
        end = to_s(m.group(5), m.group(6), m.group(7), m.group(8))
        body = " ".join(lines[1:]).strip()
        body = re.sub(r"<[^>]+>", "", body)
        if body:
            cues.append({"start": start, "end": end, "text": body})
    return cues


def find_vtt(video_id: str) -> Path | None:
    raw = MU / "raw" / video_id
    if not raw.is_dir():
        return None
    vtts = list(raw.glob("*.vtt"))
    return vtts[0] if vtts else None


def captions_near(cues: list[dict], t: float, window: float) -> str:
    parts = []
    for c in cues:
        if c["end"] < t - window or c["start"] > t + window:
            continue
        parts.append(c["text"])
    return " ".join(parts)


STOPWORDS = set(
    """
    a an the and or but if then else when for of to in on at by from with without
    is are was were be been being have has had do does did will would can could
    should may might must this that these those it its they them their we our you
    your he she his her as so not no yes into over under about after before also
    than then there here what which who whom how why where whom than very just
    more most some any all each other such only own same too can will new old
    """.split()
)


def tokenize(s: str) -> set[str]:
    toks = set(re.findall(r"[A-Za-z0-9][A-Za-z0-9'\-]{1,}", (s or "").lower()))
    return {t for t in toks if t not in STOPWORDS and not t.isdigit()}


YEAR_RE = re.compile(r"\b(?:[12][0-9]{3}|[12][0-9]{3}s|[12][0-9]{2}0s)\b")
PERIOD_RE = re.compile(
    r"\b(?:(?:early|mid|late)[\s-]?)?(?:bronze|iron|classical|medieval|renaissance|baroque|victorian|edwardian|"
    r"antebellum|gilded|progressive|interwar|cold\s*war|ancient|prehistoric|neolithic|megalithic|"
    r"tartaria(?:n)?|atlantean|antediluvian|fin[\s-]de[\s-]si[eè]cle|"
    r"BC|B\.C\.|AD|A\.D\.|CE|BCE)\b",
    re.I,
)


def extract_periods(text: str) -> list[str]:
    found = []
    for m in YEAR_RE.findall(text or ""):
        found.append(m)
    for m in PERIOD_RE.findall(text or ""):
        found.append(m)
    # dedupe preserve order
    out, seen = [], set()
    for x in found:
        k = x.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(x)
    return out


def download_video(video_id: str, dest_dir: Path) -> Path | None:
    ensure_dir(dest_dir)
    existing = list(dest_dir.glob("*"))
    media = [p for p in existing if p.suffix.lower() in {".mp4", ".webm", ".mkv"}]
    if media:
        return media[0]
    url = f"https://www.youtube.com/watch?v={video_id}"
    outtmpl = str(dest_dir / "video.%(ext)s")
    fmt = f"bv*[height<={MAX_HEIGHT}]+ba/b[height<={MAX_HEIGHT}]/bv*+ba/b"
    cmd = [
        str(YTDLP),
        "--js-runtimes",
        "node",
        "--remote-components",
        "ejs:github",
        "--ffmpeg-location",
        str(FFMPEG.parent if FFMPEG.exists() else FFMPEG),
        "-f",
        fmt,
        "--merge-output-format",
        "mp4",
        "-o",
        outtmpl,
        "--no-playlist",
    ]
    if COOKIES_FILE and Path(COOKIES_FILE).exists():
        cmd += ["--cookies", COOKIES_FILE]
    elif COOKIES_FROM_BROWSER:
        cmd += ["--cookies-from-browser", COOKIES_FROM_BROWSER]
    cmd.append(url)
    log("download", video_id, f"cookies={'file' if COOKIES_FILE else COOKIES_FROM_BROWSER or 'none'}")
    r = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True)
    if r.returncode != 0:
        log("download-fail", video_id, r.stderr[-400:])
        return None
    media = list(dest_dir.glob("video.*"))
    media = [p for p in media if p.suffix.lower() in {".mp4", ".webm", ".mkv"}]
    return media[0] if media else None


def extract_frames(video: Path, frames_dir: Path, interval_s: float) -> list[tuple[float, Path]]:
    ensure_dir(frames_dir)
    existing = sorted(frames_dir.glob("frame_*.jpg"))
    if existing:
        out = []
        for p in existing:
            m = re.search(r"frame_(\d+)", p.name)
            # store centiseconds in name
            t = int(m.group(1)) / 100.0 if m else 0.0
            out.append((t, p))
        if out:
            return out
    # fps = 1/interval
    fps = 1.0 / max(1.0, interval_s)
    pattern = str(frames_dir / "frame_%06d.jpg")
    cmd = [
        str(FFMPEG),
        "-y",
        "-i",
        str(video),
        "-vf",
        f"fps={fps}",
        "-q:v",
        "4",
        pattern,
    ]
    log("frames", video.name, f"interval={interval_s}s")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        log("frames-fail", r.stderr[-300:])
        return []
    # rename to include timestamp centiseconds for stable ids
    files = sorted(frames_dir.glob("frame_*.jpg"))
    out = []
    for i, p in enumerate(files):
        t = i * interval_s
        new = frames_dir / f"frame_{int(t * 100):08d}.jpg"
        if p != new:
            p.rename(new)
        out.append((t, new))
    return out


def process_video(item: dict) -> dict:
    video_id = item["id"]
    work = OCR_ROOT / "by-id" / video_id
    summary_path = work / "ocr-summary.json"
    if summary_path.exists() and os.environ.get("MU_OCR_FORCE") != "1":
        prev = json.loads(summary_path.read_text())
        if prev.get("ok"):
            log("skip-complete", video_id)
            return prev
        log("retry-failed", video_id, prev.get("error"))

    ensure_dir(work)
    media_dir = work / "media"
    frames_dir = work / "frames"
    duration = float(item.get("duration") or 0)
    # prefer duration from info.json
    info_path = MU / "raw" / video_id / "vid.info.json"
    if info_path.exists():
        try:
            info = json.loads(info_path.read_text())
            duration = float(info.get("duration") or duration or 0)
            if not item.get("title"):
                item["title"] = info.get("title")
        except Exception:
            pass

    video = download_video(video_id, media_dir)
    if not video:
        summary = {
            "id": video_id,
            "ok": False,
            "error": "download_failed",
            "title": item.get("title"),
            "score": item.get("score"),
        }
        summary_path.write_text(json.dumps(summary, indent=2))
        return summary

    interval = sample_interval(duration)
    # cap frames
    max_frames = int(os.environ.get("MU_OCR_MAX_FRAMES", "500"))
    if duration > 0 and duration / interval > max_frames:
        interval = duration / max_frames
    frames = extract_frames(video, frames_dir, interval)
    cues = []
    vtt = find_vtt(video_id)
    if vtt:
        cues = parse_vtt_cues(vtt)

    jsonl_path = work / "ocr.jsonl"
    # resume: load done timestamps
    done_ts = set()
    if jsonl_path.exists():
        for line in jsonl_path.read_text().splitlines():
            if not line.strip():
                continue
            try:
                done_ts.add(float(json.loads(line).get("t") or -1))
            except Exception:
                pass

    ocr_only_terms: dict[str, int] = {}
    period_hits: dict[str, int] = {}
    vision_notes: list[dict] = []
    rows_written = 0

    with jsonl_path.open("a") as jf:
        for idx, (t, frame_path) in enumerate(frames):
            if any(abs(t - dt) < 0.01 for dt in done_ts):
                continue
            try:
                ocr_text = ollama_generate(
                    OCR_MODEL,
                    "Extract ALL visible text in this video frame (titles, captions overlays, signs, documents, watermarks). "
                    "Return plain text only. If no text, return EMPTY.",
                    frame_path,
                    timeout=120,
                )
            except Exception as e:
                log("ocr-err", video_id, t, e)
                ocr_text = ""
            if ocr_text.strip().upper() == "EMPTY":
                ocr_text = ""

            cap = captions_near(cues, t, CAPTION_WINDOW_S)
            ocr_toks = tokenize(ocr_text)
            cap_toks = tokenize(cap)
            only = sorted(ocr_toks - cap_toks)
            for tok in only:
                if len(tok) < 3:
                    continue
                ocr_only_terms[tok] = ocr_only_terms.get(tok, 0) + 1

            periods = extract_periods(ocr_text)
            for p in periods:
                period_hits[p] = period_hits.get(p, 0) + 1

            vision = None
            if idx % max(1, VISION_EVERY_N) == 0:
                try:
                    vision_raw = ollama_generate(
                        VISION_MODEL,
                        "This is a frame from a historical/conspiracy research video. "
                        "Infer possible time period(s) of any artwork, architecture, photographs, maps, or documents shown "
                        "(century/era/decade). Ignore modern UI chrome. "
                        "Reply compact JSON: {\"periods\":[{\"label\":\"...\",\"confidence\":\"low|med|high\",\"why\":\"...\"}],"
                        "\"scene\":\"short description\",\"has_historical_media\":true|false}",
                        frame_path,
                        timeout=180,
                    )
                    vision = vision_raw
                    vision_notes.append({"t": t, "raw": vision_raw[:2000]})
                    # try parse periods from vision JSON
                    m = re.search(r"\{[\s\S]*\}", vision_raw)
                    if m:
                        try:
                            vj = json.loads(m.group(0))
                            for pe in vj.get("periods") or []:
                                lab = pe.get("label")
                                if lab:
                                    period_hits[f"vision:{lab}"] = period_hits.get(f"vision:{lab}", 0) + 1
                        except Exception:
                            pass
                except Exception as e:
                    log("vision-err", video_id, t, e)

            row = {
                "t": round(t, 2),
                "frame": frame_path.name,
                "ocr": ocr_text,
                "captionNear": cap[:500],
                "ocrOnlyTokens": only[:80],
                "periodsFromOcr": periods,
                "vision": vision[:1500] if isinstance(vision, str) else vision,
            }
            jf.write(json.dumps(row, ensure_ascii=False) + "\n")
            jf.flush()
            rows_written += 1
            if rows_written % 10 == 0:
                log("progress", video_id, f"{idx+1}/{len(frames)}", f"t={t:.0f}s")

    top_ocr_only = sorted(ocr_only_terms.items(), key=lambda x: (-x[1], x[0]))[:80]
    top_periods = sorted(period_hits.items(), key=lambda x: (-x[1], x[0]))[:60]
    summary = {
        "id": video_id,
        "ok": True,
        "title": item.get("title"),
        "score": item.get("score"),
        "duration": duration,
        "intervalS": interval,
        "frames": len(frames),
        "ocrRows": rows_written + len(done_ts),
        "hasCaptions": bool(cues),
        "topOcrOnlyTerms": [{"term": t, "n": n} for t, n in top_ocr_only],
        "periodCandidates": [{"label": t, "n": n} for t, n in top_periods],
        "visionSamples": len(vision_notes),
        "media": str(video.relative_to(work)) if video else None,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    summary_path.write_text(json.dumps(summary, indent=2))

    # digest
    lines = [
        f"# OCR / on-screen — {item.get('title') or video_id}",
        "",
        f"**Video:** https://www.youtube.com/watch?v={video_id}",
        f"**Score:** {item.get('score')}",
        f"**Duration:** {duration}s · frames={len(frames)} · interval≈{interval:.1f}s",
        f"**Captions available:** {'yes' if cues else 'no'}",
        "",
        "## Period / year candidates (OCR + vision)",
        "",
    ]
    for p, n in top_periods[:40]:
        lines.append(f"- `{p}` ({n})")
    lines += ["", "## On-screen terms NOT in nearby captions (top)", ""]
    for t, n in top_ocr_only[:50]:
        lines.append(f"- `{t}` ({n})")
    lines += [
        "",
        "## Method",
        "",
        f"- OCR model: `{OCR_MODEL}`",
        f"- Vision model (periodic): `{VISION_MODEL}`",
        "- `ocrOnlyTokens` = OCR tokens minus caption tokens near the same timestamp",
        "- Treat period tags as leads from on-screen text/art, not verified dating",
        "",
        f"Raw: `ocr/by-id/{video_id}/ocr.jsonl`",
        "",
    ]
    (work / "digest.md").write_text("\n".join(lines))
    log("done", video_id, f"frames={len(frames)} ocrOnly={len(top_ocr_only)} periods={len(top_periods)}")
    return summary


def rebuild_index():
    rows = []
    by_id = OCR_ROOT / "by-id"
    if not by_id.exists():
        return
    for d in sorted(by_id.iterdir()):
        sp = d / "ocr-summary.json"
        if sp.exists():
            rows.append(json.loads(sp.read_text()))
    rows.sort(key=lambda r: (-float(r.get("score") or 0), r.get("id") or ""))
    (OCR_ROOT / "summaries.json").write_text(json.dumps(rows, indent=2))
    lines = [
        "# MindUnveiled on-screen OCR index",
        "",
        f"Generated: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
        f"Videos processed: {len(rows)}",
        "",
        "| Score | ID | Frames | OCR-only terms | Periods | Title |",
        "|---:|---|---:|---:|---:|---|",
    ]
    for r in rows:
        if not r.get("ok"):
            continue
        lines.append(
            f"| {float(r.get('score') or 0):.1f} | {r.get('id')} | {r.get('frames')} | "
            f"{len(r.get('topOcrOnlyTerms') or [])} | {len(r.get('periodCandidates') or [])} | "
            f"{(r.get('title') or '').replace('|', '/')} |"
        )
    (OCR_ROOT / "INDEX.md").write_text("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=int(os.environ.get("MU_OCR_LIMIT") or 0) or None)
    ap.add_argument("--once", action="store_true", help="process limit (default 1) and exit")
    ap.add_argument("--priority-first", action="store_true", default=True)
    ap.add_argument("--channel-order", action="store_true")
    ap.add_argument("--ids", type=str, default="", help="comma-separated video ids")
    args = ap.parse_args()

    if not FFMPEG.exists():
        log("FATAL missing ffmpeg at", FFMPEG)
        sys.exit(1)
    if not YTDLP.exists():
        log("FATAL missing yt-dlp at", YTDLP)
        sys.exit(1)

    ensure_dir(OCR_ROOT)
    (OCR_ROOT / "README.md").write_text(
        "\n".join(
            [
                "# MindUnveiled on-screen OCR",
                "",
                "Captures text/art overlays **not** in closed captions.",
                "",
                f"- OCR: `{OCR_MODEL}` via Ollama",
                f"- Period/art vision samples: `{VISION_MODEL}`",
                "- Per video: `by-id/<id>/{media,frames,ocr.jsonl,ocr-summary.json,digest.md}`",
                "",
                "Run: `pnpm mu:ocr` (priority queue) or `pnpm mu:ocr:once`",
                "",
            ]
        )
    )

    if args.ids:
        want = {x.strip() for x in args.ids.split(",") if x.strip()}
        queue = [x for x in load_queue(True) if x["id"] in want]
    else:
        queue = load_queue(priority_first=not args.channel_order)

    limit = args.limit
    if args.once and not limit:
        limit = 1
    if limit:
        queue = queue[:limit]

    log(f"queue={len(queue)} model_ocr={OCR_MODEL} vision={VISION_MODEL}")
    for item in queue:
        try:
            process_video(item)
        except Exception as e:
            log("FATAL-video", item.get("id"), e)
        rebuild_index()
    rebuild_index()
    log("batch complete")


if __name__ == "__main__":
    main()
