#!/usr/bin/env python3
"""Refresh publicly sourced, attribution-friendly data for the static dashboard."""
import csv
import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)
HEADERS = {"User-Agent": "PaleBlueDotDashboard/1.0 (public static educational dashboard)", "Accept": "application/json, text/csv;q=0.9"}

def get(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=35) as response:
        return response.read().decode("utf-8-sig")

def save(filename, payload):
    target = DATA / filename
    target.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

def load(filename):
    try:
        return json.loads((DATA / filename).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}

def history():
    # Our World in Data: annual objects launched; license/credit in README.
    url = "https://ourworldindata.org/grapher/yearly-number-of-objects-launched-into-outer-space.csv"
    rows = csv.DictReader(io.StringIO(get(url)))
    fields = rows.fieldnames or []
    year_key = next((f for f in fields if f.lower() == "year"), None)
    entity_key = next((f for f in fields if f.lower() == "entity"), None)
    if not year_key or not entity_key:
        raise ValueError("Unexpected OWID CSV schema")
    values = [f for f in fields if f not in ("Entity", "Code", "Year") and f.lower() not in ("entity", "code", "year")]
    if not values:
        raise ValueError("No value field in OWID CSV")
    series = []
    for row in rows:
        if row.get(entity_key, "").strip().lower() != "world":
            continue
        try:
            year = int(row[year_key])
            value = float(row[values[0]])
            if value >= 0 and value != float("inf"):
                series.append({"year": year, "value": round(value)})
        except (TypeError, ValueError):
            continue
    if len(series) < 5:
        raise ValueError("World-level series missing/too short; refusing to fabricate totals")
    series.sort(key=lambda x: x["year"])
    save("history.json", {"updated": datetime.now(timezone.utc).isoformat(), "source": url, "metric": "objects_launched", "data": series})
    print("Updated historical data:", len(series), "annual observations")

def fetch_launches(category):
    routes = [
        f"https://ll.thespacedevs.com/2.3.0/launches/{category}/?limit=14&mode=normal&format=json",
        f"https://ll.thespacedevs.com/2.2.0/launch/{category}/?limit=14&mode=normal&format=json",
    ]
    for url in routes:
        try:
            raw = json.loads(get(url))
            if not isinstance(raw.get("results"), list):
                continue
            results = []
            for item in raw["results"]:
                provider = item.get("launch_service_provider") or {}
                pad = item.get("pad") or {}
                location = pad.get("location") or {}
                results.append({
                    "name": item.get("name") or "Unnamed launch",
                    "net": item.get("net"),
                    "provider": provider.get("name") or "Unknown operator",
                    "location": location.get("name") or pad.get("name") or "Launch site unavailable",
                    "status": (item.get("status") or {}).get("name") or "Schedule subject to change",
                    "url": item.get("url") if str(item.get("url", "")).startswith("https://") else "https://thespacedevs.com/llapi",
                })
            return results
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError) as exc:
            print(f"Launch feed failed ({category}): {url} ({exc})", file=sys.stderr)
    raise RuntimeError("No available Space Devs API route")

def launches():
    previous = load("launches.json")
    updated = {"updated": datetime.now(timezone.utc).isoformat(), "source": "https://thespacedevs.com/llapi"}
    success = False
    for category in ("upcoming", "previous"):
        key = "upcoming" if category == "upcoming" else "recent"
        try:
            updated[key] = fetch_launches(category)
            success = True
        except RuntimeError:
            updated[key] = previous.get(key) or []
    if not success:
        raise RuntimeError("No launch categories updated; keeping existing cache")
    save("launches.json", updated)
    print("Updated launch manifest:", len(updated["upcoming"]), "upcoming,", len(updated["recent"]), "recent")

if __name__ == "__main__":
    errors = []
    for fn in (history, launches):
        try:
            fn()
        except Exception as exc:
            errors.append(f"{fn.__name__}: {exc}")
            print(errors[-1], file=sys.stderr)
    if errors:
        print("Partial refresh; existing cached files preserved where possible.", file=sys.stderr)
        # Do not fail deployment when a free public feed is temporarily unavailable.
