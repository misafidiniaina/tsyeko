import test from "node:test";
import assert from "node:assert/strict";

import {
  clearVectorHandles,
  evaluateCubicBezier,
  getVectorSegments,
  makeVectorPointSmooth,
  reverseVectorPoints,
  scaleVectorPoint,
  setVectorHandle,
  splitVectorSegment,
  translateVectorAnchor,
  VECTOR_HANDLE_MODES,
} from "./vector.js";

test("curve-preserving split reproduces the original cubic", () => {
  const points = [
    {
      x: 0,
      y: 20,
      in: null,
      out: { x: 25, y: -35 },
      handleMode: VECTOR_HANDLE_MODES.FREE,
    },
    {
      x: 120,
      y: 40,
      in: { x: 75, y: 105 },
      out: null,
      handleMode: VECTOR_HANDLE_MODES.FREE,
    },
  ];
  const original = getVectorSegments(points, false)[0];
  const splitAt = 0.37;
  const insertedIndex = splitVectorSegment(points, 0, splitAt, false);
  const [first, second] = getVectorSegments(points, false);

  assert.equal(insertedIndex, 1);
  assert.equal(points.length, 3);
  assert.equal(points[0].handleMode, VECTOR_HANDLE_MODES.FREE);
  assert.equal(points[1].handleMode, VECTOR_HANDLE_MODES.FREE);
  assert.equal(points[2].handleMode, VECTOR_HANDLE_MODES.FREE);
  for (let step = 0; step <= 20; step += 1) {
    const originalRatio = step / 20;
    const expected = evaluateCubicBezier(original, originalRatio);
    const actual = originalRatio <= splitAt
      ? evaluateCubicBezier(first, originalRatio / splitAt)
      : evaluateCubicBezier(second, (originalRatio - splitAt) / (1 - splitAt));
    assert.ok(Math.abs(actual.x - expected.x) < 1e-8);
    assert.ok(Math.abs(actual.y - expected.y) < 1e-8);
  }
});

test("reversing a path swaps incoming and outgoing controls", () => {
  const points = [
    { x: 0, y: 0, in: null, out: { x: 20, y: 30 }, handleMode: "free" },
    { x: 100, y: 10, in: { x: 80, y: 45 }, out: null, handleMode: "free" },
  ];
  const original = getVectorSegments(points, false)[0];
  const reversedPoints = reverseVectorPoints(points);
  const reversed = getVectorSegments(reversedPoints, false)[0];

  assert.deepEqual(reversedPoints[0].out, points[1].in);
  assert.deepEqual(reversedPoints[1].in, points[0].out);
  for (let step = 0; step <= 10; step += 1) {
    const ratio = step / 10;
    const forwardPoint = evaluateCubicBezier(original, ratio);
    const reversedPoint = evaluateCubicBezier(reversed, 1 - ratio);
    assert.ok(Math.abs(forwardPoint.x - reversedPoint.x) < 1e-9);
    assert.ok(Math.abs(forwardPoint.y - reversedPoint.y) < 1e-9);
  }
});

test("smooth, mirrored, disconnected, and corner handle states are deterministic", () => {
  const points = [
    { x: 0, y: 0, in: null, out: null, handleMode: "corner" },
    { x: 60, y: 40, in: null, out: null, handleMode: "corner" },
    { x: 140, y: 10, in: null, out: null, handleMode: "corner" },
  ];
  const point = makeVectorPointSmooth(points, 1, false);

  assert.equal(point.handleMode, VECTOR_HANDLE_MODES.MIRRORED);
  assert.ok(point.in && point.out);
  setVectorHandle(point, "out", { x: 110, y: 70 }, false);
  assert.equal(point.handleMode, VECTOR_HANDLE_MODES.FREE);
  assert.deepEqual(point.out, { x: 110, y: 70 });
  clearVectorHandles(point);
  assert.equal(point.handleMode, VECTOR_HANDLE_MODES.CORNER);
  assert.equal(point.in, null);
  assert.equal(point.out, null);
});

test("anchor translation and non-uniform scaling include both controls", () => {
  const point = {
    x: 20,
    y: 30,
    in: { x: 10, y: 5 },
    out: { x: 45, y: 55 },
    handleMode: VECTOR_HANDLE_MODES.FREE,
  };
  translateVectorAnchor(point, 8, -3);
  assert.deepEqual(point, {
    x: 28,
    y: 27,
    in: { x: 18, y: 2 },
    out: { x: 53, y: 52 },
    handleMode: VECTOR_HANDLE_MODES.FREE,
  });

  assert.deepEqual(scaleVectorPoint(point, 2, 0.5), {
    x: 56,
    y: 13.5,
    in: { x: 36, y: 1 },
    out: { x: 106, y: 26 },
    handleMode: VECTOR_HANDLE_MODES.FREE,
  });
});
