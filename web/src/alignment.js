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
