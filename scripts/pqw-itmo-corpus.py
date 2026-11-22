#!/usr/bin/env python3
"""
Archive https://pqw.itmo.ru (Petersburg Quantum Weeks / ITMO) into a local corpus.

Tilda one-pager (EN + RU) plus linked PDFs from physics.itmo.ru and Google Drive.
Chrome User-Agent required (plain curl often 403). school.physics.itmo.ru currently
does not resolve; those links are recorded as unreachable.

Layout:
  .data/pqw-itmo/
    pages/ digests/ pdfs/ media/ assets/ videos/
    catalog.json structure.json OVERVIEW.md speakers.json

Usage:
  .venv-monitors/bin/python scripts/pqw-itmo-corpus.py
  .venv-monitors/bin/python scripts/pqw-itmo-corpus.py --pages-only
  .venv-monitors/bin/python scripts/pqw-itmo-corpus.py --assets-only
  .venv-monitors/bin/python scripts/pqw-itmo-corpus.py --ingest-only
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
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / ".data" / "pqw-itmo"
BASE = "https://pqw.itmo.ru"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
TRANSLATE_MODEL = os.environ.get("PQW_TRANSLATE_MODEL", "qwen2.5:14b")
SLEEP = float(os.environ.get("PQW_SLEEP", "0.2"))

PAGE_SEEDS = [
    f"{BASE}/en",
    f"{BASE}/",
    f"{BASE}/ru",
]

KNOWN_ASSETS = [
    "https://physics.itmo.ru/sites/default/files/PQW_2026.pdf",
    "https://physics.itmo.ru/sites/default/files/PQW_2026_Book_of_Abstracts.pdf",
    "https://itmo.ru/file/pages/79/personal_data_policy.pdf",
    "https://school.physics.itmo.ru/files/PQW_2026_template.zip",
    "https://school.physics.itmo.ru/files/%D0%9F%D1%83%D0%B1%D0%BB%D0%B8%D1%87%D0%BD%D0%B0%D1%8F_%D0%BE%D1%84%D0%B5%D1%80%D1%82%D0%B0.pdf",
    "https://drive.google.com/uc?export=download&id=1ndUVIe9GS-N7cNi5d02WTft9XKC394Fb",
]


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs: list[str] = []
        self.srcs: list[str] = []
        self.alts: list[str] = []
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
        if tag == "img" and ad.get("alt"):
            self.alts.append(ad["alt"])

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
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), "[pqw]", *a, flush=True)


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
    u = urllib.parse.urljoin(BASE + "/", url)
    p = urllib.parse.urlparse(u)
    return p._replace(fragment="").geturl()


def fetch_bytes(url: str, timeout: int = 120) -> tuple[bytes, str]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9,ru;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        ctype = r.headers.get("Content-Type", "")
        # follow already handled by urlopen for redirects
        return r.read(), ctype


def translate_text(text: str, src_lang: str = "ru") -> str:
    if not text.strip():
        return ""
    prompt = (
        f"Translate the following web page text from {src_lang} to clear, accurate English. "
        "Preserve names, affiliations, dates, fees, and technical terms. "
        "Output ONLY the English translation.\n\n"
        f"{text[:14000]}"
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


def extract_speakers(text: str) -> list[dict]:
    """Heuristic speaker list from EN page body after all-caps SPEAKERS heading."""
    # Case-sensitive: menu uses "Speakers"; section heading is "SPEAKERS".
    m = re.search(r"SPEAKERS\s+(.+?)\s+PROGRAM COMMITTEE", text, re.S)
    if not m:
        return []
    blob = m.group(1)
    # Name + affiliation + country patterns: "Valery Serbo Novosibirsk State University Russia"
    # Split on known country tokens at end of entries
    countries = (
        "Russia|USA|China|Israel|Belarus|Germany|France|UK|United Kingdom|"
        "Japan|Italy|Spain|Canada|Netherlands|Switzerland|Sweden|Finland|"
        "Poland|Korea|South Korea|India|Australia"
    )
    parts = re.split(rf"\b({countries})\b", blob)
    speakers = []
    i = 0
    while i + 1 < len(parts):
        left = parts[i].strip(" ,;")
        country = parts[i + 1].strip()
        i += 2
        if not left:
            continue
        # last 1–N words after first 2–4 name tokens are affiliation
        tokens = left.split()
        if len(tokens) < 2:
            continue
        # assume 2-word name if second token capitalized and third looks institutional
        name_n = 2
        if len(tokens) >= 3 and tokens[1][0:1].islower():
            name_n = 1
        elif len(tokens) >= 3 and tokens[2][0:1].isupper() and tokens[2].lower() not in {
            "university", "institute", "joint", "nrc", "moscow", "saint", "st.", "sun", "technion",
            "stepanov", "inr", "hse-physics", "hse",
        }:
            # possibly 3-part name (e.g. nothing common) — keep 2 unless middle is initial-like
            if re.match(r"^[A-Z]\.?$", tokens[1]):
                name_n = 3
        name = " ".join(tokens[:name_n])
        aff = " ".join(tokens[name_n:]).strip()
        if re.search(r"more speakers|to be announced", name, re.I):
            continue
        speakers.append({"name": name, "affiliation": aff, "country": country})
    return speakers


def extract_program_committee(text: str) -> list[dict]:
    m = re.search(r"PROGRAM COMMITTEE\s+(.+?)\s+PARTICIPATION OPTIONS", text, re.I | re.S)
    if not m:
        return []
    return extract_speakers("SPEAKERS " + m.group(1) + " PROGRAM COMMITTEE")


def crawl_pages(catalog: dict) -> dict:
    for url in PAGE_SEEDS:
        url = normalize(url)
        log(f"page {url}")
        try:
            raw, ctype = fetch_bytes(url, timeout=60)
        except Exception as e:
            catalog.setdefault("pages", {})[url] = {
                "ok": False,
                "error": str(e),
                "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            continue
        path_hash = sha1(url)[:12]
        page_file = CORPUS / "pages" / f"{path_hash}.html"
        page_file.write_bytes(raw)
        html = raw.decode("utf-8", "replace")
        parser = PageParser()
        try:
            parser.feed(html)
        except Exception:
            pass
        title = (parser.title or "").strip() or url
        text = re.sub(r"\s+", " ", " ".join(parser.parts)).strip()
        lang = "en" if "/en" in urllib.parse.urlparse(url).path.rstrip("/") else "ru"
        digest = CORPUS / "digests" / f"{path_hash}.md"
        digest_body = [
            f"# {title}",
            "",
            f"**URL:** {url}",
            f"**Language:** {lang}",
            f"**Crawled:** {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
            "",
            "## Text",
            "",
            text[:80_000],
            "",
        ]
        en_path = None
        if lang == "ru" and text:
            log(f"translate RU page -> EN via {TRANSLATE_MODEL}")
            try:
                # chunk if needed
                chunks = []
                for i in range(0, len(text), 12000):
                    chunks.append(translate_text(text[i : i + 12000], "ru"))
                en = "\n\n".join(chunks)
                en_file = CORPUS / "digests" / f"{path_hash}.en.md"
                en_file.write_text(
                    f"# {title} (English translation)\n\n**URL:** {url}\n\n{en}\n",
                    encoding="utf-8",
                )
                en_path = str(en_file.relative_to(CORPUS))
                digest_body.extend(["## English translation", "", en[:60_000], ""])
            except Exception as e:
                log(f"translate FAIL {e}")
                digest_body.extend(["## English translation", "", f"_(failed: {e})_", ""])
        digest.write_text("\n".join(digest_body), encoding="utf-8")

        # discover assets from page
        for href in parser.hrefs + parser.srcs:
            absu = normalize(href)
            low = absu.lower().split("?")[0]
            if any(low.endswith(ext) for ext in (".pdf", ".zip", ".mp4", ".webm", ".pptx", ".docx")):
                catalog.setdefault("assets", {})[absu] = catalog.get("assets", {}).get(absu) or {
                    "pending": True,
                    "from": url,
                }
            if "drive.google.com" in absu.lower() or "drive.usercontent.google.com" in absu.lower():
                catalog.setdefault("assets", {})[absu] = catalog.get("assets", {}).get(absu) or {
                    "pending": True,
                    "from": url,
                    "kind": "gdrive",
                }
            # tilda speaker images
            if "tildacdn.com" in absu.lower() and any(
                absu.lower().endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".webp")
            ):
                catalog.setdefault("assets", {})[absu] = catalog.get("assets", {}).get(absu) or {
                    "pending": True,
                    "from": url,
                    "kind": "image",
                }

        # real video embeds only
        for m in re.finditer(
            r"(?:youtube\.com/(?:watch\?v=|embed/|shorts/)|youtu\.be/)([A-Za-z0-9_-]{6,})",
            html,
        ):
            key = f"https://www.youtube.com/watch?v={m.group(1)}"
            catalog.setdefault("videos", {})[key] = catalog.get("videos", {}).get(key) or {
                "source": "embed",
                "id": m.group(1),
                "url": key,
                "page": url,
                "pending": True,
            }

        speakers = extract_speakers(text) if lang == "en" else []
        committee = extract_program_committee(text) if lang == "en" else []
        if speakers:
            save_json(CORPUS / "speakers.json", {"speakers": speakers, "programCommittee": committee})

        catalog.setdefault("pages", {})[url] = {
            "ok": True,
            "title": title,
            "lang": lang,
            "path": str(page_file.relative_to(CORPUS)),
            "digest": str(digest.relative_to(CORPUS)),
            "digestEn": en_path,
            "bytes": len(raw),
            "textChars": len(text),
            "speakerCount": len(speakers) if speakers else None,
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        time.sleep(SLEEP)

    # seed known assets
    for u in KNOWN_ASSETS:
        catalog.setdefault("assets", {})[u] = catalog.get("assets", {}).get(u) or {"pending": True, "seed": True}

    catalog["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    save_json(CORPUS / "catalog.json", catalog)
    return catalog


def asset_filename(url: str, ctype: str) -> str:
    path = urllib.parse.urlparse(url).path
    name = Path(urllib.parse.unquote(path)).name or "file"
    if "drive.google" in url or "drive.usercontent" in url:
        name = "gdrive-1ndUVIe9GS-N7cNi5d02WTft9XKC394Fb.pdf"
    if "pdf" in (ctype or "").lower() and not name.lower().endswith(".pdf"):
        name += ".pdf"
    # sanitize
    name = re.sub(r"[^\w.\-()+]+", "_", name)[:180]
    return f"{sha1(url)[:10]}-{name}"


def download_assets(catalog: dict, limit: int = 0) -> dict:
    n = 0
    for url, meta in list(catalog.get("assets", {}).items()):
        if meta.get("ok") and meta.get("path"):
            continue
        if limit and n >= limit:
            break
        log(f"asset {url}")
        try:
            raw, ctype = fetch_bytes(url, timeout=180)
            # Google sometimes returns HTML interstitial
            if b"<!doctype html" in raw[:200].lower() or b"<html" in raw[:200].lower():
                # try confirm token pattern for large files — this drive file is small PDF already usually
                if b"%PDF" not in raw[:1024]:
                    raise RuntimeError(f"HTML response instead of file (ctype={ctype})")
            name = asset_filename(url, ctype)
            low = name.lower()
            if low.endswith(".pdf") or "pdf" in (ctype or "").lower() or raw[:5] == b"%PDF-":
                dest = CORPUS / "pdfs" / name
                if not dest.name.lower().endswith(".pdf"):
                    dest = dest.with_suffix(dest.suffix + ".pdf")
            elif low.endswith((".jpg", ".jpeg", ".png", ".webp", ".svg", ".gif")):
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
                    timeout=180,
                )
                text = r.stdout.decode("utf-8", "replace")
                text_chars = len(text)
                dpath = CORPUS / "digests" / f"pdf-{sha1(url)[:10]}.md"
                dpath.write_text(
                    f"# {dest.name}\n\n**URL:** {url}\n\n## Extracted text\n\n{text[:80_000]}\n",
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
            catalog["assets"][url] = {
                "ok": False,
                "error": str(e),
                "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            log(f"asset FAIL {e}")
        save_json(CORPUS / "catalog.json", catalog)
        time.sleep(SLEEP)
    return catalog


def write_structure(catalog: dict):
    speakers = load_json(CORPUS / "speakers.json", {})
    pages_ok = sum(1 for p in catalog.get("pages", {}).values() if p.get("ok"))
    assets_ok = sum(1 for a in catalog.get("assets", {}).values() if a.get("ok"))
    assets_fail = [
        {"url": u, "error": a.get("error")}
        for u, a in catalog.get("assets", {}).items()
        if a.get("ok") is False
    ]
    pdfs = [
        {"url": u, **{k: a[k] for k in ("path", "bytes", "textChars", "digest") if k in a}}
        for u, a in catalog.get("assets", {}).items()
        if a.get("ok") and str(a.get("path", "")).endswith(".pdf")
    ]
    structure = {
        "version": 1,
        "base": BASE,
        "event": "Petersburg Quantum Weeks 2026",
        "dates": "2026-07-01 .. 2026-07-09",
        "venue": "9 Lomonosova Street, St. Petersburg, 191002, Russian Federation",
        "contact": "pqw@itmo.ru",
        "facets": {
            "pages": {"en": f"{BASE}/en", "ru": f"{BASE}/"},
            "program": ["School July 1–4", "Conference (ISCTP) July 6–9"],
            "topics": [
                "Theoretical Physics",
                "Quantum Computing",
                "Quantum Optics",
                "Atomic Physics",
                "Particle Physics",
                "Solid-State Physics",
                "Astrophysics",
                "Neutrino Physics",
                "Accelerator Physics",
                "Strong-field QED",
                "Highly Charged Ions",
                "Topological Photonics",
            ],
            "speakers": speakers.get("speakers", []),
            "programCommittee": speakers.get("programCommittee", []),
            "pdfs": pdfs,
        },
        "stats": {
            "pagesOk": pages_ok,
            "assetsOk": assets_ok,
            "assetsFailed": len(assets_fail),
            "videos": len(catalog.get("videos", {})),
            "speakerCount": len(speakers.get("speakers", [])),
        },
        "unreachable": assets_fail,
        "notes": [
            "Site is a Tilda one-pager; Chrome UA required.",
            "No embedded talk videos found on the site; YouTube search has no dedicated PQW 2026 channel.",
            "school.physics.itmo.ru does not resolve (template zip + public offer PDF unavailable).",
            "RU page digests include Ollama English translation when available.",
        ],
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    save_json(CORPUS / "structure.json", structure)

    overview = [
        "# Petersburg Quantum Weeks (PQW) 2026 — local archive",
        "",
        f"- Site: {BASE}/en (EN) · {BASE}/ (RU)",
        "- Dates: July 1–9, 2026 · Venue: 9 Lomonosova St, St. Petersburg",
        "- Contact: pqw@itmo.ru",
        "",
        "## Corpus stats",
        "",
        f"- Pages OK: {pages_ok}",
        f"- Assets OK: {assets_ok} (failed: {len(assets_fail)})",
        f"- Speakers parsed: {len(speakers.get('speakers', []))}",
        f"- Videos: {len(catalog.get('videos', {}))} (none expected on-site)",
        "",
        "## Key PDFs",
        "",
    ]
    for p in pdfs:
        overview.append(f"- `{p.get('path')}` — {p.get('url')} ({p.get('bytes')} bytes, {p.get('textChars')} text chars)")
    if assets_fail:
        overview.extend(["", "## Unreachable", ""])
        for a in assets_fail:
            overview.append(f"- {a['url']}: {a.get('error')}")
    overview.extend(
        [
            "",
            "## Retrieval",
            "",
            "Use agent tool `search_pqw_itmo` or browse `.data/pqw-itmo/`.",
            "",
        ]
    )
    (CORPUS / "OVERVIEW.md").write_text("\n".join(overview) + "\n", encoding="utf-8")
    log(f"structure pages={pages_ok} assets_ok={assets_ok} speakers={len(speakers.get('speakers', []))}")


def ingest_knowledge(catalog: dict):
    base = os.environ.get("BASE_URL", "http://127.0.0.1:3333").rstrip("/")
    name = "PQW ITMO 2026"

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
    files = [CORPUS / "OVERVIEW.md", CORPUS / "structure.json", CORPUS / "speakers.json"]
    files += sorted((CORPUS / "digests").glob("*.md"))
    n = 0
    for fp in files:
        if not fp.exists():
            continue
        text = fp.read_text(encoding="utf-8", errors="replace")[:47_000]
        api("/api/knowledge", {"projectId": pid, "title": fp.stem[:120], "text": text})
        n += 1
        if n % 10 == 0:
            log(f"ingest {n}")
        time.sleep(0.03)
    log(f"ingest done project={name} id={pid} docs={n}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages-only", action="store_true")
    ap.add_argument("--assets-only", action="store_true")
    ap.add_argument("--ingest-only", action="store_true")
    ap.add_argument("--limit-assets", type=int, default=0)
    args = ap.parse_args()

    ensure_dirs()
    catalog = load_json(
        CORPUS / "catalog.json",
        {"version": 1, "base": BASE, "pages": {}, "assets": {}, "videos": {}, "updatedAt": None},
    )

    if args.ingest_only:
        write_structure(catalog)
        ingest_knowledge(catalog)
        return

    if not args.assets_only:
        crawl_pages(catalog)
    if not args.pages_only:
        download_assets(catalog, limit=args.limit_assets)
    write_structure(catalog)
    if not args.pages_only and not args.assets_only:
        ingest_knowledge(catalog)
    log("done")


if __name__ == "__main__":
    main()
