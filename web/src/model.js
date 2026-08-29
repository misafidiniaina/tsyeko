export const DOCUMENT_VERSION = 3;
const MAX_HIERARCHY_DEPTH = 256;

export const NODE_TYPES = Object.freeze({
  FRAME: "frame",
  GROUP: "group",
  RECTANGLE: "rectangle",
  ELLIPSE: "ellipse",
  TEXT: "text",
  IMAGE: "image",
});

const DEFAULTS = Object.freeze({
  group: {
    name: "Group",
    width: 160,
    height: 100,
    fill: "transparent",
    stroke: "transparent",
    strokeWidth: 0,
    cornerRadius: 0,
  },
  frame: {
    name: "Frame",
    width: 640,
    height: 420,
    fill: "#ffffff",
    stroke: "#d8d8de",
    strokeWidth: 1,
    cornerRadius: 0,
  },
  rectangle: {
    name: "Rectangle",
    width: 160,
    height: 100,
    fill: "#8b5cf6",
    stroke: "#000000",
    strokeWidth: 0,
    cornerRadius: 12,
  },
  ellipse: {
    name: "Ellipse",
    width: 120,
    height: 120,
    fill: "#ec4899",
    stroke: "#000000",
    strokeWidth: 0,
    cornerRadius: 0,
  },
  text: {
    name: "Text",
    width: 240,
    height: 48,
    fill: "#17171b",
    stroke: "#000000",
    strokeWidth: 0,
    cornerRadius: 0,
    text: "Type something",
    fontFamily: "Inter, ui-sans-serif, sans-serif",
    fontSize: 28,
    fontWeight: 600,
    lineHeight: 1.2,
    textAlign: "left",
  },
  image: {
    name: "Image",
    width: 320,
    height: 240,
    fill: "#e5e7eb",
    stroke: "#000000",
    strokeWidth: 0,
    cornerRadius: 0,
    imageData: "",
    imageFit: "cover",
    altText: "",
  },
});

let fallbackId = 0;

export function makeId(prefix = "node") {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }
  fallbackId += 1;
  return `${prefix}_${Date.now().toString(36)}_${fallbackId.toString(36)}`;
}

export function createNode(type, x = 0, y = 0, overrides = {}) {
  if (!Object.values(NODE_TYPES).includes(type)) {
    throw new Error(`Unsupported node type: ${type}`);
  }

  const defaults = DEFAULTS[type];
  return normalizeNode({
    id: makeId(type),
    type,
    x,
    y,
    rotation: 0,
    parentId: null,
    opacity: 1,
    visible: true,
    locked: false,
    ...defaults,
    ...overrides,
  });
}

export function createEmptyDocument(name = "Untitled design") {
  return {
    version: DOCUMENT_VERSION,
    id: makeId("document"),
    name,
    background: "#101114",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pages: [createPage("Page 1")],
  };
}

export function createPage(name = "Untitled page", overrides = {}) {
  return normalizePage({
    id: makeId("page"),
    name,
    background: "#101114",
    nodes: [],
    ...overrides,
  });
}

