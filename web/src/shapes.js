export const ARROWHEADS = Object.freeze({
  NONE: "none",
  TRIANGLE: "triangle",
  LINE: "line",
  DIAMOND: "diamond",
  CIRCLE: "circle",
});

export const PARAMETRIC_SHAPE_TYPES = Object.freeze(["line", "polygon", "star"]);

const MIN_STAR_RATIO = 0.08;
const MAX_STAR_RATIO = 0.95;

export function isParametricShape(nodeOrType) {
  const type = typeof nodeOrType === "string" ? nodeOrType : nodeOrType?.type;
  return PARAMETRIC_SHAPE_TYPES.includes(type);
}

export function getParametricShapePoints(node) {
  if (node?.type === "polygon") {
    return regularPoints(node.width, node.height, node.polygonSides, 1);
  }
  if (node?.type === "star") {
    return starPoints(node.width, node.height, node.starPoints, node.starInnerRatio);
  }
  return [];
}

export function getLineEndpoints(node) {
  return {
    start: {
      x: (node?.lineStartX ?? 0) * (node?.width ?? 1),
      y: (node?.lineStartY ?? 0.5) * (node?.height ?? 1),
    },
    end: {
      x: (node?.lineEndX ?? 1) * (node?.width ?? 1),
      y: (node?.lineEndY ?? 0.5) * (node?.height ?? 1),
    },
  };
}

export function getLineArrowheads(node) {
  const { start, end } = getLineEndpoints(node);
  return {
    start: arrowheadGeometry(node?.arrowStart, start, end, node?.strokeWidth),
    end: arrowheadGeometry(node?.arrowEnd, end, start, node?.strokeWidth),
  };
}

export function traceRoundedPolygon(context, points, radius = 0) {
  const segments = roundedPolygonSegments(points, radius);
  if (!segments.length) return;
  context.moveTo(segments[0].entry.x, segments[0].entry.y);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const next = segments[(index + 1) % segments.length];
    context.quadraticCurveTo(
      segment.vertex.x,
      segment.vertex.y,
      segment.exit.x,
      segment.exit.y,
    );
    context.lineTo(next.entry.x, next.entry.y);
  }
  context.closePath();
}

export function parametricShapePathData(node, offsetX = 0, offsetY = 0) {
  const points = getParametricShapePoints(node).map((point) => ({
    x: point.x + offsetX,
    y: point.y + offsetY,
  }));
  const segments = roundedPolygonSegments(points, node?.cornerRadius ?? 0);
  if (!segments.length) return "";
  const commands = [`M ${pathNumber(segments[0].entry.x)} ${pathNumber(segments[0].entry.y)}`];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const next = segments[(index + 1) % segments.length];
    commands.push(
      `Q ${pathNumber(segment.vertex.x)} ${pathNumber(segment.vertex.y)} ` +
      `${pathNumber(segment.exit.x)} ${pathNumber(segment.exit.y)}`,
    );
    commands.push(`L ${pathNumber(next.entry.x)} ${pathNumber(next.entry.y)}`);
  }
  commands.push("Z");
  return commands.join(" ");
}

export function linePathData(node, offsetX = 0, offsetY = 0) {
  const { start, end } = getLineEndpoints(node);
  return `M ${pathNumber(start.x + offsetX)} ${pathNumber(start.y + offsetY)} ` +
    `L ${pathNumber(end.x + offsetX)} ${pathNumber(end.y + offsetY)}`;
}

export function arrowheadPathData(head, offsetX = 0, offsetY = 0) {
  if (!head || head.kind === ARROWHEADS.NONE || head.kind === ARROWHEADS.CIRCLE) return "";
  const [first, ...remaining] = head.points;
  if (!first) return "";
  const commands = [`M ${pathNumber(first.x + offsetX)} ${pathNumber(first.y + offsetY)}`];
  for (const point of remaining) {
    commands.push(`L ${pathNumber(point.x + offsetX)} ${pathNumber(point.y + offsetY)}`);
  }
  if (head.closed) commands.push("Z");
  return commands.join(" ");
}

export function pointInParametricShape(node, localPoint, padding = 0) {
  if (node?.type === "line") {
    const { start, end } = getLineEndpoints(node);
    const tolerance = Math.max(2, (node.strokeWidth ?? 0) / 2) + padding;
    if (distanceToSegment(localPoint, start, end) <= tolerance) return true;
    return Object.values(getLineArrowheads(node)).some((head) => pointInArrowhead(localPoint, head, tolerance));
  }

  const points = getParametricShapePoints(node);
  if (!points.length) return false;
  const contour = flattenRoundedPolygon(points, node?.cornerRadius ?? 0);
  if (pointInPolygon(localPoint, contour)) return true;
  const tolerance = Math.max(0, (node?.strokeWidth ?? 0) / 2 + padding);
  return tolerance > 0 && contour.slice(1).some((point, index) =>
    distanceToSegment(localPoint, contour[index], point) <= tolerance);
}

