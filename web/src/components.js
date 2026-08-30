import {
  COMPONENT_ROLES,
  clearComponentMetadata,
  getAncestors,
  getChildNodes,
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

export function getComponentSet(document, componentSetId) {
  return document?.componentSets?.find((componentSet) => componentSet.id === componentSetId) ?? null;
}

export function getComponentSetComponents(document, componentSetId) {
  return (document?.components ?? []).filter((component) => component.componentSetId === componentSetId);
}

export function getComponentVariantControls(document, componentId) {
  const component = getComponentDefinition(document, componentId);
  const componentSet = component ? getComponentSet(document, component.componentSetId) : null;
  if (!component || !componentSet) return [];
  const members = getComponentSetComponents(document, componentSet.id);
  return componentSet.propertyNames.map((propertyName) => {
    const candidates = members.filter((candidate) => componentSet.propertyNames.every((name) =>
      name === propertyName || candidate.variantProperties[name] === component.variantProperties[name]));
    return {
      propertyName,
      value: component.variantProperties[propertyName],
      options: candidates.map((candidate) => ({
        value: candidate.variantProperties[propertyName],
        componentId: candidate.id,
      })),
    };
  });
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

export function getComponentOverrideEntries(document, page, target) {
  const root = getComponentInstanceRoot(page, target);
  const source = root ? getComponentSource(document, root.componentId) : null;
  if (!root || !source) return [];

  const instanceBySourceId = new Map(getNodesWithDescendants(page, [root.id])
    .filter((node) => node.componentSourceId)
    .map((node) => [node.componentSourceId, node]));
  const sourceNodes = getNodesWithDescendants(source.page, [source.node.id]);
  const sourceOrder = new Map(sourceNodes.map((node, index) => [node.id, index]));
  const entries = [];

  for (const [sourceNodeId, properties] of Object.entries(root.componentOverrides ?? {})) {
    const sourceNode = getNode(source.page, sourceNodeId);
    if (!sourceNode || !properties || typeof properties !== "object") continue;
    const instanceNode = instanceBySourceId.get(sourceNodeId) ?? null;
    const normalizedSource = normalizeNode(cloneValue(sourceNode));
    for (const [property, value] of Object.entries(properties)) {
      if (!isComponentOverrideProperty(property)) continue;
      entries.push({
        sourceNodeId,
        nodeId: instanceNode?.id ?? null,
        nodeName: sourceNode.name || instanceNode?.name || "Layer",
        property,
        value: cloneValue(value),
        sourceValue: cloneValue(normalizedSource[property]),
      });
    }
  }

  return entries.sort((left, right) =>
    (sourceOrder.get(left.sourceNodeId) ?? Number.MAX_SAFE_INTEGER) -
      (sourceOrder.get(right.sourceNodeId) ?? Number.MAX_SAFE_INTEGER) ||
    left.property.localeCompare(right.property));
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
    componentSetId: null,
    variantProperties: {},
    createdAt: now,
    updatedAt: now,
  };
  if (!Array.isArray(document.components)) document.components = [];
  document.components.push(component);
  tagSourceBranch(page, source, component.id);
  sortNodesByHierarchy(page);
  return { component, source, error: null };
}

export function createComponentSet(document, componentIds, options = {}) {
  const components = [...new Set(componentIds ?? [])]
    .map((id) => getComponentDefinition(document, id))
    .filter(Boolean);
  if (components.length < 2) {
    return { componentSet: null, components: [], error: "Select at least two main components." };
  }
  if (components.some((component) => component.componentSetId)) {
    return {
      componentSet: null,
      components: [],
      error: "One or more selected components already belong to a variant set.",
    };
  }

  const inferred = inferVariantDefinition(components);
  const now = new Date().toISOString();
  const componentSet = {
    id: makeId("component-set"),
    name: cleanVariantLabel(options.name, inferred.name, 120),
    propertyNames: inferred.propertyNames,
    createdAt: now,
    updatedAt: now,
  };
  document.componentSets ??= [];
  document.componentSets.push(componentSet);
  for (const [index, component] of components.entries()) {
    component.componentSetId = componentSet.id;
    component.variantProperties = inferred.variants[index];
    component.updatedAt = now;
  }
  repairComponentMetadata(document);
  return {
    componentSet: getComponentSet(document, componentSet.id),
    components: getComponentSetComponents(document, componentSet.id),
    error: null,
  };
}

export function dissolveComponentSet(document, componentSetId) {
  const componentSet = getComponentSet(document, componentSetId);
  if (!componentSet) return [];
  const members = getComponentSetComponents(document, componentSetId);
  for (const component of members) {
    component.componentSetId = null;
    component.variantProperties = {};
  }
  document.componentSets = document.componentSets.filter((item) => item.id !== componentSetId);
  return members;
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

export function resetComponentOverride(document, page, target, sourceNodeId, property) {
  const root = getComponentInstanceRoot(page, target);
  if (!root || !isComponentOverrideProperty(property) ||
      !Object.prototype.hasOwnProperty.call(root.componentOverrides?.[sourceNodeId] ?? {}, property)) {
    return null;
  }
  const rootId = root.id;
  const overrides = cloneValue(root.componentOverrides);
  delete overrides[sourceNodeId][property];
  if (!Object.keys(overrides[sourceNodeId]).length) delete overrides[sourceNodeId];
  root.componentOverrides = overrides;
  syncDocumentComponents(document);
  return getNode(page, rootId);
}

export function swapComponentInstance(document, page, target, nextComponentId) {
  const root = getComponentInstanceRoot(page, target);
  const previousSource = root ? getComponentSource(document, root.componentId) : null;
  const nextSource = getComponentSource(document, nextComponentId);
  if (!root || !previousSource || !nextSource) {
    return {
      root: null,
      transferredOverrides: 0,
      droppedOverrides: 0,
      error: "That component instance or source is no longer available.",
    };
  }
  if (root.componentId === nextComponentId) {
    return {
      root,
      transferredOverrides: countOverrideProperties(root.componentOverrides),
      droppedOverrides: 0,
      error: null,
    };
  }

  const previousPaths = buildSemanticPaths(previousSource.page, previousSource.node);
  const nextPaths = buildSemanticPaths(nextSource.page, nextSource.node);
  const nextSourceIdByPath = new Map([...nextPaths.entries()].map(([sourceId, path]) => [path, sourceId]));
  const nextSourceById = new Map(getNodesWithDescendants(nextSource.page, [nextSource.node.id])
    .map((node) => [node.id, node]));
  const nextSourceIdByPreviousId = new Map();
  for (const [previousSourceId, path] of previousPaths) {
    const nextSourceId = nextSourceIdByPath.get(path);
    if (nextSourceId) nextSourceIdByPreviousId.set(previousSourceId, nextSourceId);
  }

  const remappedOverrides = {};
  let transferredOverrides = 0;
  let droppedOverrides = 0;
  for (const [previousSourceId, properties] of Object.entries(root.componentOverrides ?? {})) {
    const nextSourceId = nextSourceIdByPreviousId.get(previousSourceId);
    const nextSourceNode = nextSourceById.get(nextSourceId);
    for (const [property, value] of Object.entries(properties ?? {})) {
      const nextValue = normalizeOverrideForNode(nextSourceNode, property, value);
      if (nextValue === undefined) {
        droppedOverrides += 1;
        continue;
      }
      const sourceValue = normalizeNode(cloneValue(nextSourceNode))[property];
      if (sameValue(nextValue, sourceValue)) {
        droppedOverrides += 1;
        continue;
      }
      remappedOverrides[nextSourceId] ??= {};
      remappedOverrides[nextSourceId][property] = cloneValue(nextValue);
      transferredOverrides += 1;
    }
  }

  for (const node of getNodesWithDescendants(page, [root.id])) {
    const nextSourceId = nextSourceIdByPreviousId.get(node.componentSourceId);
    if (!nextSourceId) continue;
    node.componentId = nextComponentId;
    node.componentSourceId = nextSourceId;
  }
  root.componentId = nextComponentId;
  root.componentSourceId = nextSource.node.id;
  root.componentOverrides = remappedOverrides;
  const materialized = materializeInstance(
    page,
    nextSource.page,
    nextSource.component,
    nextSource.node,
    root,
  );
  return {
    root: materialized?.root ?? null,
    transferredOverrides,
    droppedOverrides,
    error: materialized ? null : "Could not swap that component instance.",
  };
}

export function selectComponentVariant(document, page, target, propertyName, value) {
  const root = getComponentInstanceRoot(page, target);
  const component = root ? getComponentDefinition(document, root.componentId) : null;
  const componentSet = component ? getComponentSet(document, component.componentSetId) : null;
  if (!root || !component || !componentSet || !componentSet.propertyNames.includes(propertyName)) {
    return {
      root: null,
      component: null,
      transferredOverrides: 0,
      droppedOverrides: 0,
      error: "That variant control is no longer available.",
    };
  }
  const nextComponent = getComponentSetComponents(document, componentSet.id).find((candidate) =>
    componentSet.propertyNames.every((name) => candidate.variantProperties[name] === (
      name === propertyName ? value : component.variantProperties[name]
    )));
  if (!nextComponent) {
    return {
      root: null,
      component: null,
      transferredOverrides: 0,
      droppedOverrides: 0,
      error: `No ${propertyName}=${value} variant exists for the current combination.`,
    };
  }
  return {
    ...swapComponentInstance(document, page, root, nextComponent.id),
    component: nextComponent,
  };
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

function buildSemanticPaths(page, sourceRoot) {
  const paths = new Map([[sourceRoot.id, JSON.stringify([])]]);
  const visit = (parent, parentPath) => {
    const occurrences = new Map();
    for (const child of getChildNodes(page, parent.id)) {
      const identity = `${child.type}\u0000${child.name}`;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      const path = [...parentPath, [child.type, child.name, occurrence]];
      paths.set(child.id, JSON.stringify(path));
      visit(child, path);
    }
  };
  visit(sourceRoot, []);
  return paths;
}

function inferVariantDefinition(components) {
  const splitNames = components.map((component) => {
    const parts = component.name.split(/\s+\/\s+/);
    return parts.length > 1
      ? { prefix: parts.shift().trim(), value: parts.join(" / ").trim() }
      : { prefix: null, value: component.name.trim() };
  });
  const sharedPrefix = splitNames[0].prefix && splitNames.every((item) => item.prefix === splitNames[0].prefix)
    ? splitNames[0].prefix
    : null;
  const labels = splitNames.map((item, index) => item.value || components[index].name || `Variant ${index + 1}`);
  const parsed = labels.map(parseVariantLabel);
  const propertyNames = parsed[0]?.propertyNames ?? [];
  const hasStructuredLabels = propertyNames.length > 0 && parsed.every((item) =>
    sameValue(item.propertyNames, propertyNames));
  if (hasStructuredLabels) {
    return {
      name: sharedPrefix ?? "Local variants",
      propertyNames,
      variants: makeVariantCombinationsUnique(parsed.map((item) => item.properties), propertyNames),
    };
  }
  return {
    name: sharedPrefix ?? "Local variants",
    propertyNames: ["Variant"],
    variants: makeVariantCombinationsUnique(
      labels.map((label, index) => ({ Variant: cleanVariantLabel(label, `Variant ${index + 1}`, 120) })),
      ["Variant"],
    ),
  };
}

function parseVariantLabel(label) {
  const properties = {};
  const propertyNames = [];
  for (const token of label.split(/\s*,\s*/)) {
    const separator = token.indexOf("=");
    if (separator <= 0) return { propertyNames: [], properties: {} };
    const propertyName = cleanVariantLabel(token.slice(0, separator), "", 80);
    const value = cleanVariantLabel(token.slice(separator + 1), "Default", 120);
    if (!propertyName || propertyNames.some((name) => name.toLowerCase() === propertyName.toLowerCase())) {
      return { propertyNames: [], properties: {} };
    }
    propertyNames.push(propertyName);
    properties[propertyName] = value;
  }
  return { propertyNames, properties };
}

function makeVariantCombinationsUnique(variants, propertyNames) {
  const seen = new Set();
  const lastProperty = propertyNames.at(-1);
  return variants.map((variant, index) => {
    const result = cloneValue(variant);
    const base = result[lastProperty] || `Variant ${index + 1}`;
    let key = JSON.stringify(propertyNames.map((name) => result[name]));
    let suffix = 2;
    while (seen.has(key)) {
      result[lastProperty] = cleanVariantLabel(`${base} ${suffix}`, `Variant ${index + 1}`, 120);
      key = JSON.stringify(propertyNames.map((name) => result[name]));
      suffix += 1;
    }
    seen.add(key);
    return result;
  });
}

function cleanVariantLabel(value, fallback, maximumLength) {
  const normalized = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return (normalized || fallback).slice(0, maximumLength);
}

function normalizeOverrideForNode(node, property, value) {
  if (!node || !isComponentOverrideProperty(property)) return undefined;
  const normalizedSource = normalizeNode(cloneValue(node));
  if (!Object.prototype.hasOwnProperty.call(normalizedSource, property)) return undefined;
  const normalized = normalizeNode({ ...cloneValue(node), [property]: cloneValue(value) });
  return cloneValue(normalized[property]);
}

function countOverrideProperties(overrides) {
  return Object.values(overrides ?? {}).reduce(
    (count, properties) => count + Object.keys(properties ?? {}).length,
    0,
  );
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
  if (value === undefined) return undefined;
  return globalThis.structuredClone
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}