export function createStarterDocument() {
  const document = createEmptyDocument("Aurora landing page");
  document.pages[0].name = "Landing page";
  document.pages[0].nodes = [
    createNode(NODE_TYPES.FRAME, -420, -280, {
      name: "Desktop · Hero",
      width: 840,
      height: 560,
      fill: "#f7f5ff",
      stroke: "#d9d5eb",
    }),
    createNode(NODE_TYPES.ELLIPSE, 176, -206, {
      name: "Glow",
      width: 330,
      height: 330,
      fill: "#ded2ff",
      opacity: 0.78,
    }),
    createNode(NODE_TYPES.ELLIPSE, 246, -120, {
      name: "Accent orb",
      width: 190,
      height: 190,
      fill: "#f6b9dc",
      opacity: 0.86,
    }),
    createNode(NODE_TYPES.RECTANGLE, 110, -182, {
      name: "Product preview",
      width: 266,
      height: 350,
      fill: "#201b2f",
      stroke: "#ffffff",
      strokeWidth: 2,
      cornerRadius: 24,
      rotation: -5,
    }),
    createNode(NODE_TYPES.RECTANGLE, 132, -147, {
      name: "Preview panel",
      width: 222,
      height: 134,
      fill: "#8b5cf6",
      cornerRadius: 15,
      rotation: -5,
    }),
    createNode(NODE_TYPES.TEXT, -342, -190, {
      name: "Eyebrow",
      width: 260,
      height: 24,
      text: "DESIGN WITHOUT LIMITS",
      fill: "#7c3aed",
      fontSize: 13,
      fontWeight: 700,
      lineHeight: 1,
    }),
    createNode(NODE_TYPES.TEXT, -345, -145, {
      name: "Hero title",
      width: 430,
      height: 145,
      text: "Ideas move faster\nwhen teams create together.",
      fill: "#181421",
      fontSize: 42,
      fontWeight: 700,
      lineHeight: 1.12,
    }),
    createNode(NODE_TYPES.TEXT, -342, 34, {
      name: "Body copy",
      width: 405,
      height: 60,
      text: "A focused, collaborative canvas for turning early thoughts into polished interfaces.",
      fill: "#6f687d",
      fontSize: 16,
      fontWeight: 400,
      lineHeight: 1.45,
    }),
    createNode(NODE_TYPES.RECTANGLE, -342, 130, {
      name: "Primary button",
      width: 166,
      height: 48,
      fill: "#7c3aed",
      cornerRadius: 12,
    }),
    createNode(NODE_TYPES.TEXT, -315, 144, {
      name: "Button label",
      width: 114,
      height: 22,
      text: "Start creating →",
      fill: "#ffffff",
      fontSize: 14,
      fontWeight: 650,
      lineHeight: 1.2,
      textAlign: "center",
    }),
  ];
  const frameId = document.pages[0].nodes[0].id;
  for (const node of document.pages[0].nodes.slice(1)) node.parentId = frameId;
  return document;
}

export function normalizeDocument(input) {
  const hasPages = Array.isArray(input?.pages);
  const isLegacyDocument = Array.isArray(input?.nodes);
  if (!input || typeof input !== "object" || (!hasPages && !isLegacyDocument)) {
    throw new Error("This file is not a valid Tsyaiko document.");
  }

  const document = createEmptyDocument(cleanString(input.name, "Untitled design", 80));
  document.id = cleanString(input.id, document.id, 160);
  document.version = DOCUMENT_VERSION;
  document.background = cleanColor(input.background, "#101114");
  document.createdAt = cleanString(input.createdAt, document.createdAt, 64);
  document.updatedAt = cleanString(input.updatedAt, document.updatedAt, 64);
  document.pages = hasPages
    ? input.pages.slice(0, 1_000).map((page, index) => normalizePage(page, `Page ${index + 1}`, document.background))
    : [createPage("Page 1", { background: document.background, nodes: input.nodes })];
  if (!document.pages.length) document.pages.push(createPage("Page 1", { background: document.background }));
  ensureUniqueIds(document);
  for (const page of document.pages) repairPageHierarchy(page);
  return document;
}

export function normalizePage(input, fallbackName = "Untitled page", fallbackBackground = "#101114") {
  const page = input && typeof input === "object" ? input : {};
  return {
    id: cleanString(page.id, makeId("page"), 160),
    name: cleanString(page.name, fallbackName, 120),
    background: cleanColor(page.background, fallbackBackground),
    nodes: Array.isArray(page.nodes)
      ? page.nodes
          .filter((node) => node && Object.values(NODE_TYPES).includes(node.type))
          .slice(0, 20_000)
          .map(normalizeNode)
      : [],
  };
}

