#!/usr/bin/env python3
"""
Fetch Google Trends data (BR + US) for DEV niche only.
Uses related_queries, related_topics, suggestions per keyword. No trending_searches.
Writes trends.json for daily-idea.js. Failures are per-term/per-geo; trends.json is always created.
"""
import json
import sys
import time
from datetime import datetime, timezone

TRENDS_FILE = "trends.json"
TIMEFRAME = "now 7-d"
MAX_PER_LIST = 20

KEYWORDS_DEV = [
    "react", "javascript", "typescript", "frontend", "developer",
    "software engineer", "remote work", "english interview",
    "web development", "programming", "system design",
    "web performance", "design system", "react hooks", "node js",
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
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "keywords_used": list(KEYWORDS_DEV),
        "data": {},
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

    for term in KEYWORDS_DEV:
        out["data"][term] = {
            "BR": {"rising": [], "top": [], "topics_rising": [], "topics_top": []},
            "US": {"rising": [], "top": [], "topics_rising": [], "topics_top": []},
            "suggestions": [],
        }
        for geo in ("BR", "US"):
            try:
                pytrends.build_payload([term], timeframe=TIMEFRAME, geo=geo)
                # related_queries
                rq = pytrends.related_queries()
                if term in rq and rq[term]:
                    for key in ("rising", "top"):
                        if key in rq[term] and rq[term][key] is not None and not rq[term][key].empty:
                            lst = _list_from_df(rq[term][key], MAX_PER_LIST)
                            out["data"][term][geo][key] = lst
                            total_items += len(lst)
                # related_topics
                rt = pytrends.related_topics()
                if term in rt and rt[term]:
                    for key in ("rising", "top"):
                        if key in rt[term] and rt[term][key] is not None and not rt[term][key].empty:
                            lst = _list_from_df(rt[term][key], MAX_PER_LIST)
                            out["data"][term][geo][f"topics_{key}"] = lst
                            total_items += len(lst)
            except Exception as e:
                print(f"WARN: {term} {geo}: {e}", file=sys.stderr)
            time.sleep(0.5)

        # suggestions (no geo)
        try:
            sug = pytrends.suggestions(keyword=term)
            if isinstance(sug, list):
                out["data"][term]["suggestions"] = [
                    s.get("title", str(s)) for s in sug[:MAX_PER_LIST] if isinstance(s, dict)
                ]
            elif isinstance(sug, dict) and "title" in sug:
                out["data"][term]["suggestions"] = [sug.get("title", "")]
            else:
                out["data"][term]["suggestions"] = []
            total_items += len(out["data"][term]["suggestions"])
        except Exception as e:
            print(f"WARN: suggestions {term}: {e}", file=sys.stderr)
            out["data"][term]["suggestions"] = []
        time.sleep(0.3)

    _write(out, total_items)


def _write(data, total_items):
    with open(TRENDS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"TRENDS_OK {total_items}")


if __name__ == "__main__":
    main()
