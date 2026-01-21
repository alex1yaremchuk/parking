const CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTH7SGADby5gPRJR44TwuMrnOyk1UgcGu3RPMdkuHOz7HCHx5AoCGw2g7Z17OqFQ1pXhQyW_5bA7JW-/pub?gid=562016189&single=true&output=csv";
const REFRESH_MS = 5000;
const STORAGE_UPDATED_AT_KEY = "parking:lastUpdatedAt";

const STATUS_LABELS = {
  available: "свободен",
  reserved: "забронирован",
  sold: "продан"
};

const STATUS_COLORS = {
  available: getCssVar("--available"),
  reserved: getCssVar("--reserved"),
  sold: getCssVar("--sold")
};

const FLOORS = [
  { id: "floor-1", label: "1 этаж", file: "floor 1.svg" },
  { id: "floor-2", label: "2 этаж", file: "plan.svg" }
];

const detailsNode = document.getElementById("spot-details");
const svgHost = document.getElementById("svg-host");
const floorSwitcher = document.getElementById("floor-switcher");
const zoomInBtn = document.getElementById("zoom-in");
const zoomOutBtn = document.getElementById("zoom-out");
let selectedSpots = [];
let selectedSpotId = null;
let panZoomInstance = null;
let spotData = {};
let dataLoadError = false;
let svgElement = null;
let spotElementsById = new Map();
let refreshToken = 0;
let hasData = false;
let lastUpdatedAt = getStoredUpdatedAt();
let activeFloorId = FLOORS[0]?.id || null;

init();

async function init() {
  await loadSpotData(true);
  initFloorSwitcher();
  await loadSvgPlan(getActiveFloor()?.file);
  showSelectedDetails();
  startAutoRefresh();
}

async function loadSvgPlan(svgPath = "plan.svg") {
  try {
    if (panZoomInstance) {
      panZoomInstance.destroy();
      panZoomInstance = null;
    }
    const response = await fetch(encodeURI(svgPath));
    const svgText = await response.text();
    const svgDoc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const svgEl = svgDoc.documentElement;
    svgElement = svgEl;

    svgHost.innerHTML = "";
    svgHost.appendChild(svgEl);

    applySpotData(svgEl);
    initPanZoom(svgEl);
    showSelectedDetails();
  } catch (error) {
    svgHost.innerHTML = "<p class=\"muted\">Не удалось загрузить SVG план.</p>";
  }
}

function collectSpotElements(svgEl) {
  const spotElements = [];
  svgEl.querySelectorAll("g[id]").forEach((group) => {
    const spotId = group.getAttribute("id");
    if (!spotId || !/^P\\d+/i.test(spotId)) {
      return;
    }

    const shape = Array.from(group.children).find((child) => {
      const tag = child.tagName ? child.tagName.toLowerCase() : "";
      return tag === "rect" || tag === "path" || tag === "polygon";
    });
    if (!shape) {
      return;
    }

    shape.classList.add("parking-spot");
    shape.setAttribute("data-spot-id", spotId);
    spotElements.push(shape);
  });
  return spotElements;
}

function applySpotData(svgEl) {
  const spots = collectSpotElements(svgEl);
  spotElementsById = new Map();
  spots.forEach((spotEl) => {
    const spotId = spotEl.getAttribute("data-spot-id");
    if (!spotId) {
      return;
    }

    spotElementsById.set(spotId, spotEl);
    const status = spotData[spotId]?.status;
    spotEl.style.fill = STATUS_COLORS[status] || "#cccccc";
    if (!spotEl.dataset.bound) {
      spotEl.addEventListener("click", () => selectSpot(spotId, spotEl));
      spotEl.addEventListener("mouseenter", () => showSpotDetails(spotId));
      spotEl.addEventListener("mouseleave", () => showSelectedDetails());
      spotEl.dataset.bound = "true";
    }
  });
}

function clearSelectedSpots() {
  selectedSpots.forEach((element) => element.classList.remove("selected"));
  selectedSpots = [];
}

function getPairedSpotIds(spotId) {
  const normalized = normalizeSpotId(spotId);
  const directPair = spotData[normalized]?.pairId;
  if (directPair) {
    return uniqueSpotIds([normalized, directPair]);
  }

  const reversePair = Object.keys(spotData).find(
    (id) => spotData[id]?.pairId === normalized
  );
  if (reversePair) {
    return uniqueSpotIds([normalized, reversePair]);
  }

  return [normalized];
}

