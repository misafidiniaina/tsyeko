export const ALIGNMENTS = Object.freeze({
  LEFT: "left",
  HORIZONTAL_CENTER: "horizontal-center",
  RIGHT: "right",
  TOP: "top",
  VERTICAL_CENTER: "vertical-center",
  BOTTOM: "bottom",
});

export const DISTRIBUTION_AXES = Object.freeze({
  HORIZONTAL: "horizontal",
  VERTICAL: "vertical",
});

const ALIGNMENT_PROPERTIES = Object.freeze({
  [ALIGNMENTS.LEFT]: { axis: "x", edge: "start" },
  [ALIGNMENTS.HORIZONTAL_CENTER]: { axis: "x", edge: "center" },
  [ALIGNMENTS.RIGHT]: { axis: "x", edge: "end" },
  [ALIGNMENTS.TOP]: { axis: "y", edge: "start" },
  [ALIGNMENTS.VERTICAL_CENTER]: { axis: "y", edge: "center" },
  [ALIGNMENTS.BOTTOM]: { axis: "y", edge: "end" },
});

const SPACING_EPSILON = 0.0001;

export function calculateAlignmentDeltas(items, alignment) {
  const property = ALIGNMENT_PROPERTIES[alignment];
  if (!property || items.length < 2) return [];

  const bounds = combinedItemBounds(items);
  const target = edgeValue(bounds, property.axis, property.edge);
  return items.map((item) => ({
    id: item.id,
    dx: property.axis === "x"
      ? target - edgeValue(item.bounds, "x", property.edge)
      : 0,
    dy: property.axis === "y"
      ? target - edgeValue(item.bounds, "y", property.edge)
      : 0,
  }));
}

export function calculateDistributionDeltas(items, axis) {
  const property = distributionProperty(axis);
  if (!property || items.length < 3) return [];

  const ordered = sortItems(items, property.axis);
  const first = ordered[0];
  const last = ordered.at(-1);
  const rangeStart = startValue(first.bounds, property.axis);
  const rangeEnd = endValue(last.bounds, property.axis);
  const occupied = ordered.reduce(
    (total, item) => total + sizeValue(item.bounds, property.axis),
    0,
  );
  const gap = (rangeEnd - rangeStart - occupied) / (ordered.length - 1);
  let cursor = rangeStart;

  return ordered.map((item, index) => {
    const delta = index === 0 || index === ordered.length - 1
      ? 0
      : cursor - startValue(item.bounds, property.axis);
    const result = {
      id: item.id,
      dx: property.axis === "x" ? delta : 0,
      dy: property.axis === "y" ? delta : 0,
    };
    cursor += sizeValue(item.bounds, property.axis) + gap;
    return result;
  });
}

export function createAlignmentGuide(items, alignment) {
  const property = ALIGNMENT_PROPERTIES[alignment];
  if (!property || !items.length) return null;
  const bounds = combinedItemBounds(items);
  return {
    type: "alignment",
    axis: property.axis,
    value: edgeValue(bounds, property.axis, property.edge),
    start: property.axis === "x" ? bounds.y : bounds.x,
    end: property.axis === "x" ? bounds.y + bounds.height : bounds.x + bounds.width,
  };
}

export function createSpacingGuides(items, axis) {
  const property = distributionProperty(axis);
  if (!property || items.length < 2) return [];
  const ordered = sortItems(items, property.axis);
  const guides = [];

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1].bounds;
    const next = ordered[index].bounds;
    const start = endValue(previous, property.axis);
    const end = startValue(next, property.axis);
    guides.push({
      type: "spacing",
      axis: property.axis,
      start,
      end,
      cross: sharedCrossPosition(previous, next, property.axis),
      value: end - start,
    });
  }

  return guides;
}

export function findSmartSpacingSnaps(movingBounds, referenceItems, threshold) {
  const moving = normalizeBounds(movingBounds);
  const references = Array.isArray(referenceItems)
    ? referenceItems
        .map((item) => ({ id: item?.id ?? null, bounds: normalizeBounds(item?.bounds) }))
        .filter((item) => item.bounds)
    : [];
  const limit = Number.isFinite(threshold) ? Math.max(0, threshold) : 0;
  if (!moving || references.length < 2) return { x: null, y: null };

  return {
    x: findAxisSpacingSnap(moving, references, "x", limit),
    y: findAxisSpacingSnap(moving, references, "y", limit),
  };
}

