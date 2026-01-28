const CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQK2UilcIYz6yJocVIcRItb06SOMsC5LXkOfnKAQjTc6rL21U8KDpYJWxbTsnTwUYpQXqh0AlnPTWxZ/pub?gid=562016189&single=true&output=csv";
const REFRESH_MS = 5000;
const STORAGE_UPDATED_AT_KEY = "parking:lastUpdatedAt";

const STATUS_LABELS = {
  available: "свободен",
  reserved: "забронирован",
  sold: "продан",
};

const STATUS_COLORS = {
  available: getCssVar("--available"),
  reserved: getCssVar("--reserved"),
  sold: getCssVar("--sold"),
};
const STORAGE_AVAILABLE_COLOR =
  getCssVar("--storage-available") || STATUS_COLORS.available;
const HOVER_FILL = getCssVar("--hover") || getCssVar("--accent");
const CLICK_FILL = HOVER_FILL;

const FLOORS = [
  { id: "floor-1", label: "−2 уровень", file: "floor_1.svg" },
  { id: "floor-2", label: "−1 уровень", file: "floor_2.svg" },
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
let tooltipEl = null;
let bubbleEl = null;
let tooltipTimer = null;
let lastTooltipEvent = null;
let refreshToken = 0;
let hasData = false;
let lastUpdatedAt = getStoredUpdatedAt();
let activeFloorId = FLOORS[0]?.id || null;

init();

async function init() {
  initFloorSwitcher();
  await loadSvgPlan(getActiveFloor()?.file);
  showSelectedDetails();
  loadSpotData(true).then((updated) => {
    if (updated && svgElement) {
      applySpotData(svgElement);
      showSelectedDetails();
    }
  });
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
    ensureOverlayElements();

    applySpotData(svgEl);
    initPanZoom(svgEl);
    showSelectedDetails();
  } catch (error) {
    svgHost.innerHTML = '<p class="muted">Не удалось загрузить SVG план.</p>';
  }
}

function collectSpotElements(svgEl) {
  const spotElements = [];
  let missingShapeCount = 0;
  const seenIds = new Set();
  const groups = Array.from(svgEl.querySelectorAll("g[id]"));
  groups.forEach((group) => {
    const spotIdRaw = (group.getAttribute("id") || "").trim();
    if (!/^(P|K)\d+$/i.test(spotIdRaw)) {
      return;
    }
    const spotId = normalizeUnitId(spotIdRaw);
    if (!spotId || seenIds.has(spotId)) {
      return;
    }

    const shape =
      Array.from(group.children).find((child) => {
        const tag = child.tagName ? child.tagName.toLowerCase() : "";
        return tag === "rect" || tag === "path" || tag === "polygon";
      }) || group.querySelector("rect, path, polygon");
    if (!shape) {
      missingShapeCount += 1;
      return;
    }

    Array.from(group.children).forEach((child) => {
      if (child !== shape) {
        child.style.pointerEvents = "none";
      }
    });

    shape.classList.add("parking-spot");
    shape.setAttribute("data-spot-id", spotId);
    spotElements.push(shape);
    seenIds.add(spotId);
  });
  const directShapes = Array.from(
    svgEl.querySelectorAll("rect[id], path[id], polygon[id]"),
  );
  directShapes.forEach((shape) => {
    const spotIdRaw = (shape.getAttribute("id") || "").trim();
    if (!/^(P|K)\d+$/i.test(spotIdRaw)) {
      return;
    }
    const spotId = normalizeUnitId(spotIdRaw);
    if (!spotId || seenIds.has(spotId)) {
      return;
    }
    shape.classList.add("parking-spot");
    shape.setAttribute("data-spot-id", spotId);
    spotElements.push(shape);
    seenIds.add(spotId);
  });
  return spotElements;
}

function collectLabelElements(svgEl) {
  const labelsById = new Map();
  svgEl.querySelectorAll(".spot-label").forEach((label) => {
    const labelId = normalizeUnitId(label.textContent);
    if (!labelId) {
      return;
    }
    if (!labelsById.has(labelId)) {
      labelsById.set(labelId, []);
    }
    labelsById.get(labelId).push(label);
  });
  return labelsById;
}

