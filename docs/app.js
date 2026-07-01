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

  let ddChart, HISTORY = [];
  const VIS = { kospi: true, kosdaq: true };   // 차트 시리즈 표시 상태
  const SERIES_IDX = { kospi: 0, kosdaq: 1 };  // datasets 내 인덱스

  async function load() {
    wireTabs();
    wireTelegram();
    wireShare();
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
    checkStale(latest.date);
    renderDualCards(latest);
    renderGauge(latest);

    if (HISTORY.length) {
      registerZoom();
      buildDdChart(250);
      renderTable();
      wireRangeButtons("rangeBtns", (n) => buildDdChart(n));
    }
  }

  // 공유 버튼: 정식(netlify) 주소를 공유 추적 태그와 함께 — 모바일은 네이티브 공유(카톡·텔레그램), 데스크톱은 복사.
  function wireShare() {
    const btn = $("shareBtn");
    if (!btn) return;
    const base = CFG.shareUrl || location.href;
    const url = base + (base.includes("?") ? "&" : "?") + "utm_source=share&utm_medium=button";
    btn.addEventListener("click", async () => {
      track("share_click", {});
      if (navigator.share) {
        try { await navigator.share({ title: document.title, url }); return; } catch (e) { /* 취소 등 */ }
      }
      try { await navigator.clipboard.writeText(url); toast("링크가 복사됐어요 — 붙여넣기 하세요"); }
      catch (e) { toast(url); }
    });
  }

  function toast(msg) {
    let t = $("toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove("show"), 2400);
  }

  // 데이터 갱신 지연 감지: 마지막 데이터일이 4일(주말 여유 포함) 넘게 지났으면 경고 표시.
  function checkStale(dateStr) {
    if (!dateStr) return;
    const last = new Date(dateStr + "T00:00:00+09:00");
    const now = new Date();
    const days = Math.floor((now - last) / 86400000);
    if (days >= 4) {
      const row = document.querySelector(".updated-row");
      if (row && !document.getElementById("staleWarn")) {
        const s = document.createElement("span");
        s.id = "staleWarn";
        s.className = "stale-warn";
        s.textContent = `⚠ 갱신 지연 — ${days}일 전 데이터`;
        row.appendChild(s);
      }
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

  function renderDualCards(latest) {
    const order = ["kospi", "kosdaq"];
    $("dualCards").innerHTML = order.map((key) => {
      const idx = latest.indices[key];
      if (!idx) return "";
      const [zk, zl] = mddZone(idx.dd52, key);
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
    $("dualCards").innerHTML = `<div class="idx-card"><div class="idx-zone">첫 데이터 갱신 대기 중</div><p class="muted">GitHub Actions의 첫 실행이 완료되면 표시됩니다.</p></div>`;
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
