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
    country_rows = []
    for row in rows:
        entity = row.get(entity_key, "").strip()
        try:
            year = int(row[year_key])
            value = float(row[values[0]])
            if value >= 0 and value != float("inf"):
                if entity.lower() == "world":
                    series.append({"year": year, "value": round(value)})
                elif entity and entity not in ("Europe", "European Union", "Asia", "Africa", "Oceania", "North America", "South America"):
                    country_rows.append({"year": year, "name": entity, "value": round(value)})
        except (TypeError, ValueError):
            continue
    if len(series) < 5:
        raise ValueError("World-level series missing/too short; refusing to fabricate totals")
    series.sort(key=lambda x: x["year"])
    save("history.json", {"updated": datetime.now(timezone.utc).isoformat(), "source": url, "metric": "objects_launched", "data": series})
    latest = series[-1]["year"]
    top = sorted((row for row in country_rows if row["year"] == latest), key=lambda r: r["value"], reverse=True)[:10]
    save("countries.json", {"updated": datetime.now(timezone.utc).isoformat(), "year": latest, "source": url, "data": top})
    print("Updated historical data:", len(series), "annual observations; top countries:", len(top))

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
                    "lat": pad.get("latitude") if pad.get("latitude") is not None else location.get("latitude"),
                    "lon": pad.get("longitude") if pad.get("longitude") is not None else location.get("longitude"),
                    "country": (pad.get("country") or location.get("country") or {}).get("name") or "Unknown",
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

def year_launches():
    """Collect completed/past launch records for the current UTC year with genuine pad locations.

    Daily cached requests stay well within the unauthed Launch Library budget
    (15/hour). A failed or incomplete update never overwrites a valid snapshot.
    """
    year = datetime.now(timezone.utc).year
    base = "https://ll.thespacedevs.com/2.3.0/launches/previous/"
    entries = []
    total = None
    limit = 100
    # At most 12 pages, with no silent truncation if a year is larger.
    for page in range(12):
        query = urllib.parse.urlencode({
            "year": year, "limit": limit, "offset": page * limit,
            "ordering": "-net", "mode": "normal", "format": "json",
        })
        response = json.loads(get(base + "?" + query))
        results = response.get("results")
        if not isinstance(results, list):
            raise ValueError("Launch API did not return a results list")
        total = int(response.get("count", 0))
        entries.extend(results)
        if len(entries) >= total or not results:
            break
    if total is None or len(entries) < total:
        raise RuntimeError(f"Incomplete {year} launch feed: fetched {len(entries)} of {total}; old snapshot retained")

    launches = []
    for item in entries:
        pad = item.get("pad") or {}
        location = pad.get("location") or {}
        country = pad.get("country") or location.get("country") or {}
        provider = item.get("launch_service_provider") or {}
        status = item.get("status") or {}
        raw_lat = pad.get("latitude")
        raw_lon = pad.get("longitude")
        if raw_lat is None:
            raw_lat = location.get("latitude")
        if raw_lon is None:
            raw_lon = location.get("longitude")
        try:
            lat = float(raw_lat) if raw_lat is not None else None
            lon = float(raw_lon) if raw_lon is not None else None
            if lat is None or lon is None or not -90 <= lat <= 90 or not -180 <= lon <= 180:
                lat, lon = None, None
        except (TypeError, ValueError):
            lat, lon = None, None
        identifier = str(item.get("id") or "")
        launches.append({
            "id": identifier,
            "name": item.get("name") or "Unnamed launch",
            "net": item.get("net"),
            "provider": provider.get("name") or "Unknown operator",
            "status": status.get("name") or "Unknown outcome",
            "site": location.get("name") or pad.get("name") or "Unknown launch site",
            "pad": pad.get("name") or "Unknown pad",
            "pad_id": pad.get("id"),
            "country": country.get("name") or "Unknown country",
            "lat": lat,
            "lon": lon,
            "url": "https://ll.thespacedevs.com/2.3.0/launches/" + urllib.parse.quote(identifier, safe="") + "/?format=json" if identifier else "https://thespacedevs.com/llapi",
        })
    valid = sum(1 for x in launches if x["lat"] is not None and x["lon"] is not None)
    save("year-launches.json", {
        "year": year,
        "updated": datetime.now(timezone.utc).isoformat(),
        "source": base,
        "coverage": "Past launch records in Launch Library 2; orbital-focused default feed",
        "total": len(launches),
        "geocoded": valid,
        "launches": launches
    })
    print(f"Updated {year} launch records: {len(launches)} total, {valid} with coordinates")

if __name__ == "__main__":
    errors = []
    for fn in (history, launches, year_launches):
        try:
            fn()
        except Exception as exc:
            errors.append(f"{fn.__name__}: {exc}")
            print(errors[-1], file=sys.stderr)
    if errors:
        print("Partial refresh; existing cached files preserved where possible.", file=sys.stderr)
        # Do not fail deployment when a free public feed is temporarily unavailable.
