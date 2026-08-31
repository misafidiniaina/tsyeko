import {
  createNode,
  getNode,
  getNodesWithDescendants,
  getVectorContours,
  localToWorld,
  NODE_TYPES,
} from "./model.js";
import { pointInSceneNode } from "./renderer.js";
import { flattenVectorPath, VECTOR_HANDLE_MODES } from "./vector.js";

const MAX_RASTER_AXIS = 512;

export function flattenBoolean(document, nodeID, options = {}) {
  const source = getNode(document, nodeID);
  if (source?.type !== NODE_TYPES.BOOLEAN) return null;
  const maximumDimension = Math.max(source.width, source.height);
  const requestedCell = Number.isFinite(options.cellSize)
    ? Math.max(0.1, options.cellSize)
    : Math.max(0.5, maximumDimension / 384);
  const columns = Math.max(1, Math.min(MAX_RASTER_AXIS, Math.ceil(source.width / requestedCell)));
  const rows = Math.max(1, Math.min(MAX_RASTER_AXIS, Math.ceil(source.height / requestedCell)));
  const cellWidth = source.width / columns;
  const cellHeight = source.height / rows;
  const occupancy = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => pointInSceneNode(document, source, {
      x: source.x + (column + 0.5) * cellWidth,
      y: source.y + (row + 0.5) * cellHeight,
    })));
  const loops = traceOccupancy(occupancy)
    .map(simplifyOrthogonalLoop)
    .filter((loop) => loop.length >= 4)
    .map((loop) => loop.map((point) => ({
      x: source.x + point.x * cellWidth,
      y: source.y + point.y * cellHeight,
    })));
  if (!loops.length) return null;
  return replaceWithContours(document, source, loops, {
    name: `${source.name} flattened`,
    fills: source.fills,
    strokes: source.strokes,
    effects: source.effects,
    fill: source.fill,
    fillType: source.fillType,
    gradient: source.gradient,
    stroke: source.stroke,
    strokeWidth: source.strokeWidth,
    vectorFillRule: "evenodd",
  });
}

export function outlineVectorStroke(document, nodeID) {
  const source = getNode(document, nodeID);
  if (source?.type !== NODE_TYPES.VECTOR || source.strokeWidth <= 0) return null;
  const distance = source.strokeWidth / 2;
  const worldLoops = [];
  for (const contour of getVectorContours(source)) {
    const curveSteps = outlineCurveSteps(source, distance);
    const points = flattenVectorPath(contour.points, contour.closed, curveSteps)
      .map((point) => localToWorld(source, point));
    if (points.length < 2) continue;
    if (contour.closed) {
      const outer = offsetClosedPolygon(points, distance);
      const inner = offsetClosedPolygon(points, -distance).reverse();
      if (outer.length >= 3) worldLoops.push(outer);
      if (inner.length >= 3) worldLoops.push(inner);
    } else {
      const outline = outlineOpenPolyline(points, distance);
      if (outline.length >= 3) worldLoops.push(outline);
    }
  }
  if (!worldLoops.length) return null;
  const strokeFills = (source.strokes ?? []).map((paint) => ({ ...paint }));
  return replaceWithContours(document, source, worldLoops, {
    name: `${source.name} outline`,
    fills: strokeFills,
    fill: source.stroke,
    fillType: strokeFills[0]?.type ?? "solid",
    gradient: strokeFills[0]?.gradient,
    strokes: [{ type: "solid", color: "transparent", opacity: 1, visible: true }],
    stroke: "transparent",
    strokeWidth: 0,
    effects: source.effects,
    vectorFillRule: "evenodd",
  });
}

export function offsetClosedPolygon(points, distance) {
  const source = removeDuplicateClosure(points);
  if (source.length < 3) return [];
  const orientation = signedArea(source) >= 0 ? 1 : -1;
  return source.map((point, index) => {
    const previous = source[(index - 1 + source.length) % source.length];
    const next = source[(index + 1) % source.length];
    const firstNormal = outwardNormal(previous, point, orientation);
    const secondNormal = outwardNormal(point, next, orientation);
    const sum = { x: firstNormal.x + secondNormal.x, y: firstNormal.y + secondNormal.y };
    const length = Math.max(0.000001, Math.hypot(sum.x, sum.y));
    const bisector = { x: sum.x / length, y: sum.y / length };
    const denominator = Math.max(0.25, Math.abs(bisector.x * secondNormal.x + bisector.y * secondNormal.y));
    const miter = Math.min(Math.abs(distance) * 4, Math.abs(distance) / denominator) * Math.sign(distance);
    return { x: point.x + bisector.x * miter, y: point.y + bisector.y * miter };
  });
}