function applySpotData(svgEl) {
  const spots = collectSpotElements(svgEl);
  const labelsById = collectLabelElements(svgEl);
  spotElementsById = new Map();
  spots.forEach((spotEl) => {
    const spotId = spotEl.getAttribute("data-spot-id");
    if (!spotId) {
      return;
    }

    spotElementsById.set(spotId, spotEl);
    let status = spotData[spotId]?.status;
    if (!status && spotId.startsWith("K")) {
      const parkingMatch = Object.keys(spotData).find(
        (id) =>
          spotData[id]?.kind === "parking" &&
          normalizeStorageId(spotData[id]?.storageNumber) === spotId,
      );
      if (parkingMatch) {
        status = spotData[parkingMatch]?.status;
      }
    }
    const baseFill = resolveBaseFill(spotId, status) || "#cccccc";
    spotEl.dataset.baseFill = baseFill;
    spotEl.style.fill = baseFill;
    setSpotLabelVisibility(spotId, spotEl, status, labelsById);
    if (!spotEl.dataset.bound) {
      spotEl.addEventListener("click", (event) => {
        selectSpot(spotId, spotEl);
        hideTooltip();
        showBubble(spotId, spotEl);
        event.stopPropagation();
      });
      spotEl.addEventListener("mouseenter", (event) => {
        applyHoverToSet(spotId);
        showSpotDetails(spotId);
        if (!spotEl.classList.contains("selected")) {
          scheduleTooltip(spotId, event);
        }
      });
      spotEl.addEventListener("mousemove", (event) => {
        lastTooltipEvent = event;
        if (
          !spotEl.classList.contains("selected") &&
          tooltipEl &&
          tooltipEl.style.opacity === "1"
        ) {
          showTooltip(spotId, event);
        }
      });
      spotEl.addEventListener("mouseleave", () => {
        clearHoverFromSet(spotId);
        hideTooltip();
        showSelectedDetails();
      });
      spotEl.dataset.bound = "true";
    }
  });
}

function clearSelectedSpots() {
  selectedSpots.forEach((element) => {
    element.classList.remove("selected");
    applyBaseFill(element);
  });
  selectedSpots = [];
}

function getParkingSetIds(parkingId) {
  const normalized = normalizeParkingId(parkingId);
  if (!normalized) {
    return [];
  }

  const ids = [normalized];
  const directPair = spotData[normalized]?.pairId;
  if (directPair) {
    ids.push(normalizeParkingId(directPair));
  }

  const reversePair = Object.keys(spotData).find(
    (id) =>
      spotData[id]?.kind === "parking" && spotData[id]?.pairId === normalized,
  );
  if (reversePair) {
    ids.push(normalizeParkingId(reversePair));
  }

  return uniqueIds(ids);
}

function getStorageIdsForParkingSet(parkingIds) {
  const storageIds = [];
  parkingIds.forEach((parkingId) => {
    const storageId = normalizeStorageId(spotData[parkingId]?.storageNumber);
    if (storageId) {
      storageIds.push(storageId);
    }
  });
  return uniqueIds(storageIds);
}

function getParkingIdsForStorage(storageId) {
  const normalized = normalizeStorageId(storageId);
  if (!normalized) {
    return [];
  }
  return Object.keys(spotData).filter(
    (id) =>
      spotData[id]?.kind === "parking" &&
      normalizeStorageId(spotData[id]?.storageNumber) === normalized,
  );
}

function getSelectionIds(unitId) {
  const normalized = normalizeUnitId(unitId);
  if (!normalized) {
    return [];
  }

  if (normalized.startsWith("P")) {
    const parkingSet = getParkingSetIds(normalized);
    const storageIds = getStorageIdsForParkingSet(parkingSet);
    return uniqueIds([...parkingSet, ...storageIds]);
  }

  if (normalized.startsWith("K")) {
    const parkingIds = getParkingIdsForStorage(normalized);
    if (parkingIds.length === 0) {
      return [normalized];
    }

    const parkingSet = uniqueIds(
      parkingIds.flatMap((id) => getParkingSetIds(id)),
    );
    const storageIds = uniqueIds([
      ...getStorageIdsForParkingSet(parkingSet),
      normalized,
    ]);
    return uniqueIds([...parkingSet, ...storageIds]);
  }

  return [];
}

