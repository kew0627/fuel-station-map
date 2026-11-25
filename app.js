"use strict";

(() => {
  const get = id => document.getElementById(id);
  const isMap = document.body.dataset.page === "map";
  const province = get("province");
  const district = get("district");
  const result = get("result");
  const imports = { stations: null, prices: null };
  const versions = { stations: 0, prices: 0 };
  const formatNumber = new Intl.NumberFormat("ko-KR");
  const items = rows => formatNumber.format(rows.length);
  let selection = null;
  let boundary = null;
  let map;
  let histories = new Map();
  let shownStations = [];
  let selectedStation = null;

  province.replaceChildren(new Option("시·도 선택", ""), ...FuelData.orderedProvinces.map(region => new Option(region.name, region.code)));
  updateDistricts();

  function updateDistricts(code = "") {
    district.replaceChildren(new Option("시·도 전체", ""));
    const region = FuelData.provinces.get(province.value);
    district.disabled = !region || !imports.stations || !imports.prices;
    if (!region) return;
    const cities = new Set();
    for (const item of [...region.districts].sort((a, b) => a.label.localeCompare(b.label, "ko"))) {
      if (item.parent && !cities.has(item.parent)) {
        cities.add(item.parent);
        district.add(new Option(item.parent + " 전체", "city:" + item.parent));
      }
      district.add(new Option(item.label, item.code));
    }
    district.value = code;
  }

  function setNote(node, message, error = false) {
    node.textContent = message;
    node.toggleAttribute("data-error", error);
  }

  function waitForPaint() {
    return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }

  for (const type of Object.keys(imports)) {
    const input = get(type);
    const note = get(type + "-note");
    input.addEventListener("change", async () => {
      const version = ++versions[type];
      imports[type] = null;
      refresh();
      const file = input.files[0];
      if (!file) {
        setNote(note, "");
        return;
      }
      setNote(note, "파일을 읽는 중입니다.");
      try {
        const bytes = await file.arrayBuffer();
        await waitForPaint();
        if (version !== versions[type]) return;
        const loaded = FuelData.readCsv(bytes, type);
        imports[type] = loaded;
        const unknown = loaded.rows.filter(record => !record.region).length;
        const broad = loaded.rows.filter(record => record.region && !record.region.district).length;
        const notes = [items(loaded.rows) + "행 · " + loaded.encoding];
        if (loaded.info) notes.push("기간 안내 " + loaded.info + "행 제외");
        if (loaded.invalid) notes.push("CSV 형식 오류 " + loaded.invalid + "행 제외");
        if (loaded.badDate) notes.push("잘못된 기록일 " + loaded.badDate + "행 제외");
        if (unknown) notes.push("시·도 미확인 " + formatNumber.format(unknown) + "행");
        if (broad) notes.push("시·군·구 미확인 " + formatNumber.format(broad) + "행");
        setNote(note, notes.join(" · "));
      } catch (error) {
        if (version === versions[type]) setNote(note, error.message, true);
      }
      if (version !== versions[type]) return;
      if (isMap && imports.stations && imports.prices) {
        const automatic = FuelData.autoRegion([...imports.stations.rows, ...imports.prices.rows]);
        province.value = automatic?.province ?? "";
        updateDistricts(automatic?.district);
      }
      refresh();
    });
  }

  province.addEventListener("change", () => {
    updateDistricts();
    refresh();
  });
  district.addEventListener("change", refresh);

  function refresh() {
    const loaded = Boolean(imports.stations && imports.prices);
    province.disabled = !loaded;
    district.disabled = !loaded || !province.value;
    selection = null;
    if (loaded && province.value) {
      const matches = record => FuelData.selectionContains(record.region, province.value, district.value);
      selection = {
        stations: imports.stations.rows.filter(matches),
        prices: imports.prices.rows.filter(matches)
      };
    }
    if (isMap) renderMap();
    else {
      get("save-stations").disabled = !selection;
      get("save-prices").disabled = !selection;
    }
    if (!selection) {
      result.textContent = loaded ? "시·도를 선택하세요." : "두 CSV를 불러온 뒤 지역을 선택하세요.";
    } else {
      const counts = ["주유소 정보 " + items(selection.stations) + "행", "판매가격 " + items(selection.prices) + "행"];
      if (isMap) {
        const missing = selection.stations.filter(station => !FuelData.coordinates(station)).length;
        const locationCount = formatNumber.format(selection.stations.length - missing);
        counts.push((map.bounds ? "지도 표시 " : "유효 좌표 ") + locationCount + "개 위치");
        if (missing) counts.push("좌표 확인 불가 " + formatNumber.format(missing) + "행");
        counts.push("미연결 가격 " + formatNumber.format(selection.unlinked) + "행");
      }
      result.textContent = counts.join(" · ");
    }
  }

  function download(type, label) {
    if (!selection) return;
    const regionName = [province.selectedOptions[0].text, district.value && district.selectedOptions[0].text].filter(Boolean).join("_");
    const blob = new Blob([FuelData.writeCsv(type, selection[type])], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = regionName + "_" + label + ".csv";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (!isMap) {
    get("save-stations").addEventListener("click", () => download("stations", "주유소정보"));
    get("save-prices").addEventListener("click", () => download("prices", "판매가격"));
    return;
  }

  const mapNote = get("boundary-note");
  const boundaryFile = "HangJeongDong_ver20261001.geojson";
  let boundaryVersion = 0;
  map = new FuelMap(get("map"), station => {
    get("station").value = String(shownStations.indexOf(station));
    showStation(station);
  });
  get("zoom-in").addEventListener("click", () => map.zoom(1.3));
  get("zoom-out").addEventListener("click", () => map.zoom(1 / 1.3));
  get("fit-map").addEventListener("click", () => map.fit());
  get("station").addEventListener("change", event => {
    showStation(event.target.value ? shownStations[Number(event.target.value)] : null);
  });
  get("date").addEventListener("change", event => showPrices(event.target.value));
  get("boundary").addEventListener("change", event => {
    const file = event.target.files[0];
    if (file) loadBoundary(() => file.text());
  });

  if (location.protocol === "file:") {
    get("boundary-picker").hidden = false;
    setNote(mapNote, "전국주유소표준데이터 폴더에서 " + boundaryFile + " 파일을 선택하세요.");
  } else {
    loadBoundary(async () => {
      const response = await fetch("./전국주유소표준데이터/" + boundaryFile);
      if (!response.ok) throw new Error("경계 파일을 읽을 수 없습니다.");
      return response.text();
    });
  }

  async function loadBoundary(read) {
    const version = ++boundaryVersion;
    boundary = null;
    refresh();
    setNote(mapNote, "행정동 경계를 읽는 중입니다.");
    try {
      const source = await read();
      await waitForPaint();
      if (version !== boundaryVersion) return;
      const parsed = JSON.parse(source.replace(/^\uFEFF/u, ""));
      if (parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features) || !parsed.features.length ||
          !parsed.features.every(validFeature)) throw new Error("행정동 경계 형식이 올바르지 않습니다.");
      boundary = parsed.features;
      setNote(mapNote, "행정동 경계 " + items(boundary) + "개를 불러왔습니다.");
    } catch {
      if (version !== boundaryVersion) return;
      get("boundary-picker").hidden = false;
      setNote(mapNote, "행정동 경계를 읽을 수 없습니다. " + boundaryFile + " 파일을 확인하고 다시 선택하세요.", true);
    }
    refresh();
  }

  function validFeature(feature) {
    const { properties, geometry } = feature ?? {};
    if (!properties?.sido || !properties.sgg || !["Polygon", "MultiPolygon"].includes(geometry?.type)) return false;
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    return Array.isArray(polygons) && polygons.length > 0 && polygons.every(polygon =>
      Array.isArray(polygon) && polygon.length > 0 && polygon.every(ring =>
        Array.isArray(ring) && ring.length >= 4 && ring.every(point =>
          Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]) &&
          Math.abs(point[0]) <= 180 && Math.abs(point[1]) < 90)));
  }

  function renderMap() {
    const region = FuelData.provinces.get(province.value);
    const districts = district.value.startsWith("city:")
      ? region.districts.filter(item => item.parent === district.value.slice(5)).map(item => item.code)
      : [district.value];
    const features = selection && boundary ? boundary.filter(({ properties }) =>
      String(properties.sido) === region.code && (!district.value || districts.includes(String(properties.sgg)))) : [];
    const markerRows = selection?.stations ?? [];
    const links = selection ? FuelData.linkPrices(markerRows, selection.prices) : { histories: new Map(), unlinked: 0 };
    if (selection) selection.unlinked = links.unlinked;
    histories = links.histories;
    shownStations = [...markerRows].sort((a, b) => a.row[0].localeCompare(b.row[0], "ko"));
    const stationChoice = get("station");
    stationChoice.replaceChildren(new Option(shownStations.length ? "주유소 선택" : "선택할 주유소 없음", ""),
      ...shownStations.map((station, index) =>
        new Option([station.row[0], station.row[3] || station.row[4]].filter(Boolean).join(" · "), String(index))));
    stationChoice.disabled = !shownStations.length;
    map.setRegion(features, markerRows);
    get("map-empty").hidden = Boolean(map.bounds);
    get("map-empty").textContent = !selection ? "지역을 선택하면 지도가 표시됩니다."
      : boundary ? "선택 지역의 경계가 없습니다." : "행정동 경계 파일을 불러오면 지도가 표시됩니다.";
    for (const id of ["zoom-in", "zoom-out", "fit-map"]) get(id).disabled = !map.bounds;
    showStation(null);
  }

  function paragraph(text, className = "") {
    const node = document.createElement("p");
    node.textContent = text;
    node.className = className;
    return node;
  }

  function showStation(station) {
    selectedStation = station;
    map.select(station);
    const details = get("station-detail");
    details.replaceChildren();
    if (station) {
      details.append(paragraph(station.row[0]), paragraph(station.row[3] || station.row[4] || "주소 정보 없음", "station-address"));
      if (station.row[8]) details.append(paragraph(station.row[8], "station-address"));
    }
    const days = [...(histories.get(station)?.keys() ?? [])].sort().reverse();
    get("date-field").hidden = !days.length;
    get("date").replaceChildren(...days.map(day => new Option(FuelData.displayDate(day), day)));
    showPrices(days[0]);
  }

  function showPrices(day) {
    const detail = get("price-detail");
    detail.replaceChildren();
    if (!selectedStation) return;
    const records = histories.get(selectedStation)?.get(day);
    if (!records) {
      detail.append(paragraph("연결된 가격 자료 없음"));
      return;
    }
    if (records.size > 1) detail.append(paragraph("가격 기록 중복 · 다음은 원본에 있는 기록입니다."));
    let number = 1;
    for (const row of records.values()) {
      const table = document.createElement("table");
      table.className = "price-table";
      if (records.size > 1) table.createCaption().textContent = "기록 " + number++;
      const body = table.createTBody();
      FuelData.fuels.forEach((fuel, index) => {
        const line = body.insertRow();
        const header = document.createElement("th");
        header.scope = "row";
        header.textContent = fuel;
        line.append(header);
        const value = Number(row[index + 7]);
        line.insertCell().textContent = Number.isFinite(value) && value > 0
          ? formatNumber.format(value) + " 원/L" : "가격 정보 없음";
      });
      detail.append(table);
    }
  }
})();