function outlineOpenPolyline(points, distance) {
  const left = [];
  const right = [];
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const deltaX = next.x - previous.x;
    const deltaY = next.y - previous.y;
    const length = Math.max(0.000001, Math.hypot(deltaX, deltaY));
    const normal = { x: -deltaY / length, y: deltaX / length };
    left.push({ x: points[index].x + normal.x * distance, y: points[index].y + normal.y * distance });
    right.push({ x: points[index].x - normal.x * distance, y: points[index].y - normal.y * distance });
  }
  return [...left, ...right.reverse()];
}

function replaceWithContours(document, source, worldLoops, overrides) {
  let minX = Infinity;
  let minY = Infinity;
  for (const loop of worldLoops) {
    for (const point of loop) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
    }
  }
  const localContours = worldLoops.map((loop, index) => ({
    id: `contour_${source.id}_${index}`,
    closed: true,
    points: loop.map((point) => ({
      x: point.x - minX,
      y: point.y - minY,
      in: null,
      out: null,
      handleMode: VECTOR_HANDLE_MODES.CORNER,
    })),
  }));
  const replacement = createNode(NODE_TYPES.VECTOR, minX, minY, {
    ...overrides,
    parentId: source.parentId,
    opacity: source.opacity,
    visible: source.visible,
    locked: source.locked,
    vectorPoints: localContours[0].points,
    vectorClosed: true,
    vectorContours: localContours,
  });
  const removed = new Set(getNodesWithDescendants(document, [source.id]).map((node) => node.id));
  const index = document.nodes.findIndex((node) => node.id === source.id);
  const remaining = document.nodes.filter((node) => !removed.has(node.id));
  remaining.splice(Math.max(0, Math.min(index, remaining.length)), 0, replacement);
  document.nodes = remaining;
  return replacement;
}

function traceOccupancy(occupancy) {
  const rows = occupancy.length;
  const columns = occupancy[0]?.length ?? 0;
  const edges = new Map();
  const add = (startX, startY, endX, endY) => {
    const key = `${startX},${startY}`;
    if (!edges.has(key)) edges.set(key, []);
    edges.get(key).push({ x: endX, y: endY });
  };
  const occupied = (column, row) => row >= 0 && row < rows && column >= 0 && column < columns && occupancy[row][column];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (!occupancy[row][column]) continue;
      if (!occupied(column, row - 1)) add(column, row, column + 1, row);
      if (!occupied(column + 1, row)) add(column + 1, row, column + 1, row + 1);
      if (!occupied(column, row + 1)) add(column + 1, row + 1, column, row + 1);
      if (!occupied(column - 1, row)) add(column, row + 1, column, row);
    }
  }
  const loops = [];
  while (edges.size) {
    const [startKey] = edges.keys();
    const [startX, startY] = startKey.split(",").map(Number);
    const loop = [{ x: startX, y: startY }];
    let key = startKey;
    let guard = 0;
    do {
      const candidates = edges.get(key);
      if (!candidates?.length) break;
      const next = candidates.pop();
      if (!candidates.length) edges.delete(key);
      loop.push(next);
      key = `${next.x},${next.y}`;
      guard += 1;
    } while (key !== startKey && guard <= rows * columns * 4);
    if (key === startKey) loops.push(loop);
  }
  return loops;
}

function simplifyOrthogonalLoop(loop) {
  const source = removeDuplicateClosure(loop);
  return source.filter((point, index) => {
    const previous = source[(index - 1 + source.length) % source.length];
    const next = source[(index + 1) % source.length];
    return (point.x - previous.x) * (next.y - point.y) !==
      (point.y - previous.y) * (next.x - point.x);
  });
}

function removeDuplicateClosure(points) {
  if (points.length > 1 && points[0].x === points.at(-1).x && points[0].y === points.at(-1).y) {
    return points.slice(0, -1);
  }
  return [...points];
}

function outwardNormal(start, end, orientation) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const length = Math.max(0.000001, Math.hypot(deltaX, deltaY));
  return orientation > 0
    ? { x: deltaY / length, y: -deltaX / length }
    : { x: -deltaY / length, y: deltaX / length };
}

function signedArea(points) {
  return points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length];
    return area + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

function outlineCurveSteps(node, distance) {
  const extent = Math.max(1, node.width, node.height, distance * 2);
  return Math.max(32, Math.min(128, Math.ceil(Math.sqrt(extent) * 8)));
}
