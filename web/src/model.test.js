import test from "node:test";
import assert from "node:assert/strict";

import {
  BOOLEAN_OPERATIONS,
  booleanGroupNodes,
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
  getVectorContours,
  getVectorWorldHandle,
  getVectorWorldPoints,
  groupNodes,
  isNodeEffectivelyVisible,
  localToWorld,
  maskNodes,
  NODE_TYPES,
  normalizeDocument,
  normalizeVectorBounds,
  pointInNode,
  reorderNode,
  ungroupNodes,
} from "./model.js";
import { DocumentHistory } from "./history.js";
import { documentToSVG } from "./export.js";
import { pointInSceneNode } from "./renderer.js";

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
  assert.equal(document.version, 12);
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

test("migrates and duplicates persistent page canvas aids", () => {
  const document = normalizeDocument({
    version: 11,
    pages: [{
      id: "page",
      name: "Guides",
      rulersVisible: false,
      guidesVisible: true,
      gridVisible: false,
      gridSize: "24",
      snapToGrid: true,
      guides: [
        { id: "guide-a", axis: "x", position: "120.5" },
        { id: "guide-b", axis: "y", position: -80 },
        { id: "bad", axis: "diagonal", position: 20 },
      ],
      nodes: [],
    }],
  });
  const page = getFirstPage(document);

  assert.equal(document.version, 12);
  assert.equal(page.rulersVisible, false);
  assert.equal(page.guidesVisible, true);
  assert.equal(page.gridVisible, false);
  assert.equal(page.gridSize, 24);
  assert.equal(page.snapToGrid, true);
  assert.deepEqual(page.guides, [
    { id: "guide-a", axis: "x", position: 120.5 },
    { id: "guide-b", axis: "y", position: -80 },
  ]);

  const copy = duplicatePage(document, page.id);
  assert.deepEqual(copy.guides.map((guide) => [guide.axis, guide.position]), [["x", 120.5], ["y", -80]]);
  assert.notDeepEqual(copy.guides.map((guide) => guide.id), page.guides.map((guide) => guide.id));
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

test("creates editable Boolean containers with deterministic source order", () => {
  const page = createPage("Boolean");
  const base = createNode(NODE_TYPES.RECTANGLE, 0, 0, { width: 100, height: 80, opacity: 0.42 });
  const cutter = createNode(NODE_TYPES.ELLIPSE, 40, 20, { width: 80, height: 80 });
  page.nodes.push(base, cutter);

  const boolean = booleanGroupNodes(page, [base.id, cutter.id], BOOLEAN_OPERATIONS.SUBTRACT);
  assert.equal(boolean.type, NODE_TYPES.BOOLEAN);
  assert.equal(boolean.booleanOperation, BOOLEAN_OPERATIONS.SUBTRACT);
  assert.equal(boolean.name, "Subtract");
  assert.equal(boolean.opacity, 0.42);
  assert.deepEqual(
    page.nodes.filter((node) => node.parentId === boolean.id).map((node) => node.id),
    [base.id, cutter.id],
  );
  assert.equal(boolean.x, 0);
  assert.equal(boolean.width, 120);

  const copy = duplicateNodes(page, [boolean.id], 10);
  const copiedBoolean = copy.find((node) => node.type === NODE_TYPES.BOOLEAN);
  assert.equal(copy.filter((node) => node.parentId === copiedBoolean.id).length, 2);

  assert.deepEqual(ungroupNodes(page, [boolean.id]), [base.id, cutter.id]);
  assert.equal(base.parentId, null);
  assert.equal(page.nodes.some((node) => node.id === boolean.id), false);
});

test("creates mask groups whose first child is the mask source", () => {
  const page = createPage("Mask");
  const source = createNode(NODE_TYPES.ELLIPSE, 20, 10);
  const content = createNode(NODE_TYPES.IMAGE, 0, 0, { width: 180, height: 140 });
  page.nodes.push(source, content);

  const mask = maskNodes(page, [source.id, content.id]);
  assert.equal(mask.type, NODE_TYPES.MASK);
  assert.equal(mask.name, "Mask group");
  assert.deepEqual(
    page.nodes.filter((node) => node.parentId === mask.id).map((node) => node.id),
    [source.id, content.id],
  );
  assert.equal(booleanGroupNodes(page, [mask.id], BOOLEAN_OPERATIONS.UNION), null);
  assert.equal(maskNodes(page, [mask.id]), null);
});

test("migrates and sanitizes v7 Boolean and mask containers", () => {
  const document = normalizeDocument({
    version: 6,
    name: "Composites",
    pages: [{
      name: "Page",
      nodes: [
        { id: "boolean", type: "boolean", booleanOperation: "unsafe" },
        { id: "shape", type: "rectangle", parentId: "boolean" },
        { id: "mask", type: "mask" },
        { id: "content", type: "ellipse", parentId: "mask" },
      ],
    }],
  });
  const page = getFirstPage(document);

  assert.equal(document.version, 12);
  assert.equal(page.nodes.find((node) => node.id === "boolean").booleanOperation, "union");
  assert.equal(page.nodes.find((node) => node.id === "shape").parentId, "boolean");
  assert.equal(page.nodes.find((node) => node.id === "content").parentId, "mask");
});

test("evaluates Boolean and mask geometry for composite hit testing", () => {
  const page = createPage("Composite hits");
  const base = createNode(NODE_TYPES.RECTANGLE, 0, 0, { width: 100, height: 100 });
  const operand = createNode(NODE_TYPES.RECTANGLE, 50, 0, { width: 100, height: 100 });
  page.nodes.push(base, operand);
  const boolean = booleanGroupNodes(page, [base.id, operand.id], BOOLEAN_OPERATIONS.UNION);

  assert.equal(pointInSceneNode(page, boolean, { x: 25, y: 50 }), true);
  assert.equal(pointInSceneNode(page, boolean, { x: 125, y: 50 }), true);
  boolean.booleanOperation = BOOLEAN_OPERATIONS.SUBTRACT;
  assert.equal(pointInSceneNode(page, boolean, { x: 25, y: 50 }), true);
  assert.equal(pointInSceneNode(page, boolean, { x: 75, y: 50 }), false);
  boolean.booleanOperation = BOOLEAN_OPERATIONS.INTERSECT;
  assert.equal(pointInSceneNode(page, boolean, { x: 75, y: 50 }), true);
  assert.equal(pointInSceneNode(page, boolean, { x: 25, y: 50 }), false);
  boolean.booleanOperation = BOOLEAN_OPERATIONS.EXCLUDE;
  assert.equal(pointInSceneNode(page, boolean, { x: 25, y: 50 }), true);
  assert.equal(pointInSceneNode(page, boolean, { x: 75, y: 50 }), false);

  boolean.booleanOperation = BOOLEAN_OPERATIONS.SUBTRACT;
  assert.equal(reorderNode(page, operand.id, "back"), true);
  assert.equal(pointInSceneNode(page, boolean, { x: 125, y: 50 }), true);
  assert.equal(pointInSceneNode(page, boolean, { x: 25, y: 50 }), false);

  ungroupNodes(page, [boolean.id]);
  const mask = maskNodes(page, [base.id, operand.id]);
  assert.equal(pointInSceneNode(page, mask, { x: 75, y: 50 }), true);
  assert.equal(pointInSceneNode(page, mask, { x: 25, y: 50 }), false);
  assert.equal(pointInSceneNode(page, mask, { x: 125, y: 50 }), false);
  base.visible = false;
  assert.equal(pointInSceneNode(page, mask, { x: 75, y: 50 }), false);
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

test("migrates v10 documents into v12 paint, effect, contour, rich-text, asset, and canvas-aid records", () => {
  const hash = "a".repeat(64);
  const document = normalizeDocument({
    version: 10,
    name: "Milestone one migration",
    assets: [{
      id: `asset_${hash}`,
      hash,
      kind: "font",
      name: "Studio.woff2",
      fontFamily: "Studio",
      data: "data:font/woff2;base64,d09GRg==",
    }],
    pages: [{
      name: "Page",
      nodes: [
        {
          id: "painted",
          type: "rectangle",
          fills: [
            { id: "base", type: "radial-gradient", opacity: 0.8, gradient: { centerX: 0.2, centerY: 0.7, radius: 0.9 } },
            { id: "tint", type: "solid", color: "#ff0000", blendMode: "multiply" },
          ],
          effects: [
            { id: "drop", type: "drop-shadow", color: "#112233", opacity: 0.4, blur: 12 },
            { id: "blur", type: "layer-blur", radius: 9 },
          ],
        },
        {
          id: "copy",
          type: "text",
          text: "Styled copy",
          fontFamily: "Studio",
          fontRef: `asset_${hash}`,
          textRuns: [{ start: 0, end: 6, fontWeight: 700, fill: "#123456" }],
        },
        {
          id: "compound",
          type: "vector",
          vectorPoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
          vectorContours: [
            { id: "outer", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] },
            { id: "hole", points: [{ x: 25, y: 25 }, { x: 25, y: 75 }, { x: 75, y: 75 }, { x: 75, y: 25 }] },
          ],
          vectorFillRule: "evenodd",
        },
      ],
    }],
  });
  const [painted, copy, compound] = getFirstPage(document).nodes;

  assert.equal(document.version, 12);
  assert.equal(document.assets[0].kind, "font");
  assert.equal(document.assets[0].fontFamily, "Studio");
  assert.equal(painted.fills.length, 2);
  assert.equal(painted.fills[0].type, "radial-gradient");
  assert.equal(painted.fills[1].blendMode, "multiply");
  assert.equal(painted.effects.find((effect) => effect.type === "drop-shadow").enabled, true);
  assert.equal(painted.layerBlur, 9);
  assert.equal(copy.fontRef, `asset_${hash}`);
  assert.equal(copy.textRuns[0].fontWeight, 700);
  assert.equal(getVectorContours(compound).length, 2);
  assert.equal(compound.vectorFillRule, "evenodd");
});

test("SVG export preserves paint stacks, radial and angular gradients, blur, and rich text", () => {
  const page = createPage("Milestone paints");
  page.nodes.push(
    createNode(NODE_TYPES.RECTANGLE, 0, 0, {
      fills: [
        { id: "radial", type: "radial-gradient", opacity: 1, gradient: { centerX: 0.3, centerY: 0.4, radius: 0.8 } },
        { id: "angular", type: "angular-gradient", opacity: 0.5, gradient: { angle: 45 } },
      ],
      layerBlur: 8,
    }),
    createNode(NODE_TYPES.TEXT, 140, 0, {
      text: "Rich text",
      textRuns: [{ start: 0, end: 4, fontWeight: 700, fontStyle: "italic", fill: "#ff0000" }],
    }),
  );
  const svg = documentToSVG(page);
  assert.match(svg, /<radialGradient/);
  assert.match(svg, /<radialGradient[^>]+gradientUnits="userSpaceOnUse"/);
  assert.match(svg, /data-paint-type="angular-gradient"/);
  assert.match(svg, /mix-blend-mode:normal/);
  assert.match(svg, /<feGaussianBlur/);
  assert.match(svg, /font-style="italic"/);
  assert.match(svg, />Rich</);
});

test("explicitly hidden effects do not fall back to legacy blur or shadow fields", () => {
  const page = createPage("Hidden effects");
  const node = createNode(NODE_TYPES.RECTANGLE, 0, 0, {
    layerBlur: 20,
    shadow: { enabled: true, color: "#000000", opacity: 0.5, offsetX: 4, offsetY: 8, blur: 12 },
    effects: [
      { id: "blur", type: "layer-blur", visible: false, radius: 20 },
      { id: "shadow", type: "drop-shadow", visible: false, opacity: 0.5, offsetX: 4, offsetY: 8, blur: 12 },
    ],
  });
  page.nodes.push(node);
  assert.equal(node.layerBlur, 0);
  assert.equal(node.shadow.enabled, false);
  assert.doesNotMatch(documentToSVG(page), /<filter/);
});

test("migrates implicit frame shadows into explicit v6 effects", () => {
  const document = normalizeDocument({
    version: 3,
    name: "Legacy frame",
    pages: [{ name: "Page", nodes: [{ id: "frame", type: "frame" }] }],
  });
  const frame = getFirstPage(document).nodes[0];

  assert.equal(document.version, 12);
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

test("exports non-destructive Booleans with SVG masks and expanded strokes", () => {
  const page = createPage("Boolean SVG");
  const base = createNode(NODE_TYPES.RECTANGLE, 0, 0, { width: 120, height: 100 });
  const cutter = createNode(NODE_TYPES.ELLIPSE, 50, 10, { width: 90, height: 80 });
  page.nodes.push(base, cutter);
  const boolean = booleanGroupNodes(page, [base.id, cutter.id], BOOLEAN_OPERATIONS.SUBTRACT);
  boolean.fill = "#7c3aed";
  boolean.stroke = "#f8fafc";
  boolean.strokeWidth = 6;
  const svg = documentToSVG(page);
  const selectedSourceSVG = documentToSVG(page, [base.id]);
  const selectedSourceBounds = getDocumentBounds(page, [base.id]);

  assert.match(svg, /id="boolean-mask-/);
  assert.match(svg, /id="boolean-stroke-mask-/);
  assert.match(svg, /<feMorphology[^>]+operator="dilate"/);
  assert.match(svg, /mask="url\(#boolean-mask-/);
  assert.match(svg, /fill="#000000"/);
  assert.match(selectedSourceSVG, /id="boolean-mask-/);
  assert.equal(selectedSourceBounds.width, boolean.width + boolean.strokeWidth * 2);
});

test("exports mask groups with their first child as the reusable mask source", () => {
  const page = createPage("Mask SVG");
  const source = createNode(NODE_TYPES.ELLIPSE, 0, 0, { width: 100, height: 100 });
  const content = createNode(NODE_TYPES.RECTANGLE, 30, 10, { width: 120, height: 80 });
  page.nodes.push(source, content);
  const mask = maskNodes(page, [source.id, content.id]);
  const svg = documentToSVG(page);

  assert.match(svg, new RegExp(`id="mask-${mask.id.replace(/[^a-z0-9_-]/gi, "-")}"`));
  assert.match(svg, /<g opacity="1" mask="url\(#mask-/);
  assert.match(svg, /<ellipse[^>]+fill="#ffffff"/);
  assert.match(svg, /<rect[^>]+fill="#8b5cf6"/);
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

  assert.equal(document.version, 12);
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

test("migrates v5 corner anchors and sanitizes Bézier handles", () => {
  const document = normalizeDocument({
    version: 5,
    name: "Curves",
    pages: [{
      name: "Page",
      nodes: [{
        id: "curve",
        type: "vector",
        width: 100,
        height: 50,
        vectorClosed: false,
        vectorPoints: [
          {
            x: 0,
            y: 20,
            out: { x: 30, y: "40" },
            handleMode: "mirrored",
          },
          {
            x: 100,
            y: 20,
            in: { x: "bad", y: 40 },
            handleMode: "free",
          },
        ],
      }],
    }],
  });
  const vector = getFirstPage(document).nodes[0];
  const first = vector.vectorPoints[0];
  const second = vector.vectorPoints[1];

  assert.equal(document.version, 12);
  assert.equal(first.handleMode, "mirrored");
  assert.ok(first.in && first.out);
  assert.equal(first.in.x - first.x, -(first.out.x - first.x));
  assert.equal(first.in.y - first.y, -(first.out.y - first.y));
  assert.equal(second.in, null);
  assert.equal(second.handleMode, "corner");
});

test("normalizing curved vector bounds preserves anchors and controls in world space", () => {
  const vector = createVectorNodeFromWorldPoints([
    {
      x: 30,
      y: 30,
      out: { x: 70, y: -10 },
      handleMode: "free",
    },
    {
      x: 150,
      y: 50,
      in: { x: 110, y: 100 },
      handleMode: "free",
    },
  ], false, { rotation: 27 });
  const anchorsBefore = getVectorWorldPoints(vector);
  const outgoingBefore = getVectorWorldHandle(vector, 0, "out");
  const incomingBefore = getVectorWorldHandle(vector, 1, "in");

  vector.vectorPoints[0].out.x -= 25;
  const changedOutgoing = getVectorWorldHandle(vector, 0, "out");
  normalizeVectorBounds(vector);

  const anchorsAfter = getVectorWorldPoints(vector);
  const outgoingAfter = getVectorWorldHandle(vector, 0, "out");
  const incomingAfter = getVectorWorldHandle(vector, 1, "in");
  anchorsAfter.forEach((point, index) => {
    assert.ok(Math.abs(point.x - anchorsBefore[index].x) < 1e-9);
    assert.ok(Math.abs(point.y - anchorsBefore[index].y) < 1e-9);
  });
  assert.ok(Math.abs(outgoingAfter.x - changedOutgoing.x) < 1e-9);
  assert.ok(Math.abs(outgoingAfter.y - changedOutgoing.y) < 1e-9);
  assert.ok(Math.abs(incomingAfter.x - incomingBefore.x) < 1e-9);
  assert.ok(Math.abs(incomingAfter.y - incomingBefore.y) < 1e-9);
  assert.notDeepEqual(outgoingBefore, outgoingAfter);
});

test("exports cubic Bézier controls as SVG path commands", () => {
  const page = createPage("Curves");
  page.nodes.push(createVectorNodeFromWorldPoints([
    {
      x: 0,
      y: 40,
      out: { x: 30, y: 0 },
      handleMode: "free",
    },
    {
      x: 100,
      y: 40,
      in: { x: 70, y: 80 },
      handleMode: "free",
    },
  ], false));
  const svg = documentToSVG(page);

  assert.match(svg, /d="M 0 40 C 30 0 70 80 100 40"/);
  assert.doesNotMatch(svg, /d="M 0 40 L 100 40"/);
});

test("v11 imports migrate compound vectors whose primary geometry lives in contours", () => {
  const document = normalizeDocument({
    version: 11,
    pages: [{
      id: "page",
      name: "Contours",
      nodes: [{
        id: "vector",
        type: "vector",
        vectorContours: [{
          id: "primary",
          closed: false,
          points: [{ x: 10, y: 20 }, { x: 90, y: 70 }],
        }],
      }],
    }],
  });
  const vector = getFirstPage(document).nodes[0];
  assert.equal(vector.vectorPoints.length, 2);
  assert.equal(vector.vectorClosed, false);
  assert.equal(getVectorContours(vector)[0].id, "primary");
});