function uniqueIds(ids) {
  const seen = new Set();
  return ids
    .map((id) => normalizeUnitId(id))
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

  const spotIds = getSelectionIds(spotId);
  selectedSpotId = spotId;
  selectedSpots = spotIds.map((id) => spotElementsById.get(id)).filter(Boolean);

  selectedSpots.forEach((element) => {
    element.classList.add("selected");
    applySelectedFill(element);
  });

  showSpotDetails(spotId);
}

function ensureOverlayElements() {
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.className = "spot-tooltip";
    tooltipEl.setAttribute("aria-hidden", "true");
  }
  if (!bubbleEl) {
    bubbleEl = document.createElement("div");
    bubbleEl.className = "spot-bubble";
    bubbleEl.setAttribute("aria-hidden", "true");
  }
  if (tooltipEl && !tooltipEl.isConnected) {
    svgHost.appendChild(tooltipEl);
  }
  if (bubbleEl && !bubbleEl.isConnected) {
    svgHost.appendChild(bubbleEl);
  }
  if (!svgHost.dataset.overlayBound) {
    svgHost.addEventListener("click", () => hideBubble());
    svgHost.dataset.overlayBound = "true";
  }
}

function scheduleTooltip(spotId, event) {
  lastTooltipEvent = event;
  if (tooltipTimer) {
    clearTimeout(tooltipTimer);
  }
  tooltipTimer = setTimeout(() => {
    if (lastTooltipEvent) {
      showTooltip(spotId, lastTooltipEvent);
    }
  }, 1000);
}

function showTooltip(spotId, event) {
  if (!tooltipEl) {
    return;
  }
  const entries = getSpotEntries(spotId);
  if (entries.length === 0) {
    hideTooltip();
    return;
  }
  tooltipEl.innerHTML = buildDetailsHtml(entries);
  tooltipEl.style.opacity = "1";
  tooltipEl.style.pointerEvents = "none";

  const hostRect = svgHost.getBoundingClientRect();
  const offsetX = event.clientX - hostRect.left + 12;
  const offsetY = event.clientY - hostRect.top + 12;
  positionOverlay(tooltipEl, offsetX, offsetY, hostRect);
}

function hideTooltip() {
  if (!tooltipEl) {
    return;
  }
  if (tooltipTimer) {
    clearTimeout(tooltipTimer);
    tooltipTimer = null;
  }
  lastTooltipEvent = null;
  tooltipEl.style.opacity = "0";
}

function showBubble(spotId, spotEl) {
  if (!bubbleEl || !spotEl) {
    return;
  }
  const entries = getSpotEntries(spotId);
  if (entries.length === 0) {
    hideBubble();
    return;
  }
  bubbleEl.innerHTML = buildDetailsHtml(entries);
  bubbleEl.style.opacity = "1";

  const hostRect = svgHost.getBoundingClientRect();
  const spotRect = spotEl.getBoundingClientRect();
  const anchor = {
    left: spotRect.left - hostRect.left,
    top: spotRect.top - hostRect.top,
    right: spotRect.right - hostRect.left,
    bottom: spotRect.bottom - hostRect.top,
  };
  positionBubbleSmart(bubbleEl, anchor, hostRect);
}

function hideBubble() {
  if (!bubbleEl) {
    return;
  }
  bubbleEl.style.opacity = "0";
}

function positionOverlay(element, x, y, hostRect, anchorCenter = false) {
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  let left = x;
  let top = y;
  if (anchorCenter) {
    left = x - width / 2;
    top = y - height;
  }

  const maxX = hostRect.width - width - 8;
  const maxY = hostRect.height - height - 8;
  const clampedX = Math.max(8, Math.min(left, maxX));
  const clampedY = Math.max(8, Math.min(top, maxY));
  element.style.transform = "none";
  element.style.left = `${clampedX}px`;
  element.style.top = `${clampedY}px`;
}

