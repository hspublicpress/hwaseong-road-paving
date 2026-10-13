/* 도로·보도 포장 발주 주기 지도 — NAVER Maps JavaScript API v3 */
(function () {
  const BAND_COLOR = { "1년 미만": "#b2182b", "1~2년": "#ef6548", "2~3년": "#fdae61", "3~5년": "#a6d96a", "5년 이상": "#1a9641", "단일": "#9e9e9e", "도로단위": "#9ecae1", "위치미상": "#cfcfcf" };
  const BAND_ORDER = ["1년 미만", "1~2년", "2~3년", "3~5년", "5년 이상", "단일", "도로단위", "위치미상"];
  const params = new URLSearchParams(location.search);
  let CITY = params.get("city") || (function () { try { return localStorage.getItem("road_city"); } catch (_) { return null; } })() || (window.CITIES || ["화성시"])[0];
  // 공개 호스팅(아티팩트 등)에서는 한글 폴더 대신 window.CITY_DIRS 로 ASCII 폴더명을 쓴다
  const dataPath = (f) => "data/" + ((window.CITY_DIRS || {})[CITY] ? (window.CITY_DIRS)[CITY] : encodeURIComponent(CITY)) + "/" + f;
  const $ = (s) => document.querySelector(s);
  const fmtWon = (v) => (v == null || v === "" || isNaN(v)) ? "-" : (Number(v) / 1e8 >= 1 ? (Number(v) / 1e8).toFixed(1) + "억원" : Math.round(Number(v) / 1e4).toLocaleString("ko-KR") + "만원");
  const gapText = (d) => d == null ? "" : (d < 365 ? Math.round(d / 30) + "개월" : (d / 365).toFixed(1) + "년");
  const state = { map: null, segs: [], hist: {}, dong: null, dongPolys: [], shapes: {}, selected: null, filters: { road: true, walk: true, c: false, dong: "", q: "" } };

  function showMsg(html) { const el = $("#overlay-msg"); el.innerHTML = html; el.hidden = false; }
  function hideMsg() { $("#overlay-msg").hidden = true; }
  async function loadJson(p) { const r = await fetch(p); if (!r.ok) throw new Error(p + " (" + r.status + ")"); return r.json(); }
  function loadNaver(cid) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=" + encodeURIComponent(cid);
      s.onload = res; s.onerror = () => rej(new Error("네이버 지도 스크립트 로드 실패"));
      window.navermap_authFailure = () => showMsg("<b>네이버 지도 인증 실패</b><br>NCP 콘솔에서 Client ID 와 서비스 URL(현재 주소, 예: http://localhost:8001)을 확인하세요.");
      document.head.appendChild(s);
    });
  }

  async function boot() {
    const sel = $("#city-select");
    (window.CITIES || [CITY]).forEach(c => { const o = document.createElement("option"); o.value = o.textContent = c; sel.appendChild(o); });
    sel.value = CITY; $("#city-title").textContent = CITY; document.title = CITY + " 포장 발주 주기 지도";
    sel.onchange = () => { try { localStorage.setItem("road_city", sel.value); } catch (_) { /* noop */ } location.search = "?city=" + encodeURIComponent(sel.value); };
    let summary, segs, hist, dong;
    try {
      [summary, segs, hist, dong] = await Promise.all([loadJson(dataPath("summary.json")), loadJson(dataPath("segments.geojson")), loadJson(dataPath("history.json")), loadJson(dataPath("dong.geojson"))]);
    } catch (e) { showMsg("<b>" + CITY + " 데이터가 없습니다.</b><br>scripts/01~05 를 --city " + CITY + " 로 실행하세요.<br>" + e.message); return; }
    state.segs = segs.features; state.hist = hist; state.dong = dong; state.summary = summary;
    const ds = $("#dong-select");
    dong.features.map(f => f.properties.dong).sort().forEach(d => { const o = document.createElement("option"); o.value = o.textContent = d; ds.appendChild(o); });
    ds.onchange = () => { state.filters.dong = ds.value; applyFilters(); zoomDong(ds.value); };
    $("#chk-road").onchange = (e) => { state.filters.road = e.target.checked; applyFilters(); };
    $("#chk-walk").onchange = (e) => { state.filters.walk = e.target.checked; applyFilters(); };
    $("#chk-c").onchange = (e) => { state.filters.c = e.target.checked; applyFilters(); };
    $("#search").oninput = (e) => { state.filters.q = e.target.value.trim(); applyFilters(); };
    renderLegend();
    $("#note").textContent = summary.note + " 자료 기간 " + summary.period[0] + "~" + summary.period[1] + ", 생성 " + summary.generatedAt + ".";
    if (!window.NCP_CLIENT_ID) { showMsg("NCP_CLIENT_ID 가 비어 있습니다. .env 를 채우고 05_intervals.py 를 다시 실행하세요."); renderList(); return; }
    try { await loadNaver(window.NCP_CLIENT_ID); } catch (e) { showMsg(e.message); renderList(); return; }
    initMap(); applyFilters();
  }

  function renderLegend() {
    $("#legend").innerHTML = "<b>직전 발주와의 최소 간격</b> " + BAND_ORDER.map(b => '<span><i style="background:' + BAND_COLOR[b] + '"></i>' + b + "</span>").join("");
  }

  function visible(f) {
    const p = f.properties, fl = state.filters;
    if (p.시설구분 === "차도" && !fl.road) return false;
    if (p.시설구분 === "보도" && !fl.walk) return false;
    if ((String(p.정확도).startsWith("C") || String(p.정확도).startsWith("B2")) && !fl.c) return false;
    if (fl.dong && p.읍면동 !== fl.dong) return false;
    if (fl.q && !((p.공고명 || "") + " " + (p.도로명 || "") + " " + (p.사업위치 || "")).includes(fl.q)) return false;
    return true;
  }

  function eachRing(geom, fn) { const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates; polys.forEach(rings => rings.forEach(fn)); }
  function coordsOf(g) { return g.type === "Point" ? [[g.coordinates]] : (g.type === "LineString" ? [g.coordinates] : g.coordinates); }
  function baseWeight(p) { return p.시설구분 === "보도" ? 4 : 6; }

  function initMap() {
    hideMsg();
    const b = new naver.maps.LatLngBounds();
    state.dong.features.forEach(f => eachRing(f.geometry, ring => ring.forEach(c => b.extend(new naver.maps.LatLng(c[1], c[0])))));
    const map = new naver.maps.Map("map", { zoom: 11, minZoom: 9, zoomControl: true, zoomControlOptions: { position: naver.maps.Position.TOP_RIGHT } });
    map.fitBounds(b); state.map = map;
    state.dong.features.forEach(f => {
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      polys.forEach(rings => {
        const pg = new naver.maps.Polygon({ map, paths: rings.map(r => r.map(c => new naver.maps.LatLng(c[1], c[0]))), strokeColor: "#5a7", strokeWeight: 1, strokeOpacity: .6, fillColor: "#5a7", fillOpacity: .03, clickable: true, zIndex: 1 });
        naver.maps.Event.addListener(pg, "click", () => { $("#dong-select").value = f.properties.dong; state.filters.dong = f.properties.dong; applyFilters(); });
        state.dongPolys.push(pg);
      });
    });
    state.segs.forEach(f => {
      const p = f.properties, col = BAND_COLOR[p.단계] || "#999", g = f.geometry;
      const shapes = [];
      const onClick = () => select(p.id, true);
      if (g.type === "Point") {
        const c = new naver.maps.Circle({ map, center: new naver.maps.LatLng(g.coordinates[1], g.coordinates[0]), radius: 70, strokeColor: col, strokeWeight: 2, fillColor: col, fillOpacity: .45, clickable: true, zIndex: 20 });
        naver.maps.Event.addListener(c, "click", onClick); shapes.push(c);
      } else {
        coordsOf(g).forEach(ls => {
          const pl = new naver.maps.Polyline({ map, path: ls.map(c => new naver.maps.LatLng(c[1], c[0])), strokeColor: col, strokeWeight: baseWeight(p), strokeOpacity: .85, strokeStyle: p.시설구분 === "보도" ? "shortdash" : "solid", strokeLineCap: "round", clickable: true, zIndex: 30 });
          naver.maps.Event.addListener(pl, "click", onClick); shapes.push(pl);
        });
      }
      state.shapes[p.id] = shapes;
    });
  }

  function applyFilters() {
    const vis = new Set();
    state.segs.forEach(f => { const v = visible(f); if (v) vis.add(f.properties.id); (state.shapes[f.properties.id] || []).forEach(s => s.setMap(v ? state.map : null)); });
    renderStats(vis); renderList(vis);
  }
  function zoomDong(d) {
    if (!d || !state.map) return;
    const f = state.dong.features.find(x => x.properties.dong === d); if (!f) return;
    const b = new naver.maps.LatLngBounds(); eachRing(f.geometry, ring => ring.forEach(c => b.extend(new naver.maps.LatLng(c[1], c[0]))));
    state.map.fitBounds(b);
  }
  function renderStats(vis) {
    const cnt = {}; state.segs.forEach(f => { if (vis.has(f.properties.id)) cnt[f.properties.단계] = (cnt[f.properties.단계] || 0) + 1; });
    $("#stats").innerHTML = "표시 " + vis.size + "건: " + BAND_ORDER.filter(b => cnt[b]).map(b => '<span class="tag" style="background:' + BAND_COLOR[b] + '">' + b + " " + cnt[b] + "</span>").join(" ");
  }
  function renderList(vis) {
    vis = vis || new Set(state.segs.map(f => f.properties.id));
    const rows = state.segs.filter(f => vis.has(f.properties.id)).sort((a, b) => ((a.properties.최소간격일 == null ? 1e9 : a.properties.최소간격일) - (b.properties.최소간격일 == null ? 1e9 : b.properties.최소간격일)) || (b.properties.이력건수 - a.properties.이력건수));
    $("#list").innerHTML = rows.slice(0, 300).map(f => {
      const p = f.properties;
      return '<div class="row" data-id="' + p.id + '"><span class="tag" style="background:' + BAND_COLOR[p.단계] + '">' + p.단계 + "</span><b>" + p.공고명 + "</b><br><small>" + p.기준일 + " · " + p.시설구분 + "/" + (p.유형 || "-") + " · 이력 " + p.이력건수 + "건" + (p.최소간격일 != null ? " · 최소 간격 " + gapText(p.최소간격일) : "") + " · " + (p.읍면동 || "") + " · 위치 " + p.정확도 + "</small></div>";
    }).join("") + (rows.length > 300 ? '<p class="meta">' + (rows.length - 300) + "건 더 있음(검색·읍면동으로 좁히세요)</p>" : "");
    $("#list").querySelectorAll(".row").forEach(el => el.onclick = () => select(el.dataset.id, true));
    $("#detail").hidden = true; $("#list").hidden = false;
  }

  function select(id, pan) {
    const f = state.segs.find(x => x.properties.id === id); if (!f) return;
    const p = f.properties, hist = state.hist[id] || [];
    if (state.selected) {
      const prevP = state.segs.find(x => x.properties.id === state.selected).properties;
      (state.shapes[state.selected] || []).forEach(s => s.setOptions({ strokeWeight: s instanceof naver.maps.Circle ? 2 : baseWeight(prevP), zIndex: 30 }));
    }
    state.selected = id; (state.shapes[id] || []).forEach(s => s.setOptions({ strokeWeight: 10, zIndex: 50 }));
    if (pan && state.map) {
      const g = f.geometry;
      if (g.type === "Point") { state.map.setCenter(new naver.maps.LatLng(g.coordinates[1], g.coordinates[0])); }
      else { const b = new naver.maps.LatLngBounds(); coordsOf(g).forEach(ls => ls.forEach(c => b.extend(new naver.maps.LatLng(c[1], c[0])))); state.map.fitBounds(b, { top: 40, right: 40, bottom: 40, left: 40 }); }
      if (state.map.getZoom() < 14) state.map.setZoom(15);
    }
    let html = '<span class="back">← 목록</span><h2>' + p.공고명 + "</h2>" +
      '<div class="meta">' + p.시설구분 + " · " + (p.유형 || "-") + " · " + (p.수요기관 || "") + "<br>위치: " + (p.사업위치 || "(공고문에 없음)") +
      "<br>도로명: " + (p.도로명 || "-") + (p.노선 ? " · " + p.노선 : "") + (p.구간표기 ? " · 구간 " + p.구간표기 : "") +
      "<br>연장 " + (p.연장m_최대 ? Math.round(p.연장m_최대) + "m" : "-") + " · 면적 " + (p["면적㎡_합"] ? Math.round(p["면적㎡_합"]).toLocaleString() + "㎡" : "-") + " · 추정가격 " + fmtWon(p.추정가격) +
      "<br>위치 정확도 " + p.정확도 + " (" + (p.위치근거 || "") + ")</div>" +
      "<p><b>같은 자리 발주 이력 " + hist.length + '건</b></p><div class="hist">';
    hist.forEach((h, i) => {
      const prev = i > 0 ? (new Date(h.date) - new Date(hist[i - 1].date)) / 864e5 : null;
      html += '<div class="item ' + (h.id === id ? "cur" : "") + '">' + (prev != null ? '<div class="gap">↑ ' + gapText(prev) + " 만에 재발주</div>" : "") + "<b>" + h.date + "</b> " + h.name + '<br><span class="meta">' + h.facility + "/" + (h.type || "-") + " · " + fmtWon(h.price) + " · 위치 " + h.grade + "</span><br>" +
        (h.url ? '<a href="' + h.url + '" target="_blank" rel="noopener">나라장터 공고 보기</a>' : "") + (h.doc ? ' · <a href="' + h.doc + '" target="_blank" rel="noopener">공고문 내려받기</a>' : "") + (h.id !== id ? ' · <a href="#" data-sel="' + h.id + '">지도에서 보기</a>' : "") + "</div>";
    });
    html += "</div>";
    const d = $("#detail"); d.innerHTML = html; d.hidden = false; $("#list").hidden = true;
    d.querySelector(".back").onclick = () => { d.hidden = true; $("#list").hidden = false; };
    d.querySelectorAll("a[data-sel]").forEach(a => a.onclick = (e) => { e.preventDefault(); select(a.dataset.sel, true); });
  }

  boot();
})();
