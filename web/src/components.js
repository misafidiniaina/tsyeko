import {
  COMPONENT_ROLES,
  clearComponentMetadata,
  getAncestors,
  getNode,
  getNodesWithDescendants,
  getPage,
  getTopLevelNodeIds,
  groupNodes,
  isComponentOverrideProperty,
  isContainerNode,
  makeId,
  normalizeNode,
  repairComponentMetadata,
  sortNodesByHierarchy,
} from "./model.js";

const INSTANCE_ROOT_EXTERNAL_PROPERTIES = new Set([
  "parentId",
  "x",
  "y",
  "layoutSizingHorizontal",
  "layoutSizingVertical",
  "layoutPositioning",
  "constraintHorizontal",
  "constraintVertical",
]);

export function isMainComponent(node) {
  return node?.componentRole === COMPONENT_ROLES.MAIN && Boolean(node.componentId);
}

export function isComponentSource(node) {
  return [COMPONENT_ROLES.MAIN, COMPONENT_ROLES.SOURCE].includes(node?.componentRole) &&
    Boolean(node.componentId);
}

export function isComponentInstanceRoot(node) {
  return node?.componentRole === COMPONENT_ROLES.INSTANCE && Boolean(node.componentId);
}

export function isComponentInstanceMember(node) {
  return [COMPONENT_ROLES.INSTANCE, COMPONENT_ROLES.INSTANCE_CHILD].includes(node?.componentRole) &&
    Boolean(node.componentId);
}

export function getComponentDefinition(document, componentId) {
  return document?.components?.find((component) => component.id === componentId) ?? null;
}

export function getComponentSource(document, componentId) {
  const component = getComponentDefinition(document, componentId);
  if (!component) return null;
  const page = getPage(document, component.sourcePageId);
  const node = page ? getNode(page, component.sourceNodeId) : null;
  return page && node ? { component, page, node } : null;
}

export function getComponentSourceNode(document, componentId, sourceNodeId) {
  const source = getComponentSource(document, componentId);
  if (!source || !sourceNodeId) return null;
  const node = getNode(source.page, sourceNodeId);
  return node?.componentId === componentId ? node : null;
}

export function getComponentInstanceRoot(page, target) {
  let node = typeof target === "string" ? getNode(page, target) : target;
  const visited = new Set();
  while (node && !visited.has(node.id)) {
    if (isComponentInstanceRoot(node)) return node;
    visited.add(node.id);
    node = node.parentId ? getNode(page, node.parentId) : null;
  }
  return null;
}

export function getComponentInstanceCount(document, componentId) {
  return document?.pages?.flatMap((page) => page.nodes ?? [])
    .filter((node) => isComponentInstanceRoot(node) && node.componentId === componentId)
    .length ?? 0;
}

export function hasComponentOverrides(page, target) {
  const root = getComponentInstanceRoot(page, target);
  return Boolean(root && Object.values(root.componentOverrides ?? {}).some((properties) =>
    properties && Object.keys(properties).length));
}

export function createComponent(document, pageId, ids) {
  const page = getPage(document, pageId);
  if (!page) return { component: null, source: null, error: "Choose a page before creating a component." };
  const roots = getTopLevelNodeIds(page, ids)
    .map((id) => getNode(page, id))
    .filter(Boolean);
  if (!roots.length) return { component: null, source: null, error: "Select one or more layers first." };
  if (roots.some((node) => isComponentManagedSelection(page, node))) {
    return {
      component: null,
      source: null,
      error: "Detach an instance before turning it into a new component.",
    };
  }
  const parentId = roots[0].parentId ?? null;
  if (roots.some((node) => (node.parentId ?? null) !== parentId)) {
    return { component: null, source: null, error: "Component layers must share the same parent." };
  }

  const source = roots.length === 1 ? roots[0] : groupNodes(page, roots.map((node) => node.id));
  if (!source) return { component: null, source: null, error: "Could not create a component from that selection." };

  const now = new Date().toISOString();
  const component = {
    id: makeId("component"),
    name: source.name || "Component",
    sourcePageId: page.id,
    sourceNodeId: source.id,
    createdAt: now,
    updatedAt: now,
  };
  if (!Array.isArray(document.components)) document.components = [];
  document.components.push(component);
  tagSourceBranch(page, source, component.id);
  sortNodesByHierarchy(page);
  return { component, source, error: null };
}