function positionBubbleSmart(element, anchor, hostRect) {
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const gap = 10;

  const candidates = [
    { left: anchor.right + gap, top: anchor.bottom + gap }, // bottom-right
    { left: anchor.left - width - gap, top: anchor.bottom + gap }, // bottom-left
    { left: anchor.right + gap, top: anchor.top - height - gap }, // top-right
    { left: anchor.left - width - gap, top: anchor.top - height - gap }, // top-left
  ];

  const fits = (pos) =>
    pos.left >= 8 &&
    pos.top >= 8 &&
    pos.left + width <= hostRect.width - 8 &&
    pos.top + height <= hostRect.height - 8;

  const chosen = candidates.find(fits) || candidates[0];
  positionOverlay(element, chosen.left, chosen.top, hostRect);
}
function showSpotDetails(spotId) {
  const entries = getSpotEntries(spotId);
  if (entries.length === 0) {
    detailsNode.innerHTML = '<p class="muted">Нет данных по месту.</p>';
    return;
  }

  detailsNode.innerHTML = buildDetailsHtml(entries);
}

function buildDetailsHtml(entries) {
  const entryLabels = entries.map((entry) => formatUnitLabel(entry.id));
  const statusLabel = entries[0].data.statusLabel || "-";
  const spotLabel = entryLabels.join(" + ");
  const storageEntryIds = getStorageEntryIds(entries);
  const storageInfo = getStorageInfo(entries, storageEntryIds);
  const totalArea = resolveTotalArea(entries, storageEntryIds);
  const totalPrice = sumNumbers(
    entries.map((entry) => {
      const entryArea = resolveEntryArea(entry, storageEntryIds);
      const pricePerSqm = entry.data.pricePerSqm;
      if (!Number.isFinite(entryArea) || !Number.isFinite(pricePerSqm)) {
        return NaN;
      }
      return entryArea * pricePerSqm;
    }),
  );

  const isSingle = entries.length === 1;
  const isStorageOnly = isSingle && entries[0].data.kind === "storage";
  const titleLabel = isStorageOnly ? "Кладовая" : "Места";
  let html = `<p><strong>${titleLabel}:</strong> ${spotLabel}</p>`;
  html += `<p><strong>Статус:</strong> ${statusLabel}</p>`;
  entries.forEach((entry) => {
    if (entry.data.kind === "storage") {
      html += `<p><strong>${formatUnitLabel(
        entry.id,
      )} — площадь кладовой:</strong> ${formatArea(entry.data.storageArea)} м²</p>`;
      return;
    }
    html += `<p><strong>${formatUnitLabel(
      entry.id,
    )} — площадь м/м:</strong> ${formatArea(entry.data.spotArea)} м²</p>`;
  });
  if (storageInfo) {
    html += `<p><strong>Кладовая:</strong> ${storageInfo.label}</p>`;
  }
  if (Number.isFinite(totalArea)) {
    html += `<p><strong>Общая площадь:</strong> ${formatArea(
      totalArea,
    )} м²</p>`;
  }
  if (entries.some((entry) => Number.isFinite(entry.data.pricePerSqm))) {
    const priceLabels = entries
      .map((entry) =>
        Number.isFinite(entry.data.pricePerSqm)
          ? `${formatUnitLabel(entry.id)}: ${formatPrice(entry.data.pricePerSqm)} ₽`
          : `${formatUnitLabel(entry.id)}: -`,
      )
      .join(", ");
    html += `<p><strong>Цена кв.м.:</strong> ${priceLabels}</p>`;
  }
  if (Number.isFinite(totalPrice)) {
    const priceTitle = isSingle ? "Цена" : "Цена комплекта";
    html += `<p><strong>${priceTitle}:</strong> ${formatPrice(totalPrice)} ₽</p>`;
  }

  return html;
}

function getSpotEntries(spotId) {
  const spotIds = getSelectionIds(spotId);
  return spotIds
    .map((id) => ({ id, data: spotData[id] }))
    .filter((entry) => Boolean(entry.data));
}

function getStorageEntryIds(entries) {
  return new Set(
    entries
      .filter((entry) => entry.data.kind === "storage")
      .map((entry) => entry.id),
  );
}

function getStorageInfo(entries, storageEntryIds) {
  const entryWithStorage = entries.find(
    (entry) => entry.data.kind === "parking" && entry.data.storageNumber,
  );
  if (!entryWithStorage) {
    return null;
  }

  const storageId = normalizeStorageId(entryWithStorage.data.storageNumber);
  if (storageId && storageEntryIds.has(storageId)) {
    return null;
  }

  const storageArea = pickFirstFinite(
    entries.map((entry) => entry.data.storageArea),
  );
  const areaLabel = Number.isFinite(storageArea)
    ? ` (${formatArea(storageArea)} м²)`
    : "";

  return {
    label: `${formatUnitLabel(entryWithStorage.data.storageNumber)}${areaLabel}`,
  };
}