function uniqueSpotIds(ids) {
  const seen = new Set();
  return ids
    .map((id) => normalizeSpotId(id))
    .filter((id) => {
      if (!id || seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });
}

function selectSpot(spotId, spotEl) {
  clearSelectedSpots();

  const spotIds = getPairedSpotIds(spotId);
  selectedSpotId = spotId;
  selectedSpots = spotIds
    .map((id) => spotElementsById.get(id))
    .filter(Boolean);

  selectedSpots.forEach((element) => {
    element.classList.add("selected");
    // Bring the selected spot to the front so the outline isn't hidden.
    if (element.parentNode) {
      element.parentNode.appendChild(element);
    }
  });

  showSpotDetails(spotId);
}

function showSpotDetails(spotId) {
  const entries = getSpotEntries(spotId);
  if (entries.length === 0) {
    detailsNode.innerHTML = "<p class=\"muted\">Нет данных по месту.</p>";
    return;
  }

  const statusLabel = entries[0].data.statusLabel || "-";
  const spotLabel = entries.map((entry) => entry.id).join(" + ");
  const storageInfo = getStorageInfo(entries);
  const totalArea = resolveTotalArea(entries);
  const pricePerSqm = pickFirstFinite(
    entries.map((entry) => entry.data.pricePerSqm)
  );
  const totalPrice =
    Number.isFinite(totalArea) && Number.isFinite(pricePerSqm)
      ? totalArea * pricePerSqm
      : NaN;

  let html = `<p><strong>Места:</strong> ${spotLabel}</p>`;
  html += `<p><strong>Статус:</strong> ${statusLabel}</p>`;
  entries.forEach((entry) => {
    html += `<p><strong>${entry.id} — площадь м/м:</strong> ${formatArea(
      entry.data.spotArea
    )} м²</p>`;
  });
  if (storageInfo) {
    html += `<p><strong>Кладовая:</strong> ${storageInfo.label}</p>`;
  }
  if (Number.isFinite(totalArea)) {
    html += `<p><strong>Общая площадь:</strong> ${formatArea(
      totalArea
    )} м²</p>`;
  }
  if (Number.isFinite(pricePerSqm)) {
    html += `<p><strong>Цена кв.м.:</strong> ${formatPrice(pricePerSqm)} ₽</p>`;
  }
  if (Number.isFinite(totalPrice)) {
    html += `<p><strong>Цена комплекта:</strong> ${formatPrice(
      totalPrice
    )} ₽</p>`;
  }

  detailsNode.innerHTML = html;
}

function getSpotEntries(spotId) {
  const spotIds = getPairedSpotIds(spotId);
  return spotIds
    .map((id) => ({ id, data: spotData[id] }))
    .filter((entry) => Boolean(entry.data));
}

function getStorageInfo(entries) {
  const entryWithStorage = entries.find(
    (entry) => entry.data.storageNumber
  );
  if (!entryWithStorage) {
    return null;
  }

  const storageArea = pickFirstFinite(
    entries.map((entry) => entry.data.storageArea)
  );
  const areaLabel = Number.isFinite(storageArea)
    ? ` (${formatArea(storageArea)} м²)`
    : "";

  return {
    label: `${entryWithStorage.data.storageNumber}${areaLabel}`
  };
}

function resolveTotalArea(entries) {
  const directTotal = pickFirstFinite(
    entries.map((entry) => entry.data.totalArea)
  );
  if (Number.isFinite(directTotal)) {
    return directTotal;
  }

  const spotSum = sumNumbers(entries.map((entry) => entry.data.spotArea));
  const storageArea = pickFirstFinite(
    entries.map((entry) => entry.data.storageArea)
  );
  return sumNumbers([spotSum, storageArea]);
}

function pickFirstFinite(values) {
  return values.find((value) => Number.isFinite(value));
}

function sumNumbers(values) {
  let total = 0;
  let hasValue = false;
  values.forEach((value) => {
    if (Number.isFinite(value)) {
      total += value;
      hasValue = true;
    }
  });
  return hasValue ? total : NaN;
}

function showSelectedDetails() {
  if (dataLoadError) {
    detailsNode.innerHTML =
      "<p class=\"muted\">Не удалось загрузить данные из таблицы.</p>";
    return;
  }

  if (selectedSpotId) {
    showSpotDetails(selectedSpotId);
    return;
  }

  detailsNode.innerHTML = "<p class=\"muted\">Выберите место на карте.</p>";
}

function formatPrice(value) {
  if (!Number.isFinite(value)) {
    return "—";
  }
  return new Intl.NumberFormat("ru-RU").format(value);
}

function formatArea(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return value.toFixed(1);
}

function getStoredUpdatedAt() {
  if (typeof localStorage === "undefined") {
    return 0;
  }
  const raw = localStorage.getItem(STORAGE_UPDATED_AT_KEY);
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function setStoredUpdatedAt(value) {
  if (typeof localStorage === "undefined") {
    return;
  }
  if (!Number.isFinite(value) || value <= 0) {
    return;
  }
  localStorage.setItem(STORAGE_UPDATED_AT_KEY, String(value));
}

function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function initPanZoom(svgEl) {
  if (typeof svgPanZoom !== "function") {
    return;
  }

  panZoomInstance = svgPanZoom(svgEl, {
    zoomEnabled: true,
    panEnabled: true,
    controlIconsEnabled: false,
    dblClickZoomEnabled: false,
    preventMouseEventsDefault: false,
    fit: true,
    center: true
  });

  if (zoomInBtn) {
    zoomInBtn.onclick = () => panZoomInstance.zoomIn();
  }
  if (zoomOutBtn) {
    zoomOutBtn.onclick = () => panZoomInstance.zoomOut();
  }
}

function initFloorSwitcher() {
  if (!floorSwitcher) {
    return;
  }

  floorSwitcher.innerHTML = "";
  FLOORS.forEach((floor) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "floor-btn";
    button.textContent = floor.label;
    button.dataset.floorId = floor.id;
    if (floor.id === activeFloorId) {
      button.classList.add("active");
    }
    button.addEventListener("click", () => selectFloor(floor.id));
    floorSwitcher.appendChild(button);
  });
}

function selectFloor(floorId) {
  if (floorId === activeFloorId) {
    return;
  }

  activeFloorId = floorId;
  updateFloorButtons();
  resetSelection();
  loadSvgPlan(getActiveFloor()?.file);
}

function updateFloorButtons() {
  if (!floorSwitcher) {
    return;
  }

  floorSwitcher.querySelectorAll(".floor-btn").forEach((button) => {
    const isActive = button.dataset.floorId === activeFloorId;
    button.classList.toggle("active", isActive);
  });
}

function resetSelection() {
  clearSelectedSpots();
  selectedSpotId = null;
  showSelectedDetails();
}

function getActiveFloor() {
  return FLOORS.find((floor) => floor.id === activeFloorId) || FLOORS[0];
}

async function loadSpotData(isInitial = false) {
  const token = (refreshToken += 1);
  try {
    const cacheBuster = Date.now();
    const response = await fetch(`${CSV_URL}&v=${cacheBuster}`, {
      cache: "no-store"
    });
    const text = await response.text();
    if (token === refreshToken) {
      const parsedResult = parseCsvData(text);
      const hasRows = Object.keys(parsedResult.data).length > 0;

      if (!hasRows) {
        if (!hasData) {
          dataLoadError = true;
        }
        return false;
      }

      const updatedAt = parsedResult.updatedAt || 0;
      if (updatedAt > 0 && updatedAt <= lastUpdatedAt) {
        dataLoadError = false;
        return false;
      }

      const shouldApply =
        isInitial || updatedAt === 0 || updatedAt > lastUpdatedAt;
      if (!shouldApply) {
        dataLoadError = false;
        return false;
      }

      spotData = parsedResult.data;
      hasData = true;
      if (updatedAt > 0) {
        lastUpdatedAt = updatedAt;
        setStoredUpdatedAt(updatedAt);
      }
      dataLoadError = false;
      return true;
    }
  } catch (error) {
    if (token === refreshToken) {
      if (!hasData) {
        dataLoadError = true;
      }
    }
  }
  return false;
}

function startAutoRefresh() {
  setInterval(async () => {
    const updated = await loadSpotData();
    if (updated && svgElement) {
      applySpotData(svgElement);
      showSelectedDetails();
    }
  }, REFRESH_MS);
}

function parseCsvData(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return { data: {}, updatedAt: 0 };
  }

  const headerRow = rows[0] || [];
  const updatedAt = parseDateTime(headerRow[0] || "");
  const headers = headerRow.slice(1).map((value) => normalizeText(value));

  const statusIdx = resolveIndex(findHeaderIndex(headers, ["статус"]), 0);
  const pairIdx = resolveIndex(findHeaderIndex(headers, ["№пары", "пары", "пара"]), 1);
  const storageIdx = resolveIndex(
    findHeaderIndex(headers, ["№кладовой", "кладовой", "кладовая"]),
    2
  );
  const spotAreaIdx = resolveIndex(
    findHeaderIndex(headers, [
      "площадьм/м",
      "площадьмм",
      "площадьмместа",
      "площадьместа"
    ]),
    3
  );
  const storageAreaIdx = resolveIndex(
    findHeaderIndex(headers, ["площадькладовой"]),
    4
  );
  const totalAreaIdx = resolveIndex(
    findHeaderIndex(headers, ["общаяплощадь"]),
    5
  );
  const priceIdx = resolveIndex(
    findHeaderIndex(headers, ["ценакв.м", "ценаквм", "ценаквм."]),
    6
  );

  const data = {};
  rows.slice(1).forEach((row) => {
    const spotId = normalizeSpotId(row[0]);
    if (!spotId) {
      return;
    }

    const rawStatus = row[statusIdx + 1] || "";
    const rawPair = row[pairIdx + 1] || "";
    const rawStorage = row[storageIdx + 1] || "";
    const rawSpotArea = row[spotAreaIdx + 1] || "";
    const rawStorageArea = row[storageAreaIdx + 1] || "";
    const rawTotalArea = row[totalAreaIdx + 1] || "";
    const rawPrice = row[priceIdx + 1] || "";

    const status = normalizeStatus(rawStatus);
    const statusLabel =
      STATUS_LABELS[status] || rawStatus.trim() || "неизвестно";
    const pairId = normalizeSpotId(rawPair);
    const storageNumber = String(rawStorage || "").trim();
    const spotArea = parseNumber(rawSpotArea);
    const storageArea = parseNumber(rawStorageArea);
    const totalArea = parseNumber(rawTotalArea);
    const pricePerSqm = parseNumber(rawPrice);

    data[spotId] = {
      status,
      statusLabel,
      pairId: pairId || null,
      storageNumber,
      spotArea,
      storageArea,
      totalArea,
      pricePerSqm
    };
  });

  return { data, updatedAt };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === "\"" && inQuotes && next === "\"") {
      current += "\"";
      i += 1;
      continue;
    }

    if (char === "\"") {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(current);
      current = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        i += 1;
      }
      row.push(current);
      if (row.length > 1 || row[0] !== "") {
        rows.push(row);
      }
      row = [];
      current = "";
      continue;
    }

    current += char;
  }

  row.push(current);
  if (row.length > 1 || row[0] !== "") {
    rows.push(row);
  }

  return rows;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "");
}