export function createComponentInstance(document, componentId, pageId, position = {}) {
  const targetPage = getPage(document, pageId);
  const source = getComponentSource(document, componentId);
  if (!targetPage || !source) return null;
  const x = finitePosition(position.x, source.node.x);
  const y = finitePosition(position.y, source.node.y);
  const instance = materializeInstance(
    targetPage,
    source.page,
    source.component,
    source.node,
    null,
    { x, y, parentId: null },
  );
  return instance?.root ?? null;
}

export function syncDocumentComponents(document) {
  if (!document || !Array.isArray(document.pages)) return document;
  repairComponentMetadata(document);
  const definitions = new Map((document.components ?? []).map((component) => [component.id, component]));

  for (const component of definitions.values()) {
    const source = getComponentSource(document, component.id);
    if (source && component.name !== source.node.name) {
      component.name = source.node.name;
      component.updatedAt = new Date().toISOString();
    }
  }

  for (const page of document.pages) {
    const instanceIds = page.nodes
      .filter((node) => isComponentInstanceRoot(node) && definitions.has(node.componentId))
      .map((node) => node.id);
    for (const instanceId of instanceIds) {
      const root = getNode(page, instanceId);
      if (!root || !isComponentInstanceRoot(root)) continue;
      const source = getComponentSource(document, root.componentId);
      if (!source) {
        detachComponentInstance(page, root);
        continue;
      }
      materializeInstance(page, source.page, source.component, source.node, root);
    }
    clearOrphanInstanceMetadata(page);
    sortNodesByHierarchy(page);
  }

  return document;
}

export function recordComponentOverride(document, page, target, property) {
  if (!isComponentOverrideProperty(property)) return false;
  const node = typeof target === "string" ? getNode(page, target) : target;
  const root = getComponentInstanceRoot(page, node);
  if (!node || !root || (node === root && INSTANCE_ROOT_EXTERNAL_PROPERTIES.has(property))) return false;
  const source = getComponentSourceNode(document, root.componentId, node.componentSourceId);
  if (!source) return false;

  const normalized = normalizeNode({ ...cloneValue(node), [property]: cloneValue(node[property]) });
  const sourceNormalized = normalizeNode({ ...cloneValue(source), [property]: cloneValue(source[property]) });
  const overrides = cloneValue(root.componentOverrides ?? {});
  const sourceId = node.componentSourceId;
  const nextValue = normalized[property];
  const sourceValue = sourceNormalized[property];

  if (sameValue(nextValue, sourceValue)) {
    if (!overrides[sourceId]) return false;
    delete overrides[sourceId][property];
    if (!Object.keys(overrides[sourceId]).length) delete overrides[sourceId];
  } else {
    overrides[sourceId] ??= {};
    overrides[sourceId][property] = cloneValue(nextValue);
  }
  root.componentOverrides = overrides;
  return true;
}

export function resetComponentOverrides(document, page, target) {
  const root = getComponentInstanceRoot(page, target);
  if (!root) return null;
  root.componentOverrides = {};
  syncDocumentComponents(document);
  return getNode(page, root.id);
}

export function detachComponentInstance(page, target) {
  const root = getComponentInstanceRoot(page, target);
  if (!root) return null;
  for (const node of getNodesWithDescendants(page, [root.id])) clearComponentMetadata(node);
  sortNodesByHierarchy(page);
  return root;
}