function resolveTotalArea(entries, storageEntryIds) {
  return sumNumbers(
    entries.map((entry) => resolveEntryArea(entry, storageEntryIds)),
  );
}

function resolveEntryArea(entry, storageEntryIds) {
  const data = entry?.data;
  if (!data) {
    return NaN;
  }
  if (data.kind === "storage") {
    return data.storageArea;
  }
  if (data.kind === "parking") {
    const spotArea = data.spotArea;
    const storageArea = data.storageArea;
    const storageId = normalizeStorageId(data.storageNumber);
    const includeStorage =
      Number.isFinite(storageArea) &&
      (!storageId || !storageEntryIds.has(storageId));
    return sumNumbers([spotArea, includeStorage ? storageArea : NaN]);
  }
  return NaN;
}

function formatUnitLabel(value) {
  const normalized = normalizeUnitId(value);
  if (!normalized) {
    return "-";
  }
  if (normalized.startsWith("P")) {
    const digits = normalized.slice(1);
    return `№${Number.parseInt(digits, 10)}`;
  }
  if (normalized.startsWith("K")) {
    const digits = normalized.slice(1).padStart(4, "0");
    const part1 = Number.parseInt(digits.slice(0, 2), 10);
    const part2 = Number.parseInt(digits.slice(2), 10);
    return `№${part1}.${part2}`;
  }
  return normalized;
}

function applyBaseFill(spotEl) {
  const baseFill = spotEl?.dataset?.baseFill;
  if (baseFill) {
    spotEl.style.fill = baseFill;
  }
}

function getSpotElementsForIds(spotIds) {
  if (!Array.isArray(spotIds)) {
    return [];
  }
  return spotIds.map((id) => spotElementsById.get(id)).filter(Boolean);
}

function applyHoverToSet(spotId) {
  const spotIds = getSelectionIds(spotId);
  const elements = getSpotElementsForIds(spotIds);
  elements.forEach((element) => {
    if (!element.classList.contains("selected")) {
      applyHoverFill(element);
    }
    element.dataset.hovered = "true";
  });
}

function clearHoverFromSet(spotId) {
  const spotIds = getSelectionIds(spotId);
  const elements = getSpotElementsForIds(spotIds);
  elements.forEach((element) => {
    if (element.classList.contains("selected")) {
      applySelectedFill(element);
    } else {
      applyBaseFill(element);
    }
    delete element.dataset.hovered;
  });
}

function setSpotLabelVisibility(spotId, spotEl, status, labelsById) {
  if (!spotId || !spotEl) {
    return;
  }
  const hide = status === "sold";
  const labelElements = [];
  const group = spotEl.closest("g[id]");
  if (group) {
    Array.from(group.children).forEach((child) => {
      if (child !== spotEl) {
        labelElements.push(child);
      }
    });
  }
  const textLabels = labelsById?.get(spotId);
  if (textLabels) {
    labelElements.push(...textLabels);
  }
  if (labelElements.length === 0) {
    return;
  }
  labelElements.forEach((element) => {
    element.style.opacity = hide ? "0" : "1";
  });
}

function resolveBaseFill(spotId, status) {
  const isStorage =
    (spotId && spotId.startsWith("K")) || spotData[spotId]?.kind === "storage";
  if (status === "available" && isStorage) {
    return STORAGE_AVAILABLE_COLOR || STATUS_COLORS.available || "";
  }
  return STATUS_COLORS[status] || "";
}

function applyHoverFill(spotEl) {
  const baseFill = spotEl?.dataset?.baseFill;
  const hoverFill = HOVER_FILL || adjustHexColor(baseFill, 0.18);
  if (hoverFill) {
    spotEl.style.fill = hoverFill;
  }
}

function applySelectedFill(spotEl) {
  const baseFill = spotEl?.dataset?.baseFill;
  const selectedFill = CLICK_FILL || adjustHexColor(baseFill, 0.32);
  if (selectedFill) {
    spotEl.style.fill = selectedFill;
  }
}

