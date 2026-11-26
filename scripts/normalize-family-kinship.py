#!/usr/bin/env python3
"""
Normalize family_or_associate links to a single FROM-centric kinship convention
and backfill person metadata.gender where inferable.

Convention (matches Rockefeller Child + Timothy "father of …"):
  roleLabel describes FROM's relation to TO.
  - Child / Son / Daughter: FROM is child of TO
  - Father / Mother / Parent: FROM is parent of TO
  - Spouse / Brother / Sister: FROM is that relative of TO
  - "X of …" phrases: FROM is X of TO

Dutch-royal TO-centric Mother/Father/Son/Daughter rows are rewritten.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

DB_DEFAULT = Path(__file__).resolve().parents[1] / ".data/profiles/profiles.sqlite"

YEAR_RE = re.compile(r"^(\d{4})")
MRS_RE = re.compile(r"^Mrs\.?\s+", re.I)
MISS_RE = re.compile(r"^Miss\.?\s+", re.I)
MS_RE = re.compile(r"^Ms\.\s+")
MR_RE = re.compile(r"^Mr\.?\s+", re.I)


def year_of(raw: str | None) -> int | None:
	if not raw:
		return None
	m = YEAR_RE.match(str(raw).strip())
	return int(m.group(1)) if m else None


def parse_meta(raw: str | None) -> dict:
	try:
		m = json.loads(raw or "{}")
		return m if isinstance(m, dict) else {}
	except Exception:
		return {}


def norm_gender(v) -> str | None:
	if v is None:
		return None
	s = str(v).strip().lower()
	if s in ("female", "f", "woman", "girl"):
		return "female"
	if s in ("male", "m", "man", "boy"):
		return "male"
	return None


def gender_from_name(name: str | None) -> str | None:
	n = (name or "").strip()
	if not n:
		return None
	if MRS_RE.match(n) or MISS_RE.match(n) or MS_RE.match(n):
		return "female"
	if MR_RE.match(n):
		return "male"
	# Common royal / noble titles (family corpus)
	if re.match(r"^(?:Princess|Queen|Duchess|Countess|Lady)\b", n):
		return "female"
	if re.match(r"^(?:Prince|King|Duke|Earl|Lord|Count|Baron)\b", n):
		return "male"
	return None


def child_role_for_gender(g: str | None) -> str:
	if g == "female":
		return "Daughter"
	if g == "male":
		return "Son"
	return "Child"


def parent_role_for_gender(g: str | None) -> str:
	if g == "female":
		return "Mother"
	if g == "male":
		return "Father"
	return "Parent"


def main() -> int:
	ap = argparse.ArgumentParser()
	ap.add_argument("--db", type=Path, default=DB_DEFAULT)
	ap.add_argument("--apply", action="store_true", help="Write changes (default dry-run)")
	ap.add_argument("--limit", type=int, default=0, help="Max link rewrites (0=all)")
	args = ap.parse_args()
	dry = not args.apply

	con = sqlite3.connect(str(args.db))
	con.row_factory = sqlite3.Row

	links = con.execute(
		"""
		select l.id, l.role_label, l.from_profile_id, l.to_profile_id,
		       f.name as from_name, f.start_date as from_start, f.metadata_json as from_meta,
		       f.profile_type as from_type,
		       t.name as to_name, t.start_date as to_start, t.metadata_json as to_meta,
		       t.profile_type as to_type
		from profile_links l
		join profiles f on f.id = l.from_profile_id
		join profiles t on t.id = l.to_profile_id
		where l.relation_type = 'family_or_associate'
		"""
	).fetchall()

	# Reciprocal person↔person kinship roles (same pair, opposite direction).
	recip_role: dict[tuple[str, str], str] = {}
	for r in links:
		if r["from_type"] != "person" or r["to_type"] != "person":
			continue
		rl = (r["role_label"] or "").strip().lower()
		if rl in (
			"mother",
			"father",
			"parent",
			"son",
			"daughter",
			"child",
			"adopted child",
			"daughter (acknowledged)",
		):
			recip_role[(r["from_profile_id"], r["to_profile_id"])] = rl

	gender_updates: dict[str, str] = {}  # profile_id -> gender
	role_updates: list[tuple[str, str, str]] = []  # id, old, new

	def set_gender(pid: str, g: str | None, meta_raw: str | None, name: str | None):
		if not g or not pid:
			return
		if pid in gender_updates:
			return
		existing = norm_gender(parse_meta(meta_raw).get("gender")) or norm_gender(
			parse_meta(meta_raw).get("sex")
		)
		if existing:
			return
		inferred = gender_from_name(name)
		gender_updates[pid] = inferred or g

	def from_gender(r) -> str | None:
		return (
			norm_gender(parse_meta(r["from_meta"]).get("gender"))
			or gender_updates.get(r["from_profile_id"])
			or gender_from_name(r["from_name"])
		)

	# Seed genders from honorifics for every person on a family link
	for r in links:
		for pid, name, meta in (
			(r["from_profile_id"], r["from_name"], r["from_meta"]),
			(r["to_profile_id"], r["to_name"], r["to_meta"]),
		):
			g = gender_from_name(name)
			if g:
				set_gender(pid, g, meta, name)

	stats = defaultdict(int)

	for r in links:
		raw = (r["role_label"] or "").strip()
		role_l = raw.lower()
		fy, ty = year_of(r["from_start"]), year_of(r["to_start"])
		from_younger = fy is not None and ty is not None and fy > ty
		to_younger = fy is not None and ty is not None and ty > fy
		both_people = r["from_type"] == "person" and r["to_type"] == "person"
		recip = recip_role.get((r["to_profile_id"], r["from_profile_id"])) if both_people else None

		new_role = None

		# --- Convention B (TO-centric) → FROM-centric ---
		# Mother/Father naming TO (child→parent), often paired with reciprocal Son/Daughter.
		if role_l in ("mother", "father") and both_people:
			to_centric = bool(recip in ("son", "daughter", "child", "adopted child", "daughter (acknowledged)")) or (
				from_younger and not to_younger
			)
			to_g = "female" if role_l == "mother" else "male"
			if to_centric:
				set_gender(r["to_profile_id"], to_g, r["to_meta"], r["to_name"])
				new_role = child_role_for_gender(from_gender(r))
				stats[f"rewrite_{raw}_to_{new_role}"] += 1
			elif to_younger and not from_younger:
				# Already FROM-centric parent noun
				set_gender(r["from_profile_id"], to_g, r["from_meta"], r["from_name"])
				stats["keep_parent_noun_to_younger"] += 1
			else:
				# Ambiguous: prefer TO-centric (Dutch-style Mother/Father on child→parent)
				set_gender(r["to_profile_id"], to_g, r["to_meta"], r["to_name"])
				new_role = child_role_for_gender(from_gender(r))
				stats[f"rewrite_{raw}_to_{new_role}_ambiguous"] += 1

		elif role_l in ("son", "daughter") and both_people:
			to_g = "female" if role_l == "daughter" else "male"
			to_centric = bool(recip in ("mother", "father", "parent")) or (to_younger and not from_younger)
			from_centric = (from_younger and not to_younger and not recip) or (
				recip is None and not to_younger and not from_younger
			)
			if to_centric and not from_centric:
				set_gender(r["to_profile_id"], to_g, r["to_meta"], r["to_name"])
				new_role = parent_role_for_gender(from_gender(r))
				stats[f"rewrite_{raw}_to_{new_role}"] += 1
			else:
				# FROM-centric child noun (Margaret Miller → Carnegie; rare Son from_younger)
				set_gender(r["from_profile_id"], to_g, r["from_meta"], r["from_name"])
				stats[f"keep_child_noun_{raw}"] += 1

		elif role_l == "daughter (acknowledged)" and both_people:
			set_gender(r["to_profile_id"], "female", r["to_meta"], r["to_name"])
			new_role = parent_role_for_gender(from_gender(r))
			stats[f"rewrite_Daughter_ack_to_{new_role}"] += 1

		elif role_l == "child" and both_people:
			if to_younger and not from_younger:
				stats["flag_Child_to_younger"] += 1
			else:
				stats["keep_Child"] += 1

		elif role_l == "parent" and both_people:
			# Bodhi kids → Tao: TO-centric Parent → child noun for FROM
			to_centric = bool(recip in ("son", "daughter", "child")) or not to_younger
			if to_centric:
				new_role = child_role_for_gender(from_gender(r))
				stats[f"rewrite_Parent_to_{new_role}"] += 1
			else:
				stats["keep_Parent"] += 1

		elif role_l == "spouse":
			if raw != "Spouse":
				new_role = "Spouse"
				stats["canonicalize_Spouse"] += 1
			else:
				stats["keep_Spouse"] += 1

		elif role_l == "husband" and both_people:
			new_role = "Spouse"
			stats["rewrite_Husband_to_Spouse"] += 1

		elif role_l == "adopted child" and both_people:
			# Grace → Winthrop Paul: TO-centric adopted child
			from_g = from_gender(r) or "female"
			new_role = parent_role_for_gender(from_g)
			stats[f"rewrite_Adopted_child_to_{new_role}"] += 1

		elif role_l in (
			"son / family member",
			"daughter / family member",
			"mother / family member",
			"father / family member",
		):
			if role_l.startswith("son"):
				new_role = "Son"
				set_gender(r["from_profile_id"], "male", r["from_meta"], r["from_name"])
			elif role_l.startswith("daughter"):
				new_role = "Daughter"
				set_gender(r["from_profile_id"], "female", r["from_meta"], r["from_name"])
			elif role_l.startswith("mother"):
				new_role = "Mother"
				set_gender(r["from_profile_id"], "female", r["from_meta"], r["from_name"])
			elif role_l.startswith("father"):
				new_role = "Father"
				set_gender(r["from_profile_id"], "male", r["from_meta"], r["from_name"])
			if new_role:
				stats[f"rewrite_family_member_blend_to_{new_role}"] += 1

		# Gender from explicit FROM-centric "X of" phrases
		if re.search(
			r"(?i)^(?:son|daughter|grandson|granddaughter|brother|sister|great[- ]?(?:nephew|niece))\s+of\b",
			raw,
		):
			g = (
				"female"
				if re.search(r"(?i)^(?:daughter|granddaughter|sister|great[- ]?niece)\b", raw)
				else "male"
				if re.search(r"(?i)^(?:son|grandson|brother|great[- ]?nephew)\b", raw)
				else None
			)
			if g:
				set_gender(r["from_profile_id"], g, r["from_meta"], r["from_name"])
		if re.search(
			r"(?i)^(?:adoptive\s+|step\s+)?(?:birth\s+)?(?:father|mother|parent|great[- ]?(?:uncle|aunt|grandfather|grandmother))\s+of\b",
			raw,
		):
			g = (
				"female"
				if re.search(r"(?i)\b(?:mother|aunt|grandmother)\b", raw)
				else "male"
				if re.search(r"(?i)\b(?:father|uncle|grandfather)\b", raw)
				else None
			)
			if g:
				set_gender(r["from_profile_id"], g, r["from_meta"], r["from_name"])

		if role_l == "brother":
			set_gender(r["from_profile_id"], "male", r["from_meta"], r["from_name"])
		elif role_l == "sister":
			set_gender(r["from_profile_id"], "female", r["from_meta"], r["from_name"])

		if new_role and new_role != raw:
			role_updates.append((r["id"], raw, new_role))
			if args.limit and len(role_updates) >= args.limit:
				break

	# Second pass: genders from rewritten intent already collected; also Child keepers with
	# honorifics only. Apply genders for people still missing via Sister/Brother on reverse? skip.

	print(f"family links scanned: {len(links)}")
	print(f"role rewrites: {len(role_updates)}")
	print(f"gender backfills: {len(gender_updates)}")
	print("\n--- rewrite stats ---")
	for k, v in sorted(stats.items(), key=lambda x: (-x[1], x[0])):
		print(f"  {v:4d}  {k}")

	print("\n--- sample role rewrites (20) ---")
	id_to_link = {r["id"]: r for r in links}
	for lid, old, new in role_updates[:20]:
		r = id_to_link[lid]
		print(f"  {r['from_name'][:36]:36s} → {r['to_name'][:36]:36s}")
		print(f"      {old!r}  ⇒  {new!r}")

	print("\n--- sample gender backfills (20) ---")
	# resolve names
	name_by_id = {}
	for r in links:
		name_by_id[r["from_profile_id"]] = r["from_name"]
		name_by_id[r["to_profile_id"]] = r["to_name"]
	for i, (pid, g) in enumerate(gender_updates.items()):
		if i >= 20:
			break
		print(f"  {g:7s}  {name_by_id.get(pid, pid)[:50]}")

	if dry:
		print("\nDry-run only. Re-run with --apply to write.")
		return 0

	now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
	cur = con.cursor()
	for lid, old, new in role_updates:
		cur.execute(
			"update profile_links set role_label = ?, updated_at = ? where id = ?",
			(new, now, lid),
		)

	for pid, g in gender_updates.items():
		row = cur.execute(
			"select metadata_json from profiles where id = ?", (pid,)
		).fetchone()
		if not row:
			continue
		meta = parse_meta(row[0])
		if norm_gender(meta.get("gender")) or norm_gender(meta.get("sex")):
			continue
		meta["gender"] = g
		cur.execute(
			"update profiles set metadata_json = ?, updated_at = ? where id = ?",
			(json.dumps(meta, ensure_ascii=False), now, pid),
		)

	con.commit()
	print(f"\nApplied {len(role_updates)} role updates and {len(gender_updates)} gender backfills.")
	return 0


if __name__ == "__main__":
	sys.exit(main())
