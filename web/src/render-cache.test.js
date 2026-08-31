import test from "node:test";
import assert from "node:assert/strict";

import {
  BoundsSurfaceCache,
  renderBranchSignature,
  summarizeFrameProfiles,
} from "./render-cache.js";
import {
  BOOLEAN_OPERATIONS,
  booleanGroupNodes,
  createNode,
  createPage,
  NODE_TYPES,
} from "./model.js";
import { CanvasRenderer } from "./renderer.js";

test("bounds surface cache enforces LRU entry and byte quotas", () => {
  const cache = new BoundsSurfaceCache({ maxEntries: 2, maxBytes: 400 });
  cache.set("first", { width: 5, height: 5 });
  cache.set("second", { width: 5, height: 5 });
  assert.ok(cache.get("first"));
  cache.set("third", { width: 5, height: 5 });
  assert.equal(cache.get("second"), null);
  assert.ok(cache.get("first"));
  assert.ok(cache.get("third"));
  assert.deepEqual(cache.stats, { entries: 2, bytes: 200 });
});

test("render signatures ignore timestamps but include content changes", () => {
  const original = [{ id: "node", fill: "#fff", updatedAt: "one" }];
  assert.equal(
    renderBranchSignature(original),
    renderBranchSignature([{ ...original[0], updatedAt: "two" }]),
  );
  assert.notEqual(
    renderBranchSignature(original),
    renderBranchSignature([{ ...original[0], fill: "#000" }]),
  );
});

test("frame profiles report deterministic average and p95 durations", () => {
  const summary = summarizeFrameProfiles([
    { frameMs: 5 }, { frameMs: 10 }, { frameMs: 20 }, { frameMs: 40 },
  ]);
  assert.equal(summary.samples, 4);
  assert.equal(summary.averageFrameMs, 18.75);
  assert.equal(summary.p95FrameMs, 40);
  assert.equal(summary.maximumFrameMs, 40);
});

test("dirty planning skips stable frames and invalidates composite ancestors", () => {
  const renderer = new CanvasRenderer({ getContext: () => ({}) });
  renderer.width = 800;
  renderer.height = 600;
  renderer.pixelRatio = 1;
  const page = createPage("Dirty regions");
  const first = createNode(NODE_TYPES.RECTANGLE, 40, 40, { width: 120, height: 90 });
  const second = createNode(NODE_TYPES.ELLIPSE, 80, 60, { width: 90, height: 90 });
  page.nodes.push(first, second);
  const composite = booleanGroupNodes(page, [first.id, second.id], BOOLEAN_OPERATIONS.UNION);
  const camera = { x: 0, y: 0, zoom: 1 };
  const options = {};
  const initial = renderer.captureRenderState(page, [], camera, options);
  renderer.previousRenderState = initial;
  renderer.sceneInvalidated = false;
  assert.deepEqual(renderer.createDirtyPlan(initial), { full: false, skip: true, regions: [] });

  const previousCompositeSignature = initial.nodes.get(composite.id).signature;
  first.x += 15;
  const changed = renderer.captureRenderState(page, [], camera, options);
  assert.notEqual(changed.nodes.get(composite.id).signature, previousCompositeSignature);
  const dirty = renderer.createDirtyPlan(changed);
  assert.equal(dirty.full, false);
  assert.equal(dirty.skip, false);
  assert.ok(dirty.regions.length >= 1);

  renderer.previousRenderState = changed;
  const movedCamera = renderer.captureRenderState(page, [], { ...camera, x: 10 }, options);
  assert.equal(renderer.createDirtyPlan(movedCamera).full, true);
});