function adjustHexColor(hex, amount) {
  if (!hex || typeof hex !== "string") {
    return "";
  }
  const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
  const full =
    normalized.length === 3
      ? normalized
          .split("")
          .map((c) => c + c)
          .join("")
      : normalized;
  if (full.length !== 6) {
    return "";
  }
  const num = Number.parseInt(full, 16);
  if (Number.isNaN(num)) {
    return "";
  }
  const r = (num >> 16) & 0xff;
  const g = (num >> 8) & 0xff;
  const b = num & 0xff;
  const factor = 1 + amount;
  const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
  const next =
    (clamp(r * factor) << 16) | (clamp(g * factor) << 8) | clamp(b * factor);
  return `#${next.toString(16).padStart(6, "0")}`;
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
      '<p class="muted">Не удалось загрузить данные из таблицы.</p>';
    return;
  }

  if (selectedSpotId) {
    showSpotDetails(selectedSpotId);
    return;
  }

  detailsNode.innerHTML = '<p class="muted">Выберите место на карте.</p>';
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
  return value.toFixed(2);
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
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
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
    center: true,
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
      cache: "no-store",
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
      if (!isInitial && updatedAt > 0 && updatedAt <= lastUpdatedAt) {
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
  const pairIdx = resolveIndex(
    findHeaderIndex(headers, ["№пары", "пары", "пара"]),
    1,
  );
  const storageIdx = resolveIndex(
    findHeaderIndex(headers, ["№кладовой", "кладовой", "кладовая"]),
    2,
  );
  const spotAreaIdx = resolveIndex(
    findHeaderIndex(headers, [
      "площадьм/м",
      "площадьмм",
      "площадьмместа",
      "площадьместа",
    ]),
    3,
  );
  const storageAreaIdx = resolveIndex(
    findHeaderIndex(headers, ["площадькладовой"]),
    4,
  );
  const totalAreaIdx = resolveIndex(
    findHeaderIndex(headers, ["общаяплощадь"]),
    5,
  );
  const priceIdx = resolveIndex(
    findHeaderIndex(headers, ["ценакв.м", "ценаквм", "ценаквм."]),
    6,
  );

  const data = {};
  rows.slice(1).forEach((row) => {
    const unitId = normalizeUnitId(row[0]);
    if (!unitId) {
      return;
    }

    const kind = unitId.startsWith("K") ? "storage" : "parking";
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
    const pairId = kind === "parking" ? normalizeParkingId(rawPair) : "";
    const storageNumber =
      kind === "parking" ? normalizeStorageId(rawStorage) : "";
    const spotArea = parseNumber(rawSpotArea);
    const storageArea =
      kind === "storage"
        ? parseNumber(rawSpotArea)
        : parseNumber(rawStorageArea);
    const totalArea = parseNumber(rawTotalArea);
    const pricePerSqm = parseNumber(rawPrice);

    data[unitId] = {
      kind,
      status,
      statusLabel,
      pairId: pairId || null,
      storageNumber,
      spotArea: kind === "storage" ? NaN : spotArea,
      storageArea,
      totalArea,
      pricePerSqm,
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

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
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

function normalizeUnitId(value) {
  const raw = String(value || "");
  const cleaned = raw
    .replace(/﻿/g, "")
    .replace(/ /g, "")
    .replace(/\s+/g, "")
    .replace(/[Р]/g, "P")
    .replace(/[К]/g, "K")
    .trim()
    .toUpperCase();
  if (!cleaned) {
    return "";
  }
  if (/^P\d+$/.test(cleaned)) {
    const digits = cleaned.replace(/^P/, "");
    return `P${digits.padStart(3, "0")}`;
  }
  if (/^K\d+$/.test(cleaned)) {
    const digits = cleaned.replace(/^K/, "");
    return `K${digits.padStart(4, "0")}`;
  }
  if (/^\d+$/.test(cleaned)) {
    return `P${cleaned.padStart(3, "0")}`;
  }
  return "";
}

function normalizeParkingId(value) {
  const normalized = normalizeUnitId(value);
  return normalized.startsWith("P") ? normalized : "";
}

function normalizeStorageId(value) {
  const normalized = normalizeUnitId(value);
  return normalized.startsWith("K") ? normalized : "";
}

function findHeaderIndex(headers, keywords) {
  return headers.findIndex((header) =>
    keywords.some((keyword) => header.includes(keyword)),
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
    Number(second || 0),
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
