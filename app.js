const CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vSg8VslzF_Df-VUljYjnEzx-GT3io2AusHsensjtTI92zGQvnyfCFFeKDxk36VdZ6p8SHeVXkeWcnPK/pub?gid=0&single=true&output=csv";
const REFRESH_MS = 5000;

const STATUS_LABELS = {
  available: "Доступно",
  reserved: "Бронь",
  sold: "Продано"
};

const STATUS_COLORS = {
  available: getCssVar("--available"),
  reserved: getCssVar("--reserved"),
  sold: getCssVar("--sold")
};

const detailsNode = document.getElementById("spot-details");
const svgHost = document.getElementById("svg-host");
const zoomInBtn = document.getElementById("zoom-in");
const zoomOutBtn = document.getElementById("zoom-out");
let selectedSpot = null;
let selectedSpotId = null;
let panZoomInstance = null;
let spotData = {};
let dataLoadError = false;
let svgElement = null;
let refreshToken = 0;
let hasData = false;
let lastUpdatedAt = 0;

init();

async function init() {
  await loadSpotData(true);
  await loadSvgPlan();
  showSelectedDetails();
  startAutoRefresh();
}

async function loadSvgPlan() {
  try {
    const response = await fetch("plan.svg");
    const svgText = await response.text();
    const svgDoc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const svgEl = svgDoc.documentElement;
    svgElement = svgEl;

    svgHost.innerHTML = "";
    svgHost.appendChild(svgEl);

    applySpotData(svgEl);
    initPanZoom(svgEl);
  } catch (error) {
    svgHost.innerHTML = "<p class=\"muted\">Не удалось загрузить SVG план.</p>";
  }
}

function applySpotData(svgEl) {
  const spots = svgEl.querySelectorAll(".parking-spot");
  spots.forEach((spotEl) => {
    const spotId = spotEl.getAttribute("id");
    if (!spotId) {
      return;
    }

    const status = spotData[spotId]?.status;
    spotEl.style.fill = STATUS_COLORS[status] || "#cccccc";
    spotEl.setAttribute("data-spot-id", spotId);
    if (!spotEl.dataset.bound) {
      spotEl.addEventListener("click", () => selectSpot(spotId, spotEl));
      spotEl.addEventListener("mouseenter", () => showSpotDetails(spotId));
      spotEl.addEventListener("mouseleave", () => showSelectedDetails());
      spotEl.dataset.bound = "true";
    }
  });
}

function selectSpot(spotId, spotEl) {
  if (selectedSpot) {
    selectedSpot.classList.remove("selected");
  }

  selectedSpot = spotEl;
  selectedSpot.classList.add("selected");
  selectedSpotId = spotId;

  showSpotDetails(spotId);
}

function showSpotDetails(spotId) {
  const data = spotData[spotId];
  if (!data) {
    detailsNode.innerHTML = "<p class=\"muted\">Нет данных по месту.</p>";
    return;
  }

  detailsNode.innerHTML = `
    <p><strong>Место:</strong> ${spotId}</p>
    <p><strong>Площадь:</strong> ${formatArea(data.area)} м²</p>
    <p><strong>Цена:</strong> ${formatPrice(data.price)} ₽</p>
    <p><strong>Статус:</strong> ${data.statusLabel}</p>
  `;
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
    return "—";
  }
  return value.toFixed(1);
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

      const updatedAt = parsedResult.maxUpdatedAt || 0;
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
    return { data: {}, maxUpdatedAt: 0 };
  }

  const headers = rows[0].map((value) => normalizeText(value));
  const idIdx = resolveIndex(findHeaderIndex(headers, ["идентифик", "id"]), 0);
  const priceIdx = resolveIndex(findHeaderIndex(headers, ["цен"]), 1);
  const areaIdx = resolveIndex(findHeaderIndex(headers, ["площад", "area"]), 2);
  const statusIdx = resolveIndex(findHeaderIndex(headers, ["статус"]), 3);
  const updatedIdx = resolveIndex(
    findHeaderIndex(headers, ["обновлено", "updated"]),
    4
  );

  const data = {};
  let maxUpdatedAt = 0;
  rows.slice(1).forEach((row) => {
    const spotId = (row[idIdx] || "").trim();
    if (!spotId) {
      return;
    }

    const rawPrice = row[priceIdx] || "";
    const rawArea = row[areaIdx] || "";
    const rawStatus = row[statusIdx] || "";
    const rawUpdated = row[updatedIdx] || "";

    const price = parseNumber(rawPrice);
    const area = parseNumber(rawArea);
    const status = normalizeStatus(rawStatus);
    const statusLabel =
      STATUS_LABELS[status] || rawStatus.trim() || "Неизвестно";
    const updatedAt = parseDateTime(rawUpdated);
    if (Number.isFinite(updatedAt)) {
      maxUpdatedAt = Math.max(maxUpdatedAt, updatedAt);
    }

    data[spotId] = { price, area, status, statusLabel, updatedAt };
  });

  return { data, maxUpdatedAt };
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
  const [month, day, year] = datePart.split("/");
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
  if (normalized.includes("доступ")) {
    return "available";
  }
  if (normalized.includes("брон")) {
    return "reserved";
  }
  if (normalized.includes("прод")) {
    return "sold";
  }
  return "available";
}

