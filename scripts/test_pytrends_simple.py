#!/usr/bin/env python3
"""
Teste MÍNIMO do PyTrends: 1 keyword, 1 geo, só o básico.
Rode: pip install pytrends pandas && python scripts/test_pytrends_simple.py
"""
import sys

def main():
    print("1. Importando pytrends...")
    try:
        from pytrends.request import TrendReq
    except ImportError:
        print("ERRO: pip install pytrends pandas")
        sys.exit(1)

    print("2. Conectando (TrendReq)...")
    try:
        pytrends = TrendReq(hl="en-US", tz=360)
    except Exception as e:
        print(f"ERRO: {e}")
        sys.exit(1)

    keyword = "react"
    geo = ""  # mundo; use "BR" ou "US" se quiser
    timeframe = "today 3-m"  # últimos 3 meses (costuma retornar mais que now 7-d)

    print(f"3. Payload: keyword={keyword!r}, geo={geo!r}, timeframe={timeframe!r}")
    try:
        pytrends.build_payload([keyword], timeframe=timeframe, geo=geo if geo else "")
    except Exception as e:
        print(f"ERRO build_payload: {e}")
        sys.exit(1)

    print("4. interest_over_time (o mais estável)...")
    try:
        df = pytrends.interest_over_time()
        if df is not None and not df.empty:
            print(f"   OK: {len(df)} linhas. Colunas: {list(df.columns)}")
            print(df.tail(5).to_string())
        else:
            print("   (vazio)")
    except Exception as e:
        print(f"   ERRO: {e}")

    print("5. related_queries...")
    try:
        rq = pytrends.related_queries()
        if rq and keyword in rq and rq[keyword]:
            for k in ("rising", "top"):
                df = rq[keyword].get(k)
                if df is not None and not df.empty:
                    col = df.columns[0] if len(df.columns) else None
                    if col:
                        vals = df[col].dropna().head(10).tolist()
                        print(f"   {k}: {vals}")
                else:
                    print(f"   {k}: (vazio)")
        else:
            print("   (sem dados para este keyword)")
    except Exception as e:
        print(f"   ERRO: {e}")

    print("6. suggestions...")
    try:
        sug = pytrends.suggestions(keyword=keyword)
        if isinstance(sug, list) and sug:
            titles = [s.get("title", "") for s in sug[:5] if isinstance(s, dict)]
            print(f"   {titles}")
        else:
            print("   (vazio)")
    except Exception as e:
        print(f"   ERRO: {e}")

    print("\nFim. Se 4 ou 5 ou 6 mostraram dados, o PyTrends está OK.")

if __name__ == "__main__":
    main()