function normalizeSpotId(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  if (/^P\d+$/i.test(trimmed)) {
    const digits = trimmed.replace(/^P/i, "");
    return `P${digits.padStart(3, "0")}`;
  }
  if (/^\d+$/.test(trimmed)) {
    return `P${trimmed.padStart(3, "0")}`;
  }
  return trimmed;
}

function findHeaderIndex(headers, keywords) {
  return headers.findIndex((header) =>
    keywords.some((keyword) => header.includes(keyword))
  );
}

function resolveIndex(index, fallback) {
  return index >= 0 ? index : fallback;
}

function parseDateTime(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return NaN;
  }

  const [datePart, timePart = "00:00:00"] = trimmed.split(" ");
  const datePieces = datePart.split(/[./]/);
  if (datePieces.length < 3) {
    return NaN;
  }
  const [part1, part2, part3] = datePieces;
  let day = part2;
  let month = part1;
  let year = part3;
  if (datePart.includes(".")) {
    day = part1;
    month = part2;
    year = part3;
  } else if (Number(part1) > 12) {
    day = part1;
    month = part2;
    year = part3;
  }
  const [hour, minute, second] = timePart.split(":");

  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second || 0)
  );

  return Number.isNaN(date.getTime()) ? NaN : date.getTime();
}

function parseNumber(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return NaN;
  }

  let normalized = trimmed.replace(/[^\d,.-]/g, "");
  const hasComma = normalized.includes(",");
  const hasDot = normalized.includes(".");

  if (hasComma && !hasDot) {
    normalized = normalized.replace(",", ".");
  } else if (hasComma && hasDot) {
    normalized = normalized.replace(/,/g, "");
  }

  return Number.parseFloat(normalized);
}

function normalizeStatus(value) {
  const normalized = normalizeText(value);
  if (normalized.includes("свобод")) {
    return "available";
  }
  if (normalized.includes("заброн")) {
    return "reserved";
  }
  if (normalized.includes("прод")) {
    return "sold";
  }
  return "available";
}

