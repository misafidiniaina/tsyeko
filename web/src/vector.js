export const VECTOR_HANDLE_MODES = Object.freeze({
  CORNER: "corner",
  MIRRORED: "mirrored",
  FREE: "free",
});

export function cloneVectorPoint(point) {
  return {
    x: point.x,
    y: point.y,
    in: point.in ? { ...point.in } : null,
    out: point.out ? { ...point.out } : null,
    handleMode: point.handleMode ?? VECTOR_HANDLE_MODES.CORNER,
  };
}

export function getVectorSegments(source, closedOverride) {
  const points = Array.isArray(source) ? source : source?.vectorPoints ?? [];
  const closed = closedOverride ?? (!Array.isArray(source) && source?.vectorClosed === true);
  const segments = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    segments.push(createSegment(points, index, index + 1));
  }
  if (closed && points.length > 2) {
    segments.push(createSegment(points, points.length - 1, 0));
  }
  return segments;
}

export function evaluateCubicBezier(segment, ratio) {
  const t = clamp(ratio, 0, 1);
  const inverse = 1 - t;
  const inverseSquared = inverse * inverse;
  const squared = t * t;
  return {
    x: inverseSquared * inverse * segment.p0.x +
      3 * inverseSquared * t * segment.c1.x +
      3 * inverse * squared * segment.c2.x +
      squared * t * segment.p3.x,
    y: inverseSquared * inverse * segment.p0.y +
      3 * inverseSquared * t * segment.c1.y +
      3 * inverse * squared * segment.c2.y +
      squared * t * segment.p3.y,
  };
}

export function flattenVectorPath(source, closedOverride, curveSteps = 24) {
  const segments = getVectorSegments(source, closedOverride);
  if (!segments.length) {
    const points = Array.isArray(source) ? source : source?.vectorPoints ?? [];
    return points.map(({ x, y }) => ({ x, y }));
  }
  const output = [{ ...segments[0].p0 }];
  for (const segment of segments) {
    if (!segment.curved) {
      output.push({ ...segment.p3 });
      continue;
    }
    for (let step = 1; step <= curveSteps; step += 1) {
      output.push(evaluateCubicBezier(segment, step / curveSteps));
    }
  }
  return output;
}

export function nearestPointOnCubic(segment, target, curveSteps = 32) {
  let previous = { ...segment.p0 };
  let previousT = 0;
  let best = {
    point: previous,
    t: 0,
    distance: pointDistance(previous, target),
  };
  const steps = segment.curved ? curveSteps : 1;
  for (let step = 1; step <= steps; step += 1) {
    const currentT = step / steps;
    const current = evaluateCubicBezier(segment, currentT);
    const projection = projectPointToSegment(target, previous, current);
    const segmentRatio = lineRatio(projection, previous, current);
    const distance = pointDistance(projection, target);
    if (distance < best.distance) {
      best = {
        point: projection,
        t: previousT + (currentT - previousT) * segmentRatio,
        distance,
      };
    }
    previous = current;
    previousT = currentT;
  }
  return best;
}

export function splitVectorSegment(points, startIndex, ratio, closed = false) {
  const endIndex = startIndex === points.length - 1
    ? (closed ? 0 : -1)
    : startIndex + 1;
  if (endIndex < 0 || !points[startIndex] || !points[endIndex]) return null;
  const segment = createSegment(points, startIndex, endIndex);
  const t = clamp(ratio, 0.001, 0.999);
  const q0 = interpolate(segment.p0, segment.c1, t);
  const q1 = interpolate(segment.c1, segment.c2, t);
  const q2 = interpolate(segment.c2, segment.p3, t);
  const r0 = interpolate(q0, q1, t);
  const r1 = interpolate(q1, q2, t);
  const anchor = interpolate(r0, r1, t);
  const insertIndex = startIndex + 1;

  if (segment.curved) {
    points[startIndex].out = q0;
    points[endIndex].in = q2;
    points[startIndex].handleMode = points[startIndex].in || points[startIndex].out
      ? VECTOR_HANDLE_MODES.FREE
      : VECTOR_HANDLE_MODES.CORNER;
    points[endIndex].handleMode = points[endIndex].in || points[endIndex].out
      ? VECTOR_HANDLE_MODES.FREE
      : VECTOR_HANDLE_MODES.CORNER;
    points.splice(insertIndex, 0, {
      ...anchor,
      in: r0,
      out: r1,
      handleMode: VECTOR_HANDLE_MODES.FREE,
    });
  } else {
    points.splice(insertIndex, 0, {
      ...anchor,
      in: null,
      out: null,
      handleMode: VECTOR_HANDLE_MODES.CORNER,
    });
  }
  return insertIndex;
}

export function translateVectorAnchor(point, deltaX, deltaY) {
  point.x += deltaX;
  point.y += deltaY;
  if (point.in) {
    point.in.x += deltaX;
    point.in.y += deltaY;
  }
  if (point.out) {
    point.out.x += deltaX;
    point.out.y += deltaY;
  }
  return point;
}

