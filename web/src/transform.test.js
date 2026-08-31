import test from "node:test";
import assert from "node:assert/strict";

import {
  combineTransformBounds,
  resizeTransformBounds,
  resizeTransformBoundsToDimension,
  rotateGeometryAroundPoint,
  rotationDelta,
  scaleGeometryInBounds,
} from "./transform.js";

test("combines disjoint transform bounds", () => {
  assert.deepEqual(combineTransformBounds([
    { x: 20, y: 40, width: 30, height: 20 },
    { x: -10, y: 10, width: 15, height: 80 },
  ]), { x: -10, y: 10, width: 60, height: 80 });
  assert.equal(combineTransformBounds([]), null);
});

test("resizes a selection from a corner while keeping the opposite corner fixed", () => {
  const source = { x: 10, y: 20, width: 100, height: 50 };
  assert.deepEqual(
    resizeTransformBounds(source, "se", { x: 160, y: 120 }),
    { x: 10, y: 20, width: 150, height: 100 },
  );
  assert.deepEqual(
    resizeTransformBounds(source, "nw", { x: 109.8, y: 69.8 }),
    { x: 109, y: 69, width: 1, height: 1 },
  );
});

test("Alt resize keeps the selection center stationary", () => {
  const source = { x: 10, y: 20, width: 100, height: 50 };
  assert.deepEqual(
    resizeTransformBounds(source, "se", { x: 160, y: 120 }, { centered: true }),
    { x: -40, y: -30, width: 200, height: 150 },
  );
});

test("Shift corner resize preserves the original aspect ratio", () => {
  const source = { x: 0, y: 0, width: 100, height: 50 };
  assert.deepEqual(
    resizeTransformBounds(source, "se", { x: 120, y: 90 }, { preserveAspectRatio: true }),
    { x: 0, y: 0, width: 180, height: 90 },
  );
});

test("sets an exact transform dimension with an optional locked aspect ratio", () => {
  const source = { x: 10, y: 20, width: 120, height: 80 };
  assert.deepEqual(
    resizeTransformBoundsToDimension(source, "width", 240, { preserveAspectRatio: true }),
    { x: 10, y: 20, width: 240, height: 160 },
  );
  assert.deepEqual(
    resizeTransformBoundsToDimension(source, "height", 0),
    { x: 10, y: 20, width: 120, height: 1 },
  );
  assert.throws(
    () => resizeTransformBoundsToDimension(source, "depth", 10),
    /Unsupported transform dimension/,
  );
});

test("scales node centers, dimensions, and spacing inside selection bounds", () => {
  const sourceBounds = { x: 0, y: 0, width: 200, height: 100 };
  const targetBounds = { x: 20, y: 30, width: 400, height: 50 };
  const geometry = { x: 40, y: 20, width: 40, height: 30, rotation: 25 };

  assert.deepEqual(scaleGeometryInBounds(geometry, sourceBounds, targetBounds), {
    x: 100,
    y: 40,
    width: 80,
    height: 15,
    rotation: 25,
  });
});

test("rotates node centers and rotations around a shared pivot", () => {
  const geometry = { x: 20, y: 40, width: 20, height: 10, rotation: -15 };
  const rotated = rotateGeometryAroundPoint(geometry, { x: 10, y: 45 }, 90);

  assert.ok(Math.abs(rotated.x - 0) < 0.0001);
  assert.ok(Math.abs(rotated.y - 60) < 0.0001);
  assert.equal(rotated.width, 20);
  assert.equal(rotated.height, 10);
  assert.equal(rotated.rotation, 75);
});

test("rotation deltas cross the angle boundary and snap to 15 degrees", () => {
  const center = { x: 0, y: 0 };
  const point = (degrees) => ({
    x: Math.cos((degrees * Math.PI) / 180) * 100,
    y: Math.sin((degrees * Math.PI) / 180) * 100,
  });

  assert.equal(rotationDelta(center, point(170), point(-170)), 20);
  assert.equal(rotationDelta(center, point(0), point(22), 15), 15);
});
