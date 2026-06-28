/* 코스피·코스닥 MDD 트래커 — 프론트엔드 */
(function () {
  "use strict";

  // 지수별 구간 임계값(코스피=이그전, 코스닥=백분위 매칭). latest.json에서 덮어씀.
  const DEFAULT_THRESH = {
    kospi:  { disp: { overheat: 130, caution: 120, cooldown: 105 }, mdd: { watch: -5, correction: -10, breach: -15 } },
    kosdaq: { disp: { overheat: 124, caution: 118, cooldown: 106 }, mdd: { watch: -9, correction: -14, breach: -20 } },
  };
  let THRESH = DEFAULT_THRESH;

  const CFG = window.SITE_CONFIG || {};
  const track = (name, params) => {
    if (typeof window.gtag === "function") window.gtag("event", name, params || {});
  };

  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = (n, d = 2) =>
    n == null || isNaN(n) ? "—" : Number(n).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const signed = (n, d = 2) => (n == null || isNaN(n) ? "—" : (n > 0 ? "+" : "") + fmt(n, d));

  function mddZone(dd, key) {
    if (dd == null) return ["", ""];
    const t = THRESH[key].mdd;
    if (dd <= t.breach) return ["breach", "경계"];
    if (dd <= t.correction) return ["correction", "조정"];
    if (dd <= t.watch) return ["watch", "관심"];
    return ["normal", "정상"];
  }
  function dispZone(d, key) {
    if (d == null) return ["", ""];
    const t = THRESH[key].disp;
    if (d >= t.overheat) return ["overheat", "과열"];
    if (d >= t.caution) return ["caution", "경계"];
    if (d <= t.cooldown) return ["cooldown", "과열해소"];
    return ["normal", "정상"];
  }

  // 통합 신호: MDD 구간 + 이격도 → (class, emoji, 결론, 설명)
  function combinedSignal(dd, disp, key) {
    const [mz] = mddZone(dd, key);
    const dt = THRESH[key].disp;
    const cool = disp != null && disp <= dt.cooldown;
    const hot = disp != null && disp >= dt.overheat;
    if (mz === "breach")
      return ["alert", "🔴", "경계", "고점 대비 낙폭이 −15%를 넘었습니다. 역사적으로 경기둔화기에만 나온 깊이로, 단순 조정과 구분이 필요합니다."];
    if (mz === "correction") {
      if (cool) return ["buy", "🟢", "분할매수 후보", "강세장 정상 범위의 조정이면서 이격도도 과열 해소(≤105) 구간입니다. 패닉셀보다 분할매수를 고려할 자리."];
      if (hot) return ["wait", "🟡", "대기", "고점 대비론 빠졌지만 이격도가 과열(≥130)이라 50일선 대비 아직 비쌉니다. 더 식기를 기다릴 구간."];
      return ["buy", "🟢", "정상 조정", "강세장에서 흔한 −10%대 조정입니다. 전략을 쉽게 포기하지 말 것. 이격도까지 해소되면 매수 관심."];
    }
    if (mz === "watch") {
      if (cool) return ["buy", "🟢", "매수 관심", "조정이 진행 중이고 이격도도 과열 해소 구간입니다. 이격조정이 끝난 업종부터 관심."];
      return ["neutral", "⚪", "관망", "조정 초입입니다. 더 진행될지 지켜볼 구간."];
    }
    // normal
    if (hot) return ["avoid", "🟠", "추격매수 자제", "낙폭은 얕은데 이격도가 과열(≥130)입니다. 강세장일수록 곧 조정이 잦게 오니 추격매수는 자제."];
    return ["neutral", "⚪", "중립", "고점 부근의 통상 범위입니다. 특이 신호 없음."];
  }

  let ddChart, HISTORY = [];
  const VIS = { kospi: true, kosdaq: true };   // 차트 시리즈 표시 상태
  const SERIES_IDX = { kospi: 0, kosdaq: 1 };  // datasets 내 인덱스

  async function load() {
    wireTabs();
    wireTelegram();
    wireSeriesToggles();
    // 본 페이지(MDD)가 코스피·코스닥 MDD+이격도의 단일 소스(canonical).
    const [hist, latest] = await Promise.all([
      fetchJSON("./data/history.json"),
      fetchJSON("./data/latest.json"),
    ]);

    HISTORY = (hist || []).filter((d) => d && d.kospi_dd != null);
    if (!latest || !latest.indices) { emptyState(); return; }
    if (latest.thresholds && latest.thresholds.kospi) THRESH = latest.thresholds;

    $("updatedAt").textContent = `${latest.date} ${latest.type === "close" ? "15:40" : "12:00"} 기준`;
    renderSignals(latest);
    renderDualCards(latest);
    renderGauge(latest);

    if (HISTORY.length) {
      registerZoom();
      buildDdChart(250);
      renderTable();
      wireRangeButtons("rangeBtns", (n) => buildDdChart(n));
    }
  }

  function wireTabs() {
    const url = CFG.disparityUrl || "";
    if (url) {
      const join = (u) => u + (u.includes("?") ? "&" : "?") + "utm_source=mdd&utm_medium=tab";
      ["dispTab", "dispLink2"].forEach((id) => {
        const el = $(id);
        if (!el) return;
        el.href = join(url);
        el.addEventListener("click", () => track("disparity_click", { from: id }));
      });
    }
  }

  function wireTelegram() {
    const url = CFG.telegramUrl || "";
    if (!url) return;
    const l = $("tgLink");
    if (!l) return;
    l.href = url;
    l.hidden = false;
    l.addEventListener("click", () => track("telegram_click", { url }));
  }

  function wireSeriesToggles() {
    const box = $("seriesToggles");
    if (!box) return;
    box.addEventListener("click", (e) => {
      const b = e.target.closest(".series-toggle");
      if (!b) return;
      const key = b.dataset.key;
      VIS[key] = !VIS[key];
      b.classList.toggle("on", VIS[key]);
      if (ddChart) {
        ddChart.setDatasetVisibility(SERIES_IDX[key], VIS[key]);
        ddChart.update();
      }
      track("series_toggle", { key: key, on: VIS[key] });
    });
  }

  function effDisp(idx) {
    return idx.disparity;
  }

  function renderSignals(latest) {
    const order = ["kospi", "kosdaq"];
    $("signalRows").innerHTML = order.map((key) => {
      const idx = latest.indices[key];
      if (!idx) return "";
      const [cls, emoji, verdict, desc] = combinedSignal(idx.dd52, effDisp(idx), key);
      return `<div class="sig ${cls}">
        <span class="sig-emoji">${emoji}</span>
        <div class="sig-main">
          <div class="sig-idx">${idx.name} · MDD ${signed(idx.dd52, 1)}% · 이격도 ${fmt(effDisp(idx), 1)}</div>
          <div class="sig-verdict">${verdict}</div>
          <div class="sig-desc">${desc}</div>
        </div>
      </div>`;
    }).join("");
  }

  function renderDualCards(latest) {
    const order = ["kospi", "kosdaq"];
    $("dualCards").innerHTML = order.map((key) => {
      const idx = latest.indices[key];
      if (!idx) return "";
      const [zk, zl] = mddZone(idx.dd52, key);
      const disp = effDisp(idx);
      const [dzk, dzl] = dispZone(disp, key);
      const up = idx.change > 0, dn = idx.change < 0;
      const chg = idx.change == null ? "" :
        `${up ? "▲" : dn ? "▼" : "—"} ${fmt(Math.abs(idx.change))} (${signed(idx.change_pct)}%)`;
      return `<div class="idx-card">
        <div class="idx-head">
          <div class="idx-name"><span class="dot ${key}"></span>${idx.name}</div>
          <div class="idx-price">${fmt(idx.price)}<span class="chg ${up ? "up" : dn ? "down" : ""}">${chg}</span></div>
        </div>
        <div class="dd-big z-${zk}">${signed(idx.dd52, 1)}<span class="pct">%</span></div>
        <div class="idx-zone z-${zk}">${zl} · 52주 고점 대비</div>
        <div class="idx-stats">
          <div class="row"><span class="k">사상 최고가 대비</span><span class="v z-${mddZone(idx.dd_ath, key)[0]}">${signed(idx.dd_ath, 1)}%</span></div>
          <div class="row"><span class="k">52주 고점</span><span class="v">${fmt(idx.high_52w)}</span></div>
          <div class="row"><span class="k">50일 이격도</span><span class="v dz-${dzk}">${fmt(disp, 1)}<span class="sub">${dzl}</span></span></div>
        </div>
      </div>`;
    }).join("");
  }

  // 게이지 위치: 각 지수의 '자기 구간(zone)' 안에서의 위치(0~100%).
  // 좌(경계)→우(정상). 구간별 동일폭(25%) 세그먼트에 매핑하므로 코스피·코스닥이 한 게이지에서 공정 비교.
  function mddPos(dd, key) {
    const t = THRESH[key].mdd;
    let p;
    if (dd >= t.watch) p = 75 + clamp((dd - t.watch) / (0 - t.watch), 0, 1) * 25;         // 정상
    else if (dd >= t.correction) p = 50 + (dd - t.correction) / (t.watch - t.correction) * 25; // 관심
    else if (dd >= t.breach) p = 25 + (dd - t.breach) / (t.correction - t.breach) * 25;        // 조정
    else { const floor = t.breach * 1.6; p = clamp((dd - floor) / (t.breach - floor), 0, 1) * 25; } // 경계
    return clamp(p, 4, 96);
  }

  function renderGauge(latest) {
    const place = (idx, mkId, vId) => {
      const data = latest.indices[idx];
      if (!data) return;
      const m = $(mkId);
      m.style.left = mddPos(data.dd52, idx) + "%";
      m.hidden = false;
      $(vId).textContent = `${signed(data.dd52, 1)}%`;
    };
    place("kospi", "mkKospi", "mkKospiV");
    place("kosdaq", "mkKosdaq", "mkKosdaqV");
  }

  function emptyState() {
    $("signalRows").innerHTML = `<div class="sig neutral"><span class="sig-emoji">⏳</span><div class="sig-main"><div class="sig-verdict">첫 데이터 갱신 대기 중</div><div class="sig-desc">GitHub Actions의 첫 실행이 완료되면 표시됩니다.</div></div></div>`;
  }

  // ---- 차트 ----
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  function slice(n) { return n && n > 0 ? HISTORY.slice(-n) : HISTORY; }

  function buildDdChart(n) {
    const data = slice(n);
    const labels = data.map((d) => d.date);
    const ctx = $("ddChart");
    if (ddChart) ddChart.destroy();
    const line = (key, color) => ({
      label: key === "kospi" ? "코스피" : "코스닥",
      data: data.map((d) => d[key + "_dd"]),
      borderColor: color, borderWidth: 1.6, pointRadius: 0, tension: 0.12, fill: false,
      hidden: !VIS[key],   // 토글 상태 유지(범위 변경 시에도)
    });
    const ref = (y, color) => ({
      label: "", data: labels.map(() => y), borderColor: color,
      borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false,
    });
    ddChart = new Chart(ctx, {
      type: "line",
      data: { labels, datasets: [
        line("kospi", css("--kospi")), line("kosdaq", css("--kosdaq")),
        ref(THRESH.kospi.mdd.correction, css("--correction")), ref(THRESH.kospi.mdd.breach, css("--breach")),
      ] },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#0b0f17", borderColor: "#222c3d", borderWidth: 1,
            titleColor: "#e7edf6", bodyColor: "#e7edf6", padding: 10,
            filter: (item) => item.dataset.label !== "",
            callbacks: { label: (c) => `${c.dataset.label}: ${signed(c.parsed.y, 2)}%` },
          },
          zoom: {
            pan: { enabled: true, mode: "x" },
            zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" },
          },
        },
        scales: {
          x: { ticks: { color: css("--muted"), maxTicksLimit: 6, font: { size: 10 } }, grid: { color: "#1c2535" } },
          y: { position: "right", suggestedMax: 1, ticks: { color: css("--muted"), font: { size: 10 }, callback: (v) => v + "%" }, grid: { color: "#1c2535" } },
        },
      },
    });
    ctx.ondblclick = () => ddChart.resetZoom();
  }

  function registerZoom() {
    if (!window.Chart) return;
    const z = window.ChartZoom || window.chartjsPluginZoom || window["chartjs-plugin-zoom"];
    if (z && (z.id === "zoom" || z.default)) {
      try { window.Chart.register(z.default || z); } catch (e) { /* 이미 등록됨 */ }
    }
  }

  function wireRangeButtons(boxId, onPick) {
    const box = $(boxId);
    if (!box) return;
    box.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      [...box.children].forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      onPick(+b.dataset.r);
      track("range_change", { range: b.dataset.r });
    });
  }

  function renderTable() {
    const tb = $("histTable").querySelector("tbody");
    const rows = HISTORY.slice(-30).reverse();
    tb.innerHTML = rows.map((d) => {
      const [kz, kl] = mddZone(d.kospi_dd, "kospi");
      const hasKq = d.kosdaq_dd != null;
      const [qz, ql] = hasKq ? mddZone(d.kosdaq_dd, "kosdaq") : ["", "—"];
      return `<tr>
        <td class="c-date">${d.date}</td>
        <td class="c-kospi"><b>${signed(d.kospi_dd, 1)}%</b></td>
        <td class="c-kzone"><span class="pill ${kz}">${kl}</span></td>
        <td class="c-kosdaq"><b>${hasKq ? signed(d.kosdaq_dd, 1) + "%" : "—"}</b></td>
        <td class="c-dzone">${hasKq ? `<span class="pill ${qz}">${ql}</span>` : ""}</td>
      </tr>`;
    }).join("");
  }

  async function fetchJSON(url, external) {
    try {
      const sep = url.includes("?") ? "&" : "?";
      const r = await fetch(url + sep + "v=" + Date.now(), external ? { mode: "cors" } : undefined);
      if (!r.ok) return null;
      const t = (await r.text()).trim();
      return t ? JSON.parse(t) : null;
    } catch (e) { return null; }
  }

  load();
})();
