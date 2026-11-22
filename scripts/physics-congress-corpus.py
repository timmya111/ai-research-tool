#!/usr/bin/env python3
"""
Archive https://physics-congress.kz (Physics Congress 2026, Nazarbayev University, Astana).

Tilda site + linked Google Drive PDFs / Docs / Slides. No on-site talk videos found
at build time; hotel booking shortlinks are recorded as external refs only.

Layout:
  .data/physics-congress/
    pages/ digests/ pdfs/ media/ assets/ docs/
    catalog.json structure.json OVERVIEW.md speakers.json

Usage:
  .venv-monitors/bin/python scripts/physics-congress-corpus.py
  .venv-monitors/bin/python scripts/physics-congress-corpus.py --pages-only
  .venv-monitors/bin/python scripts/physics-congress-corpus.py --assets-only
  .venv-monitors/bin/python scripts/physics-congress-corpus.py --ingest-only
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
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / ".data" / "physics-congress"
BASE = "https://physics-congress.kz"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
SLEEP = float(os.environ.get("PC_SLEEP", "0.25"))

PAGE_SEEDS = [
    f"{BASE}/",
    f"{BASE}/plenary_speakers",
    f"{BASE}/program",
    f"{BASE}/venue",
    f"{BASE}/accommodation",
    f"{BASE}/visitastana",
    f"{BASE}/special_events",
    f"{BASE}/photo_gallery",
    f"{BASE}/dynamics_days",
    f"{BASE}/kps",
    f"{BASE}/ofssdt",
]

# Form result pages — keep lightly or skip body
SKIP_HEAVY = {f"{BASE}/failed", f"{BASE}/success"}

DRIVE_FILES = [
    ("1ZeeH8XyLbVbdGae7WFyb8Dmvg5DumqVr", "drive-1ZeeH8Xy.pdf"),
    ("1lrBbycqqCOR2rUdA-e1xEuutY8vUbYQJ", "drive-1lrBbycq.pdf"),
    ("1o4d2r8NQ3fL221iCFWTWQFN5zY0aoXhc", "drive-1o4d2r8N.pdf"),
]
DOC_IDS = [
    ("1UfV1CaDYhb0Wy4hSYdzcf2l9e1NhXutE", "abstract-template-general.txt"),
    ("1gbpX2ZJwH1n094B6TS0PgkONdDs0exs-", "abstract-template-ofssdt.txt"),
    ("16e-ul-i0sM6lXR-wDszwK-mrLcq0sbGP", "doc-16e-ul-i0.txt"),
]
SLIDE_IDS = [
    ("1a9B2eLlmz09AbBl9O_ZIp3KHmKgChppi", "slides-1a9B2eLl.pdf"),
    ("1vsnDRnqSW_K_JTzg3L_PCioQc8lDwDMr", "slides-1vsnDRnq.pdf"),
]


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
        for _k, v in attrs:
            if not v:
                continue
            lv = v.lower()
            if "youtube.com" in lv or "youtu.be" in lv or lv.endswith(".pdf"):
                self.hrefs.append(v)

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
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), "[physics-congress]", *a, flush=True)


def ensure_dirs():
    for p in [
        CORPUS,
        CORPUS / "pages",
        CORPUS / "digests",
        CORPUS / "pdfs",
        CORPUS / "media",
        CORPUS / "assets",
        CORPUS / "docs",
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


def same_site(url: str) -> bool:
    p = urllib.parse.urlparse(url)
    if p.scheme in {"mailto", "tel", "javascript"}:
        return False
    host = p.netloc.lower()
    return host in {"", "physics-congress.kz", "www.physics-congress.kz"}


def fetch_bytes(url: str, timeout: int = 180) -> tuple[bytes, str, str]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers.get("Content-Type", ""), r.geturl()


def seed_from_sitemap() -> list[str]:
    seeds = list(PAGE_SEEDS)
    try:
        raw, _, _ = fetch_bytes(f"{BASE}/sitemap.xml", timeout=30)
        for loc in re.findall(r"<loc>([^<]+)</loc>", raw.decode("utf-8", "replace")):
            seeds.append(loc.strip())
    except Exception as e:
        log(f"sitemap FAIL {e}")
    # unique preserve order
    out, seen = [], set()
    for u in seeds:
        u = normalize(u)
        if u in seen:
            continue
        seen.add(u)
        out.append(u)
    return out


def extract_speakers(text: str) -> list[dict]:
    """Curated plenary/special-event speakers with bio snippets from page text."""

    def bio_after(marker: str, n: int = 700) -> str:
        i = text.find(marker)
        if i < 0:
            return ""
        return re.sub(r"\s+", " ", text[i : i + n + 100])[:n]

    curated = [
        (
            "Rafael Mariano Grossi",
            "International Atomic Energy Agency",
            "special_event",
            "Public Lecture by Rafael Mariano Grossi, Director General of the International Atomic Energy Agency.",
        ),
        (
            "Aurora Tumino",
            "Kore University of Enna / INFN-LNS Catania",
            "plenary",
            bio_after("Aurora Tumino is a Professor"),
        ),
        (
            "Ebrahim Karimi",
            "Chapman University / University of Ottawa",
            "plenary",
            bio_after("Professor Ebrahim Karimi is a Professor"),
        ),
        (
            "Yang Ran",
            "Jinan University, China",
            "plenary",
            bio_after("Yang Ran is a Professor"),
        ),
        (
            "Eugene Demler",
            "Institute for Theoretical Physics, ETH Zurich",
            "plenary",
            bio_after("Eugene Demler is a Professor"),
        ),
        (
            "Minghong Yang",
            "National Engineering Research Center for Fiber Optic Sensing Technologies",
            "plenary",
            bio_after("Minghong Yang"),
        ),
        (
            "Qi Ma",
            "Suzhou Institute of Nano-Tech and Nano-Bionics, Chinese Academy of Sciences",
            "plenary",
            bio_after("Qi Ma"),
        ),
        (
            "Giulio Casati",
            "University of Insubria and Lake Como School of Advanced Studies",
            "plenary",
            bio_after("Giulio Casati graduated"),
        ),
    ]
    speakers = []
    for name, aff, role, bio in curated:
        if name != "Rafael Mariano Grossi" and name not in text and not bio:
            continue
        speakers.append(
            {
                "name": name,
                "affiliation": aff,
                "role": role,
                "bio": bio or bio_after(name),
            }
        )
    return speakers


def crawl_pages(catalog: dict) -> dict:
    seeds = seed_from_sitemap()
    for url in seeds:
        if not same_site(url):
            continue
        if url in catalog.get("pages", {}) and catalog["pages"][url].get("ok"):
            continue
        log(f"page {url}")
        try:
            raw, ctype, final = fetch_bytes(url, timeout=60)
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
        title = re.sub(r"\s+", " ", (parser.title or "").strip()) or url
        text = re.sub(r"\s+", " ", " ".join(parser.parts)).strip()
        # lightweight skip note for form pages
        if url.rstrip("/") in {u.rstrip("/") for u in SKIP_HEAVY}:
            text = text[:500]

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

        if "plenary" in url:
            speakers = extract_speakers(text)
            if speakers:
                save_json(CORPUS / "speakers.json", {"source": url, "speakers": speakers})
                log(f"speakers parsed={len(speakers)}")

        for href in parser.hrefs + parser.srcs:
            absu = normalize(href)
            low = absu.lower().split("?")[0]
            if same_site(absu) and absu not in seeds:
                # discover extra on-site pages
                if not any(low.endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".webp", ".svg", ".gif", ".css", ".js")):
                    if "/tilda/" not in low:
                        seeds.append(absu)
            if any(low.endswith(ext) for ext in (".pdf", ".zip", ".doc", ".docx", ".pptx")):
                catalog.setdefault("assets", {})[absu] = catalog.get("assets", {}).get(absu) or {
                    "pending": True,
                    "from": url,
                }
            if "drive.google.com" in absu or "docs.google.com" in absu:
                catalog.setdefault("assets", {})[absu] = catalog.get("assets", {}).get(absu) or {
                    "pending": True,
                    "from": url,
                    "kind": "gdrive",
                }
            if ("tildacdn" in absu or "thb.tilda" in absu) and any(
                absu.lower().endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".webp")
            ):
                # speaker / gallery images
                if "plenary" in url or "photo" in url or "gallery" in url:
                    catalog.setdefault("assets", {})[absu] = catalog.get("assets", {}).get(absu) or {
                        "pending": True,
                        "from": url,
                        "kind": "image",
                    }
            for m in re.finditer(
                r"(?:youtube\.com/(?:watch\?v=|embed/|shorts/)|youtu\.be/)([A-Za-z0-9_-]{6,})",
                absu,
            ):
                key = f"https://www.youtube.com/watch?v={m.group(1)}"
                catalog.setdefault("videos", {})[key] = catalog.get("videos", {}).get(key) or {
                    "source": "page",
                    "id": m.group(1),
                    "url": key,
                    "page": url,
                    "pending": True,
                }
            # hotel shortlinks → external refs only
            if "bit.ly" in absu or "booking.com" in absu:
                catalog.setdefault("externalRefs", {})[absu] = {"from": url, "kind": "accommodation"}

        catalog.setdefault("pages", {})[url] = {
            "ok": True,
            "title": title,
            "finalUrl": final,
            "path": str(page_file.relative_to(CORPUS)),
            "digest": str(digest.relative_to(CORPUS)),
            "bytes": len(raw),
            "textChars": len(text),
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        time.sleep(SLEEP)

    catalog["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    save_json(CORPUS / "catalog.json", catalog)
    return catalog


def download_drive_bundle(catalog: dict):
    """Fetch known Drive PDFs, Docs (txt), Slides (pdf)."""
    for fid, name in DRIVE_FILES:
        url = f"https://drive.usercontent.google.com/download?id={fid}&export=download"
        key = f"https://drive.google.com/file/d/{fid}/view"
        if catalog.get("assets", {}).get(key, {}).get("ok"):
            continue
        log(f"drive {fid}")
        try:
            raw, ctype, _ = fetch_bytes(url, timeout=600)
            if raw[:4] != b"%PDF" and b"%PDF" not in raw[:1024]:
                raise RuntimeError(f"not a PDF (ctype={ctype}, head={raw[:40]!r})")
            dest = CORPUS / "pdfs" / f"{sha1(fid)[:10]}-{name}"
            dest.write_bytes(raw)
            text_chars = 0
            digest_rel = None
            r = subprocess.run(
                ["pdftotext", "-layout", "-nopgbrk", str(dest), "-"],
                capture_output=True,
                timeout=600,
            )
            text = r.stdout.decode("utf-8", "replace")
            text_chars = len(text)
            dpath = CORPUS / "digests" / f"pdf-{sha1(fid)[:10]}.md"
            dpath.write_text(
                f"# {name}\n\n**URL:** {key}\n\n## Extracted text\n\n{text[:100_000]}\n",
                encoding="utf-8",
            )
            digest_rel = str(dpath.relative_to(CORPUS))
            catalog.setdefault("assets", {})[key] = {
                "ok": True,
                "path": str(dest.relative_to(CORPUS)),
                "bytes": len(raw),
                "contentType": ctype,
                "textChars": text_chars,
                "digest": digest_rel,
                "driveId": fid,
            }
        except Exception as e:
            catalog.setdefault("assets", {})[key] = {"ok": False, "error": str(e), "driveId": fid}
            log(f"drive FAIL {fid}: {e}")
        save_json(CORPUS / "catalog.json", catalog)
        time.sleep(SLEEP)

    for fid, name in DOC_IDS:
        url = f"https://docs.google.com/document/d/{fid}/export?format=txt"
        key = f"https://docs.google.com/document/d/{fid}/edit"
        if catalog.get("assets", {}).get(key, {}).get("ok"):
            continue
        log(f"doc {fid}")
        try:
            raw, ctype, _ = fetch_bytes(url, timeout=60)
            text = raw.decode("utf-8", "replace")
            dest = CORPUS / "docs" / f"{sha1(fid)[:10]}-{name}"
            dest.write_text(text, encoding="utf-8")
            dpath = CORPUS / "digests" / f"doc-{sha1(fid)[:10]}.md"
            dpath.write_text(
                f"# {name}\n\n**URL:** {key}\n\n## Text\n\n{text[:80_000]}\n",
                encoding="utf-8",
            )
            catalog.setdefault("assets", {})[key] = {
                "ok": True,
                "path": str(dest.relative_to(CORPUS)),
                "bytes": len(raw),
                "contentType": ctype,
                "textChars": len(text),
                "digest": str(dpath.relative_to(CORPUS)),
                "driveId": fid,
            }
        except Exception as e:
            catalog.setdefault("assets", {})[key] = {"ok": False, "error": str(e), "driveId": fid}
            log(f"doc FAIL {fid}: {e}")
        save_json(CORPUS / "catalog.json", catalog)
        time.sleep(SLEEP)

    for fid, name in SLIDE_IDS:
        url = f"https://docs.google.com/presentation/d/{fid}/export/pdf"
        key = f"https://docs.google.com/presentation/d/{fid}/edit"
        if catalog.get("assets", {}).get(key, {}).get("ok"):
            continue
        log(f"slides {fid}")
        try:
            raw, ctype, _ = fetch_bytes(url, timeout=120)
            dest = CORPUS / "pdfs" / f"{sha1(fid)[:10]}-{name}"
            dest.write_bytes(raw)
            r = subprocess.run(
                ["pdftotext", "-layout", "-nopgbrk", str(dest), "-"],
                capture_output=True,
                timeout=120,
            )
            text = r.stdout.decode("utf-8", "replace")
            dpath = CORPUS / "digests" / f"slides-{sha1(fid)[:10]}.md"
            dpath.write_text(
                f"# {name}\n\n**URL:** {key}\n\n## Extracted text\n\n{text[:80_000]}\n",
                encoding="utf-8",
            )
            catalog.setdefault("assets", {})[key] = {
                "ok": True,
                "path": str(dest.relative_to(CORPUS)),
                "bytes": len(raw),
                "contentType": ctype,
                "textChars": len(text),
                "digest": str(dpath.relative_to(CORPUS)),
                "driveId": fid,
            }
        except Exception as e:
            catalog.setdefault("assets", {})[key] = {"ok": False, "error": str(e), "driveId": fid}
            log(f"slides FAIL {fid}: {e}")
        save_json(CORPUS / "catalog.json", catalog)
        time.sleep(SLEEP)


def download_assets(catalog: dict, limit: int = 0) -> dict:
    download_drive_bundle(catalog)
    n = 0
    for url, meta in list(catalog.get("assets", {}).items()):
        if meta.get("ok") and meta.get("path"):
            continue
        if meta.get("driveId"):
            continue  # handled above
        if "docs.google.com" in url or "drive.google.com" in url or "drive.usercontent" in url:
            continue
        if limit and n >= limit:
            break
        log(f"asset {url}")
        try:
            raw, ctype, _ = fetch_bytes(url, timeout=180)
            name = Path(urllib.parse.unquote(urllib.parse.urlparse(url).path)).name or "file"
            name = re.sub(r"[^\w.\-()+]+", "_", name)[:160]
            fname = f"{sha1(url)[:10]}-{name}"
            low = name.lower()
            if low.endswith((".jpg", ".jpeg", ".png", ".webp", ".gif")) or "image" in (ctype or ""):
                dest = CORPUS / "media" / fname
            elif low.endswith(".pdf") or raw[:4] == b"%PDF":
                dest = CORPUS / "pdfs" / fname
            else:
                dest = CORPUS / "assets" / fname
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(raw)
            catalog["assets"][url] = {
                "ok": True,
                "path": str(dest.relative_to(CORPUS)),
                "bytes": len(raw),
                "contentType": ctype,
            }
            n += 1
        except Exception as e:
            catalog["assets"][url] = {"ok": False, "error": str(e)}
            log(f"asset FAIL {e}")
        save_json(CORPUS / "catalog.json", catalog)
        time.sleep(SLEEP)
    return catalog


def write_structure(catalog: dict):
    speakers = load_json(CORPUS / "speakers.json", {})
    pages_ok = sum(1 for p in catalog.get("pages", {}).values() if p.get("ok"))
    assets_ok = sum(1 for a in catalog.get("assets", {}).values() if a.get("ok"))
    structure = {
        "version": 1,
        "event": "Physics Congress 2026",
        "venue": "Nazarbayev University, Astana, Kazakhstan",
        "contact": "pc2026@nu.edu.kz",
        "base": BASE,
        "tracks": [
            "Dynamics Days Central Asia and Caucasus",
            "International Symposium on Optical Sensors 2026 (ISOS2026)",
            "5th Annual Meeting of Kazakh Physical Society",
        ],
        "stats": {
            "pagesOk": pages_ok,
            "assetsOk": assets_ok,
            "speakers": len(speakers.get("speakers", [])),
            "videos": len(catalog.get("videos", {})),
            "externalRefs": len(catalog.get("externalRefs", {})),
        },
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    save_json(CORPUS / "structure.json", structure)
    lines = [
        "# Physics Congress 2026 — local archive",
        "",
        f"- Site: {BASE}",
        "- Venue: Nazarbayev University, Astana, Kazakhstan",
        "- Contact: pc2026@nu.edu.kz",
        "",
        "## Tracks",
        "",
        "- Dynamics Days Central Asia and Caucasus",
        "- ISOS2026 — Optical Fiber Sensing Systems / Optical Sensors",
        "- 5th Annual Meeting of Kazakh Physical Society",
        "",
        "## Stats",
        "",
        f"- Pages: {pages_ok}",
        f"- Assets: {assets_ok}",
        f"- Speakers: {len(speakers.get('speakers', []))}",
        f"- Videos: {len(catalog.get('videos', {}))}",
        "",
        "## Notes",
        "",
        "- Google Drive PDFs/Docs/Slides linked from the site are archived under `pdfs/` and `docs/`.",
        "- Hotel booking shortlinks are listed in catalog.externalRefs only (not scraped).",
        "",
        "Use agent tool `search_physics_congress`.",
        "",
    ]
    (CORPUS / "OVERVIEW.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    log(f"structure pages={pages_ok} assets={assets_ok} speakers={len(speakers.get('speakers', []))}")


def ingest_knowledge(catalog: dict):
    base = os.environ.get("BASE_URL", "http://127.0.0.1:3333").rstrip("/")
    name = "Physics Congress 2026"

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
        {
            "version": 1,
            "base": BASE,
            "pages": {},
            "assets": {},
            "videos": {},
            "externalRefs": {},
            "updatedAt": None,
        },
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
