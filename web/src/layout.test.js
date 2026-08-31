import test from "node:test";
import assert from "node:assert/strict";

import {
  createEmptyDocument,
  createNode,
  duplicateNodes,
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
  isAutoLayoutChild,
  reorderAutoLayoutChild,
  resizeFrameChildren,
  resolvePageLayout,
} from "./layout.js";
import { documentToSVG } from "./export.js";
import { intrinsicTextSize } from "./text.js";

function pageWith(...nodes) {
  const page = createEmptyDocument().pages[0];
  page.nodes = nodes;
  return page;
}

test("v12 migration preserves safe responsive layout defaults", () => {
  const document = normalizeDocument({
    version: 7,
    name: "Legacy layout",
    pages: [{
      name: "Page",
      nodes: [
        { id: "frame", type: "frame", layoutMode: "diagonal", layoutGap: -20 },
        { id: "child", type: "rectangle", parentId: "frame", constraintHorizontal: "invalid" },
        { id: "rotated", type: "frame", layoutMode: "horizontal", rotation: 45 },
      ],
    }],
  });
  const [frame, child, rotated] = document.pages[0].nodes;

  assert.equal(document.version, 12);
  assert.equal(frame.layoutMode, LAYOUT_MODES.NONE);
  assert.equal(frame.layoutGap, 0);
  assert.equal(frame.paddingLeft, 16);
  assert.equal(child.layoutSizingHorizontal, LAYOUT_SIZING.FIXED);
  assert.equal(child.layoutPositioning, LAYOUT_POSITIONING.AUTO);
  assert.equal(child.constraintHorizontal, HORIZONTAL_CONSTRAINTS.LEFT);
  assert.equal(child.constraintVertical, VERTICAL_CONSTRAINTS.TOP);
  assert.equal(rotated.rotation, 0);
  assert.equal(frame.layoutWrap, false);
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

test("min and max dimensions constrain hug and fill layout", () => {
  const frame = createNode(NODE_TYPES.FRAME, 0, 0, {
    width: 300,
    height: 100,
    layoutMode: LAYOUT_MODES.HORIZONTAL,
    layoutSizingHorizontal: LAYOUT_SIZING.HUG,
  });
  const child = createNode(NODE_TYPES.RECTANGLE, 0, 0, {
    parentId: frame.id,
    width: 20,
    height: 20,
    minWidth: 80,
    maxWidth: 100,
  });
  const page = pageWith(frame, child);

  resolvePageLayout(page);
  assert.equal(child.width, 80);
  assert.equal(frame.width, 112);

  frame.layoutSizingHorizontal = LAYOUT_SIZING.FIXED;
  frame.width = 300;
  child.layoutSizingHorizontal = LAYOUT_SIZING.FILL;
  resolvePageLayout(page);
  assert.equal(child.width, 100);
});

test("fill layout redistributes space after a child reaches its maximum", () => {
  const frame = createNode(NODE_TYPES.FRAME, 0, 0, {
    width: 300,
    height: 80,
    layoutMode: LAYOUT_MODES.HORIZONTAL,
    layoutGap: 0,
    paddingTop: 10,
    paddingRight: 10,
    paddingBottom: 10,
    paddingLeft: 10,
  });
  const capped = createNode(NODE_TYPES.RECTANGLE, 0, 0, {
    parentId: frame.id,
    layoutSizingHorizontal: LAYOUT_SIZING.FILL,
    maxWidth: 100,
  });
  const flexible = createNode(NODE_TYPES.RECTANGLE, 0, 0, {
    parentId: frame.id,
    layoutSizingHorizontal: LAYOUT_SIZING.FILL,
  });
  const page = pageWith(frame, capped, flexible);

  resolvePageLayout(page);

  assert.equal(capped.width, 100);
  assert.equal(flexible.width, 180);
  assert.equal(flexible.x, 110);
});

test("horizontal Auto Layout wraps children into rows and hugs the cross axis", () => {
  const frame = createNode(NODE_TYPES.FRAME, 10, 20, {
    width: 150,
    height: 200,
    layoutMode: LAYOUT_MODES.HORIZONTAL,
    layoutWrap: true,
    layoutGap: 10,
    paddingTop: 10,
    paddingRight: 10,
    paddingBottom: 10,
    paddingLeft: 10,
    layoutSizingVertical: LAYOUT_SIZING.HUG,
  });
  const children = [0, 1, 2].map((index) => createNode(NODE_TYPES.RECTANGLE, 0, 0, {
    parentId: frame.id,
    name: `Item ${index}`,
    width: 60,
    height: 20 + index * 10,
  }));
  const page = pageWith(frame, ...children);

  resolvePageLayout(page);

  assert.deepEqual(children.map((child) => [child.x, child.y]), [
    [20, 30],
    [90, 30],
    [20, 70],
  ]);
  assert.equal(frame.height, 100);
});

test("vertical Auto Layout wraps children into columns", () => {
  const frame = createNode(NODE_TYPES.FRAME, 0, 0, {
    width: 200,
    height: 130,
    layoutMode: LAYOUT_MODES.VERTICAL,
    layoutWrap: true,
    layoutGap: 10,
    paddingTop: 10,
    paddingRight: 10,
    paddingBottom: 10,
    paddingLeft: 10,
  });
  const children = [0, 1, 2].map(() => createNode(NODE_TYPES.RECTANGLE, 0, 0, {
    parentId: frame.id,
    width: 40,
    height: 50,
  }));
  const page = pageWith(frame, ...children);

  resolvePageLayout(page);

  assert.deepEqual(children.map((child) => [child.x, child.y]), [
    [10, 10],
    [10, 70],
    [60, 10],
  ]);
});

test("horizontal Auto Layout aligns text and controls on a shared baseline", () => {
  const frame = createNode(NODE_TYPES.FRAME, 0, 0, {
    width: 240,
    height: 100,
    layoutMode: LAYOUT_MODES.HORIZONTAL,
    layoutSizingVertical: LAYOUT_SIZING.HUG,
    counterAxisAlign: COUNTER_AXIS_ALIGNS.BASELINE,
    paddingTop: 0,
    paddingRight: 0,
    paddingBottom: 0,
    paddingLeft: 0,
  });
  const text = createNode(NODE_TYPES.TEXT, 0, 0, {
    parentId: frame.id,
    width: 80,
    height: 30,
    fontSize: 20,
  });
  const control = createNode(NODE_TYPES.RECTANGLE, 0, 0, {
    parentId: frame.id,
    width: 60,
    height: 24,
  });
  const page = pageWith(frame, text, control);

  resolvePageLayout(page);

  assert.equal(text.y, 8);
  assert.equal(control.y, 0);
  assert.equal(text.y + text.fontSize * 0.8, control.y + control.height);
  assert.equal(frame.height, 38);
});

test("text children can hug intrinsic width and wrapped height", () => {
  const frame = createNode(NODE_TYPES.FRAME, 0, 0, {
    width: 220,
    height: 200,
    layoutMode: LAYOUT_MODES.VERTICAL,
    paddingTop: 10,
    paddingRight: 10,
    paddingBottom: 10,
    paddingLeft: 10,
  });
  const natural = createNode(NODE_TYPES.TEXT, 0, 0, {
    parentId: frame.id,
    text: "Intrinsic label",
    fontSize: 20,
    lineHeight: 1.2,
    layoutSizingHorizontal: LAYOUT_SIZING.HUG,
    layoutSizingVertical: LAYOUT_SIZING.HUG,
  });
  const wrapped = createNode(NODE_TYPES.TEXT, 0, 0, {
    parentId: frame.id,
    width: 90,
    text: "This text wraps onto several lines",
    fontSize: 16,
    lineHeight: 1.25,
    layoutSizingVertical: LAYOUT_SIZING.HUG,
  });
  const page = pageWith(frame, natural, wrapped);

  resolvePageLayout(page);

  const naturalSize = intrinsicTextSize(natural);
  const wrappedSize = intrinsicTextSize(wrapped, wrapped.width);
  assert.equal(natural.width, naturalSize.width);
  assert.equal(natural.height, 24);
  assert.equal(wrapped.height, wrappedSize.height);
  assert.ok(wrappedSize.lines.length > 1);
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

test("a duplicate dragged beyond a hug frame stays managed and reorders in flow", () => {
  const first = createNode(NODE_TYPES.RECTANGLE, 10, 20, { width: 40, height: 30, name: "First" });
  const second = createNode(NODE_TYPES.RECTANGLE, 10, 80, { width: 40, height: 30, name: "Second" });
  const page = pageWith(first, second);
  const frame = createAutoLayoutFrame(page, [first.id, second.id], LAYOUT_MODES.VERTICAL);
  const [copy] = duplicateNodes(page, [first.id], { x: 0, y: 0 });

  copy.y = frame.y - copy.height - 40;
  assert.equal(isAutoLayoutChild(page, copy), true);
  assert.equal(reorderAutoLayoutChild(page, copy.id), true);
  resolvePageLayout(page);

  assert.equal(copy.parentId, frame.id);
  assert.deepEqual(getChildNodes(page, frame.id).map((node) => node.name), [
    "First copy",
    "First",
    "Second",
  ]);
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

  const svg = documentToSVG(page);

  assert.equal(child.x, 99);
  assert.equal(child.y, 99);
  assert.match(svg, /<rect x="10" y="10" width="40" height="20"/);
});