export function normalizeNode(input) {
  const defaults = DEFAULTS[input.type] ?? DEFAULTS.rectangle;
  const node = {
    id: cleanString(input.id, makeId(input.type ?? "node"), 160),
    type: Object.values(NODE_TYPES).includes(input.type) ? input.type : NODE_TYPES.RECTANGLE,
    name: cleanString(input.name, defaults.name, 120),
    parentId: typeof input.parentId === "string"
      ? cleanString(input.parentId, "", 160) || null
      : null,
    x: finiteNumber(input.x, 0, -1_000_000, 1_000_000),
    y: finiteNumber(input.y, 0, -1_000_000, 1_000_000),
    width: finiteNumber(input.width, defaults.width, 1, 100_000),
    height: finiteNumber(input.height, defaults.height, 1, 100_000),
    rotation: normalizeRotation(finiteNumber(input.rotation, 0, -36_000, 36_000)),
    opacity: finiteNumber(input.opacity, 1, 0, 1),
    visible: input.visible !== false,
    locked: input.locked === true,
    fill: cleanColor(input.fill, defaults.fill),
    stroke: cleanColor(input.stroke, defaults.stroke),
    strokeWidth: finiteNumber(input.strokeWidth, defaults.strokeWidth, 0, 200),
    cornerRadius: finiteNumber(input.cornerRadius, defaults.cornerRadius, 0, 50_000),
  };

  if (node.type === NODE_TYPES.TEXT) {
    node.text = cleanString(input.text, defaults.text, 20_000, true);
    node.fontFamily = cleanString(input.fontFamily, defaults.fontFamily, 200);
    node.fontSize = finiteNumber(input.fontSize, defaults.fontSize, 1, 1_000);
    node.fontWeight = finiteNumber(input.fontWeight, defaults.fontWeight, 100, 900);
    node.lineHeight = finiteNumber(input.lineHeight, defaults.lineHeight, 0.5, 5);
    node.textAlign = ["left", "center", "right"].includes(input.textAlign)
      ? input.textAlign
      : "left";
  }

  if (node.type === NODE_TYPES.IMAGE) {
    node.imageData = cleanImageData(input.imageData);
    node.imageFit = ["cover", "contain"].includes(input.imageFit) ? input.imageFit : "cover";
    node.altText = cleanString(input.altText, "", 500);
  }

  return node;
}

export function cloneDocument(document) {
  return globalThis.structuredClone
    ? globalThis.structuredClone(document)
    : JSON.parse(JSON.stringify(document));
}

export function getPage(document, id) {
  return document.pages.find((page) => page.id === id) ?? null;
}

export function getFirstPage(document) {
  return document.pages[0] ?? null;
}

export function duplicatePage(document, id) {
  const index = document.pages.findIndex((page) => page.id === id);
  if (index < 0) return null;
  const source = document.pages[index];
  const idMap = new Map(source.nodes.map((node) => [node.id, makeId(node.type)]));
  const copy = {
    ...cloneValue(source),
    id: makeId("page"),
    name: `${source.name} copy`,
    nodes: source.nodes.map((node) => ({
      ...cloneValue(node),
      id: idMap.get(node.id),
      parentId: node.parentId ? idMap.get(node.parentId) ?? null : null,
    })),
  };
  document.pages.splice(index + 1, 0, copy);
  return copy;
}

export function getNode(document, id) {
  return document.nodes.find((node) => node.id === id) ?? null;
}

export function getNodes(document, ids) {
  const idSet = new Set(ids);
  return document.nodes.filter((node) => idSet.has(node.id));
}

export function isContainerNode(node) {
  return node?.type === NODE_TYPES.FRAME || node?.type === NODE_TYPES.GROUP;
}

export function getChildNodes(document, parentId = null) {
  return document.nodes.filter((node) => (node.parentId ?? null) === (parentId ?? null));
}

export function getAncestors(document, id) {
  const ancestors = [];
  const visited = new Set([typeof id === "string" ? id : id?.id]);
  let node = typeof id === "string" ? getNode(document, id) : id;
  while (node?.parentId) {
    if (visited.has(node.parentId)) break;
    visited.add(node.parentId);
    const parent = getNode(document, node.parentId);
    if (!parent) break;
    ancestors.push(parent);
    node = parent;
  }
  return ancestors;
}

