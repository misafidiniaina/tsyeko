export const GUIDE_AXES = Object.freeze({
  VERTICAL: "x",
  HORIZONTAL: "y",
});

export const DEFAULT_GRID_SIZE = 16;
export const MAX_PAGE_GUIDES = 256;

const GUIDE_AXIS_VALUES = new Set(Object.values(GUIDE_AXES));

export function createGuide(axis, position, id) {
  if (!GUIDE_AXIS_VALUES.has(axis)) throw new TypeError(`Unsupported guide axis: ${axis}`);
  if (!Number.isFinite(position)) throw new TypeError("Guide position must be finite.");
  return {
    id: cleanGuideId(id) || fallbackGuideId(),
    axis,
    position: clamp(position, -1_000_000, 1_000_000),
  };
}

export function normalizeGuides(input, idFactory = fallbackGuideId) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const guides = [];
  for (const candidate of input.slice(0, MAX_PAGE_GUIDES)) {
    if (!candidate || !GUIDE_AXIS_VALUES.has(candidate.axis)) continue;
    const position = Number(candidate.position);
    if (!Number.isFinite(position)) continue;
    let id = cleanGuideId(candidate.id);
    if (!id || seen.has(id)) {
      const base = cleanGuideId(idFactory()) || fallbackGuideId();
      id = base;
      let suffix = 2;
      while (seen.has(id)) {
        id = `${base.slice(0, 150)}_${suffix}`;
        suffix += 1;
      }
    }
    seen.add(id);
    guides.push(createGuide(candidate.axis, position, id));
  }
  return guides;
}

export function closestGridSnap(targets, gridSize, threshold) {
  const size = Number(gridSize);
  if (!Array.isArray(targets) || !targets.length || !Number.isFinite(size) || size <= 0) return null;
  let best = null;
  for (const target of targets) {
    if (!Number.isFinite(target)) continue;
    const value = Math.round(target / size) * size;
    const delta = value - target;
    if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
      best = { delta, value };
    }
  }
  return best;
}

export function snapGuidePosition(position, references, threshold) {
  let best = null;
  for (const reference of references ?? []) {
    if (!Number.isFinite(reference)) continue;
    const distance = Math.abs(reference - position);
    if (distance <= threshold && (!best || distance < best.distance)) {
      best = { value: reference, distance };
    }
  }
  return best?.value ?? Math.round(position * 10) / 10;
}

export function rulerStep(zoom, minimumPixels = 72) {
  const safeZoom = Math.max(0.0001, Number(zoom) || 1);
  const desired = Math.max(1, minimumPixels) / safeZoom;
  const magnitude = 10 ** Math.floor(Math.log10(desired));
  const normalized = desired / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function cleanGuideId(value) {
  return typeof value === "string"
    ? value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160)
    : "";
}

let fallbackId = 0;

function fallbackGuideId() {
  fallbackId += 1;
  return `guide_${Date.now().toString(36)}_${fallbackId.toString(36)}`;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
