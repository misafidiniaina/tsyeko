import test from "node:test";
import assert from "node:assert/strict";

import {
  BOOLEAN_OPERATIONS,
  booleanGroupNodes,
  createNode,
  createPage,
  getVectorContours,
  NODE_TYPES,
} from "./model.js";
import { flattenBoolean, offsetClosedPolygon, outlineVectorStroke } from "./geometry.js";

test("destructive Boolean flattening produces an editable compound vector", () => {
  const page = createPage("Flatten");
  const base = createNode(NODE_TYPES.RECTANGLE, 0, 0, { width: 100, height: 80 });
  const cutout = createNode(NODE_TYPES.ELLIPSE, 25, 15, { width: 50, height: 50 });
  page.nodes.push(base, cutout);
  const boolean = booleanGroupNodes(page, [base.id, cutout.id], BOOLEAN_OPERATIONS.SUBTRACT);
  const flattened = flattenBoolean(page, boolean.id, { cellSize: 2 });
  assert.equal(flattened.type, NODE_TYPES.VECTOR);
  assert.equal(flattened.vectorFillRule, "evenodd");
  assert.ok(getVectorContours(flattened).length >= 2);
  assert.equal(page.nodes.some((node) => node.type === NODE_TYPES.BOOLEAN), false);
});

test("stroke outlining converts closed and open vector strokes into fills", () => {
  const page = createPage("Outline");
  const vector = createNode(NODE_TYPES.VECTOR, 10, 10, {
    vectorPoints: [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
      { x: 80, y: 40 },
      { x: 0, y: 40 },
    ],
    vectorClosed: true,
    stroke: "#ff0000",
    strokeWidth: 8,
  });
  page.nodes.push(vector);
  const outline = outlineVectorStroke(page, vector.id);
  assert.equal(outline.strokeWidth, 0);
  assert.equal(outline.fill, "#ff0000");
  assert.equal(getVectorContours(outline).length, 2);
});

test("stroke outlining preserves rotated scene geometry", () => {
  const page = createPage("Rotated outline");
  const vector = createNode(NODE_TYPES.VECTOR, 10, 20, {
    vectorPoints: [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
      { x: 80, y: 40 },
      { x: 0, y: 40 },
    ],
    vectorClosed: true,
    rotation: 90,
    strokeWidth: 8,
  });
  page.nodes.push(vector);
  const outline = outlineVectorStroke(page, vector.id);
  assert.ok(outline.width < outline.height);
  assert.ok(outline.width >= 47 && outline.width <= 49);
  assert.ok(outline.height >= 87 && outline.height <= 89);
  assert.equal(outline.rotation, 0);
});

test("offset geometry remains finite across randomized convex boxes", () => {
  let seed = 123456789;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let index = 0; index < 500; index += 1) {
    const width = 1 + random() * 1_000;
    const height = 1 + random() * 1_000;
    const offset = (random() - 0.5) * Math.min(width, height);
    const output = offsetClosedPolygon([
      { x: 0, y: 0 }, { x: width, y: 0 },
      { x: width, y: height }, { x: 0, y: height },
    ], offset);
    assert.equal(output.length, 4);
    assert.ok(output.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
  }
});

test("geometry kernel survives deterministic polygon, curve, and Boolean fuzz cases", () => {
  let seed = 0x51f15eed;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  for (let sample = 0; sample < 750; sample += 1) {
    const count = 3 + Math.floor(random() * 18);
    const polygon = Array.from({ length: count }, (_, index) => {
      const angle = (index / count) * Math.PI * 2 + (random() - 0.5) * (Math.PI / count);
      const radius = 1 + random() * 500;
      return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    });
    const offset = (random() - 0.5) * 200;
    const output = offsetClosedPolygon(polygon, offset);
    assert.equal(output.length, polygon.length);
    assert.ok(output.every(isFinitePoint));
  }

  for (let sample = 0; sample < 120; sample += 1) {
    const page = createPage("Curve fuzz");
    const vector = createNode(NODE_TYPES.VECTOR, random() * 200 - 100, random() * 200 - 100, {
      vectorPoints: [
        { x: 0, y: 0, out: { x: random() * 120, y: random() * 160 - 80 } },
        { x: 80 + random() * 120, y: random() * 120 - 60, in: { x: random() * 120, y: random() * 160 - 80 } },
        { x: 180 + random() * 100, y: 20 + random() * 120, in: { x: 120 + random() * 100, y: random() * 180 - 90 } },
      ],
      vectorClosed: random() > 0.5,
      rotation: random() * 720 - 360,
      strokeWidth: 0.25 + random() * 80,
    });
    page.nodes.push(vector);
    const outline = outlineVectorStroke(page, vector.id);
    assert.ok(outline);
    assert.ok(getVectorContours(outline).flatMap((contour) => contour.points).every(isFinitePoint));
  }

  for (let sample = 0; sample < 30; sample += 1) {
    for (const operation of Object.values(BOOLEAN_OPERATIONS)) {
      const page = createPage("Boolean fuzz");
      const width = 30 + random() * 90;
      const height = 30 + random() * 90;
      const base = createNode(NODE_TYPES.RECTANGLE, 0, 0, { width, height });
      const overlap = createNode(NODE_TYPES.ELLIPSE, width * 0.2, height * 0.15, {
        width: width * 0.65,
        height: height * 0.7,
      });
      page.nodes.push(base, overlap);
      const boolean = booleanGroupNodes(page, [base.id, overlap.id], operation);
      const flattened = flattenBoolean(page, boolean.id, { cellSize: 3 });
      assert.ok(flattened, `${operation} sample ${sample} should produce geometry`);
      assert.ok(getVectorContours(flattened).flatMap((contour) => contour.points).every(isFinitePoint));
    }
  }
});

function isFinitePoint(point) {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}