export function getDescendantIds(document, ids) {
  const descendants = new Set();
  const queue = [...new Set(Array.isArray(ids) ? ids : [ids])];
  while (queue.length) {
    const parentId = queue.shift();
    for (const child of document.nodes) {
      if (child.parentId !== parentId || descendants.has(child.id)) continue;
      descendants.add(child.id);
      queue.push(child.id);
    }
  }
  return descendants;
}

export function getTopLevelNodeIds(document, ids) {
  const selected = new Set(ids);
  return document.nodes
    .filter((node) => selected.has(node.id))
    .filter((node) => !getAncestors(document, node).some((ancestor) => selected.has(ancestor.id)))
    .map((node) => node.id);
}

export function getNodesWithDescendants(document, ids) {
  const roots = getTopLevelNodeIds(document, ids);
  const included = new Set([...roots, ...getDescendantIds(document, roots)]);
  return document.nodes.filter((node) => included.has(node.id));
}

export function isNodeEffectivelyVisible(document, id) {
  const node = typeof id === "string" ? getNode(document, id) : id;
  return Boolean(node?.visible && getAncestors(document, node).every((ancestor) => ancestor.visible));
}

export function isNodeEffectivelyLocked(document, id) {
  const node = typeof id === "string" ? getNode(document, id) : id;
  return Boolean(node?.locked || getAncestors(document, node).some((ancestor) => ancestor.locked));
}

export function getEffectiveOpacity(document, id) {
  const node = typeof id === "string" ? getNode(document, id) : id;
  if (!node) return 0;
  return [node, ...getAncestors(document, node)]
    .reduce((opacity, item) => opacity * item.opacity, 1);
}

