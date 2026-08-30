import test from "node:test";
import assert from "node:assert/strict";

import {
  createEmptyDocument,
  createNode,
  createPage,
  createVectorNodeFromWorldPoints,
  deleteNodes,
  duplicatePage,
  duplicateNodes,
  getDocumentBounds,
  getFirstPage,
  getNodesWithDescendants,
  getNodeVisualBounds,
  getVectorWorldPoints,
  groupNodes,
  isNodeEffectivelyVisible,
  localToWorld,
  NODE_TYPES,
  normalizeDocument,
  normalizeVectorBounds,
  pointInNode,
  ungroupNodes,
} from "./model.js";
import { DocumentHistory } from "./history.js";
import { documentToSVG } from "./export.js";

test("migrates v1 documents and clamps untrusted geometry", () => {
  const document = normalizeDocument({
    name: "Imported",
    nodes: [{
      id: "shape",
      type: "rectangle",
      x: "12",
      y: 8,
      width: -100,
      height: 50,
      fill: "javascript:bad",
      opacity: 4,
    }],
  });

  assert.equal(document.name, "Imported");
  assert.equal(document.version, 5);
  assert.equal(document.pages.length, 1);
  assert.equal(document.pages[0].nodes[0].x, 12);
  assert.equal(document.pages[0].nodes[0].width, 1);
  assert.equal(document.pages[0].nodes[0].opacity, 1);
  assert.equal(document.pages[0].nodes[0].fill, "#8b5cf6");
});

test("normalizes multi-page documents and repairs duplicate ids", () => {
  const document = normalizeDocument({
    version: 2,
    name: "Pages",
    pages: [
      { id: "same", name: "One", nodes: [{ id: "node", type: "ellipse" }] },
      { id: "same", name: "Two", nodes: [
        { id: "node", type: "frame" },
        { id: "child", type: "rectangle", parentId: "node" },
      ] },
    ],
  });

  assert.equal(document.pages.length, 2);
  assert.notEqual(document.pages[0].id, document.pages[1].id);
  assert.notEqual(document.pages[0].nodes[0].id, document.pages[1].nodes[0].id);
  assert.equal(document.pages[1].nodes[1].parentId, document.pages[1].nodes[0].id);
});

test("hit testing accounts for rotation", () => {
  const node = createNode(NODE_TYPES.RECTANGLE, 10, 20, {
    width: 100,
    height: 50,
    rotation: 90,
  });
  const center = localToWorld(node, { x: 50, y: 25 });
  assert.equal(pointInNode(node, center), true);
  assert.equal(pointInNode(node, { x: -200, y: -200 }), false);
});

test("history supports commit, undo, and redo", () => {
  const document = createEmptyDocument();
  const history = new DocumentHistory(document);
  getFirstPage(document).nodes.push(createNode(NODE_TYPES.ELLIPSE));
  history.commit(document);

  assert.equal(history.canUndo, true);
  assert.equal(getFirstPage(history.undo()).nodes.length, 0);
  assert.equal(getFirstPage(history.redo()).nodes.length, 1);
});

test("history ignores timestamp-only changes and preserves embedded assets", () => {
  const document = createEmptyDocument();
  const page = getFirstPage(document);
  const image = createNode(NODE_TYPES.IMAGE, 0, 0, {
    imageData: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
  });
  page.nodes.push(image);
  const history = new DocumentHistory(document);

  document.updatedAt = new Date(Date.now() + 1_000).toISOString();
  assert.equal(history.commit(document), false);
  image.x = 25;
  assert.equal(history.commit(document), true);
  assert.equal(getFirstPage(history.undo()).nodes[0].imageData, image.imageData);
});

test("duplicates nodes with new ids and offsets", () => {
  const document = createEmptyDocument();
  const page = getFirstPage(document);
  const original = createNode(NODE_TYPES.RECTANGLE, 20, 30);
  page.nodes.push(original);
  const [copy] = duplicateNodes(page, [original.id], 12);

  assert.notEqual(copy.id, original.id);
  assert.equal(copy.x, 32);
  assert.equal(copy.y, 42);
  assert.equal(page.nodes.length, 2);
});

test("duplicates a page with globally unique node ids", () => {
  const document = createEmptyDocument();
  const page = getFirstPage(document);
  const frame = createNode(NODE_TYPES.FRAME);
  const text = createNode(NODE_TYPES.TEXT, 20, 20, { parentId: frame.id });
  page.nodes.push(frame, text);
  const copy = duplicatePage(document, page.id);

  assert.equal(document.pages.length, 2);
  assert.equal(copy.name, "Page 1 copy");
  assert.notEqual(copy.id, page.id);
  assert.notEqual(copy.nodes[0].id, page.nodes[0].id);
  assert.equal(copy.nodes[1].parentId, copy.nodes[0].id);
});