export function getParametricHandles(node, options = {}) {
  if (node?.type === "line") {
    const { start, end } = getLineEndpoints(node);
    return [
      { kind: "line-start", point: start, cursor: "move" },
      { kind: "line-end", point: end, cursor: "move" },
    ];
  }

  if (!["polygon", "star"].includes(node?.type)) return [];
  const points = getParametricShapePoints(node);
  if (!points.length) return [];
  const handles = [];
  const countKind = node.type === "polygon" ? "polygon-sides" : "star-points";
  handles.push({
    kind: countKind,
    point: { x: node.width * 0.76, y: node.height * 0.5 },
    cursor: "ew-resize",
  });

  const first = points[0];
  const next = points[1];
  const edgeLength = distance(first, next);
  const minimumDisplayDistance = Math.max(0, options.minimumDisplayDistance ?? 0);
  const radiusDistance = clamp(
    Math.max(node.cornerRadius ?? 0, minimumDisplayDistance),
    0,
    edgeLength / 2,
  );
  handles.push({
    kind: "corner-radius",
    point: pointAlong(first, next, edgeLength ? radiusDistance / edgeLength : 0),
    cursor: "move",
  });

  if (node.type === "star") {
    handles.push({
      kind: "star-inner-ratio",
      point: points[1],
      cursor: "move",
    });
  }
  return handles;
}

export function maxParametricCornerRadius(node) {
  const points = getParametricShapePoints(node);
  if (points.length < 3) return 0;
  return Math.min(distance(points[0], points.at(-1)), distance(points[0], points[1])) / 2;
}

export function cornerRadiusFromPoint(node, localPoint) {
  const points = getParametricShapePoints(node);
  if (points.length < 3) return 0;
  const start = points[0];
  const end = points[1];
  const projected = projectPointToSegment(localPoint, start, end);
  return clamp(distance(start, projected), 0, maxParametricCornerRadius(node));
}

export function cornerRadiusFromDrag(node, startPoint, currentPoint) {
  const points = getParametricShapePoints(node);
  if (points.length < 3) return 0;
  const start = points[0];
  const end = points[1];
  const edgeX = end.x - start.x;
  const edgeY = end.y - start.y;
  const edgeLength = Math.hypot(edgeX, edgeY);
  if (edgeLength < 0.001) return 0;
  const dragX = currentPoint.x - startPoint.x;
  const dragY = currentPoint.y - startPoint.y;
  const delta = (dragX * edgeX + dragY * edgeY) / edgeLength;
  return clamp(
    (Number(node?.cornerRadius) || 0) + delta,
    0,
    maxParametricCornerRadius(node),
  );
}

export function starInnerRatioFromPoint(node, localPoint) {
  const halfWidth = Math.max(0.5, node?.width / 2);
  const halfHeight = Math.max(0.5, node?.height / 2);
  const x = (localPoint.x - halfWidth) / halfWidth;
  const y = (localPoint.y - halfHeight) / halfHeight;
  return clamp(Math.hypot(x, y), MIN_STAR_RATIO, MAX_STAR_RATIO);
}

export function lineVisualPadding(node) {
  const { start, end } = getLineEndpoints(node);
  const length = distance(start, end);
  const size = arrowheadSize(length, node?.strokeWidth);
  const hasHead = [node?.arrowStart, node?.arrowEnd]
    .some((kind) => kind && kind !== ARROWHEADS.NONE);
  return Math.max((node?.strokeWidth ?? 0) / 2, hasHead ? size * 0.62 : 0);
}

function regularPoints(width, height, count, radius) {
  const sides = clamp(Math.round(Number(count) || 3), 3, 60);
  const centerX = Math.max(1, width) / 2;
  const centerY = Math.max(1, height) / 2;
  const radiusX = centerX * radius;
  const radiusY = centerY * radius;
  return Array.from({ length: sides }, (_, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / sides;
    return {
      x: centerX + Math.cos(angle) * radiusX,
      y: centerY + Math.sin(angle) * radiusY,
    };
  });
}