export function scaleVectorPoint(point, scaleX, scaleY) {
  return {
    x: point.x * scaleX,
    y: point.y * scaleY,
    in: point.in ? { x: point.in.x * scaleX, y: point.in.y * scaleY } : null,
    out: point.out ? { x: point.out.x * scaleX, y: point.out.y * scaleY } : null,
    handleMode: point.handleMode,
  };
}

export function setVectorHandle(point, kind, target, mirrorOpposite = true) {
  if (!point || !["in", "out"].includes(kind)) return point;
  point[kind] = { x: target.x, y: target.y };
  if (mirrorOpposite) {
    const opposite = kind === "in" ? "out" : "in";
    point[opposite] = {
      x: point.x * 2 - target.x,
      y: point.y * 2 - target.y,
    };
    point.handleMode = VECTOR_HANDLE_MODES.MIRRORED;
  } else {
    point.handleMode = VECTOR_HANDLE_MODES.FREE;
  }
  return point;
}

export function clearVectorHandles(point) {
  point.in = null;
  point.out = null;
  point.handleMode = VECTOR_HANDLE_MODES.CORNER;
  return point;
}

export function makeVectorPointSmooth(points, index, closed = false) {
  const point = points[index];
  if (!point) return null;
  const previous = points[index > 0 ? index - 1 : closed ? points.length - 1 : -1];
  const next = points[index < points.length - 1 ? index + 1 : closed ? 0 : -1];
  if (!previous && !next) return point;

  const tangentStart = previous ?? point;
  const tangentEnd = next ?? point;
  let directionX = tangentEnd.x - tangentStart.x;
  let directionY = tangentEnd.y - tangentStart.y;
  let directionLength = Math.hypot(directionX, directionY);
  if (directionLength < 0.0001) {
    directionX = next ? next.x - point.x : point.x - previous.x;
    directionY = next ? next.y - point.y : point.y - previous.y;
    directionLength = Math.max(0.0001, Math.hypot(directionX, directionY));
  }
  directionX /= directionLength;
  directionY /= directionLength;

  const previousDistance = previous ? pointDistance(point, previous) : Infinity;
  const nextDistance = next ? pointDistance(point, next) : Infinity;
  const handleLength = Math.max(1, Math.min(80, Math.min(previousDistance, nextDistance) / 3));
  point.in = previous ? {
    x: point.x - directionX * handleLength,
    y: point.y - directionY * handleLength,
  } : null;
  point.out = next ? {
    x: point.x + directionX * handleLength,
    y: point.y + directionY * handleLength,
  } : null;
  point.handleMode = previous && next
    ? VECTOR_HANDLE_MODES.MIRRORED
    : VECTOR_HANDLE_MODES.FREE;
  return point;
}

export function reverseVectorPoints(points) {
  return [...points].reverse().map((point) => ({
    x: point.x,
    y: point.y,
    in: point.out ? { ...point.out } : null,
    out: point.in ? { ...point.in } : null,
    handleMode: point.handleMode,
  }));
}

export function getVectorControlBounds(points) {
  const controls = points.flatMap((point) => [
    { x: point.x, y: point.y },
    ...(point.in ? [point.in] : []),
    ...(point.out ? [point.out] : []),
  ]);
  if (!controls.length) return null;
  const minX = Math.min(...controls.map((point) => point.x));
  const minY = Math.min(...controls.map((point) => point.y));
  const maxX = Math.max(...controls.map((point) => point.x));
  const maxY = Math.max(...controls.map((point) => point.y));
  return { minX, minY, maxX, maxY };
}

export function countCurvedSegments(source, closedOverride) {
  return getVectorSegments(source, closedOverride).filter((segment) => segment.curved).length;
}

function createSegment(points, startIndex, endIndex) {
  const start = points[startIndex];
  const end = points[endIndex];
  return {
    index: startIndex,
    startIndex,
    endIndex,
    p0: { x: start.x, y: start.y },
    c1: start.out ? { ...start.out } : { x: start.x, y: start.y },
    c2: end.in ? { ...end.in } : { x: end.x, y: end.y },
    p3: { x: end.x, y: end.y },
    curved: Boolean(start.out || end.in),
  };
}

function interpolate(start, end, ratio) {
  return {
    x: start.x + (end.x - start.x) * ratio,
    y: start.y + (end.y - start.y) * ratio,
  };
}

function projectPointToSegment(point, start, end) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared <= Number.EPSILON) return { ...start };
  const ratio = clamp(
    ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared,
    0,
    1,
  );
  return {
    x: start.x + deltaX * ratio,
    y: start.y + deltaY * ratio,
  };
}

function lineRatio(point, start, end) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared <= Number.EPSILON) return 0;
  return clamp(
    ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared,
    0,
    1,
  );
}

function pointDistance(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
