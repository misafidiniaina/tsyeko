const EPSILON = 0.0001;

export function createDistanceGuides(sourceBounds, targetBounds, targetId = null) {
  const source = normalizeBounds(sourceBounds);
  const target = normalizeBounds(targetBounds);
  if (!source || !target) return [];

  if (containsBounds(target, source)) {
    return [
      distanceGuide("x", target.x, source.x, source.y + source.height / 2, targetId),
      distanceGuide("x", source.x + source.width, target.x + target.width, source.y + source.height / 2, targetId),
      distanceGuide("y", target.y, source.y, source.x + source.width / 2, targetId),
      distanceGuide("y", source.y + source.height, target.y + target.height, source.x + source.width / 2, targetId),
    ].filter(Boolean);
  }

  return [
    separatedAxisGuide(source, target, "x", targetId),
    separatedAxisGuide(source, target, "y", targetId),
  ].filter(Boolean);
}

export function createNearestSpacingGuides(sourceBounds, targets, maximumDistance = Infinity) {
  const source = normalizeBounds(sourceBounds);
  if (!source || !Array.isArray(targets)) return [];
  const limit = Number.isFinite(maximumDistance) ? Math.max(0, maximumDistance) : Infinity;
  const nearest = new Map();

  for (const target of [...targets].sort((left, right) => String(left?.id).localeCompare(String(right?.id)))) {
    for (const guide of createDistanceGuides(source, target?.bounds, target?.id ?? null)) {
      if (guide.value > limit || guide.value <= EPSILON) continue;
      const current = nearest.get(guide.axis);
      if (!current || guide.value < current.value - EPSILON) nearest.set(guide.axis, guide);
    }
  }

  return [nearest.get("x"), nearest.get("y")].filter(Boolean);
}

function separatedAxisGuide(source, target, axis, targetId) {
  const sourceStart = startValue(source, axis);
  const sourceEnd = endValue(source, axis);
  const targetStart = startValue(target, axis);
  const targetEnd = endValue(target, axis);
  let start;
  let end;
  if (sourceEnd <= targetStart) {
    start = sourceEnd;
    end = targetStart;
  } else if (targetEnd <= sourceStart) {
    start = targetEnd;
    end = sourceStart;
  } else {
    return null;
  }
  return distanceGuide(axis, start, end, sharedCrossPosition(source, target, axis), targetId);
}

function distanceGuide(axis, start, end, cross, targetId) {
  const value = Math.abs(end - start);
  if (!Number.isFinite(value) || value <= EPSILON) return null;
  return {
    type: "distance",
    axis,
    start: Math.min(start, end),
    end: Math.max(start, end),
    cross,
    value,
    targetId,
  };
}

function sharedCrossPosition(source, target, axis) {
  const crossAxis = axis === "x" ? "y" : "x";
  const overlapStart = Math.max(startValue(source, crossAxis), startValue(target, crossAxis));
  const overlapEnd = Math.min(endValue(source, crossAxis), endValue(target, crossAxis));
  if (overlapEnd >= overlapStart) return (overlapStart + overlapEnd) / 2;
  const sourceCenter = (startValue(source, crossAxis) + endValue(source, crossAxis)) / 2;
  const targetCenter = (startValue(target, crossAxis) + endValue(target, crossAxis)) / 2;
  return (sourceCenter + targetCenter) / 2;
}

function containsBounds(outer, inner) {
  return outer.x <= inner.x + EPSILON &&
    outer.y <= inner.y + EPSILON &&
    outer.x + outer.width >= inner.x + inner.width - EPSILON &&
    outer.y + outer.height >= inner.y + inner.height - EPSILON;
}

function normalizeBounds(bounds) {
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return null;
  if (bounds.width < 0 || bounds.height < 0) return null;
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

function startValue(bounds, axis) {
  return axis === "x" ? bounds.x : bounds.y;
}

function endValue(bounds, axis) {
  return startValue(bounds, axis) + (axis === "x" ? bounds.width : bounds.height);
}
