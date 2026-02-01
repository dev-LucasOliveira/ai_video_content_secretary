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

# Column names that related_queries / related_topics may return (first match wins)
QUERY_COLS = ["query", "title", "value"]
TOPIC_COLS = ["topic_title", "title", "topic_mid", "topic_type"]


def safe_df_to_list(df, col=None, limit=20):
    """Extract a list from a DataFrame column. Never raises; returns [] on any issue."""
    if df is None:
        return []
    if getattr(df, "empty", True):
        return []
    cols = list(getattr(df, "columns", []))
    if not cols:
        return []
    # Prefer explicit col, then try known names, then first column
    to_try = ([col] if col and col in cols else []) + QUERY_COLS + TOPIC_COLS + [cols[0]]
    for c in to_try:
        if c not in cols:
            continue
        try:
            out = df[c].dropna().astype(str).head(limit).tolist()
            return out[:limit] if isinstance(out, list) else []
        except Exception:
            continue
    return []


def safe_related_queries(pytrends, term, geo):
    """Return { 'rising': [...], 'top': [...] }. Never raises; uses safe_df_to_list."""
    result = {"rising": [], "top": []}
    try:
        pytrends.build_payload([term], timeframe=TIMEFRAME, geo=geo)
        rq = pytrends.related_queries()
    except Exception as e:
        return result, str(e)
    if not rq or term not in rq:
        return result, "no data"
    term_data = rq.get(term)
    if term_data is None:
        return result, "no data"
    try:
        rising_df = term_data.get("rising")
        top_df = term_data.get("top")
        result["rising"] = safe_df_to_list(rising_df, limit=MAX_PER_LIST)
        result["top"] = safe_df_to_list(top_df, limit=MAX_PER_LIST)
    except Exception as e:
        return result, str(e)
    return result, None


def safe_related_topics(pytrends, term, geo):
    """Return { 'topics_rising': [...], 'topics_top': [...] }. Prefer topic_title column."""
    result = {"topics_rising": [], "topics_top": []}
    try:
        pytrends.build_payload([term], timeframe=TIMEFRAME, geo=geo)
        rt = pytrends.related_topics()
    except Exception as e:
        return result, str(e)
    if not rt or term not in rt:
        return result, "no data"
    term_data = rt.get(term)
    if term_data is None:
        return result, "no data"
    try:
        rising_df = term_data.get("rising")
        top_df = term_data.get("top")
        result["topics_rising"] = safe_df_to_list(rising_df, col="topic_title", limit=MAX_PER_LIST)
        result["topics_top"] = safe_df_to_list(top_df, col="topic_title", limit=MAX_PER_LIST)
    except Exception as e:
        return result, str(e)
    return result, None


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
        _write(out, len(KEYWORDS_DEV), total_items)
        return

    try:
        pytrends = TrendReq(hl="en-US", tz=360)
    except Exception as e:
        print(f"WARN: TrendReq failed: {e}", file=sys.stderr)
        _write(out, len(KEYWORDS_DEV), total_items)
        return

    for term in KEYWORDS_DEV:
        out["data"][term] = {
            "BR": {"rising": [], "top": [], "topics_rising": [], "topics_top": []},
            "US": {"rising": [], "top": [], "topics_rising": [], "topics_top": []},
            "suggestions": [],
        }
        for geo in ("BR", "US"):
            # related_queries
            rq_result, rq_err = safe_related_queries(pytrends, term, geo)
            if rq_err:
                print(f"WARN: {term} {geo} related_queries: {rq_err}", file=sys.stderr)
            else:
                out["data"][term][geo]["rising"] = rq_result["rising"]
                out["data"][term][geo]["top"] = rq_result["top"]
                total_items += len(rq_result["rising"]) + len(rq_result["top"])
            time.sleep(0.3)

            # related_topics
            rt_result, rt_err = safe_related_topics(pytrends, term, geo)
            if rt_err:
                print(f"WARN: {term} {geo} related_topics: {rt_err}", file=sys.stderr)
            else:
                out["data"][term][geo]["topics_rising"] = rt_result["topics_rising"]
                out["data"][term][geo]["topics_top"] = rt_result["topics_top"]
                total_items += len(rt_result["topics_rising"]) + len(rt_result["topics_top"])
            time.sleep(0.3)

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
            print(f"WARN: {term} suggestions: {e}", file=sys.stderr)
            out["data"][term]["suggestions"] = []
        time.sleep(0.3)

    _write(out, len(KEYWORDS_DEV), total_items)


def _write(data, terms_count, total_items):
    with open(TRENDS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"TRENDS_OK terms={terms_count} total_items={total_items}")


def print_summary():
    """Print a quick summary of trends.json (run after main() or standalone: python trends.py --summary)."""
    try:
        with open(TRENDS_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        print("trends.json not found. Run: python trends.py")
        return
    except json.JSONDecodeError as e:
        print(f"trends.json invalid: {e}")
        return
    gen = data.get("generated_at", "?")
    data_by_term = data.get("data") or {}
    print(f"Generated: {gen}")
    print(f"Keywords: {len(data_by_term)}")
    for term, entry in list(data_by_term.items())[:5]:
        br = entry.get("BR") or {}
        us = entry.get("US") or {}
        sug = entry.get("suggestions") or []
        n_br = len(br.get("rising", [])) + len(br.get("top", []))
        n_us = len(us.get("rising", [])) + len(us.get("top", []))
        print(f"  {term}: BR={n_br} US={n_us} suggestions={len(sug)}")
    if len(data_by_term) > 5:
        print(f"  ... and {len(data_by_term) - 5} more keywords")
    total = sum(
        len((e.get("BR") or {}).get("rising", [])) + len((e.get("BR") or {}).get("top", []))
        + len((e.get("US") or {}).get("rising", [])) + len((e.get("US") or {}).get("top", []))
        + len(e.get("suggestions", []))
        for e in data_by_term.values()
    )
    print(f"Total items: {total}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--summary":
        print_summary()
    else:
        main()