export function combinedItemBounds(items) {
  if (!items.length) return null;
  const left = Math.min(...items.map((item) => item.bounds.x));
  const top = Math.min(...items.map((item) => item.bounds.y));
  const right = Math.max(...items.map((item) => item.bounds.x + item.bounds.width));
  const bottom = Math.max(...items.map((item) => item.bounds.y + item.bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function distributionProperty(axis) {
  if (axis === DISTRIBUTION_AXES.HORIZONTAL) return { axis: "x" };
  if (axis === DISTRIBUTION_AXES.VERTICAL) return { axis: "y" };
  return null;
}

function sortItems(items, axis) {
  return [...items].sort((left, right) => {
    const difference = startValue(left.bounds, axis) - startValue(right.bounds, axis);
    return difference || String(left.id).localeCompare(String(right.id));
  });
}

function edgeValue(bounds, axis, edge) {
  const start = startValue(bounds, axis);
  if (edge === "start") return start;
  if (edge === "center") return start + sizeValue(bounds, axis) / 2;
  return start + sizeValue(bounds, axis);
}

function startValue(bounds, axis) {
  return axis === "x" ? bounds.x : bounds.y;
}

function sizeValue(bounds, axis) {
  return axis === "x" ? bounds.width : bounds.height;
}

function endValue(bounds, axis) {
  return startValue(bounds, axis) + sizeValue(bounds, axis);
}

function sharedCrossPosition(previous, next, axis) {
  const crossAxis = axis === "x" ? "y" : "x";
  const overlapStart = Math.max(
    startValue(previous, crossAxis),
    startValue(next, crossAxis),
  );
  const overlapEnd = Math.min(
    endValue(previous, crossAxis),
    endValue(next, crossAxis),
  );
  if (overlapEnd >= overlapStart) return (overlapStart + overlapEnd) / 2;
  const previousCenter = edgeValue(previous, crossAxis, "center");
  const nextCenter = edgeValue(next, crossAxis, "center");
  return (previousCenter + nextCenter) / 2;
}

function findAxisSpacingSnap(moving, references, axis, threshold) {
  const crossAxis = axis === "x" ? "y" : "x";
  const compatible = references
    .filter((item) => rangesOverlap(item.bounds, moving, crossAxis))
    .sort((left, right) => {
      const difference = startValue(left.bounds, axis) - startValue(right.bounds, axis);
      return difference || String(left.id).localeCompare(String(right.id));
    });
  if (compatible.length < 2) return null;

  const pairs = [];
  for (let index = 1; index < compatible.length; index += 1) {
    const before = compatible[index - 1].bounds;
    const after = compatible[index].bounds;
    const gap = startValue(after, axis) - endValue(before, axis);
    if (gap >= -SPACING_EPSILON) pairs.push({ before, after, gap: Math.max(0, gap) });
  }
  if (!pairs.length) return null;

  let best = null;
  const movingSize = sizeValue(moving, axis);
  const consider = (targetStart, gap, guides, priority) => {
    const delta = targetStart - startValue(moving, axis);
    if (Math.abs(delta) > threshold + SPACING_EPSILON) return;
    const target = translateBoundsOnAxis(moving, axis, delta);
    if (compatible.some((item) => rangesOverlap(item.bounds, target, axis, true))) return;
    const candidate = {
      axis,
      delta,
      gap,
      guides: deduplicateSpacingGuides(guides.filter(Boolean)),
      priority,
    };
    if (!best || compareSpacingCandidates(candidate, best) < 0) best = candidate;
  };

  for (const pair of pairs) {
    const available = startValue(pair.after, axis) - endValue(pair.before, axis) - movingSize;
    if (available < -SPACING_EPSILON) continue;
    const gap = Math.max(0, available / 2);
    const targetStart = endValue(pair.before, axis) + gap;
    const target = translateBoundsOnAxis(moving, axis, targetStart - startValue(moving, axis));
    consider(targetStart, gap, [
      ...guidesForGap(pairs, gap, axis),
      spacingGuide(pair.before, target, axis),
      spacingGuide(target, pair.after, axis),
    ], 0);
  }

  for (const pair of pairs) {
    if (pair.gap <= SPACING_EPSILON) continue;
    const repeatedGuides = guidesForGap(pairs, pair.gap, axis);
    for (const anchor of compatible) {
      const afterStart = endValue(anchor.bounds, axis) + pair.gap;
      const afterTarget = translateBoundsOnAxis(moving, axis, afterStart - startValue(moving, axis));
      consider(afterStart, pair.gap, [
        ...repeatedGuides,
        spacingGuide(anchor.bounds, afterTarget, axis),
      ], 1);

      const beforeStart = startValue(anchor.bounds, axis) - pair.gap - movingSize;
      const beforeTarget = translateBoundsOnAxis(moving, axis, beforeStart - startValue(moving, axis));
      consider(beforeStart, pair.gap, [
        ...repeatedGuides,
        spacingGuide(beforeTarget, anchor.bounds, axis),
      ], 1);
    }
  }

  if (!best) return null;
  const { priority: _priority, ...snap } = best;
  return snap;
}

function guidesForGap(pairs, gap, axis) {
  return pairs
    .filter((pair) => Math.abs(pair.gap - gap) <= SPACING_EPSILON)
    .map((pair) => spacingGuide(pair.before, pair.after, axis));
}

function spacingGuide(before, after, axis) {
  const start = endValue(before, axis);
  const end = startValue(after, axis);
  if (end < start - SPACING_EPSILON) return null;
  return {
    type: "spacing",
    axis,
    start,
    end,
    cross: sharedCrossPosition(before, after, axis),
    value: Math.max(0, end - start),
  };
}

function compareSpacingCandidates(left, right) {
  const distance = Math.abs(left.delta) - Math.abs(right.delta);
  if (Math.abs(distance) > SPACING_EPSILON) return distance;
  if (left.priority !== right.priority) return left.priority - right.priority;
  if (left.guides.length !== right.guides.length) return right.guides.length - left.guides.length;
  return left.gap - right.gap;
}

function deduplicateSpacingGuides(guides) {
  const seen = new Set();
  return guides.filter((guide) => {
    const key = [guide.axis, guide.start, guide.end, guide.cross, guide.value]
      .map((value) => typeof value === "number" ? value.toFixed(4) : value)
      .join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rangesOverlap(left, right, axis, requireArea = false) {
  const overlap = Math.min(endValue(left, axis), endValue(right, axis)) -
    Math.max(startValue(left, axis), startValue(right, axis));
  return requireArea ? overlap > SPACING_EPSILON : overlap >= -SPACING_EPSILON;
}

function translateBoundsOnAxis(bounds, axis, delta) {
  return {
    ...bounds,
    x: bounds.x + (axis === "x" ? delta : 0),
    y: bounds.y + (axis === "y" ? delta : 0),
  };
}

function normalizeBounds(bounds) {
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return null;
  if (bounds.width < 0 || bounds.height < 0) return null;
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}
