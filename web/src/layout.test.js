import test from "node:test";
import assert from "node:assert/strict";

import {
  createEmptyDocument,
  createNode,
  getChildNodes,
  HORIZONTAL_CONSTRAINTS,
  LAYOUT_MODES,
  LAYOUT_POSITIONING,
  LAYOUT_SIZING,
  NODE_TYPES,
  normalizeDocument,
  PRIMARY_AXIS_ALIGNS,
  COUNTER_AXIS_ALIGNS,
  VERTICAL_CONSTRAINTS,
} from "./model.js";
import {
  createAutoLayoutFrame,
  reorderAutoLayoutChild,
  resizeFrameChildren,
  resolvePageLayout,
} from "./layout.js";
import { documentToSVG } from "./export.js";

function pageWith(...nodes) {
  const page = createEmptyDocument().pages[0];
  page.nodes = nodes;
  return page;
}

test("v8 migration adds safe responsive layout defaults", () => {
  const document = normalizeDocument({
    version: 7,
    name: "Legacy layout",
    pages: [{
      name: "Page",
      nodes: [
        { id: "frame", type: "frame", layoutMode: "diagonal", layoutGap: -20 },
        { id: "child", type: "rectangle", parentId: "frame", constraintHorizontal: "invalid" },
      ],
    }],
  });
  const [frame, child] = document.pages[0].nodes;

  assert.equal(document.version, 8);
  assert.equal(frame.layoutMode, LAYOUT_MODES.NONE);
  assert.equal(frame.layoutGap, 0);
  assert.equal(frame.paddingLeft, 16);
  assert.equal(child.layoutSizingHorizontal, LAYOUT_SIZING.FIXED);
  assert.equal(child.layoutPositioning, LAYOUT_POSITIONING.AUTO);
  assert.equal(child.constraintHorizontal, HORIZONTAL_CONSTRAINTS.LEFT);
  assert.equal(child.constraintVertical, VERTICAL_CONSTRAINTS.TOP);
});

test("horizontal Auto Layout distributes fill children and aligns the counter axis", () => {
  const frame = createNode(NODE_TYPES.FRAME, 10, 20, {
    width: 400,
    height: 100,
    layoutMode: LAYOUT_MODES.HORIZONTAL,
    layoutGap: 10,
    paddingTop: 10,
    paddingRight: 10,
    paddingBottom: 10,
    paddingLeft: 10,
    counterAxisAlign: COUNTER_AXIS_ALIGNS.CENTER,
  });
  const fixed = createNode(NODE_TYPES.RECTANGLE, 0, 0, {
    parentId: frame.id,
    width: 50,
    height: 20,
  });
  const fill = createNode(NODE_TYPES.RECTANGLE, 0, 0, {
    parentId: frame.id,
    width: 20,
    height: 20,
    layoutSizingHorizontal: LAYOUT_SIZING.FILL,
  });
  const page = pageWith(frame, fixed, fill);

  resolvePageLayout(page);

  assert.equal(fixed.x, 20);
  assert.equal(fixed.y, 60);
  assert.equal(fill.x, 80);
  assert.equal(fill.y, 60);
  assert.equal(fill.width, 320);
});