export function localToWorld(node, point) {
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;
  const radians = (node.rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const offsetX = point.x - node.width / 2;
  const offsetY = point.y - node.height / 2;
  return {
    x: centerX + offsetX * cosine - offsetY * sine,
    y: centerY + offsetX * sine + offsetY * cosine,
  };
}

export function worldToLocal(node, point) {
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;
  const radians = (-node.rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const offsetX = point.x - centerX;
  const offsetY = point.y - centerY;
  return {
    x: node.width / 2 + offsetX * cosine - offsetY * sine,
    y: node.height / 2 + offsetX * sine + offsetY * cosine,
  };
}

export function pointInNode(node, point, padding = 0) {
  if (!node.visible) return false;
  const local = worldToLocal(node, point);
  return (
    local.x >= -padding &&
    local.y >= -padding &&
    local.x <= node.width + padding &&
    local.y <= node.height + padding
  );
}

export function getNodeAABB(node) {
  const corners = [
    localToWorld(node, { x: 0, y: 0 }),
    localToWorld(node, { x: node.width, y: 0 }),
    localToWorld(node, { x: node.width, y: node.height }),
    localToWorld(node, { x: 0, y: node.height }),
  ];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

export function getDocumentBounds(document, ids = null) {
  const idSet = ids ? new Set(getNodesWithDescendants(document, ids).map((node) => node.id)) : null;
  const nodes = document.nodes.filter(
    (node) => node.type !== NODE_TYPES.GROUP && isNodeEffectivelyVisible(document, node) && (!idSet || idSet.has(node.id)),
  );
  if (!nodes.length) return { x: -160, y: -100, width: 320, height: 200 };

  const bounds = nodes.map(getNodeAABB);
  const minX = Math.min(...bounds.map((box) => box.x));
  const minY = Math.min(...bounds.map((box) => box.y));
  const maxX = Math.max(...bounds.map((box) => box.x + box.width));
  const maxY = Math.max(...bounds.map((box) => box.y + box.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function reorderNode(document, id, direction) {
  const node = getNode(document, id);
  if (!node) return false;
  const siblings = getChildNodes(document, node.parentId);
  const siblingIndex = siblings.findIndex((item) => item.id === id);
  const nextSiblingIndex = direction === "front"
    ? Math.min(siblings.length - 1, siblingIndex + 1)
    : Math.max(0, siblingIndex - 1);
  if (nextSiblingIndex === siblingIndex) return false;

  const other = siblings[nextSiblingIndex];
  const branch = getNodesWithDescendants(document, [node.id]);
  const otherBranch = getNodesWithDescendants(document, [other.id]);
  const branchIds = new Set([...branch, ...otherBranch].map((item) => item.id));
  const firstIndex = document.nodes.findIndex((item) => branchIds.has(item.id));
  const replacement = direction === "front"
    ? [...otherBranch, ...branch]
    : [...branch, ...otherBranch];
  document.nodes = [
    ...document.nodes.slice(0, firstIndex).filter((item) => !branchIds.has(item.id)),
    ...replacement,
    ...document.nodes.slice(firstIndex).filter((item) => !branchIds.has(item.id)),
  ];
  return true;
}

export function duplicateNodes(document, ids, offset = 20) {
  const roots = new Set(getTopLevelNodeIds(document, ids));
  const sourceNodes = getNodesWithDescendants(document, [...roots]);
  const idMap = new Map(sourceNodes.map((node) => [node.id, makeId(node.type)]));
  const copies = sourceNodes.map((node) => ({
      ...cloneValue(node),
      id: idMap.get(node.id),
      parentId: node.parentId ? idMap.get(node.parentId) ?? node.parentId : null,
      name: roots.has(node.id) ? `${node.name} copy` : node.name,
      x: node.x + offset,
      y: node.y + offset,
      locked: false,
    }));
  document.nodes.push(...copies);
  sortNodesByHierarchy(document);
  return copies;
}

export function deleteNodes(document, ids) {
  const roots = getTopLevelNodeIds(document, ids);
  const deleting = new Set(getNodesWithDescendants(document, roots).map((node) => node.id));
  if (!deleting.size) return [];
  document.nodes = document.nodes.filter((node) => !deleting.has(node.id));
  syncGroupBounds(document);
  return [...deleting];
}

export function groupNodes(document, ids) {
  const roots = getTopLevelNodeIds(document, ids)
    .map((id) => getNode(document, id))
    .filter(Boolean);
  if (!roots.length) return null;
  const parentId = roots[0].parentId ?? null;
  if (roots.some((node) => (node.parentId ?? null) !== parentId)) return null;

  const bounds = combinedBounds(roots.map(getNodeAABB));
  const group = createNode(NODE_TYPES.GROUP, bounds.x, bounds.y, {
    width: bounds.width,
    height: bounds.height,
    parentId,
  });
  const firstIndex = Math.min(...roots.map((node) => document.nodes.indexOf(node)));
  document.nodes.splice(firstIndex, 0, group);
  for (const node of roots) node.parentId = group.id;
  sortNodesByHierarchy(document);
  return group;
}

export function ungroupNodes(document, ids) {
  const groups = getTopLevelNodeIds(document, ids)
    .map((id) => getNode(document, id))
    .filter((node) => node?.type === NODE_TYPES.GROUP);
  const released = [];
  for (const group of groups) {
    for (const child of getChildNodes(document, group.id)) {
      child.parentId = group.parentId ?? null;
      released.push(child.id);
    }
  }
  const groupIds = new Set(groups.map((group) => group.id));
  document.nodes = document.nodes.filter((node) => !groupIds.has(node.id));
  sortNodesByHierarchy(document);
  syncGroupBounds(document);
  return released;
}

export function syncGroupBounds(document) {
  const groups = document.nodes
    .filter((node) => node.type === NODE_TYPES.GROUP)
    .sort((a, b) => getAncestors(document, b).length - getAncestors(document, a).length);
  for (const group of groups) {
    const children = getChildNodes(document, group.id);
    if (!children.length) continue;
    const bounds = combinedBounds(children.map(getNodeAABB));
    group.x = bounds.x;
    group.y = bounds.y;
    group.width = Math.max(1, bounds.width);
    group.height = Math.max(1, bounds.height);
    group.rotation = 0;
  }
}

export function findContainingFrame(document, node, excludedIds = []) {
  const excluded = new Set([node.id, ...excludedIds, ...getDescendantIds(document, [node.id])]);
  const center = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  for (let index = document.nodes.length - 1; index >= 0; index -= 1) {
    const candidate = document.nodes[index];
    if (candidate.type !== NODE_TYPES.FRAME || excluded.has(candidate.id)) continue;
    if (!isNodeEffectivelyVisible(document, candidate) || !pointInNode(candidate, center)) continue;
    return candidate;
  }
  return null;
}

export function repairPageHierarchy(document) {
  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  for (const node of document.nodes) {
    const parent = node.parentId ? nodeMap.get(node.parentId) : null;
    if (!parent || parent.id === node.id || !isContainerNode(parent)) node.parentId = null;
  }

  for (const node of document.nodes) {
    const visited = new Set([node.id]);
    let cursor = node;
    let depth = 0;
    while (cursor.parentId) {
      depth += 1;
      if (visited.has(cursor.parentId) || depth > MAX_HIERARCHY_DEPTH) {
        node.parentId = null;
        break;
      }
      visited.add(cursor.parentId);
      cursor = nodeMap.get(cursor.parentId);
      if (!cursor) break;
    }
  }
  sortNodesByHierarchy(document);
  syncGroupBounds(document);
}

export function sortNodesByHierarchy(document) {
  const original = [...document.nodes];
  const byParent = new Map();
  for (const node of original) {
    const parentId = node.parentId ?? null;
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(node);
  }
  const sorted = [];
  const visited = new Set();
  const visit = (node) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    sorted.push(node);
    for (const child of byParent.get(node.id) ?? []) visit(child);
  };
  for (const root of byParent.get(null) ?? []) visit(root);
  for (const node of original) visit(node);
  document.nodes = sorted;
}

function cloneValue(value) {
  return globalThis.structuredClone
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function ensureUniqueIds(document) {
  const pageIds = new Set();
  const nodeIds = new Set();
  for (const page of document.pages) {
    if (pageIds.has(page.id)) page.id = makeId("page");
    pageIds.add(page.id);
    const localIdMap = new Map();
    for (const node of page.nodes) {
      const originalId = node.id;
      if (nodeIds.has(node.id)) node.id = makeId(node.type);
      nodeIds.add(node.id);
      if (!localIdMap.has(originalId)) localIdMap.set(originalId, node.id);
    }
    for (const node of page.nodes) {
      if (node.parentId && localIdMap.has(node.parentId)) {
        node.parentId = localIdMap.get(node.parentId);
      }
    }
  }
}

function combinedBounds(bounds) {
  const minX = Math.min(...bounds.map((box) => box.x));
  const minY = Math.min(...bounds.map((box) => box.y));
  const maxX = Math.max(...bounds.map((box) => box.x + box.width));
  const maxY = Math.max(...bounds.map((box) => box.y + box.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function cleanString(value, fallback, maxLength, preserveNewlines = false) {
  if (typeof value !== "string") return fallback;
  const cleaned = preserveNewlines
    ? value.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    : value.replace(/[\r\n\t]/g, " ");
  return cleaned.slice(0, maxLength);
}

function cleanColor(value, fallback) {
  if (typeof value !== "string") return fallback;
  const color = value.trim();
  if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) return color;
  if (/^(rgba?|hsla?)\([\d\s.,%+-]+\)$/i.test(color)) return color;
  if (color === "transparent") return color;
  return fallback;
}

function cleanImageData(value) {
  if (typeof value !== "string" || value.length > 40_000_000) return "";
  return /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z\d+/=\s]+$/i.test(value)
    ? value.replace(/\s/g, "")
    : "";
}

function finiteNumber(value, fallback, minimum, maximum) {
  const number = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function normalizeRotation(degrees) {
  const normalized = ((degrees % 360) + 360) % 360;
  return normalized > 180 ? normalized - 360 : normalized;
}
