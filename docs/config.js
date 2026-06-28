/*
 * 사이트 설정 — 여기 값만 채우면 자동 반영됩니다. (코드 수정 불필요)
 *
 * 1) disparityUrl     : 50일 이격도 페이지(시즌1) 주소. 상단 탭에서 이동.
 * 2) telegramUrl      : 텔레그램 채널 공개 링크. 채우면 헤더에 채널 버튼 표시.
 * 3) gaMeasurementId  : Google Analytics 4 측정 ID. (비우면 추적 비활성)
 *
 * ※ 본 MDD 페이지가 코스피·코스닥 MDD+이격도의 단일 소스(canonical)입니다.
 *   이격도(시즌1) 페이지는 본 페이지의 data/*.json 을 읽어 같은 수치를 표시합니다.
 */
window.SITE_CONFIG = {
  disparityUrl: "https://kospi-ma.netlify.app/",
  telegramUrl: "https://t.me/andyc14note",
  gaMeasurementId: "G-B8M3849G0G",
};
