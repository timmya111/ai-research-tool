#!/usr/bin/env python3
"""
Poll Bryan County real-time filings from okcountyrecords.com and POST new
items into the local research knowledge store.

Uses curl_cffi (Chrome TLS impersonation) — no browser, no login UI.
Cloudflare blocks plain requests and detail pages; the public real-time feed
is readable and yields instrument / type / county / images / detail URL.
Grantor/grantee require the paid/authenticated OKCR API or a CF solver later.

Usage:
  .venv-monitors/bin/python scripts/bryan_realtime_monitor.py
  BRYAN_MONITOR_ONCE=1 pnpm bryan:monitor
  BRYAN_MONITOR_INTERVAL_MS=120000 pnpm bryan:monitor

Requires: research app on RESEARCH_APP_URL (default http://127.0.0.1:3333)
and the project venv: uv venv .venv-monitors && uv pip install -r scripts/requirements-bryan.txt
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
	from curl_cffi import requests as creq
	from bs4 import BeautifulSoup
except ImportError:
	print(
		"Missing deps. Create venv and install:\n"
		"  uv venv .venv-monitors\n"
		"  uv pip install --python .venv-monitors/bin/python -r scripts/requirements-bryan.txt",
		file=sys.stderr,
	)
	sys.exit(1)

REALTIME_URL = os.environ.get("BRYAN_REALTIME_URL", "https://okcountyrecords.com/real-time/bryan")
APP_URL = os.environ.get("RESEARCH_APP_URL", "http://127.0.0.1:3333").rstrip("/")
INTERVAL_MS = max(15_000, int(os.environ.get("BRYAN_MONITOR_INTERVAL_MS", "60000")))
ONCE = os.environ.get("BRYAN_MONITOR_ONCE") == "1"
DETAIL_LIMIT = max(1, min(20, int(os.environ.get("BRYAN_MONITOR_DETAIL_LIMIT", "5"))))
STATE_DIR = Path(os.environ.get("BRYAN_MONITOR_STATE_DIR") or Path.cwd() / ".data" / "monitors")
SEEN_PATH = STATE_DIR / "bryan-seen.json"
IMPERSONATE = os.environ.get("BRYAN_MONITOR_IMPERSONATE", "chrome")


def log(*args: Any) -> None:
	print(datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), *args, flush=True)


def load_seen() -> set[str]:
	try:
		raw = json.loads(SEEN_PATH.read_text())
		ids = raw.get("ids") if isinstance(raw, dict) else None
		return {str(x) for x in ids} if isinstance(ids, list) else set()
	except (OSError, json.JSONDecodeError):
		return set()


def save_seen(seen: set[str]) -> None:
	STATE_DIR.mkdir(parents=True, exist_ok=True)
	ids = list(seen)[-5000:]
	SEEN_PATH.write_text(json.dumps({"updatedAt": datetime.now(timezone.utc).isoformat(), "ids": ids}, indent=2))


def parse_card(li) -> dict[str, Any] | None:
	a = li.select_one('a[href*="/detail/"]')
	if not a:
		return None
	href = a.get("href") or ""
	if href.startswith("/"):
		href = "https://okcountyrecords.com" + href
	m = re.search(r"/detail/([^/]+)/([^/]+)/(\d+)", href)
	if not m:
		return None
	doc_type = (li.select_one(".instrument-type") or a).get_text(strip=True)
	if li.select_one(".instrument-type"):
		doc_type = li.select_one(".instrument-type").get_text(strip=True)
	site_name = li.select_one(".site-name")
	county = f"{site_name.get_text(strip=True)} County" if site_name else "Bryan County"
	img_el = li.select_one(".instrument-images")
	images = None
	if img_el:
		im = re.search(r"(\d+)\s+images?", img_el.get_text(), re.I)
		images = int(im.group(1)) if im else None
	record_id = m.group(3) or li.get("id") or ""
	return {
		"id": str(record_id),
		"site": m.group(1),
		"instrumentNo": m.group(2),
		"instrument": a.get_text(strip=True),
		"docType": doc_type or "UNKNOWN",
		"images": images,
		"href": href,
		"county": county,
		"recorded": None,
		"instrumentDate": None,
		"book": None,
		"pages": None,
		"grantor": None,
		"grantee": None,
		"legal": None,
		"filingFees": None,
		"mortgageAmount": None,
		"consideration": None,
		"scrapedAt": datetime.now(timezone.utc).isoformat(),
	}


def scrape_feed(session: creq.Session) -> list[dict[str, Any]]:
	r = session.get(REALTIME_URL, timeout=60)
	if r.status_code != 200:
		raise RuntimeError(f"feed HTTP {r.status_code}")
	if re.search(r"just a moment|attention required|cloudflare", r.text, re.I):
		raise RuntimeError("feed still behind Cloudflare challenge")
	soup = BeautifulSoup(r.text, "lxml")
	items: list[dict[str, Any]] = []
	seen: set[str] = set()
	for li in soup.select("li"):
		item = parse_card(li)
		if not item or not item["id"] or item["id"] in seen:
			continue
		seen.add(item["id"])
		items.append(item)
	if not items:
		# Fallback: any detail anchors
		for a in soup.select('a[href*="/detail/"]'):
			href = a.get("href") or ""
			if href.startswith("/"):
				href = "https://okcountyrecords.com" + href
			m = re.search(r"/detail/([^/]+)/([^/]+)/(\d+)", href)
			if not m or m.group(3) in seen:
				continue
			seen.add(m.group(3))
			items.append(
				{
					"id": m.group(3),
					"site": m.group(1),
					"instrumentNo": m.group(2),
					"instrument": a.get_text(strip=True),
					"docType": "UNKNOWN",
					"images": None,
					"href": href,
					"county": "Bryan County",
					"recorded": None,
					"instrumentDate": None,
					"book": None,
					"pages": None,
					"grantor": None,
					"grantee": None,
					"legal": None,
					"filingFees": None,
					"mortgageAmount": None,
					"consideration": None,
					"scrapedAt": datetime.now(timezone.utc).isoformat(),
				}
			)
	return items


def post_filings(filings: list[dict[str, Any]]) -> dict[str, Any]:
	body = json.dumps({"filings": filings}).encode("utf-8")
	req = urllib.request.Request(
		f"{APP_URL}/api/monitors/bryan/ingest",
		data=body,
		headers={"Content-Type": "application/json"},
		method="POST",
	)
	try:
		with urllib.request.urlopen(req, timeout=120) as resp:
			data = json.loads(resp.read().decode("utf-8"))
	except urllib.error.HTTPError as e:
		err_body = e.read().decode("utf-8", errors="replace")
		raise RuntimeError(f"ingest HTTP {e.code}: {err_body[:400]}") from e
	if not data.get("ok", True):
		raise RuntimeError(data.get("error") or "ingest failed")
	return data


def poll_once(session: creq.Session, seen: set[str]) -> dict[str, Any]:
	feed = scrape_feed(session)
	log(f"feed items={len(feed)}")
	fresh = [f for f in feed if f["id"] and f["id"] not in seen]
	if not fresh:
		log("no new filings")
		return {"newCount": 0}

	to_save = fresh[:DETAIL_LIMIT]
	log(f"new filings={len(fresh)} (ingest up to {DETAIL_LIMIT})")
	for f in to_save:
		log(f"feed {f['instrument']} {f['docType']} images={f['images']} href={f['href']}")

	result = post_filings(to_save)
	for f in to_save:
		seen.add(f["id"])
	save_seen(seen)
	log(f"ingest saved={result.get('saved')} skipped={result.get('skipped')} projectId={result.get('projectId')}")
	return {"newCount": result.get("saved", 0), "result": result}


def main() -> None:
	STATE_DIR.mkdir(parents=True, exist_ok=True)
	seen = load_seen()
	log(f"starting Bryan monitor (python/curl_cffi) → {APP_URL} interval={INTERVAL_MS}ms once={ONCE} seen={len(seen)}")
	session = creq.Session(impersonate=IMPERSONATE)

	poll_once(session, seen)
	if ONCE:
		return

	while True:
		time.sleep(INTERVAL_MS / 1000.0)
		try:
			poll_once(session, seen)
		except Exception as e:
			log("poll error:", e)


if __name__ == "__main__":
	try:
		main()
	except Exception as e:
		print(e, file=sys.stderr)
		sys.exit(1)
