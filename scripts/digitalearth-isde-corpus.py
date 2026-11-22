#!/usr/bin/env python3
"""
Crawl https://www.digitalearth-isde.org/ into a local corpus, download PDFs/media,
archive ISDE YouTube + on-site HLS lectures, transcribe (faster-whisper), and
translate non-English speech to English via Ollama.

Layout:
  .data/digitalearth-isde/
    pages/ digests/ pdfs/ media/ videos/{id}/
    catalog.json structure.json OVERVIEW.md
    data-layers.json   # discovered GIS/data endpoints & references

Usage:
  .venv-monitors/bin/python scripts/digitalearth-isde-corpus.py
  .venv-monitors/bin/python scripts/digitalearth-isde-corpus.py --crawl-only
  .venv-monitors/bin/python scripts/digitalearth-isde-corpus.py --videos-only
  .venv-monitors/bin/python scripts/digitalearth-isde-corpus.py --limit-videos 2
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from collections import deque
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / ".data" / "digitalearth-isde"
BASE = "https://www.digitalearth-isde.org"
YT_CHANNEL = "https://www.youtube.com/@isde_digitalearth/videos"
UA = "ai-research-tool-digitalearth/1.0 (+local research archive)"
FFMPEG = str(ROOT / ".tools" / "ffmpeg")
YT_DLP = str(ROOT / ".venv-monitors" / "bin" / "yt-dlp")
PYTHON = str(ROOT / ".venv-monitors" / "bin" / "python")
OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
TRANSLATE_MODEL = os.environ.get("DE_TRANSLATE_MODEL", "qwen2.5:14b")
WHISPER_MODEL = os.environ.get("DE_WHISPER_MODEL", "small")
SLEEP = float(os.environ.get("DE_SLEEP", "0.25"))

DATA_LAYER_RE = re.compile(
    r"(wms|wmts|wfs|wcs|geojson|geoserver|arcgis|mapserver|xyz tile|cog\b|stac\b|"
    r"data layer|knowledge platform|open data|geoportal|cesium|mapbox|ghsl|"
    r"global human settlement|big earth data)",
    re.I,
)


class LinkExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs: list[str] = []
        self.srcs: list[str] = []
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        ad = dict(attrs)
        if tag == "a" and "href" in ad:
            self.hrefs.append(ad["href"])
        if tag in {"iframe", "source", "video", "audio", "embed"} and "src" in ad:
            self.srcs.append(ad["src"])
        if tag == "title":
            self._in_title = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data


def log(*a):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), "[digitalearth]", *a, flush=True)


def ensure_dirs():
    for p in [
        CORPUS,
        CORPUS / "pages",
        CORPUS / "digests",
        CORPUS / "pdfs",
        CORPUS / "media",
        CORPUS / "videos",
        CORPUS / "assets",
    ]:
        p.mkdir(parents=True, exist_ok=True)


def load_json(path: Path, fallback):
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            pass
    return fallback


def save_json(path: Path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def sha1(s: str) -> str:
    return hashlib.sha1(s.encode()).hexdigest()


def same_site(url: str) -> bool:
    host = urlparse(url).netloc.lower()
    return host in {"", "www.digitalearth-isde.org", "digitalearth-isde.org"}


def normalize(url: str) -> str:
    u = urljoin(BASE + "/", url)
    p = urlparse(u)
    # drop fragments
    return p._replace(fragment="").geturl()


def fetch_bytes(url: str, timeout: int = 60) -> tuple[bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        ctype = r.headers.get("Content-Type", "")
        return r.read(), ctype


def html_to_text(html: str) -> str:
    html = re.sub(r"(?is)<script[^>]*>.*?</script>", " ", html)
    html = re.sub(r"(?is)<style[^>]*>.*?</style>", " ", html)
    html = re.sub(r"(?is)<!--.*?-->", " ", html)
    html = re.sub(r"(?is)<[^>]+>", " ", html)
    html = (
        html.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
    )
    return re.sub(r"\s+", " ", html).strip()


def seed_urls() -> list[str]:
    seeds = [BASE + "/", BASE + "/list-36-1.html", BASE + "/list-41-1.html"]
    # major sections from homepage nav
    for cat in [
        1, 2, 4, 5, 7, 20, 22, 23, 24, 25, 28, 30, 31, 33, 34, 36, 37, 38, 39, 40, 41, 42,
        44, 45, 48, 49, 50, 51, 54, 61, 62, 88, 89, 90, 92, 93, 94, 95, 96, 97, 99, 100,
        101, 104, 108, 121, 129, 148, 150, 152, 153,
    ]:
        for page in range(1, 12):
            seeds.append(f"{BASE}/list-{cat}-{page}.html")
    seeds.append(f"{BASE}/index.php?m=content&c=index&a=lists&catid=109")
    return seeds


def crawl(limit_pages: int = 0) -> dict:
    catalog = load_json(
        CORPUS / "catalog.json",
        {"version": 1, "base": BASE, "pages": {}, "assets": {}, "videos": {}, "updatedAt": None},
    )
    data_layers = load_json(CORPUS / "data-layers.json", {"references": [], "updatedAt": None})
    q = deque(seed_urls())
    seen: set[str] = set(catalog.get("pages", {}).keys())
    for u in list(q):
        if u not in seen:
            pass
    fetched = 0
    while q:
        url = normalize(q.popleft())
        if not same_site(url):
            continue
        if url in catalog["pages"] and catalog["pages"][url].get("ok"):
            continue
        if limit_pages and fetched >= limit_pages:
            break
        log(f"crawl {url}")
        try:
            raw, ctype = fetch_bytes(url, timeout=45)
        except Exception as e:
            catalog["pages"][url] = {"ok": False, "error": str(e), "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            save_json(CORPUS / "catalog.json", catalog)
            continue
        fetched += 1
        path_hash = sha1(url)[:12]
        is_html = "html" in ctype.lower() or raw[:200].lstrip().lower().startswith(b"<!doctype") or raw[:100].lstrip().startswith(b"<html")
        if not is_html:
            # binary asset linked as page somehow
            ext = Path(urlparse(url).path).suffix or ".bin"
            dest = CORPUS / "assets" / f"{path_hash}{ext}"
            dest.write_bytes(raw)
            catalog["assets"][url] = {"ok": True, "path": str(dest.relative_to(CORPUS)), "bytes": len(raw), "contentType": ctype}
            continue

        html = raw.decode("utf-8", "replace")
        page_file = CORPUS / "pages" / f"{path_hash}.html"
        page_file.write_bytes(raw)
        parser = LinkExtractor()
        try:
            parser.feed(html)
        except Exception:
            pass
        title = (parser.title or "").strip() or url
        text = html_to_text(html)
        digest = CORPUS / "digests" / f"{path_hash}.md"
        digest.write_text(
            "\n".join(
                [
                    f"# {title}",
                    "",
                    f"**URL:** {url}",
                    f"**Crawled:** {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
                    "",
                    "## Text",
                    "",
                    text[:80_000],
                    "",
                ]
            ),
            encoding="utf-8",
        )
        # discover links
        links = []
        for href in parser.hrefs + parser.srcs:
            if not href:
                continue
            absu = normalize(href)
            links.append(absu)
            low = absu.lower()
            if same_site(absu):
                if absu not in catalog["pages"] and absu not in seen:
                    # prioritize content pages
                    if re.search(r"/(list|show)-\d+", absu) or "uploadfile" in absu or absu.endswith(".html"):
                        q.append(absu)
                        seen.add(absu)
            # assets
            if any(low.split("?")[0].endswith(ext) for ext in (".pdf", ".mp4", ".webm", ".m3u8", ".zip", ".geojson", ".json", ".kml", ".tif", ".tiff")):
                catalog.setdefault("assets", {})[absu] = catalog.get("assets", {}).get(absu) or {"pending": True}
            if "youtube.com" in low or "youtu.be" in low:
                catalog.setdefault("videos", {})[absu] = catalog.get("videos", {}).get(absu) or {
                    "source": "youtube-link",
                    "url": absu,
                    "pending": True,
                }
            if DATA_LAYER_RE.search(absu) or DATA_LAYER_RE.search(str(href)):
                data_layers["references"].append({"url": absu, "from": url, "kind": "link"})

        # on-page data-layer mentions
        for m in DATA_LAYER_RE.finditer(text):
            start = max(0, m.start() - 80)
            end = min(len(text), m.end() + 120)
            data_layers["references"].append(
                {"url": url, "from": url, "kind": "mention", "snippet": text[start:end], "match": m.group(0)}
            )

        # HLS / mp4 in page source
        for m in re.findall(r'["\']([^"\']+\.(?:m3u8|mp4)[^"\']*)["\']', html, re.I):
            absu = normalize(m)
            catalog.setdefault("videos", {})[absu] = {
                "source": "site-media",
                "url": absu,
                "page": url,
                "title": title,
                "pending": True,
            }

        catalog["pages"][url] = {
            "ok": True,
            "title": title,
            "path": str(page_file.relative_to(CORPUS)),
            "digest": str(digest.relative_to(CORPUS)),
            "bytes": len(raw),
            "textChars": len(text),
            "outLinks": len(links),
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        if fetched % 10 == 0:
            catalog["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            data_layers["updatedAt"] = catalog["updatedAt"]
            # dedupe data layer refs
            uniq = []
            seen_ref = set()
            for r in data_layers["references"]:
                key = (r.get("kind"), r.get("url"), r.get("match"), r.get("snippet", "")[:80])
                if key in seen_ref:
                    continue
                seen_ref.add(key)
                uniq.append(r)
            data_layers["references"] = uniq[-2000:]
            save_json(CORPUS / "catalog.json", catalog)
            save_json(CORPUS / "data-layers.json", data_layers)
        time.sleep(SLEEP)

    catalog["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    save_json(CORPUS / "catalog.json", catalog)
    save_json(CORPUS / "data-layers.json", data_layers)
    log(f"crawl done pages={len(catalog['pages'])} assets={len(catalog.get('assets', {}))} videos={len(catalog.get('videos', {}))}")
    return catalog


def download_assets(catalog: dict, limit: int = 0):
    n = 0
    for url, meta in list(catalog.get("assets", {}).items()):
        if meta.get("ok") and meta.get("path"):
            continue
        if limit and n >= limit:
            break
        if not same_site(url) and not url.lower().endswith(".pdf"):
            # still allow offsite pdfs referenced
            if not url.lower().split("?")[0].endswith((".pdf", ".geojson", ".zip")):
                continue
        low_path = urlparse(url).path.lower()
        # Large lecture videos belong in the video pipeline (stream + whisper), not RAM-buffered assets.
        if low_path.endswith((".mp4", ".webm", ".m3u8", ".mov")):
            catalog.setdefault("videos", {})[url] = catalog.get("videos", {}).get(url) or {
                "source": "site-media",
                "url": url,
                "title": Path(urlparse(url).path).name,
                "pending": True,
            }
            catalog["assets"][url] = {
                "ok": False,
                "skipped": True,
                "error": "deferred-to-videos",
            }
            log(f"asset defer video {url}")
            save_json(CORPUS / "catalog.json", catalog)
            continue
        log(f"asset {url}")
        try:
            # Stream to disk — some PDFs/media are hundreds of MB.
            req = urllib.request.Request(
                url,
                headers={"User-Agent": UA, "Accept": "*/*"},
            )
            with urllib.request.urlopen(req, timeout=600) as r:
                ctype = r.headers.get("Content-Type", "")
                ext = Path(urlparse(url).path).suffix or ".bin"
                if "pdf" in (ctype or "").lower():
                    ext = ".pdf"
                dest_dir = CORPUS / ("pdfs" if ext.lower() == ".pdf" else "media")
                dest_dir.mkdir(parents=True, exist_ok=True)
                dest = dest_dir / f"{sha1(url)[:10]}-{Path(urlparse(url).path).name or ('file'+ext)}"
                nbytes = 0
                with open(dest, "wb") as out:
                    while True:
                        chunk = r.read(1024 * 1024)
                        if not chunk:
                            break
                        out.write(chunk)
                        nbytes += len(chunk)
            text_chars = 0
            if ext.lower() == ".pdf":
                pr = subprocess.run(
                    ["pdftotext", "-layout", "-nopgbrk", str(dest), "-"],
                    capture_output=True,
                    timeout=300,
                )
                text = pr.stdout.decode("utf-8", "replace")
                text_chars = len(text)
                (CORPUS / "digests" / f"pdf-{sha1(url)[:10]}.md").write_text(
                    f"# {dest.name}\n\n**URL:** {url}\n\n## Extracted text\n\n{text[:60_000]}\n",
                    encoding="utf-8",
                )
            catalog["assets"][url] = {
                "ok": True,
                "path": str(dest.relative_to(CORPUS)),
                "bytes": nbytes,
                "contentType": ctype,
                "textChars": text_chars,
            }
            n += 1
        except Exception as e:
            catalog["assets"][url] = {"ok": False, "error": str(e)}
            log(f"asset FAIL {e}")
        save_json(CORPUS / "catalog.json", catalog)
        time.sleep(SLEEP)


def youtube_inventory(catalog: dict):
    log("youtube inventory")
    cmd = [
        YT_DLP,
        "--flat-playlist",
        "--print",
        "%({id,title,duration,webpage_url,upload_date,description,channel,language,automatic_captions,subtitles})j",
        YT_CHANNEL,
    ]
    # simpler print fields
    cmd = [
        YT_DLP,
        "--flat-playlist",
        "--print",
        "%(id)s\t%(title)s\t%(duration)s\t%(webpage_url)s\t%(upload_date)s",
        YT_CHANNEL,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        log("youtube inventory error", r.stderr[:500])
    for line in r.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        vid, title, duration, url = parts[0], parts[1], parts[2], parts[3]
        upload = parts[4] if len(parts) > 4 else ""
        key = f"https://www.youtube.com/watch?v={vid}"
        prev = catalog.setdefault("videos", {}).get(key) or {}
        catalog["videos"][key] = {
            **prev,
            "source": "youtube",
            "id": vid,
            "title": title,
            "durationSec": int(duration) if str(duration).isdigit() else duration,
            "url": key,
            "uploadDate": upload,
            "pending": prev.get("transcriptPath") is None,
        }
    save_json(CORPUS / "catalog.json", catalog)
    log(f"youtube videos indexed={sum(1 for v in catalog['videos'].values() if v.get('source')=='youtube')}")


def translate_text(text: str, src_lang: str) -> str:
    if not text.strip():
        return ""
    if src_lang.lower().startswith("en"):
        return text
    prompt = (
        f"Translate the following transcript from {src_lang} to clear, accurate English. "
        "Preserve meaning, names, technical terms, and paragraph breaks. "
        "Output ONLY the English translation.\n\n"
        f"{text[:12000]}"
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
    with urllib.request.urlopen(req, timeout=300) as r:
        data = json.load(r)
    return str(data.get("response") or "").strip()


def process_video(entry: dict, catalog: dict) -> dict:
    url = entry["url"]
    vid = entry.get("id") or sha1(url)[:12]
    vdir = CORPUS / "videos" / vid
    vdir.mkdir(parents=True, exist_ok=True)
    meta_path = vdir / "meta.json"
    audio = vdir / "audio.wav"
    # download audio-only when possible
    if not audio.exists() or audio.stat().st_size < 1000:
        log(f"download audio {url}")
        cmd = [
            YT_DLP,
            "-f",
            "bestaudio/best",
            "--no-playlist",
            "-o",
            str(vdir / "media.%(ext)s"),
            "--ffmpeg-location",
            str(ROOT / ".tools"),
            url,
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            entry["error"] = r.stderr[-500:]
            entry["ok"] = False
            return entry
        # convert to wav 16k mono
        media = next(vdir.glob("media.*"), None)
        if not media:
            entry["error"] = "no media file"
            entry["ok"] = False
            return entry
        subprocess.run(
            [FFMPEG, "-y", "-i", str(media), "-ac", "1", "-ar", "16000", str(audio)],
            capture_output=True,
            timeout=300,
            check=False,
        )
    # metadata via yt-dlp
    mr = subprocess.run(
        [YT_DLP, "--skip-download", "--print", "%({id,title,description,duration,language,upload_date,channel,webpage_url,tags,categories,subtitles,automatic_captions})j", url],
        capture_output=True,
        text=True,
        timeout=120,
    )
    meta = {}
    if mr.returncode == 0 and mr.stdout.strip():
        try:
            meta = json.loads(mr.stdout.splitlines()[0])
        except Exception:
            meta = {"raw": mr.stdout[:2000]}
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n")

    # Prefer official subs if English; else whisper
    transcript = ""
    lang = "unknown"
    # try listing subs
    sub_en = vdir / "subs.en.vtt"
    if not (vdir / "transcript.txt").exists():
        subprocess.run(
            [
                YT_DLP,
                "--skip-download",
                "--write-auto-sub",
                "--write-sub",
                "--sub-lang",
                "en.*,zh.*,ja.*,ko.*,de.*,fr.*,es.*,ru.*,it.*,pt.*",
                "--sub-format",
                "vtt",
                "-o",
                str(vdir / "subs"),
                "--ffmpeg-location",
                str(ROOT / ".tools"),
                url,
            ],
            capture_output=True,
            text=True,
            timeout=180,
        )
    # whisper — load wav as numpy (PyAV in this venv rejects faster-whisper's metadata_errors)
    import wave

    import numpy as np
    from faster_whisper import WhisperModel

    with wave.open(str(audio), "rb") as wf:
        audio_np = (
            np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16).astype(np.float32)
            / 32768.0
        )
    log(f"whisper {vid} model={WHISPER_MODEL} samples={len(audio_np)}")
    prefer_cpu = os.environ.get("DIGITALEARTH_WHISPER_DEVICE", "").lower() == "cpu"
    try:
        if prefer_cpu:
            raise RuntimeError("prefer cpu")
        model = WhisperModel(WHISPER_MODEL, device="cuda", compute_type="float16")
        segments, info = model.transcribe(audio_np, vad_filter=True)
    except Exception as e:
        log(f"whisper cuda/skip ({e}); trying cpu")
        model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
        segments, info = model.transcribe(audio_np, vad_filter=True)
    lang = info.language or "unknown"
    lines = []
    for seg in segments:
        lines.append(f"[{seg.start:.1f}-{seg.end:.1f}] {seg.text.strip()}")
    transcript = "\n".join(lines)

    (vdir / "transcript.txt").write_text(transcript, encoding="utf-8")
    translation = transcript
    if not str(lang).lower().startswith("en"):
        log(f"translate {vid} {lang} -> en via {TRANSLATE_MODEL}")
        # translate in chunks
        chunks = transcript.split("\n")
        out = []
        buf = []
        buf_len = 0
        for line in chunks:
            buf.append(line)
            buf_len += len(line)
            if buf_len > 4000:
                out.append(translate_text("\n".join(buf), lang))
                buf, buf_len = [], 0
        if buf:
            out.append(translate_text("\n".join(buf), lang))
        translation = "\n\n".join(out)
    (vdir / "transcript.en.txt").write_text(translation, encoding="utf-8")

    digest = CORPUS / "digests" / f"video-{vid}.md"
    digest.write_text(
        "\n".join(
            [
                f"# {entry.get('title') or meta.get('title') or vid}",
                "",
                f"**URL:** {url}",
                f"**Source language (detected):** {lang}",
                f"**Duration:** {entry.get('durationSec') or meta.get('duration')}",
                "",
                "## Metadata",
                "",
                f"```json\n{json.dumps({k: meta.get(k) for k in ['id','title','channel','upload_date','description','tags'] if k in meta}, ensure_ascii=False, indent=2)[:4000]}\n```",
                "",
                "## Transcript (original)",
                "",
                transcript[:30_000] or "_(empty)_",
                "",
                "## Transcript (English)",
                "",
                translation[:30_000] or "_(same as original / empty)_",
                "",
            ]
        ),
        encoding="utf-8",
    )
    entry.update(
        {
            "ok": True,
            "pending": False,
            "id": vid,
            "language": lang,
            "dir": str(vdir.relative_to(CORPUS)),
            "transcriptPath": str((vdir / "transcript.txt").relative_to(CORPUS)),
            "transcriptEnPath": str((vdir / "transcript.en.txt").relative_to(CORPUS)),
            "digest": str(digest.relative_to(CORPUS)),
            "metaPath": str(meta_path.relative_to(CORPUS)),
        }
    )
    catalog["videos"][url] = entry
    save_json(CORPUS / "catalog.json", catalog)
    return entry


def process_videos(catalog: dict, limit: int = 0):
    youtube_inventory(catalog)
    # also queue site m3u8/mp4
    items = []
    for url, v in catalog.get("videos", {}).items():
        if v.get("transcriptPath"):
            continue
        items.append(v)
    # prefer youtube first
    items.sort(key=lambda v: 0 if v.get("source") == "youtube" else 1)
    n = 0
    for v in items:
        if limit and n >= limit:
            break
        try:
            process_video(v, catalog)
            n += 1
        except Exception as e:
            log(f"video FAIL {v.get('url')}: {e}")
            v["ok"] = False
            v["error"] = str(e)
            catalog["videos"][v["url"]] = v
            save_json(CORPUS / "catalog.json", catalog)


def write_overview(catalog: dict):
    pages_ok = sum(1 for p in catalog.get("pages", {}).values() if p.get("ok"))
    assets_ok = sum(1 for p in catalog.get("assets", {}).values() if p.get("ok"))
    videos_ok = sum(1 for p in catalog.get("videos", {}).values() if p.get("transcriptPath"))
    lines = [
        "# Digital Earth ISDE corpus",
        "",
        f"- Site: {BASE}",
        f"- Pages crawled: {pages_ok}",
        f"- Assets downloaded: {assets_ok}",
        f"- Videos transcribed: {videos_ok} / {len(catalog.get('videos', {}))}",
        f"- Updated: {catalog.get('updatedAt')}",
        "",
        "## Data layers / GIS references",
        "",
        "See `data-layers.json` for WMS/GHSL/Big Earth Data / Knowledge Platform mentions discovered while crawling.",
        "",
        "## Videos",
        "",
        "YouTube channel `@isde_digitalearth` plus on-site HLS lecture streams. "
        "Each video folder has meta.json, transcript.txt (source language), transcript.en.txt (English).",
        "",
        "## Commands",
        "",
        "```bash",
        "pnpm digitalearth:crawl",
        "pnpm digitalearth:videos",
        "pnpm digitalearth:ingest",
        "```",
        "",
    ]
    (CORPUS / "OVERVIEW.md").write_text("\n".join(lines), encoding="utf-8")


def ingest_knowledge(catalog: dict):
    import urllib.request

    base = os.environ.get("BASE_URL", "http://127.0.0.1:3333").rstrip("/")
    name = "Digital Earth ISDE"

    def api(path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            base + path,
            data=data,
            method="GET" if body is None else "POST",
            headers={"Content-Type": "application/json"} if body is not None else {},
        )
        return json.load(urllib.request.urlopen(req))

    projects = api("/api/knowledge/projects").get("projects") or []
    proj = next((p for p in projects if p.get("name") == name), None)
    if not proj:
        created = api("/api/knowledge/projects", {"name": name})
        proj = created.get("project") or created
    pid = proj["id"]
    files = [CORPUS / "OVERVIEW.md", CORPUS / "data-layers.json"]
    files += sorted((CORPUS / "digests").glob("*.md"))
    n = 0
    for fp in files:
        if not fp.exists():
            continue
        text = fp.read_text(encoding="utf-8", errors="replace")[:47_000]
        api("/api/knowledge", {"projectId": pid, "title": fp.stem[:120], "text": text})
        n += 1
        if n % 25 == 0:
            log(f"ingest {n}")
        time.sleep(0.03)
    log(f"ingest done project={name} id={pid} docs={n}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--crawl-only", action="store_true")
    ap.add_argument("--videos-only", action="store_true")
    ap.add_argument("--assets-only", action="store_true")
    ap.add_argument("--ingest-only", action="store_true")
    ap.add_argument("--limit-pages", type=int, default=0)
    ap.add_argument("--limit-assets", type=int, default=0)
    ap.add_argument("--limit-videos", type=int, default=0)
    args = ap.parse_args()
    ensure_dirs()
    catalog = load_json(CORPUS / "catalog.json", {"version": 1, "base": BASE, "pages": {}, "assets": {}, "videos": {}})

    if args.ingest_only:
        ingest_knowledge(catalog)
        return

    if not args.videos_only and not args.assets_only:
        catalog = crawl(limit_pages=args.limit_pages)
        download_assets(catalog, limit=args.limit_assets)

    if args.assets_only:
        download_assets(catalog, limit=args.limit_assets)

    if not args.crawl_only and not args.assets_only:
        process_videos(catalog, limit=args.limit_videos)

    write_overview(catalog)
    save_json(CORPUS / "catalog.json", catalog)
    log("complete")


if __name__ == "__main__":
    main()
