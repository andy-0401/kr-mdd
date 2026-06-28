# 코스피·코스닥 MDD 트래커 (이그전 시즌2)

고점 대비 **최대 낙폭(MDD, Maximum Drawdown)**을 코스피·코스닥 두 지수로 실시간 추적하는 정적 웹페이지.
[50일 이격도 트래커](https://kospi-ma.netlify.app/)의 자매 페이지(시즌2)로, 상단 탭으로 오갈 수 있다.

> **MDD = (현재가 ÷ 직전 고점 − 1) × 100**

## 이 페이지로 무엇을 보나

이그전(이은택의 그림전략) 이론의 핵심: **강세장일수록 조정(MDD)은 더 자주·더 크게 나타난다.**
그래서 −10%대 조정은 강세장에선 '비정상'이 아니라 '정상'에 가깝다. 이 페이지는

1. **현재 위치** — 코스피·코스닥이 고점 대비 몇 % 빠졌는지 (52주 / 사상최고가 두 기준)
2. **정상성 판단** — 지금 낙폭이 강세장에서 흔한 조정인지, 드물게 깊은 하락(−15%+)인지
3. **통합 신호** — MDD에 **50일 이격도**를 결합해 "분할매수 후보 / 대기 / 추격매수 자제 / 경계"를 제시

를 보여준다. (매매 권유가 아니라 구간 설명용)

### 구간(52주 고점 대비)

| 낙폭 | 구간 | 의미 |
|---|---|---|
| 0 ~ -5% | 정상 | 통상 범위 |
| -5 ~ -10% | 관심 | 조정 진입 가능 |
| -10 ~ -15% | 조정 | 강세장에선 흔한 정상 조정, 패닉셀 자제 |
| -15% 이하 | 경계 | 역사적으로 경기둔화기에만 출현 |

## 구조

```
docs/            정적 사이트(Netlify publish 루트)
  index.html     페이지
  app.js         렌더링(듀얼 카드·통합 배너·게이지·차트)
  styles.css
  config.js      이격도 페이지 링크/데이터 URL, GA4 ID
  data/          history.json(낙폭 시계열) · latest.json(최신 스냅샷) — Actions가 갱신
  share/         링크 공유용 OG 프리뷰
scripts/
  mdd.py         수집·낙폭/이격도 계산 핵심 라이브러리
  run_update.py  갱신 엔트리포인트
  requirements.txt
.github/workflows/update.yml   매 거래일 12:00 / 15:40 KST 자동 갱신
```

## 로컬 실행

```bash
pip install -r scripts/requirements.txt
python scripts/run_update.py --type close --force   # 데이터 생성
cd docs && python3 -m http.server 8000              # http://localhost:8000
```

데이터 소스: pykrx(KRX) 우선, 실패 시 Yahoo Finance 폴백. 장중값은 Naver 금융 폴링 API.

## 이격도 페이지와의 연동

`config.js`의 `disparityDataUrl`이 이격도 페이지의 `latest.json`을 가리키면, 코스피 이격도 값을
원본에서 그대로 가져와(재계산 X) 두 페이지가 같은 숫자를 말하도록 보정한다. (CORS 허용 필요 — `netlify.toml`)

※ 본 사이트는 정보 제공용이며 투자 권유가 아닙니다. 출처: [이그전](https://m.blog.naver.com/egzion/224322732361).
