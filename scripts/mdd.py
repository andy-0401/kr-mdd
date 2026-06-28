"""
코스피·코스닥 MDD(최대 낙폭, Maximum Drawdown) 계산 핵심 라이브러리
(이그전 - 이은택의 그림전략 이론 기반)

MDD(현재 낙폭) = (현재가 ÷ 직전 고점 − 1) × 100

본 트래커는 두 가지 고점 기준을 함께 제공한다.
  - 52주(최근 1년) 롤링 최고가 대비 낙폭  → 헤드라인 구간(zone) 판정 기준
  - 사상 최고가(수집 구간 내) 대비 낙폭   → 보조(맥락) 표기

이그전 응용법 (강세장일수록 조정이 더 자주·더 크게 나타남):
  - 0 ~ -5%   : 정상 (통상 범위)
  - -5 ~ -10% : 관심 (조정 진입 가능)
  - -10 ~ -15%: 조정 (강세장에선 흔한 정상 조정 / 패닉셀 자제)
  - -15% 이하 : 경계 (역사적으로 경기둔화기에만 출현)

동반 지표로 50일 이격도(현재가 ÷ 50일 이동평균 × 100)도 같은 종가로 산출한다.
(MDD + 이격도 동시 활용 → 조정 시점·매수 타이밍 가늠)

데이터 소스(무료 공개):
  - 과거 일봉 종가 : pykrx(KRX 공식) → 실패 시 Yahoo Finance 폴백
  - 장중 실시간 값 : Naver 금융 폴링 API → 실패 시 Yahoo Finance 폴백
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Optional
from zoneinfo import ZoneInfo

import requests

KST = ZoneInfo("Asia/Seoul")

WINDOW_52W = 250   # 52주 ≈ 250 거래일
MA_WINDOW = 50     # 50일 이동평균(동반 이격도)

# 지수별 구간 임계값.
#   코스피 = 이그전(이은택의 그림전략) 원본 기준 그대로.
#   코스닥 = 코스피 임계값과 '같은 희소도(백분위)'가 되도록 코스닥 자기 분포에서 산출.
#           (2005~2026 ≈21년 일봉 백분위 매칭 결과를 반영. 다중 사이클·이그전 실측 MDD와 교차검증됨.)
# disp = 이격도(현재가÷50일선×100), mdd = 52주 고점대비 낙폭(%, 음수).
THRESHOLDS = {
    "kospi": {
        "disp": {"overheat": 130.0, "caution": 120.0, "cooldown": 105.0},
        "mdd":  {"watch": -5.0, "correction": -10.0, "breach": -15.0},
    },
    "kosdaq": {
        "disp": {"overheat": 124.0, "caution": 118.0, "cooldown": 106.0},
        "mdd":  {"watch": -9.0, "correction": -14.0, "breach": -20.0},
    },
}

# 지수별 데이터 소스 식별자
INDICES = {
    "kospi": {
        "name": "코스피",
        "pykrx": "1001",          # KRX 코스피 종합지수
        "yahoo": "%5EKS11",       # ^KS11
        "naver": "KOSPI",
    },
    "kosdaq": {
        "name": "코스닥",
        "pykrx": "2001",          # KRX 코스닥 종합지수
        "yahoo": "%5EKQ11",       # ^KQ11
        "naver": "KOSDAQ",
    },
}


@dataclass
class DailyPoint:
    date: str          # YYYY-MM-DD
    close: float
    dd52: Optional[float] = None    # 52주 고점 대비 낙폭 %
    dd_ath: Optional[float] = None  # 사상최고가 대비 낙폭 %
    ma50: Optional[float] = None    # 50일 이동평균
    disparity: Optional[float] = None
    zone: Optional[str] = None      # MDD 구간 키


@dataclass
class IndexSnapshot:
    key: str           # "kospi" | "kosdaq"
    name: str          # "코스피"
    price: float
    change: Optional[float]
    change_pct: Optional[float]
    high_52w: float
    dd52: float        # 헤드라인 낙폭
    ath: float
    dd_ath: float
    zone: str
    zone_label: str
    ma50: Optional[float]
    disparity: Optional[float]
    prev_disparity: Optional[float]
    disp_zone: Optional[str]


@dataclass
class Snapshot:
    date: str
    time: str
    type: str          # "intraday" | "close"
    note: str
    updated_at: str
    indices: dict = field(default_factory=dict)  # key -> IndexSnapshot(dict)
    thresholds: dict = field(default_factory=dict)  # 지수별 구간 임계값(프런트 공유)


# --------------------------------------------------------------------------
# 구간 판정
# --------------------------------------------------------------------------
def classify_mdd(dd: float, index_key: str = "kospi") -> tuple[str, str]:
    """현재 낙폭(%) → (zone key, 한글 라벨). dd는 0 이하 음수. 지수별 임계값 적용."""
    t = THRESHOLDS[index_key]["mdd"]
    if dd <= t["breach"]:
        return "breach", "경계 (경기둔화 가능성)"
    if dd <= t["correction"]:
        return "correction", "조정 (강세장 정상 조정)"
    if dd <= t["watch"]:
        return "watch", "관심 (조정 진입 가능)"
    return "normal", "정상 (통상 범위)"


def classify_disparity(disp: float, index_key: str = "kospi") -> str:
    t = THRESHOLDS[index_key]["disp"]
    if disp >= t["overheat"]:
        return "overheat"
    if disp >= t["caution"]:
        return "caution"
    if disp <= t["cooldown"]:
        return "cooldown"
    return "normal"


# --------------------------------------------------------------------------
# 과거 일봉 수집
# --------------------------------------------------------------------------
def fetch_history_pykrx(index_key: str, days: int) -> list[DailyPoint]:
    from pykrx import stock  # 지연 임포트

    code = INDICES[index_key]["pykrx"]
    today = dt.datetime.now(KST).date()
    start = (today - dt.timedelta(days=days)).strftime("%Y%m%d")
    end = today.strftime("%Y%m%d")
    df = stock.get_index_ohlcv_by_date(start, end, code)
    if df is None or df.empty:
        raise RuntimeError(f"pykrx 응답이 비어 있음({index_key})")
    points: list[DailyPoint] = []
    for idx, row in df.iterrows():
        d = idx.date() if hasattr(idx, "date") else idx
        close = float(row["종가"])
        if close <= 0:
            continue
        points.append(DailyPoint(date=d.strftime("%Y-%m-%d"), close=close))
    return points


def fetch_history_yahoo(index_key: str, rng: str) -> list[DailyPoint]:
    sym = INDICES[index_key]["yahoo"]
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
        f"?range={rng}&interval=1d"
    )
    r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=20)
    r.raise_for_status()
    res = r.json()["chart"]["result"][0]
    ts = res["timestamp"]
    closes = res["indicators"]["quote"][0]["close"]
    points: list[DailyPoint] = []
    for t, c in zip(ts, closes):
        if c is None:
            continue
        d = dt.datetime.fromtimestamp(t, KST).date()
        points.append(DailyPoint(date=d.strftime("%Y-%m-%d"), close=float(c)))
    return points


def fetch_history(index_key: str, days: int = 1900) -> list[DailyPoint]:
    """과거 일봉 수집: pykrx 우선, 실패 시 Yahoo 폴백.
    (ATH 정확도를 위해 기본 ~5년 수집)"""
    errors = []
    try:
        pts = fetch_history_pykrx(index_key, days=days)
        if len(pts) >= WINDOW_52W:
            return pts
        errors.append(f"pykrx 데이터 부족({len(pts)}개)")
    except Exception as e:  # noqa: BLE001
        errors.append(f"pykrx 실패: {e}")
    try:
        rng = "5y" if days <= 1900 else "10y"
        return fetch_history_yahoo(index_key, rng=rng)
    except Exception as e:  # noqa: BLE001
        errors.append(f"yahoo 실패: {e}")
    raise RuntimeError(f"{index_key} 과거 데이터 수집 실패: " + " | ".join(errors))


# --------------------------------------------------------------------------
# 실시간(장중) 현재가
# --------------------------------------------------------------------------
def _scale_candidates(val: float) -> list[float]:
    """Naver 지수는 ×100 정수로 오기도 함 → 원값과 ÷100 둘 다 후보."""
    return [val, val / 100.0]


def fetch_live_naver(index_key: str) -> float:
    name = INDICES[index_key]["naver"]
    url = f"https://polling.finance.naver.com/api/realtime/domestic/index/{name}"
    r = requests.get(
        url,
        headers={"User-Agent": "Mozilla/5.0", "Referer": "https://finance.naver.com/"},
        timeout=15,
    )
    r.raise_for_status()
    data = r.json()
    datas = data.get("datas") or data.get("result", {}).get("datas") or []
    if not datas:
        raise RuntimeError("naver 응답에 datas 없음")
    nv = datas[0].get("nv")
    if nv is None:
        raise RuntimeError("naver 응답에 nv 없음")
    return float(nv)


def fetch_live_yahoo(index_key: str) -> float:
    sym = INDICES[index_key]["yahoo"]
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
        f"?range=1d&interval=1m"
    )
    r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
    r.raise_for_status()
    meta = r.json()["chart"]["result"][0]["meta"]
    return float(meta["regularMarketPrice"])


def fetch_live(index_key: str, reference_close: Optional[float] = None) -> float:
    """실시간 현재가: Naver 우선, 스케일/이상치 보정 후 Yahoo 폴백."""
    # Naver: 스케일 후보 중 reference에 가장 가까운 값 채택
    try:
        raw = fetch_live_naver(index_key)
        cands = [v for v in _scale_candidates(raw) if v > 0]
        if reference_close:
            cands.sort(key=lambda v: abs(v - reference_close) / reference_close)
            if cands and abs(cands[0] - reference_close) / reference_close <= 0.3:
                return cands[0]
        elif cands:
            return cands[0]
    except Exception:  # noqa: BLE001
        pass
    try:
        return fetch_live_yahoo(index_key)
    except Exception:  # noqa: BLE001
        pass
    raise RuntimeError(f"{index_key} 실시간 현재가 수집 실패")


# --------------------------------------------------------------------------
# 낙폭/이격도 계산
# --------------------------------------------------------------------------
def compute_history(points: list[DailyPoint], index_key: str = "kospi") -> list[DailyPoint]:
    """일봉 리스트에 52주/ATH 낙폭·이격도·구간 채우기(날짜 오름차순)."""
    pts = sorted(points, key=lambda p: p.date)
    closes = [p.close for p in pts]
    run_ath = 0.0
    for i, p in enumerate(pts):
        run_ath = max(run_ath, p.close)
        high52 = max(closes[max(0, i - WINDOW_52W + 1): i + 1])
        p.dd52 = round((p.close / high52 - 1.0) * 100.0, 2)
        p.dd_ath = round((p.close / run_ath - 1.0) * 100.0, 2)
        p.zone = classify_mdd(p.dd52, index_key)[0]
        if i + 1 >= MA_WINDOW:
            ma = sum(closes[i + 1 - MA_WINDOW: i + 1]) / MA_WINDOW
            p.ma50 = round(ma, 2)
            p.disparity = round(p.close / ma * 100.0, 2)
    return pts


def _index_snapshot(index_key: str, history: list[DailyPoint], run_type: str) -> IndexSnapshot:
    pts = sorted(history, key=lambda p: p.date)
    closes = [p.close for p in pts]
    last = pts[-1]
    prev = pts[-2] if len(pts) >= 2 else None
    name = INDICES[index_key]["name"]

    if run_type == "close":
        price = last.close
        high52 = max(closes[-WINDOW_52W:])
        ath = max(closes)
        ma50 = sum(closes[-MA_WINDOW:]) / MA_WINDOW if len(closes) >= MA_WINDOW else None
        prev_close = prev.close if prev else None
    else:  # intraday — 오늘 미확정: 직전 종가들 + 실시간 현재가
        live = fetch_live(index_key, reference_close=last.close)
        price = round(live, 2)
        # 오늘 실시간을 고점 후보로 포함
        high52 = max(max(closes[-WINDOW_52W:]), price)
        ath = max(max(closes), price)
        ma50 = sum(closes[-MA_WINDOW:]) / MA_WINDOW if len(closes) >= MA_WINDOW else None
        prev_close = last.close

    dd52 = round((price / high52 - 1.0) * 100.0, 2)
    dd_ath = round((price / ath - 1.0) * 100.0, 2)
    zone, zone_label = classify_mdd(dd52, index_key)
    disparity = round(price / ma50 * 100.0, 2) if ma50 else None
    disp_zone = classify_disparity(disparity, index_key) if disparity is not None else None
    # 직전 이격도: close=마지막 확정일의 직전, intraday=마지막 확정일
    prev_disparity = ((prev.disparity if prev else None) if run_type == "close" else last.disparity)
    change = round(price - prev_close, 2) if prev_close else None
    change_pct = round((price - prev_close) / prev_close * 100.0, 2) if prev_close else None

    return IndexSnapshot(
        key=index_key, name=name, price=round(price, 2),
        change=change, change_pct=change_pct,
        high_52w=round(high52, 2), dd52=dd52,
        ath=round(ath, 2), dd_ath=dd_ath,
        zone=zone, zone_label=zone_label,
        ma50=round(ma50, 2) if ma50 else None,
        disparity=disparity, prev_disparity=prev_disparity, disp_zone=disp_zone,
    )


def build_snapshot(histories: dict[str, list[DailyPoint]], run_type: str) -> Snapshot:
    now = dt.datetime.now(KST)
    if run_type == "close":
        time_str = "15:40"
        note = "장 마감 종가 기준 확정값입니다."
        date_str = max(h[-1].date for h in histories.values())
    else:
        time_str = "12:00"
        note = "정규장 중 실시간 현재가 기준 추정치입니다(종가 확정 시 갱신)."
        date_str = now.strftime("%Y-%m-%d")

    indices: dict[str, dict] = {}
    for key, hist in histories.items():
        snap = _index_snapshot(key, hist, run_type)
        indices[key] = snap.__dict__
    return Snapshot(
        date=date_str, time=time_str, type=run_type, note=note,
        updated_at=f"{date_str}T{time_str}:00+09:00", indices=indices,
        thresholds=THRESHOLDS,
    )


def history_to_records(histories: dict[str, list[DailyPoint]]) -> list[dict]:
    """두 지수의 낙폭 시계열을 날짜 기준으로 합쳐 차트용 레코드 생성."""
    by_date: dict[str, dict] = {}
    for key, hist in histories.items():
        for p in hist:
            if p.dd52 is None:
                continue
            row = by_date.setdefault(p.date, {"date": p.date})
            row[f"{key}_close"] = round(p.close, 2)
            row[f"{key}_dd"] = p.dd52
            if p.ma50 is not None:
                row[f"{key}_ma50"] = p.ma50
            if p.disparity is not None:
                row[f"{key}_disp"] = p.disparity
    return [by_date[d] for d in sorted(by_date)]


def is_trading_today(histories: dict[str, list[DailyPoint]]) -> bool:
    today = dt.datetime.now(KST).strftime("%Y-%m-%d")
    return any(h and h[-1].date == today for h in histories.values())