test("normalizes hierarchy and repairs invalid or cyclic parents", () => {
  const document = normalizeDocument({
    version: 3,
    name: "Hierarchy",
    pages: [{
      id: "page",
      name: "Page",
      nodes: [
        { id: "frame", type: "frame", parentId: null },
        { id: "child", type: "rectangle", parentId: "frame" },
        { id: "invalid", type: "ellipse", parentId: "child" },
        { id: "group-a", type: "group", parentId: "group-b" },
        { id: "group-b", type: "group", parentId: "group-a" },
      ],
    }],
  });
  const page = getFirstPage(document);

  assert.equal(page.nodes.find((node) => node.id === "child").parentId, "frame");
  assert.equal(page.nodes.find((node) => node.id === "invalid").parentId, null);
  const groupA = page.nodes.find((node) => node.id === "group-a");
  const groupB = page.nodes.find((node) => node.id === "group-b");
  assert.ok(groupA.parentId === null || groupB.parentId === null);
});

test("groups, duplicates, ungroups, and recursively deletes subtrees", () => {
  const page = createPage("Hierarchy");
  const first = createNode(NODE_TYPES.RECTANGLE, 10, 20, { width: 100, height: 50 });
  const second = createNode(NODE_TYPES.ELLIPSE, 150, 40, { width: 40, height: 40 });
  page.nodes.push(first, second);

  const group = groupNodes(page, [first.id, second.id]);
  assert.equal(first.parentId, group.id);
  assert.equal(second.parentId, group.id);
  assert.equal(group.x, 10);
  assert.equal(group.width, 180);

  const copies = duplicateNodes(page, [group.id], 12);
  const copiedGroup = copies.find((node) => node.type === NODE_TYPES.GROUP);
  const copiedChildren = copies.filter((node) => node.parentId === copiedGroup.id);
  assert.equal(copiedChildren.length, 2);
  assert.equal(getNodesWithDescendants(page, [copiedGroup.id]).length, 3);

  const released = ungroupNodes(page, [group.id]);
  assert.deepEqual(new Set(released), new Set([first.id, second.id]));
  assert.equal(first.parentId, null);

  deleteNodes(page, [copiedGroup.id]);
  assert.equal(copies.some((copy) => page.nodes.includes(copy)), false);
});

test("inherits visibility through frame and group ancestors", () => {
  const page = createPage("Visibility");
  const frame = createNode(NODE_TYPES.FRAME);
  const group = createNode(NODE_TYPES.GROUP, 0, 0, { parentId: frame.id });
  const child = createNode(NODE_TYPES.TEXT, 0, 0, { parentId: group.id });
  page.nodes.push(frame, group, child);

  assert.equal(isNodeEffectivelyVisible(page, child), true);
  frame.visible = false;
  assert.equal(isNodeEffectivelyVisible(page, child), false);
});

test("creates independently editable pages", () => {
  const page = createPage("Flow");
  page.nodes.push(createNode(NODE_TYPES.ELLIPSE));
  assert.equal(page.name, "Flow");
  assert.equal(page.nodes.length, 1);
});

test("accepts embedded raster images and rejects unsafe image sources", () => {
  const safeSource = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
  const image = createNode(NODE_TYPES.IMAGE, 0, 0, {
    imageData: safeSource,
    imageFit: "contain",
    altText: "Pixel",
  });
  const unsafe = createNode(NODE_TYPES.IMAGE, 0, 0, {
    imageData: "https://example.com/tracker.png",
  });

  assert.equal(image.imageData, safeSource);
  assert.equal(image.imageFit, "contain");
  assert.equal(image.altText, "Pixel");
  assert.equal(unsafe.imageData, "");
});

test("normalizes gradient paints and bounded shadow effects", () => {
  const node = createNode(NODE_TYPES.RECTANGLE, 10, 20, {
    width: 100,
    height: 50,
    fillType: "linear-gradient",
    gradient: {
      angle: 450,
      stops: [
        { position: 1, color: "#112233" },
        { position: -2, color: "not-a-color" },
      ],
    },
    shadow: {
      enabled: true,
      color: "javascript:bad",
      opacity: 4,
      offsetX: 5,
      offsetY: 8,
      blur: 10,
    },
  });

  assert.equal(node.fillType, "linear-gradient");
  assert.equal(node.gradient.angle, 90);
  assert.deepEqual(node.gradient.stops.map((stop) => stop.position), [0, 1]);
  assert.equal(node.shadow.color, "#000000");
  assert.equal(node.shadow.opacity, 1);
  assert.deepEqual(getNodeVisualBounds(node), { x: -5, y: 8, width: 140, height: 90 });
});

test("migrates implicit frame shadows into explicit v5 effects", () => {
  const document = normalizeDocument({
    version: 3,
    name: "Legacy frame",
    pages: [{ name: "Page", nodes: [{ id: "frame", type: "frame" }] }],
  });
  const frame = getFirstPage(document).nodes[0];

  assert.equal(document.version, 5);
  assert.equal(frame.fillType, "solid");
  assert.equal(frame.shadow.enabled, true);
  assert.equal(frame.shadow.blur, 16);
});

