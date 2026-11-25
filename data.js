"use strict";

const FuelData = (() => {
  const headers = {
    stations: "주유소명,시도명,시군구명,소재지도로명주소,소재지지번주소,전화번호,위도,경도,상표구분명,대표자명,총직원수,데이터기준일자,제공기관코드,제공기관명".split(","),
    prices: "번호,지역,상호,주소,기간,상표,셀프여부,고급휘발유,휘발유,경유,실내등유".split(",")
  };
  const fuels = headers.prices.slice(7);
  const provinceAliases = {
    서울특별시: ["서울"], 부산광역시: ["부산"], 대구광역시: ["대구"],
    인천광역시: ["인천"], 대전광역시: ["대전"], 울산광역시: ["울산"],
    세종특별자치시: ["세종시", "세종"], 경기도: ["경기"],
    강원특별자치도: ["강원도", "강원"], 충청북도: ["충북"], 충청남도: ["충남"],
    전북특별자치도: ["전라북도", "전북"], 전남광주통합특별시: ["전남광주", "전라남도", "전남", "광주광역시", "광주"],
    경상북도: ["경북"], 경상남도: ["경남"], 제주특별자치도: ["제주도", "제주"]
  };
  const provinces = new Map();
  for (const [code, name, districtCode, districtName] of REGION_ROWS) {
    if (!provinces.has(code)) provinces.set(code, { code, name, districts: [] });
    const parent = districtName.match(/^(.+?시)(.+구)$/)?.[1] ?? "";
    const label = parent ? parent + " " + districtName.slice(parent.length) : districtName;
    provinces.get(code).districts.push({ code: districtCode, name: districtName, parent, label });
  }
  const aliases = [...provinces.values()].flatMap(province =>
    [province.name, ...(provinceAliases[province.name] ?? [])].map(name => ({ name, province }))
  ).sort((first, second) => second.name.length - first.name.length);
  const orderedProvinces = [...provinces.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));

  function clean(value) {
    return String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
  }

  function compact(value) {
    return clean(value).replaceAll(" ", "");
  }

  function provincePrefix(value) {
    const input = clean(value);
    return aliases.find(({ name }) => input === name || input.startsWith(name + " "));
  }

  function identifyRegion(provinceText, districtText, address) {
    const fromLabel = provincePrefix(provinceText);
    const fromAddress = provincePrefix(address);
    const province = fromLabel?.province ?? fromAddress?.province;
    if (!province) return null;

    const label = clean(districtText || clean(provinceText).slice(fromLabel?.name.length ?? 0));
    const addressBody = fromAddress?.province === province ? clean(address).slice(fromAddress.name.length).trim() : "";
    const districts = province.districts;
    const districtMatches = (value, allowShort) => {
      const normalized = compact(value);
      return districts.filter(district => {
        const short = district.parent ? district.name.slice(district.parent.length) : district.name;
        return normalized.startsWith(district.name) || (allowShort && normalized.startsWith(short));
      });
    };

    const parent = districts.some(district => district.parent === compact(label)) ? compact(label) : "";
    const byLabel = parent ? [] : districtMatches(label, true);
    const byAddress = districtMatches(addressBody, false);
    if (byLabel.length === 1) return { province, district: byLabel[0], parent: byLabel[0].parent };
    if (byAddress.length === 1 && (!parent || byAddress[0].parent === parent) &&
        (!byLabel.length || byLabel.includes(byAddress[0]))) {
      return { province, district: byAddress[0], parent: byAddress[0].parent };
    }
    if (districts.length === 1 && province.name === "세종특별자치시") {
      return { province, district: districts[0], parent: "" };
    }
    return { province, district: null, parent };
  }

  function parseCsv(input) {
    const records = [];
    let row = [];
    let value = "";
    let quoted = false;
    let closedQuote = false;
    let malformed = false;

    function pushValue() {
      row.push(value);
      value = "";
      closedQuote = false;
    }

    function pushRow() {
      pushValue();
      if (row.length !== 1 || row[0] !== "" || malformed) records.push({ row, malformed });
      row = [];
      malformed = false;
    }

    for (let index = 0; index < input.length; index++) {
      const character = input[index];
      if (quoted) {
        if (character !== '"') value += character;
        else if (input[index + 1] === '"') {
          value += '"';
          index++;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else if (character === ",") pushValue();
      else if (character === "\r" || character === "\n") {
        pushRow();
        if (character === "\r" && input[index + 1] === "\n") index++;
      } else if (character === '"' && !value && !closedQuote) quoted = true;
      else {
        if (closedQuote || character === '"') malformed = true;
        value += character;
      }
    }
    if (quoted) throw new Error("CSV의 닫는 큰따옴표를 찾을 수 없습니다.");
    if (value || row.length || closedQuote) pushRow();
    return records;
  }

  function readCsv(bytes, type) {
    let input;
    let encoding = "UTF-8";
    try {
      input = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      encoding = "CP949";
      try {
        input = new TextDecoder("euc-kr", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("파일을 읽을 수 없습니다. UTF-8 또는 CP949 CSV를 선택하세요.");
      }
    }
    const records = parseCsv(input);
    const first = records.shift();
    const expected = headers[type];
    if (!first || first.malformed || first.row.length !== expected.length ||
        expected.some((name, index) => name !== first.row[index])) {
      throw new Error(type === "stations" ? "주유소 정보 CSV의 헤더 또는 열 순서를 확인하세요." : "판매가격 CSV의 헤더 또는 열 순서를 확인하세요.");
    }
    const rows = [];
    let info = 0;
    let invalid = 0;
    let badDate = 0;
    for (const { row, malformed } of records) {
      if (type === "prices" && !malformed && /^기준\s*:/u.test(row[0]) && row.slice(1).every(value => !value.trim())) {
        info++;
        continue;
      }
      if (malformed || row.length !== expected.length) {
        invalid++;
        continue;
      }
      if (type === "prices" && !validDate(row[4])) {
        badDate++;
        continue;
      }
      rows.push({ row, region: type === "stations"
        ? identifyRegion(row[1], row[2], row[3] || row[4])
        : identifyRegion(row[1], "", row[3]) });
    }
    return { rows, encoding, info, invalid, badDate };
  }

  function validDate(date) {
    if (!/^\d{8}$/u.test(date)) return false;
    const formatted = displayDate(date);
    const parsed = new Date(formatted);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === formatted;
  }

  function displayDate(date) {
    return date.slice(0, 4) + "-" + date.slice(4, 6) + "-" + date.slice(6, 8);
  }

  function selectionContains(region, provinceCode, districtCode) {
    if (region?.province.code !== provinceCode) return false;
    if (!districtCode) return true;
    if (districtCode.startsWith("city:")) return region.parent === districtCode.slice(5);
    return region.district?.code === districtCode;
  }

  function autoRegion(records) {
    const regions = records.map(record => record.region).filter(Boolean);
    if (!regions.length || regions.some(region => region.province !== regions[0].province)) return null;
    const first = regions[0];
    let district = "";
    if (first.district && regions.every(region => region.district === first.district)) district = first.district.code;
    else if (first.parent && regions.every(region => region.parent === first.parent)) district = "city:" + first.parent;
    return { province: first.province.code, district };
  }

  function writeCsv(type, records) {
    const escape = value => /[",\r\n]/u.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
    return "\uFEFF" + [headers[type], ...records.map(record => record.row)]
      .map(row => row.map(escape).join(",")).join("\r\n") + "\r\n";
  }

  function addressKey(address, region) {
    const normalized = clean(address);
    const prefix = provincePrefix(normalized);
    let remaining = compact(prefix?.province === region.province ? normalized.slice(prefix.name.length) : normalized);
    const district = region.district;
    const regionalPrefix = [district?.name, district?.parent, district?.parent && district.name.slice(district.parent.length)]
      .find(part => part && remaining.startsWith(part));
    if (regionalPrefix) remaining = remaining.slice(regionalPrefix.length);
    return remaining;
  }

  function linkPrices(stations, prices) {
    const stationKeys = new Map();
    for (const station of stations) {
      const [name, , , road, parcel] = station.row;
      const keys = new Set([road, parcel].map(address => addressKey(address, station.region)).filter(Boolean));
      for (const address of keys) {
        const key = JSON.stringify([station.region.province.code, compact(name), address]);
        if (!stationKeys.has(key)) stationKeys.set(key, []);
        stationKeys.get(key).push(station);
      }
    }
    const groups = new Map();
    for (const price of prices) {
      const [id, , name, address] = price.row;
      const key = JSON.stringify([price.region.province.code, compact(name), addressKey(address, price.region)]);
      const candidates = (name.trim() && address.trim() ? stationKeys.get(key) ?? [] : []).filter(station => {
        const stationRegion = station.region;
        const priceRegion = price.region;
        if (stationRegion.district && priceRegion.district) return stationRegion.district === priceRegion.district;
        return !stationRegion.parent || !priceRegion.parent || stationRegion.parent === priceRegion.parent;
      });
      if (!groups.has(id)) groups.set(id, { station: candidates.length === 1 ? candidates[0] : null, rows: [] });
      const group = groups.get(id);
      group.rows.push(price);
      if (!id.trim() || candidates.length !== 1 || candidates[0] !== group.station) group.station = null;
    }
    const byStation = new Map();
    let unlinked = 0;
    for (const group of groups.values()) {
      if (!group.station) unlinked += group.rows.length;
      else {
        if (!byStation.has(group.station)) byStation.set(group.station, []);
        byStation.get(group.station).push(group.rows);
      }
    }
    const histories = new Map();
    for (const [station, records] of byStation) {
      if (records.length !== 1) {
        unlinked += records.flat().length;
        continue;
      }
      const days = new Map();
      for (const { row } of records[0]) {
        if (!days.has(row[4])) days.set(row[4], new Map());
        days.get(row[4]).set(JSON.stringify(row), row);
      }
      histories.set(station, days);
    }
    return { histories, unlinked };
  }

  function coordinates(record) {
    const [, , , , , , latitudeText, longitudeText] = record.row;
    const latitude = Number(latitudeText);
    const longitude = Number(longitudeText);
    if (!latitudeText.trim() || !longitudeText.trim() || !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
        latitude < 32 || latitude > 40 || longitude < 123 || longitude > 133) return null;
    return [longitude, latitude];
  }

  return { provinces, orderedProvinces, fuels, readCsv, writeCsv, selectionContains, autoRegion, linkPrices, coordinates, displayDate };
})();
