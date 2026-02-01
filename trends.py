#!/usr/bin/env python3
"""
Fetch Google Trends data (BR + US) and write trends.json for daily-idea.js.
Runs before the Node script in CI; optional locally. Failures are per-section.
"""
import json
import sys
import time
from datetime import datetime, timezone

TRENDS_FILE = "trends.json"
TIMEFRAME = "now 7-d"
TRENDING_TOP_N = 20
TERMS = [
    "frontend", "javascript", "react", "typescript",
    "remote work", "software engineer", "developer",
    "english interview", "system design", "web performance",
    "design system", "job interview",
]

def _list_from_df(df, max_items=20):
    if df is None or df.empty:
        return []
    col = df.columns[0] if len(df.columns) else None
    if col is None:
        return []
    out = df[col].dropna().astype(str).tolist()
    return out[:max_items]

def main():
    out = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "trending_searches": {"BR": [], "US": []},
        "related_queries": {},
        "suggestions": {},
    }
    total_items = 0

    try:
        from pytrends.request import TrendReq
    except ImportError:
        print("WARN: pytrends not installed; run: pip install pytrends pandas", file=sys.stderr)
        _write(out, total_items)
        return

    try:
        pytrends = TrendReq(hl="en-US", tz=360)
    except Exception as e:
        print(f"WARN: TrendReq failed: {e}", file=sys.stderr)
        _write(out, total_items)
        return

    # --- Trending searches BR ---
    try:
        df_br = pytrends.trending_searches(pn="brazil")
        out["trending_searches"]["BR"] = _list_from_df(df_br, TRENDING_TOP_N)
        total_items += len(out["trending_searches"]["BR"])
    except Exception as e:
        print(f"WARN: trending_searches BR failed: {e}", file=sys.stderr)

    # --- Trending searches US (may not be supported in all regions) ---
    try:
        df_us = pytrends.trending_searches(pn="united_states")
        out["trending_searches"]["US"] = _list_from_df(df_us, TRENDING_TOP_N)
        total_items += len(out["trending_searches"]["US"])
    except Exception as e:
        print(f"WARN: trending_searches US failed (may not be supported): {e}", file=sys.stderr)

    # --- Related queries per term (BR + US) ---
    for term in TERMS:
        out["related_queries"][term] = {"BR": {"rising": [], "top": []}, "US": {"rising": [], "top": []}}
        for geo, geo_key in [("BR", "BR"), ("US", "US")]:
            try:
                pytrends.build_payload([term], timeframe=TIMEFRAME, geo=geo)
                rq = pytrends.related_queries()
                if term in rq and rq[term]:
                    for key in ("rising", "top"):
                        if key in rq[term] and rq[term][key] is not None and not rq[term][key].empty:
                            out["related_queries"][term][geo_key][key] = _list_from_df(rq[term][key], 20)
                            total_items += len(out["related_queries"][term][geo_key][key])
            except Exception as e:
                print(f"WARN: related_queries {term} {geo}: {e}", file=sys.stderr)
            time.sleep(0.5)

    # --- Suggestions per term (returns list of dicts with 'title') ---
    for term in TERMS:
        try:
            sug = pytrends.suggestions(keyword=term)
            if isinstance(sug, list):
                out["suggestions"][term] = [s.get("title", str(s)) for s in sug[:15] if isinstance(s, dict)]
            elif isinstance(sug, dict) and "title" in sug:
                out["suggestions"][term] = [sug.get("title", "")]
            else:
                out["suggestions"][term] = []
            total_items += len(out["suggestions"].get(term, []))
        except Exception as e:
            print(f"WARN: suggestions {term}: {e}", file=sys.stderr)
            out["suggestions"][term] = []
        time.sleep(0.3)

    _write(out, total_items)

def _write(data, total_items):
    with open(TRENDS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"TRENDS_OK {total_items}")

if __name__ == "__main__":
    main()