test("nested hug frames resolve from the inside out and move descendants together", () => {
  const outer = createNode(NODE_TYPES.FRAME, 100, 50, {
    layoutMode: LAYOUT_MODES.VERTICAL,
    layoutGap: 8,
    paddingTop: 12,
    paddingRight: 12,
    paddingBottom: 12,
    paddingLeft: 12,
    layoutSizingHorizontal: LAYOUT_SIZING.HUG,
    layoutSizingVertical: LAYOUT_SIZING.HUG,
  });
  const inner = createNode(NODE_TYPES.FRAME, -100, -100, {
    parentId: outer.id,
    layoutMode: LAYOUT_MODES.HORIZONTAL,
    layoutGap: 6,
    paddingTop: 5,
    paddingRight: 5,
    paddingBottom: 5,
    paddingLeft: 5,
    layoutSizingHorizontal: LAYOUT_SIZING.HUG,
    layoutSizingVertical: LAYOUT_SIZING.HUG,
  });
  const first = createNode(NODE_TYPES.RECTANGLE, 0, 0, {
    parentId: inner.id,
    width: 30,
    height: 20,
  });
  const second = createNode(NODE_TYPES.RECTANGLE, 0, 0, {
    parentId: inner.id,
    width: 40,
    height: 25,
  });
  const page = pageWith(outer, inner, first, second);

  resolvePageLayout(page);

  assert.equal(inner.width, 86);
  assert.equal(inner.height, 35);
  assert.equal(outer.width, 110);
  assert.equal(outer.height, 59);
  assert.equal(inner.x, 112);
  assert.equal(inner.y, 62);
  assert.equal(first.x, 117);
  assert.equal(first.y, 67);
  assert.equal(second.x, 153);
  assert.equal(second.y, 67);
});

test("space-between and stretch produce deterministic responsive geometry", () => {
  const frame = createNode(NODE_TYPES.FRAME, 0, 0, {
    width: 300,
    height: 80,
    layoutMode: LAYOUT_MODES.HORIZONTAL,
    paddingTop: 10,
    paddingRight: 10,
    paddingBottom: 10,
    paddingLeft: 10,
    primaryAxisAlign: PRIMARY_AXIS_ALIGNS.SPACE_BETWEEN,
    counterAxisAlign: COUNTER_AXIS_ALIGNS.STRETCH,
  });
  const first = createNode(NODE_TYPES.RECTANGLE, 0, 0, {
    parentId: frame.id,
    width: 40,
    height: 12,
  });
  const second = createNode(NODE_TYPES.RECTANGLE, 0, 0, {
    parentId: frame.id,
    width: 60,
    height: 12,
  });
  const page = pageWith(frame, first, second);

  resolvePageLayout(page);

  assert.deepEqual(
    [first.x, first.y, first.height, second.x, second.y, second.height],
    [10, 10, 60, 230, 10, 60],
  );
});

test("frame constraints preserve edge distances and stretch pinned children", () => {
  const frame = createNode(NODE_TYPES.FRAME, 20, 30, { width: 200, height: 120 });
  const edge = createNode(NODE_TYPES.RECTANGLE, 170, 120, {
    parentId: frame.id,
    width: 30,
    height: 20,
    constraintHorizontal: HORIZONTAL_CONSTRAINTS.RIGHT,
    constraintVertical: VERTICAL_CONSTRAINTS.BOTTOM,
  });
  const stretch = createNode(NODE_TYPES.RECTANGLE, 40, 50, {
    parentId: frame.id,
    width: 160,
    height: 80,
    constraintHorizontal: HORIZONTAL_CONSTRAINTS.LEFT_RIGHT,
    constraintVertical: VERTICAL_CONSTRAINTS.TOP_BOTTOM,
  });
  const page = pageWith(frame, edge, stretch);
  const snapshots = page.nodes.map((node) => structuredClone(node));
  const originalFrame = structuredClone(frame);
  frame.x = 10;
  frame.y = 15;
  frame.width = 300;
  frame.height = 200;

  resizeFrameChildren(page, originalFrame, frame, snapshots);

  assert.deepEqual(
    [edge.x, edge.y, edge.width, edge.height],
    [260, 185, 30, 20],
  );
  assert.deepEqual(
    [stretch.x, stretch.y, stretch.width, stretch.height],
    [30, 35, 260, 160],
  );
});