test("exports visible content to SVG", () => {
  const document = createEmptyDocument("Example & test");
  const page = getFirstPage(document);
  page.name = document.name;
  page.nodes.push(createNode(NODE_TYPES.RECTANGLE, 10, 20, {
    width: 200,
    height: 100,
  }));
  const svg = documentToSVG(page);
  const bounds = getDocumentBounds(page);

  assert.match(svg, /<svg/);
  assert.match(svg, /Example &amp; test/);
  assert.match(svg, /<rect/);
  assert.equal(bounds.width, 200);
});

test("embeds image layers in SVG exports", () => {
  const page = createPage("Images");
  page.nodes.push(createNode(NODE_TYPES.IMAGE, 4, 8, {
    width: 64,
    height: 48,
    imageData: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
    imageFit: "cover",
  }));
  const svg = documentToSVG(page);

  assert.match(svg, /<image/);
  assert.match(svg, /data:image\/png;base64/);
  assert.match(svg, /preserveAspectRatio="xMidYMid slice"/);
});

test("SVG export clips descendants to frames", () => {
  const page = createPage("Clipped");
  const frame = createNode(NODE_TYPES.FRAME, 0, 0, { width: 100, height: 100 });
  const child = createNode(NODE_TYPES.RECTANGLE, 80, 20, {
    width: 80,
    height: 80,
    parentId: frame.id,
  });
  page.nodes.push(frame, child);
  const svg = documentToSVG(page);

  assert.match(svg, /<clipPath id="frame-clip-/);
  assert.match(svg, /clip-path="url\(#frame-clip-/);
});

test("SVG export includes gradient and shadow definitions", () => {
  const page = createPage("Paints");
  page.nodes.push(createNode(NODE_TYPES.RECTANGLE, 0, 0, {
    fillType: "linear-gradient",
    gradient: {
      angle: 30,
      stops: [
        { position: 0, color: "#7c3aed" },
        { position: 1, color: "#ec4899" },
      ],
    },
    shadow: {
      enabled: true,
      color: "#000000",
      opacity: 0.25,
      offsetX: 2,
      offsetY: 10,
      blur: 20,
    },
  }));
  const svg = documentToSVG(page);

  assert.match(svg, /<linearGradient id="gradient-/);
  assert.match(svg, /<filter id="shadow-/);
  assert.match(svg, /fill="url\(#gradient-/);
  assert.match(svg, /filter="url\(#shadow-/);
  assert.match(svg, /<feDropShadow/);
});

test("normalizes vector paths and rejects invalid point data", () => {
  const document = normalizeDocument({
    version: 4,
    name: "Vector migration",
    pages: [{
      name: "Page",
      nodes: [{
        id: "path",
        type: "vector",
        vectorPoints: [
          { x: "10", y: -2_000_000 },
          null,
          { x: 40, y: 30 },
        ],
        vectorClosed: true,
        vectorFillRule: "evenodd",
      }],
    }],
  });
  const vector = getFirstPage(document).nodes[0];

  assert.equal(document.version, 5);
  assert.equal(vector.type, NODE_TYPES.VECTOR);
  assert.equal(vector.vectorPoints.length, 2);
  assert.equal(vector.vectorClosed, false);
  assert.equal(vector.vectorFillRule, "evenodd");
  assert.equal(vector.width, 30);
  assert.equal(vector.height, 1_000_030);
});

test("creates vectors from world points and preserves anchors when bounds normalize", () => {
  const vector = createVectorNodeFromWorldPoints([
    { x: 30, y: 20 },
    { x: 110, y: 40 },
    { x: 60, y: 100 },
  ], true, { rotation: 0 });

  assert.equal(vector.x, 30);
  assert.equal(vector.y, 20);
  assert.equal(vector.width, 80);
  assert.equal(vector.height, 80);
  assert.deepEqual(getVectorWorldPoints(vector), [
    { x: 30, y: 20 },
    { x: 110, y: 40 },
    { x: 60, y: 100 },
  ]);

  vector.rotation = 32;
  vector.vectorPoints[0] = { x: -25, y: 8 };
  const worldBefore = getVectorWorldPoints(vector);
  normalizeVectorBounds(vector);
  const worldAfter = getVectorWorldPoints(vector);
  worldAfter.forEach((point, index) => {
    assert.ok(Math.abs(point.x - worldBefore[index].x) < 1e-9);
    assert.ok(Math.abs(point.y - worldBefore[index].y) < 1e-9);
  });
});

test("exports open and closed vectors as editable SVG paths", () => {
  const page = createPage("Vectors");
  page.nodes.push(
    createVectorNodeFromWorldPoints([
      { x: 0, y: 0 },
      { x: 60, y: 20 },
      { x: 20, y: 80 },
    ], true, { vectorFillRule: "evenodd" }),
    createVectorNodeFromWorldPoints([
      { x: 100, y: 10 },
      { x: 180, y: 70 },
    ], false),
  );
  const svg = documentToSVG(page);

  assert.match(svg, /<path d="M 0 0 L 60 20 L 20 80 Z"/);
  assert.match(svg, /fill-rule="evenodd"/);
  assert.match(svg, /<path d="M 100 10 L 180 70" fill="none"/);
  assert.match(svg, /stroke-linecap="round"/);
});