function starPoints(width, height, count, innerRatio) {
  const points = clamp(Math.round(Number(count) || 5), 3, 60);
  const ratio = clamp(Number(innerRatio) || 0.4, MIN_STAR_RATIO, MAX_STAR_RATIO);
  const centerX = Math.max(1, width) / 2;
  const centerY = Math.max(1, height) / 2;
  return Array.from({ length: points * 2 }, (_, index) => {
    const radius = index % 2 === 0 ? 1 : ratio;
    const angle = -Math.PI / 2 + (index * Math.PI) / points;
    return {
      x: centerX + Math.cos(angle) * centerX * radius,
      y: centerY + Math.sin(angle) * centerY * radius,
    };
  });
}

function roundedPolygonSegments(points, requestedRadius) {
  if (!Array.isArray(points) || points.length < 3) return [];
  const radius = Math.max(0, Number(requestedRadius) || 0);
  return points.map((vertex, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    const amount = Math.min(radius, distance(vertex, previous) / 2, distance(vertex, next) / 2);
    return {
      vertex,
      entry: pointAlong(vertex, previous, distance(vertex, previous) ? amount / distance(vertex, previous) : 0),
      exit: pointAlong(vertex, next, distance(vertex, next) ? amount / distance(vertex, next) : 0),
    };
  });
}

function flattenRoundedPolygon(points, radius) {
  const segments = roundedPolygonSegments(points, radius);
  if (!segments.length) return [];
  const flattened = [segments[0].entry];
  const curveSteps = 8;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const next = segments[(index + 1) % segments.length];
    for (let step = 1; step <= curveSteps; step += 1) {
      const amount = step / curveSteps;
      const inverse = 1 - amount;
      flattened.push({
        x: inverse * inverse * segment.entry.x +
          2 * inverse * amount * segment.vertex.x + amount * amount * segment.exit.x,
        y: inverse * inverse * segment.entry.y +
          2 * inverse * amount * segment.vertex.y + amount * amount * segment.exit.y,
      });
    }
    flattened.push(next.entry);
  }
  return flattened;
}

function arrowheadGeometry(kind, tip, other, strokeWidth = 1) {
  if (!Object.values(ARROWHEADS).includes(kind) || kind === ARROWHEADS.NONE) return null;
  const deltaX = tip.x - other.x;
  const deltaY = tip.y - other.y;
  const length = Math.hypot(deltaX, deltaY);
  if (length < 0.001) return null;
  const unit = { x: deltaX / length, y: deltaY / length };
  const perpendicular = { x: -unit.y, y: unit.x };
  const size = arrowheadSize(length, strokeWidth);
  const behind = (amount) => ({ x: tip.x - unit.x * amount, y: tip.y - unit.y * amount });
  const offset = (point, amount) => ({
    x: point.x + perpendicular.x * amount,
    y: point.y + perpendicular.y * amount,
  });

  if (kind === ARROWHEADS.CIRCLE) {
    const radius = size * 0.42;
    return { kind, center: behind(radius), radius, closed: true, points: [] };
  }
  if (kind === ARROWHEADS.DIAMOND) {
    const center = behind(size * 0.5);
    return {
      kind,
      closed: true,
      points: [tip, offset(center, size * 0.38), behind(size), offset(center, -size * 0.38)],
    };
  }
  const base = behind(size);
  const first = offset(base, size * 0.52);
  const second = offset(base, -size * 0.52);
  return {
    kind,
    closed: kind === ARROWHEADS.TRIANGLE,
    points: [first, tip, second],
  };
}

function arrowheadSize(length, strokeWidth = 1) {
  return Math.min(length * 0.42, Math.max(8, (Number(strokeWidth) || 1) * 4));
}

function pointInArrowhead(point, head, tolerance) {
  if (!head) return false;
  if (head.kind === ARROWHEADS.CIRCLE) {
    return distance(point, head.center) <= head.radius + tolerance;
  }
  if (head.closed && pointInPolygon(point, head.points)) return true;
  return head.points.slice(1).some((end, index) =>
    distanceToSegment(point, head.points[index], end) <= tolerance) ||
    (head.closed && distanceToSegment(point, head.points.at(-1), head.points[0]) <= tolerance);
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const crosses = (currentPoint.y > point.y) !== (previousPoint.y > point.y) &&
      point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
        (previousPoint.y - currentPoint.y) + currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function projectPointToSegment(point, start, end) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared === 0) return { ...start };
  const ratio = clamp(
    ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared,
    0,
    1,
  );
  return pointAlong(start, end, ratio);
}

function distanceToSegment(point, start, end) {
  return distance(point, projectPointToSegment(point, start, end));
}

function pointAlong(start, end, ratio) {
  return {
    x: start.x + (end.x - start.x) * ratio,
    y: start.y + (end.y - start.y) * ratio,
  };
}

function distance(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function pathNumber(value) {
  return Math.round(value * 1000) / 1000;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
