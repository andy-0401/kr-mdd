"""
데이터 갱신 엔트리포인트 (코스피·코스닥 MDD).

사용:
  python run_update.py --type close      # 종가 확정(15:40 KST)
  python run_update.py --type intraday   # 장중 속보(12:00 KST)
  python run_update.py --type close --force   # 비거래일에도 강제 실행

동작:
  1) 코스피·코스닥 과거 일봉 수집 → 52주/ATH 낙폭·이격도 계산
  2) docs/data/history.json (낙폭 시계열) 갱신
  3) docs/data/latest.json  (최신 스냅샷) 갱신
(텔레그램 알림은 현재 비활성 — 홍보는 링크 공유 방식)
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from dataclasses import asdict
from pathlib import Path

import mdd as M

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "docs" / "data"
HISTORY_PATH = DATA_DIR / "history.json"
LATEST_PATH = DATA_DIR / "latest.json"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--type", choices=["intraday", "close"], required=True)
    ap.add_argument("--force", action="store_true", help="비거래일에도 실행")
    args = ap.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    histories: dict[str, list] = {}
    for key in M.INDICES:
        print(f"[update] {M.INDICES[key]['name']} 과거 일봉 수집 중...")
        raw = M.fetch_history(key)
        histories[key] = M.compute_history(raw, key)
        print(f"[update]   일봉 {len(histories[key])}개")

    # 갱신 여부: 새 확정 종가가 있거나, 소스에 '오늘' 바가 있으면 갱신.
    latest_date = max(h[-1].date for h in histories.values())
    prev_committed = None
    if HISTORY_PATH.exists():
        try:
            prev = json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
            prev_committed = prev[-1]["date"] if prev else None
        except Exception:  # noqa: BLE001
            prev_committed = None
    today = dt.datetime.now(M.KST).strftime("%Y-%m-%d")
    has_new_close = prev_committed is None or latest_date > prev_committed
    is_today = latest_date == today
    if not (has_new_close or is_today) and not args.force:
        print(f"[update] 새 데이터 없음(최신: {latest_date}, 직전 커밋: {prev_committed}). 생략.")
        return 0

    records = M.history_to_records(histories)
    HISTORY_PATH.write_text(
        json.dumps(records, ensure_ascii=False, indent=0, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"[update] history.json 저장: {len(records)} rows")

    snap = M.build_snapshot(histories, run_type=args.type)

    # 지연된 장중 실행이 '이미 확정된 종가 스냅샷'을 덮어쓰지 못하게 막는다.
    #   GitHub 무료 cron 은 이 계정에서 몇 시간씩 밀려, 12:00 장중 크론이 17시경에
    #   실행되는 일이 잦다(2026-09-18 실측: 17:10·17:21 KST). 그대로 쓰면 15:40 종가
    #   스냅샷이 'intraday 12:00' 으로 덮여, 값은 같은데 페이지 표기만 장중으로 어긋난다.
    #   같은 날짜에 close 가 이미 있으면 장중 스냅샷은 무시한다(--force 로는 덮어쓸 수 있음).
    #   ※ history.json(일자별 종가)은 유형과 무관하므로 위에서 이미 갱신했다.
    if args.type == "intraday" and not args.force and LATEST_PATH.exists():
        try:
            cur = json.loads(LATEST_PATH.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            cur = {}
        if cur.get("type") == "close" and cur.get("date") == snap.date:
            print(f"[update] {snap.date} 종가 스냅샷이 이미 있음 — 장중 갱신 생략"
                  " (지연 실행이 종가를 덮어쓰는 것 방지)")
            return 0

    LATEST_PATH.write_text(
        json.dumps(asdict(snap), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    for key, idx in snap.indices.items():
        print(f"[update]   {idx['name']}: 52주 낙폭 {idx['dd52']}% "
              f"({idx['zone_label']}), 이격도 {idx['disparity']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