test("center and scale constraints respond from the original frame geometry", () => {
  const frame = createNode(NODE_TYPES.FRAME, 0, 0, { width: 200, height: 100 });
  const centered = createNode(NODE_TYPES.RECTANGLE, 75, 10, {
    parentId: frame.id,
    width: 50,
    height: 20,
    constraintHorizontal: HORIZONTAL_CONSTRAINTS.CENTER,
  });
  const scaled = createNode(NODE_TYPES.RECTANGLE, 20, 10, {
    parentId: frame.id,
    width: 40,
    height: 20,
    constraintHorizontal: HORIZONTAL_CONSTRAINTS.SCALE,
    constraintVertical: VERTICAL_CONSTRAINTS.SCALE,
  });
  const page = pageWith(frame, centered, scaled);
  const snapshots = page.nodes.map((node) => structuredClone(node));
  const originalFrame = structuredClone(frame);
  Object.assign(frame, { x: 10, y: 20, width: 400, height: 200 });

  resizeFrameChildren(page, originalFrame, frame, snapshots);

  assert.equal(centered.x, 185);
  assert.deepEqual(
    [scaled.x, scaled.y, scaled.width, scaled.height],
    [50, 40, 80, 40],
  );
});

test("wrapping a spatial selection creates a hug frame in visual order", () => {
  const right = createNode(NODE_TYPES.RECTANGLE, 130, 20, { width: 50, height: 30, name: "Right" });
  const left = createNode(NODE_TYPES.RECTANGLE, 20, 30, { width: 40, height: 20, name: "Left" });
  const page = pageWith(right, left);

  const frame = createAutoLayoutFrame(page, [right.id, left.id], LAYOUT_MODES.HORIZONTAL);
  const children = getChildNodes(page, frame.id);

  assert.ok(frame);
  assert.equal(frame.layoutSizingHorizontal, LAYOUT_SIZING.HUG);
  assert.deepEqual(children.map((node) => node.name), ["Left", "Right"]);
  assert.equal(frame.x, 4);
  assert.equal(frame.y, 4);
  assert.equal(frame.width, 192);
  assert.equal(frame.height, 62);
  assert.equal(left.x, 20);
  assert.equal(right.x, 130);
});

test("drag-order evaluation reorders flow siblings before layout resolves", () => {
  const frame = createNode(NODE_TYPES.FRAME, 0, 0, {
    width: 220,
    height: 60,
    layoutMode: LAYOUT_MODES.HORIZONTAL,
    layoutGap: 10,
    paddingTop: 10,
    paddingRight: 10,
    paddingBottom: 10,
    paddingLeft: 10,
  });
  const first = createNode(NODE_TYPES.RECTANGLE, 0, 0, { parentId: frame.id, width: 40, height: 40, name: "First" });
  const second = createNode(NODE_TYPES.RECTANGLE, 0, 0, { parentId: frame.id, width: 40, height: 40, name: "Second" });
  const third = createNode(NODE_TYPES.RECTANGLE, 0, 0, { parentId: frame.id, width: 40, height: 40, name: "Third" });
  const page = pageWith(frame, first, second, third);
  resolvePageLayout(page);
  first.x = 180;

  assert.equal(reorderAutoLayoutChild(page, first.id), true);
  resolvePageLayout(page);

  assert.deepEqual(getChildNodes(page, frame.id).map((node) => node.name), ["Second", "Third", "First"]);
  assert.equal(first.x, 110);
});

test("SVG export uses the same resolved Auto Layout geometry as the canvas model", () => {
  const frame = createNode(NODE_TYPES.FRAME, 0, 0, {
    width: 200,
    height: 80,
    layoutMode: LAYOUT_MODES.HORIZONTAL,
    paddingTop: 10,
    paddingRight: 10,
    paddingBottom: 10,
    paddingLeft: 10,
  });
  const child = createNode(NODE_TYPES.RECTANGLE, 99, 99, {
    parentId: frame.id,
    width: 40,
    height: 20,
  });
  const page = pageWith(frame, child);

  resolvePageLayout(page);
  const svg = documentToSVG(page);

  assert.equal(child.x, 10);
  assert.equal(child.y, 10);
  assert.match(svg, /<rect x="10" y="10" width="40" height="20"/);
});