function materializeInstance(targetPage, sourcePage, component, sourceRoot, existingRoot, placement = null) {
  const sourceBranch = getNodesWithDescendants(sourcePage, [sourceRoot.id]);
  if (!sourceBranch.length) return null;
  const existingBranch = existingRoot ? getNodesWithDescendants(targetPage, [existingRoot.id]) : [];
  const existingBySourceId = new Map(existingBranch
    .filter((node) => node.componentId === component.id && node.componentSourceId)
    .map((node) => [node.componentSourceId, node]));
  const preserve = existingRoot
    ? captureInstancePlacement(targetPage, existingRoot)
    : {
        parentId: placement?.parentId ?? null,
        x: finitePosition(placement?.x, sourceRoot.x),
        y: finitePosition(placement?.y, sourceRoot.y),
      };
  const idBySourceId = new Map();
  for (const sourceNode of sourceBranch) {
    const existing = existingBySourceId.get(sourceNode.id);
    idBySourceId.set(sourceNode.id, existing?.type === sourceNode.type ? existing.id : makeId(sourceNode.type));
  }

  const rootOffsetX = preserve.x - sourceRoot.x;
  const rootOffsetY = preserve.y - sourceRoot.y;
  const overrides = cloneValue(existingRoot?.componentOverrides ?? {});
  const nodes = sourceBranch.map((sourceNode) => {
    const node = cloneValue(sourceNode);
    node.id = idBySourceId.get(sourceNode.id);
    node.parentId = sourceNode.id === sourceRoot.id
      ? preserve.parentId
      : idBySourceId.get(sourceNode.parentId) ?? null;
    node.x = sourceNode.x + rootOffsetX;
    node.y = sourceNode.y + rootOffsetY;
    node.componentId = component.id;
    node.componentRole = sourceNode.id === sourceRoot.id
      ? COMPONENT_ROLES.INSTANCE
      : COMPONENT_ROLES.INSTANCE_CHILD;
    node.componentSourceId = sourceNode.id;
    node.componentOverrides = {};
    applyOverrides(node, overrides[sourceNode.id]);
    return node;
  });
  const root = nodes.find((node) => node.componentSourceId === sourceRoot.id);
  if (!root) return null;
  applyInstancePlacement(root, preserve);
  root.componentOverrides = overrides;

  replaceBranch(targetPage, existingBranch, nodes, existingRoot?.id ?? null);
  sortNodesByHierarchy(targetPage);
  return { root: getNode(targetPage, root.id), nodes };
}

function tagSourceBranch(page, sourceRoot, componentId) {
  for (const node of getNodesWithDescendants(page, [sourceRoot.id])) {
    node.componentId = componentId;
    node.componentRole = node.id === sourceRoot.id ? COMPONENT_ROLES.MAIN : COMPONENT_ROLES.SOURCE;
    node.componentSourceId = node.id;
    node.componentOverrides = {};
  }
}

function isComponentManagedSelection(page, node) {
  return getNodesWithDescendants(page, [node.id]).some(isComponentSource) ||
    getNodesWithDescendants(page, [node.id]).some(isComponentInstanceMember) ||
    getAncestors(page, node).some((ancestor) => isComponentSource(ancestor) || isComponentInstanceMember(ancestor));
}

function captureInstancePlacement(page, root) {
  const parent = root.parentId ? getNode(page, root.parentId) : null;
  return {
    parentId: parent && isContainerNode(parent) ? parent.id : null,
    x: root.x,
    y: root.y,
    layoutSizingHorizontal: root.layoutSizingHorizontal,
    layoutSizingVertical: root.layoutSizingVertical,
    layoutPositioning: root.layoutPositioning,
    constraintHorizontal: root.constraintHorizontal,
    constraintVertical: root.constraintVertical,
  };
}

function applyInstancePlacement(root, placement) {
  for (const property of INSTANCE_ROOT_EXTERNAL_PROPERTIES) {
    if (placement[property] !== undefined) root[property] = placement[property];
  }
}

function applyOverrides(node, properties) {
  if (!properties || typeof properties !== "object") return;
  for (const [property, value] of Object.entries(properties)) {
    if (!isComponentOverrideProperty(property)) continue;
    const normalized = normalizeNode({ ...cloneValue(node), [property]: cloneValue(value) });
    node[property] = cloneValue(normalized[property]);
  }
}

function replaceBranch(page, existingBranch, nextNodes, rootId) {
  if (!existingBranch.length) {
    page.nodes.push(...nextNodes);
    return;
  }
  const existingIds = new Set(existingBranch.map((node) => node.id));
  const rootIndex = Math.max(0, page.nodes.findIndex((node) => node.id === rootId));
  const before = page.nodes.slice(0, rootIndex).filter((node) => !existingIds.has(node.id));
  const after = page.nodes.slice(rootIndex).filter((node) => !existingIds.has(node.id));
  page.nodes = [...before, ...nextNodes, ...after];
}

function clearOrphanInstanceMetadata(page) {
  const instanceMemberIds = new Set();
  for (const root of page.nodes.filter(isComponentInstanceRoot)) {
    for (const node of getNodesWithDescendants(page, [root.id])) instanceMemberIds.add(node.id);
  }
  for (const node of page.nodes) {
    if (node.componentRole === COMPONENT_ROLES.INSTANCE_CHILD && !instanceMemberIds.has(node.id)) {
      clearComponentMetadata(node);
    }
  }
}

function finitePosition(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneValue(value) {
  return globalThis.structuredClone
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}
