#!/usr/bin/env python3
"""
Archive META 2025 (Malaga) from https://metaconferences.org/META25/ into a local corpus.

Scope: META25 site content only. Skips promotional material for newer editions
(META 2026 / META 2027 / Niagara Falls / "current edition" banners) and does not
download other years' proceedings or META 2026 YouTube talks.

Layout:
  .data/meta25/
    pages/ digests/ pdfs/ media/ assets/ videos/
    catalog.json structure.json OVERVIEW.md speakers.json skipped-promo.json

Usage:
  .venv-monitors/bin/python scripts/meta25-corpus.py
  .venv-monitors/bin/python scripts/meta25-corpus.py --crawl-only
  .venv-monitors/bin/python scripts/meta25-corpus.py --assets-only
  .venv-monitors/bin/python scripts/meta25-corpus.py --videos-only
  .venv-monitors/bin/python scripts/meta25-corpus.py --ingest-only
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import time
import urllib.parse
import urllib.request
from collections import deque
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / ".data" / "meta25"
BASE = "https://metaconferences.org/META25"
BASE_PAGE = f"{BASE}/index.php/META"
YT_CHANNEL = "https://www.youtube.com/@metaconferences/videos"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
FFMPEG = str(ROOT / ".tools" / "ffmpeg")
YT_DLP = str(ROOT / ".venv-monitors" / "bin" / "yt-dlp")
OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
TRANSLATE_MODEL = os.environ.get("META25_TRANSLATE_MODEL", "qwen2.5:14b")
WHISPER_MODEL = os.environ.get("META25_WHISPER_MODEL", "small")
SLEEP = float(os.environ.get("META25_SLEEP", "0.2"))

# Newer-conference promo patterns (skip crawl targets + strip from digests)
PROMO_URL_RE = re.compile(
    r"META26|/META26/|META27|/META27/|META\s*2026|META\s*2027|niagara|quantum2025\.org|"
    r"aesconference\.org|editions\.html|submit\.html",
    re.I,
)
PROMO_TEXT_RE = re.compile(
    r"(?:The current edition is META 2027[^.]*\.)|"
    r"(?:META 2027\s*[—\-–][^.]*Niagara Falls[^.]*\.)|"
    r"(?:The 17th International Conference[^.]*2027[^.]*\.)|"
    r"(?:Call for Papers is open\.)|"
    r"(?:Next edition:\s*META 2027[^.]*\.)|"
    r"(?:META 2026[^.]*\.)",
    re.I,
)

PAGE_SEEDS = [
    f"{BASE_PAGE}/index",
    f"{BASE_PAGE}/about",
    f"{BASE_PAGE}/about/contact",
    f"{BASE_PAGE}/about/editorialTeam",
    f"{BASE_PAGE}/about/submissions",
    f"{BASE_PAGE}/announcement",
    f"{BASE_PAGE}/program",
    f"{BASE_PAGE}/plenaries",
    f"{BASE_PAGE}/sessions",
    f"{BASE_PAGE}/symposia",
    f"{BASE_PAGE}/tutorials",
    f"{BASE_PAGE}/workshop",
    f"{BASE_PAGE}/proceeding",
    f"{BASE_PAGE}/publication",
    f"{BASE_PAGE}/awards",
    f"{BASE_PAGE}/paper_awards",
    f"{BASE_PAGE}/APQ_award",
    f"{BASE_PAGE}/bsoa",
    f"{BASE_PAGE}/photos",
    f"{BASE_PAGE}/venue",
    f"{BASE_PAGE}/exhibitors",
    f"{BASE_PAGE}/sponsors",
    f"{BASE_PAGE}/social",
    f"{BASE_PAGE}/faq",
    f"{BASE_PAGE}/ethics",
    f"{BASE_PAGE}/contact",
    f"{BASE_PAGE}/mailing",
    f"{BASE_PAGE}/submission",
    f"{BASE_PAGE}/issue/archive",
    f"{BASE_PAGE}/issue/current",
]

KNOWN_ASSETS = [
    f"{BASE}/files/META2025_program.pdf",
    f"{BASE}/files/meta25_proceedings.pdf",
    f"{BASE}/files/flyer-sponsors-meta25.pdf",
    f"{BASE}/files/META_summary_template.doc",
    f"{BASE}/files/META_template_full.zip",
    "https://metaconferences.org/proceedings/meta25_proceedings.pdf",
]

SKIP_PATH_FRAGMENTS = (
    "/login",
    "/user/register",
    "/search/search",
    "/gateway/",
    "@@download",
)


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs: list[str] = []
        self.srcs: list[str] = []
        self.title = ""
        self.parts: list[str] = []
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        ad = dict(attrs)
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip += 1
        if tag == "title":
            self._in_title = True
        if tag == "a" and "href" in ad:
            self.hrefs.append(ad["href"])
        if tag in {"iframe", "source", "video", "audio", "embed", "img"} and "src" in ad:
            self.srcs.append(ad["src"])

    def handle_endtag(self, tag):
        if tag in {"script", "style", "noscript", "svg"} and self._skip:
            self._skip -= 1
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if self._skip:
            return
        t = data.strip()
        if t:
            self.parts.append(t)


def log(*a):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), "[meta25]", *a, flush=True)


def ensure_dirs():
    for p in [
        CORPUS,
        CORPUS / "pages",
        CORPUS / "digests",
        CORPUS / "pdfs",
        CORPUS / "media",
        CORPUS / "assets",
        CORPUS / "videos",
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


def normalize(url: str) -> str:
    u = urllib.parse.urljoin(BASE_PAGE + "/", url)
    p = urllib.parse.urlparse(u)
    return p._replace(fragment="").geturl()


def is_meta25(url: str) -> bool:
    host = urllib.parse.urlparse(url).netloc.lower()
    path = urllib.parse.urlparse(url).path
    if host not in {"", "metaconferences.org", "www.metaconferences.org"}:
        return False
    if "/META25/" in path or path.startswith("/META25"):
        return True
    # allow the single meta25 proceedings alias outside META25/
    if path.rstrip("/").endswith("/proceedings/meta25_proceedings.pdf"):
        return True
    return False


def is_promo_url(url: str) -> bool:
    return bool(PROMO_URL_RE.search(url))


def strip_promo_text(text: str) -> tuple[str, list[str]]:
    removed = []
    out = text
    for m in PROMO_TEXT_RE.finditer(text):
        removed.append(m.group(0).strip())
    out = PROMO_TEXT_RE.sub(" ", out)
    out = re.sub(r"\s+", " ", out).strip()
    return out, removed


def fetch_bytes(url: str, timeout: int = 180) -> tuple[bytes, str]:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers.get("Content-Type", "")


def extract_speakers_from_text(text: str) -> list[dict]:
    """Pull 'Plenary/Keynote' name blocks from plenaries-style pages."""
    speakers = []
    # Patterns like "Plenary Lecture N: Title Name Affiliation"
    for m in re.finditer(
        r"(Plenary Lecture\s*\d+|Keynote(?:\s*(?:Lecture|Talk))?\s*\d*)\s*:\s*(.+?)\s{2,}([A-Z][^0-9]{3,80}?)\s+((?:University|Institute|ETH|MIT|Caltech|CNRS|CSIC|A\*STAR|Samsung|Meta|Harvard|Stanford|Imperial|Max Planck)[^.]{0,120})",
        text,
    ):
        speakers.append(
            {
                "role": m.group(1).strip(),
                "talk": m.group(2).strip()[:240],
                "name": m.group(3).strip(),
                "affiliation": m.group(4).strip()[:200],
            }
        )
    # Fallback: lines with known image surnames already handled elsewhere
    return speakers


def crawl(catalog: dict, skipped: dict, limit_pages: int = 0) -> dict:
    q = deque(PAGE_SEEDS)
    seen: set[str] = set()
    fetched = 0
    promo_removed_all: list[dict] = skipped.setdefault("textSnippets", [])

    while q:
        url = normalize(q.popleft())
        if url in seen:
            continue
        seen.add(url)
        if is_promo_url(url):
            skipped.setdefault("urls", []).append({"url": url, "reason": "newer-conference-promo"})
            continue
        if not is_meta25(url):
            # record offsite refs lightly
            if url.startswith("http") and "metaconferences.org" not in url:
                skipped.setdefault("externalRefs", []).append(url)
            continue
        if any(frag in url for frag in SKIP_PATH_FRAGMENTS):
            continue
        if url in catalog.get("pages", {}) and catalog["pages"][url].get("ok"):
            continue
        if limit_pages and fetched >= limit_pages:
            break

        log(f"crawl {url}")
        try:
            raw, ctype = fetch_bytes(url, timeout=60)
        except Exception as e:
            catalog.setdefault("pages", {})[url] = {
                "ok": False,
                "error": str(e),
                "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            continue

        fetched += 1
        path_hash = sha1(url)[:12]
        is_html = (
            "html" in (ctype or "").lower()
            or raw[:200].lstrip().lower().startswith(b"<!doctype")
            or raw[:100].lstrip().startswith(b"<html")
        )
        if not is_html:
            ext = Path(urllib.parse.urlparse(url).path).suffix or ".bin"
            dest = CORPUS / "assets" / f"{path_hash}{ext}"
            dest.write_bytes(raw)
            catalog.setdefault("assets", {})[url] = {
                "ok": True,
                "path": str(dest.relative_to(CORPUS)),
                "bytes": len(raw),
                "contentType": ctype,
            }
            continue

        html = raw.decode("utf-8", "replace")
        page_file = CORPUS / "pages" / f"{path_hash}.html"
        page_file.write_bytes(raw)
        parser = PageParser()
        try:
            parser.feed(html)
        except Exception:
            pass
        title = re.sub(r"\s+", " ", (parser.title or "").strip()) or url
        text = re.sub(r"\s+", " ", " ".join(parser.parts)).strip()
        clean, removed = strip_promo_text(text)
        for r in removed:
            promo_removed_all.append({"url": url, "snippet": r[:300]})

        digest = CORPUS / "digests" / f"{path_hash}.md"
        digest.write_text(
            "\n".join(
                [
                    f"# {title}",
                    "",
                    f"**URL:** {url}",
                    f"**Crawled:** {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
                    "",
                    "_Newer-conference promotional blurbs (META 2026/2027) stripped from this digest._",
                    "",
                    "## Text",
                    "",
                    clean[:80_000],
                    "",
                ]
            ),
            encoding="utf-8",
        )

        if "plenaries" in url.lower():
            speakers = extract_speakers_from_text(clean)
            if speakers:
                save_json(CORPUS / "speakers.json", {"source": url, "speakers": speakers})

        for href in parser.hrefs + parser.srcs:
            absu = normalize(href)
            low = absu.lower().split("?")[0]
            if is_promo_url(absu):
                skipped.setdefault("urls", []).append({"url": absu, "reason": "newer-conference-promo", "from": url})
                continue
            # Only enqueue HTML content routes; binaries go to assets only.
            if is_meta25(absu) and "/index.php/META/" in absu:
                if absu not in seen and not any(frag in absu for frag in SKIP_PATH_FRAGMENTS):
                    if not any(
                        low.endswith(ext)
                        for ext in (
                            ".pdf",
                            ".zip",
                            ".doc",
                            ".docx",
                            ".ppt",
                            ".pptx",
                            ".mp4",
                            ".webm",
                            ".jpg",
                            ".jpeg",
                            ".png",
                            ".webp",
                            ".gif",
                            ".svg",
                        )
                    ):
                        q.append(absu)
            if any(
                low.endswith(ext)
                for ext in (".pdf", ".zip", ".doc", ".docx", ".ppt", ".pptx", ".mp4", ".webm")
            ):
                # only META25 files or meta25_proceedings alias
                if is_meta25(absu) or "meta25" in low:
                    # skip other years' proceedings even if linked from proceeding page
                    if re.search(r"meta(?:10|12|13|14|15|16|17|18|19|21|22|23|24|26|27)_proceedings", low):
                        skipped.setdefault("urls", []).append(
                            {"url": absu, "reason": "other-year-proceedings", "from": url}
                        )
                        continue
                    catalog.setdefault("assets", {})[absu] = catalog.get("assets", {}).get(absu) or {
                        "pending": True,
                        "from": url,
                    }
            if any(low.endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".webp", ".gif", ".JPG")):
                if "/META25/" in absu:
                    catalog.setdefault("assets", {})[absu] = catalog.get("assets", {}).get(absu) or {
                        "pending": True,
                        "from": url,
                        "kind": "image",
                    }
            for m in re.finditer(
                r"(?:youtube\.com/(?:watch\?v=|embed/)|youtu\.be/)([A-Za-z0-9_-]{6,})",
                absu + " " + href,
            ):
                key = f"https://www.youtube.com/watch?v={m.group(1)}"
                catalog.setdefault("videos", {})[key] = catalog.get("videos", {}).get(key) or {
                    "source": "page-embed",
                    "id": m.group(1),
                    "url": key,
                    "page": url,
                    "pending": True,
                }

        catalog.setdefault("pages", {})[url] = {
            "ok": True,
            "title": title,
            "path": str(page_file.relative_to(CORPUS)),
            "digest": str(digest.relative_to(CORPUS)),
            "bytes": len(raw),
            "textChars": len(clean),
            "promoStripped": len(removed),
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        if fetched % 10 == 0:
            catalog["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            save_json(CORPUS / "catalog.json", catalog)
            save_json(CORPUS / "skipped-promo.json", skipped)
        time.sleep(SLEEP)

    for u in KNOWN_ASSETS:
        catalog.setdefault("assets", {})[u] = catalog.get("assets", {}).get(u) or {
            "pending": True,
            "seed": True,
        }

    # dedupe skipped urls
    if "urls" in skipped:
        uniq, seen_u = [], set()
        for r in skipped["urls"]:
            k = (r.get("url"), r.get("reason"))
            if k in seen_u:
                continue
            seen_u.add(k)
            uniq.append(r)
        skipped["urls"] = uniq

    catalog["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    save_json(CORPUS / "catalog.json", catalog)
    save_json(CORPUS / "skipped-promo.json", skipped)
    log(f"crawl done pages={len(catalog.get('pages', {}))} assets={len(catalog.get('assets', {}))}")
    return catalog


def asset_filename(url: str, ctype: str) -> str:
    path = urllib.parse.urlparse(url).path
    name = Path(urllib.parse.unquote(path)).name or "file"
    if "pdf" in (ctype or "").lower() and not name.lower().endswith(".pdf"):
        name += ".pdf"
    name = re.sub(r"[^\w.\-()+]+", "_", name)[:180]
    return f"{sha1(url)[:10]}-{name}"


def download_assets(catalog: dict, limit: int = 0) -> dict:
    n = 0
    for url, meta in list(catalog.get("assets", {}).items()):
        if meta.get("ok") and meta.get("path"):
            continue
        if is_promo_url(url):
            catalog["assets"][url] = {"ok": False, "error": "skipped-promo", "skipped": True}
            continue
        # never pull other-year proceedings
        if re.search(r"meta(?:10|12|13|14|15|16|17|18|19|21|22|23|24|26|27)_proceedings", url, re.I):
            catalog["assets"][url] = {"ok": False, "error": "other-year-proceedings", "skipped": True}
            continue
        if limit and n >= limit:
            break
        log(f"asset {url}")
        try:
            raw, ctype = fetch_bytes(url, timeout=600)
            name = asset_filename(url, ctype)
            low = name.lower()
            if low.endswith(".pdf") or "pdf" in (ctype or "").lower() or raw[:5] == b"%PDF-":
                dest = CORPUS / "pdfs" / name
            elif any(low.endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg")):
                dest = CORPUS / "media" / name
            else:
                dest = CORPUS / "assets" / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(raw)
            text_chars = 0
            digest_rel = None
            if dest.suffix.lower() == ".pdf" or raw[:5] == b"%PDF-":
                r = subprocess.run(
                    ["pdftotext", "-layout", "-nopgbrk", str(dest), "-"],
                    capture_output=True,
                    timeout=600,
                )
                text = r.stdout.decode("utf-8", "replace")
                text_chars = len(text)
                dpath = CORPUS / "digests" / f"pdf-{sha1(url)[:10]}.md"
                # strip promo lines from PDF text too
                clean, _ = strip_promo_text(text)
                dpath.write_text(
                    f"# {dest.name}\n\n**URL:** {url}\n\n## Extracted text\n\n{clean[:100_000]}\n",
                    encoding="utf-8",
                )
                digest_rel = str(dpath.relative_to(CORPUS))
            catalog["assets"][url] = {
                "ok": True,
                "path": str(dest.relative_to(CORPUS)),
                "bytes": len(raw),
                "contentType": ctype,
                "textChars": text_chars,
                "digest": digest_rel,
            }
            n += 1
        except Exception as e:
            catalog["assets"][url] = {"ok": False, "error": str(e)}
            log(f"asset FAIL {e}")
        save_json(CORPUS / "catalog.json", catalog)
        time.sleep(SLEEP)
    return catalog


def is_meta25_video_title(title: str) -> bool:
    """Keep only META 2025-tagged talks, or unlabeled talks (no META year at all)."""
    t = title or ""
    # Any META year other than 2025 → reject (covers 2015–2024 and 2026–2027)
    years = re.findall(r"META\s*20(\d{2})", t, re.I)
    years += re.findall(r"META\s*(1[5-9]|2[0-7])\b", t, re.I)
    for y in years:
        yy = int(y)
        if yy < 100:
            # two-digit form: 15–27 → 2015–2027
            yy = 2000 + yy if yy >= 15 else yy
        if yy != 2025:
            return False
    if re.search(r"META\s*2025|META\s*25\b|META2025", t, re.I):
        return True
    # No META year in title → candidate for surname match later
    if not re.search(r"\bMETA\b", t, re.I):
        return False  # handled by surname path
    return False


def youtube_inventory(catalog: dict, skipped: dict):
    log("youtube inventory @metaconferences (META 2025 only)")
    cmd = [
        YT_DLP,
        "--flat-playlist",
        "--print",
        "%(id)s\t%(title)s\t%(duration)s\t%(webpage_url)s\t%(upload_date)s",
        YT_CHANNEL,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        log("youtube inventory error", r.stderr[:500])
    # surnames from plenaries page digest if present
    surnames: set[str] = set()
    for d in (CORPUS / "digests").glob("*.md"):
        if "plenar" in d.read_text(encoding="utf-8", errors="ignore")[:200].lower() or True:
            pass
    plenaries = CORPUS / "speakers.json"
    # Also parse plenaries digest for surnames
    for pmeta in catalog.get("pages", {}).values():
        if "plenaries" in str(pmeta.get("path", "")) or "Plenary" in str(pmeta.get("title", "")):
            dig = CORPUS / str(pmeta.get("digest") or "")
            if dig.exists():
                txt = dig.read_text(encoding="utf-8", errors="ignore")
                for name in re.findall(
                    r"\b([A-Z][a-z]+(?:\s+[A-Z]\.)?\s+(?:Boyd|Engheta|Platero|Yablonovitch|Al[uù]|Atwater|Pendry|Shalaev|Boltasseva|Soljacic|Sotomayor|[A-Z][a-z]{3,}))\b",
                    txt,
                ):
                    parts = name.split()
                    if parts:
                        surnames.add(parts[-1].lower())
                for s in re.findall(
                    r"\b(Boyd|Engheta|Platero|Yablonovitch|Alù|Alu|Atwater|Pendry|Shalaev|Boltasseva|Kroker|Hess|Baffou|Bachelot|Bliokh|Chen|Chang|Everschor|Ferry|Hersam|Kafesaki|Kildishev|Lalanne|Makris|Miniaci|Padilla|Sengupta|Soljacic|Sotomayor|Tournat|Yun|Smirnova)\b",
                    txt,
                    re.I,
                ):
                    surnames.add(s.lower())

    for line in r.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        vid, title, duration, url = parts[0], parts[1], parts[2], parts[3]
        upload = parts[4] if len(parts) > 4 else ""
        key = f"https://www.youtube.com/watch?v={vid}"
        # Reject any META year ≠ 2025 up front
        year_hits = re.findall(r"META\s*20(\d{2})", title, re.I)
        year_hits += re.findall(r"META\s*(1[5-9]|2[0-7])\b", title, re.I)
        other_year = False
        for y in year_hits:
            yy = int(y)
            if yy < 100:
                yy = 2000 + yy
            if yy != 2025:
                other_year = True
                reason = "newer-conference" if yy >= 2026 else "other-year"
                skipped.setdefault("videos", []).append({"url": key, "title": title, "reason": reason})
                break
        if other_year:
            # drop if previously kept by buggy filter
            catalog.get("videos", {}).pop(key, None)
            continue
        # Strict: only titles that name META 2025. Unlabeled channel uploads are often
        # older talks (homepage also embeds “past META” videos) — do not auto-include
        # by surname. Optional allowlist for known META25 plenary uploads without a year tag.
        UNLABELED_ALLOW = {
            "cd6GwRPnPJs",  # Gloria Platero — META25 plenary; sits next to Engheta META 2025
        }
        keep = bool(re.search(r"META\s*2025|META\s*25\b|META2025", title, re.I))
        if not keep and vid in UNLABELED_ALLOW:
            keep = True
        if not keep:
            skipped.setdefault("videos", []).append({"url": key, "title": title, "reason": "not-meta25"})
            catalog.get("videos", {}).pop(key, None)
            continue
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
    save_json(CORPUS / "skipped-promo.json", skipped)
    kept = sum(1 for v in catalog.get("videos", {}).values() if v.get("source") == "youtube")
    log(f"youtube META25 videos kept={kept} skipped={len(skipped.get('videos', []))}")


def translate_text(text: str, src_lang: str) -> str:
    if not text.strip() or src_lang.lower().startswith("en"):
        return text
    prompt = (
        f"Translate the following transcript from {src_lang} to clear, accurate English. "
        "Preserve names, technical terms, and paragraph breaks. Output ONLY the English translation.\n\n"
        f"{text[:12000]}"
    )
    body = {"model": TRANSLATE_MODEL, "prompt": prompt, "stream": False, "options": {"temperature": 0.1}}
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
    audio = vdir / "audio.wav"
    meta_path = vdir / "meta.json"

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

    mr = subprocess.run(
        [
            YT_DLP,
            "--skip-download",
            "--print",
            "%({id,title,description,duration,language,upload_date,channel,webpage_url,tags})j",
            url,
        ],
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

    import wave

    import numpy as np
    from faster_whisper import WhisperModel

    # Load wav ourselves — PyAV in this venv rejects faster-whisper's metadata_errors kwarg.
    with wave.open(str(audio), "rb") as wf:
        assert wf.getnchannels() == 1 and wf.getsampwidth() == 2
        audio_np = (
            np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16).astype(np.float32)
            / 32768.0
        )

    log(f"whisper {vid} model={WHISPER_MODEL} samples={len(audio_np)}")
    prefer_cpu = os.environ.get("META25_WHISPER_DEVICE", "").lower() == "cpu"
    segments, info = None, None
    if not prefer_cpu:
        try:
            model = WhisperModel(WHISPER_MODEL, device="cuda", compute_type="float16")
            segments, info = model.transcribe(audio_np, vad_filter=True)
        except Exception as e:
            log(f"whisper cuda fail ({e}); cpu")
    if segments is None:
        model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
        segments, info = model.transcribe(audio_np, vad_filter=True)
    lang = info.language or "unknown"
    lines = [f"[{seg.start:.1f}-{seg.end:.1f}] {seg.text.strip()}" for seg in segments]
    transcript = "\n".join(lines)
    (vdir / "transcript.txt").write_text(transcript, encoding="utf-8")
    translation = transcript
    if not str(lang).lower().startswith("en"):
        log(f"translate {vid} {lang} -> en")
        chunks, buf, buf_len, out = transcript.split("\n"), [], 0, []
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
                f"**Language:** {lang}",
                "",
                "## Transcript (English)",
                "",
                translation[:40_000],
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
            "title": entry.get("title") or meta.get("title"),
        }
    )
    catalog["videos"][url] = entry
    save_json(CORPUS / "catalog.json", catalog)
    return entry


def process_videos(catalog: dict, skipped: dict, limit: int = 0):
    youtube_inventory(catalog, skipped)
    items = [v for v in catalog.get("videos", {}).values() if not v.get("transcriptPath")]
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


def write_structure(catalog: dict, skipped: dict):
    pages_ok = sum(1 for p in catalog.get("pages", {}).values() if p.get("ok"))
    assets_ok = sum(1 for a in catalog.get("assets", {}).values() if a.get("ok"))
    videos_ok = sum(1 for v in catalog.get("videos", {}).values() if v.get("transcriptPath"))
    structure = {
        "version": 1,
        "event": "META 2025 — 15th International Conference on Metamaterials, Photonic Crystals and Plasmonics",
        "dates": "2025-07-22 .. 2025-07-25",
        "venue": "Malaga, Spain",
        "base": BASE_PAGE + "/index",
        "issn": "2429-1390",
        "scope": "META25 archive only; newer-conference promo excluded",
        "stats": {
            "pagesOk": pages_ok,
            "assetsOk": assets_ok,
            "videosTranscribed": videos_ok,
            "videosIndexed": len(catalog.get("videos", {})),
            "promoUrlsSkipped": len(skipped.get("urls", [])),
            "promoVideosSkipped": len(skipped.get("videos", [])),
        },
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    save_json(CORPUS / "structure.json", structure)
    lines = [
        "# META 2025 local archive",
        "",
        f"- Site: {BASE_PAGE}/index",
        "- Malaga, Spain, 22–25 July 2025",
        "- Scope: META25 content only; META 2026/2027 promotional material excluded",
        "",
        "## Stats",
        "",
        f"- Pages: {pages_ok}",
        f"- Assets: {assets_ok}",
        f"- Videos transcribed: {videos_ok} / {len(catalog.get('videos', {}))}",
        f"- Promo URLs skipped: {len(skipped.get('urls', []))}",
        f"- Non-META25 videos skipped: {len(skipped.get('videos', []))}",
        "",
        "## Key files",
        "",
        "- `pdfs/` — program, proceedings (~92MB), sponsor flyer",
        "- `digests/` — page + PDF text with 2026/2027 promo stripped",
        "- `skipped-promo.json` — what was filtered out",
        "",
        "## Commands",
        "",
        "```bash",
        "pnpm meta25:all",
        "pnpm meta25:ingest",
        "```",
        "",
    ]
    (CORPUS / "OVERVIEW.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def ingest_knowledge(catalog: dict):
    base = os.environ.get("BASE_URL", "http://127.0.0.1:3333").rstrip("/")
    name = "META 2025"

    def api(path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            base + path,
            data=data,
            method="GET" if body is None else "POST",
            headers={"Content-Type": "application/json"} if body is not None else {},
        )
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)

    try:
        projects = api("/api/knowledge/projects").get("projects") or []
    except Exception as e:
        log(f"ingest skip (API unreachable): {e}")
        return
    proj = next((p for p in projects if p.get("name") == name), None)
    if not proj:
        created = api("/api/knowledge/projects", {"name": name})
        proj = created.get("project") or created
    pid = proj["id"]
    files = [CORPUS / "OVERVIEW.md", CORPUS / "structure.json", CORPUS / "skipped-promo.json"]
    files += sorted((CORPUS / "digests").glob("*.md"))
    n = 0
    for fp in files:
        if not fp.exists():
            continue
        text = fp.read_text(encoding="utf-8", errors="replace")[:47_000]
        api("/api/knowledge", {"projectId": pid, "title": fp.stem[:120], "text": text})
        n += 1
        if n % 20 == 0:
            log(f"ingest {n}")
        time.sleep(0.03)
    log(f"ingest done project={name} id={pid} docs={n}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--crawl-only", action="store_true")
    ap.add_argument("--assets-only", action="store_true")
    ap.add_argument("--videos-only", action="store_true")
    ap.add_argument("--ingest-only", action="store_true")
    ap.add_argument("--limit-pages", type=int, default=0)
    ap.add_argument("--limit-assets", type=int, default=0)
    ap.add_argument("--limit-videos", type=int, default=0)
    args = ap.parse_args()

    ensure_dirs()
    catalog = load_json(
        CORPUS / "catalog.json",
        {"version": 1, "base": BASE, "pages": {}, "assets": {}, "videos": {}, "updatedAt": None},
    )
    skipped = load_json(CORPUS / "skipped-promo.json", {"urls": [], "videos": [], "textSnippets": []})

    if args.ingest_only:
        write_structure(catalog, skipped)
        ingest_knowledge(catalog)
        return

    if args.videos_only:
        process_videos(catalog, skipped, limit=args.limit_videos)
        write_structure(catalog, skipped)
        ingest_knowledge(catalog)
        log("complete")
        return

    if args.assets_only:
        download_assets(catalog, limit=args.limit_assets)
        write_structure(catalog, skipped)
        return

    if not args.assets_only and not args.videos_only:
        crawl(catalog, skipped, limit_pages=args.limit_pages)
        if not args.crawl_only:
            download_assets(catalog, limit=args.limit_assets)
            process_videos(catalog, skipped, limit=args.limit_videos)

    write_structure(catalog, skipped)
    if not args.crawl_only:
        ingest_knowledge(catalog)
    log("complete")


if __name__ == "__main__":
    main()
