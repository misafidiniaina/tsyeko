import {
  COUNTER_AXIS_ALIGNS,
  createNode,
  getAncestors,
  getChildNodes,
  getNode,
  getNodeAABB,
  getNodesWithDescendants,
  getTopLevelNodeIds,
  HORIZONTAL_CONSTRAINTS,
  LAYOUT_MODES,
  LAYOUT_POSITIONING,
  LAYOUT_SIZING,
  NODE_TYPES,
  PRIMARY_AXIS_ALIGNS,
  reorderNode,
  sortNodesByHierarchy,
  syncGroupBounds,
  VERTICAL_CONSTRAINTS,
} from "./model.js";
import { scaleVectorPoint } from "./vector.js";
import { intrinsicTextSize } from "./text.js";

const EPSILON = 0.001;
const MIN_SIZE = 1;
const MAX_LAYOUT_PASSES = 12;
const AUTO_BOUNDS_TYPES = new Set([
  NODE_TYPES.GROUP,
  NODE_TYPES.BOOLEAN,
  NODE_TYPES.MASK,
]);

export function isAutoLayoutFrame(node) {
  return node?.type === NODE_TYPES.FRAME && node.layoutMode !== LAYOUT_MODES.NONE;
}

export function isAutoLayoutChild(document, node) {
  const parent = node?.parentId ? getNode(document, node.parentId) : null;
  return Boolean(
    isAutoLayoutFrame(parent) &&
    node.visible !== false &&
    node.layoutPositioning !== LAYOUT_POSITIONING.ABSOLUTE,
  );
}

export function resolvePageLayout(document) {
  let changed = false;
  for (let pass = 0; pass < MAX_LAYOUT_PASSES; pass += 1) {
    let passChanged = false;
    const frames = document.nodes
      .filter(isAutoLayoutFrame)
      .sort((left, right) => getAncestors(document, right).length - getAncestors(document, left).length);
    for (const frame of frames) {
      passChanged = layoutFrame(document, frame) || passChanged;
    }
    changed = changed || passChanged;
    if (!passChanged) break;
  }
  return changed;
}

export function createResolvedLayoutSnapshot(document) {
  const snapshot = globalThis.structuredClone
    ? globalThis.structuredClone(document)
    : JSON.parse(JSON.stringify(document));
  syncGroupBounds(snapshot);
  resolvePageLayout(snapshot);
  syncGroupBounds(snapshot);
  return snapshot;
}

function layoutFrame(document, frame) {
  const horizontal = frame.layoutMode === LAYOUT_MODES.HORIZONTAL;
  const children = getChildNodes(document, frame.id)
    .filter((node) => node.visible !== false && node.layoutPositioning !== LAYOUT_POSITIONING.ABSOLUTE);
  const paddingMainStart = horizontal ? frame.paddingLeft : frame.paddingTop;
  const paddingMainEnd = horizontal ? frame.paddingRight : frame.paddingBottom;
  const paddingCrossStart = horizontal ? frame.paddingTop : frame.paddingLeft;
  const paddingCrossEnd = horizontal ? frame.paddingBottom : frame.paddingRight;
  const mainSizing = horizontal ? frame.layoutSizingHorizontal : frame.layoutSizingVertical;
  const crossSizing = horizontal ? frame.layoutSizingVertical : frame.layoutSizingHorizontal;
  let changed = false;

  for (const child of children) {
    if (child.type !== NODE_TYPES.TEXT || !canResize(child)) continue;
    let targetWidth = child.width;
    if (child.layoutSizingHorizontal === LAYOUT_SIZING.HUG) {
      targetWidth = clampSize(child, true, intrinsicTextSize(child).width);
    }
    let targetHeight = child.height;
    if (child.layoutSizingVertical === LAYOUT_SIZING.HUG) {
      targetHeight = clampSize(child, false, intrinsicTextSize(child, targetWidth).height);
    }
    changed = resizeNode(document, child, true, targetWidth, targetHeight) || changed;
  }

  const childMainTotal = children.reduce((total, child) => total + mainSize(child, horizontal), 0);
  const singleLineMetrics = crossLineMetrics(children, horizontal, frame.counterAxisAlign);
  const childCrossMax = singleLineMetrics.size;
  const fixedGaps = frame.layoutGap * Math.max(0, children.length - 1);

  if (mainSizing === LAYOUT_SIZING.HUG) {
    changed = setFrameAxisSize(
      frame,
      horizontal,
      clampSize(frame, horizontal, paddingMainStart + childMainTotal + fixedGaps + paddingMainEnd),
    ) || changed;
  }
  if (frame.layoutWrap && children.length) {
    return layoutWrappedFrame(document, frame, children, horizontal, changed);
  }
  if (crossSizing === LAYOUT_SIZING.HUG) {
    changed = setFrameAxisSize(
      frame,
      !horizontal,
      clampSize(frame, !horizontal, paddingCrossStart + childCrossMax + paddingCrossEnd),
    ) || changed;
  }
  if (!children.length) return changed;

  const innerMain = Math.max(0, mainSize(frame, horizontal) - paddingMainStart - paddingMainEnd);
  const innerCross = Math.max(0, crossSize(frame, horizontal) - paddingCrossStart - paddingCrossEnd);
  const fillMainChildren = mainSizing === LAYOUT_SIZING.HUG
    ? []
    : children.filter((child) => childSizing(child, horizontal) === LAYOUT_SIZING.FILL && canResize(child));
  const nonFillMain = children.reduce(
    (total, child) => total + (fillMainChildren.includes(child) ? 0 : mainSize(child, horizontal)),
    0,
  );
  const availableForFill = Math.max(0, innerMain - fixedGaps - nonFillMain);
  const fillMainSizes = distributeFillSpace(fillMainChildren, horizontal, availableForFill);

  for (const child of children) {
    let targetMain = mainSize(child, horizontal);
    let targetCross = crossSize(child, horizontal);
    if (fillMainSizes.has(child)) targetMain = fillMainSizes.get(child);
    if (
      canResize(child) &&
      (childSizing(child, !horizontal) === LAYOUT_SIZING.FILL ||
        frame.counterAxisAlign === COUNTER_AXIS_ALIGNS.STRETCH)
    ) {
      targetCross = innerCross;
    }
    changed = resizeNode(document, child, horizontal, targetMain, targetCross) || changed;
  }

  const occupiedMain = children.reduce((total, child) => total + mainSize(child, horizontal), 0);
  let gap = frame.layoutGap;
  let freeMain = innerMain - occupiedMain - gap * Math.max(0, children.length - 1);
  let mainOffset = 0;
  if (frame.primaryAxisAlign === PRIMARY_AXIS_ALIGNS.SPACE_BETWEEN && children.length > 1) {
    gap = Math.max(0, (innerMain - occupiedMain) / (children.length - 1));
    freeMain = 0;
  } else if (frame.primaryAxisAlign === PRIMARY_AXIS_ALIGNS.CENTER) {
    mainOffset = freeMain / 2;
  } else if (frame.primaryAxisAlign === PRIMARY_AXIS_ALIGNS.END) {
    mainOffset = freeMain;
  }

  let cursor = mainOrigin(frame, horizontal) + paddingMainStart + mainOffset;
  const crossOriginValue = crossOrigin(frame, horizontal) + paddingCrossStart;
  for (const child of children) {
    const availableCrossSpace = innerCross - crossSize(child, horizontal);
    let crossOffset = 0;
    if (frame.counterAxisAlign === COUNTER_AXIS_ALIGNS.CENTER) {
      crossOffset = availableCrossSpace / 2;
    } else if (frame.counterAxisAlign === COUNTER_AXIS_ALIGNS.END) {
      crossOffset = availableCrossSpace;
    } else if (horizontal && frame.counterAxisAlign === COUNTER_AXIS_ALIGNS.BASELINE) {
      crossOffset = singleLineMetrics.baseline - baselineOffset(child);
    }
    const x = horizontal ? cursor : crossOriginValue + crossOffset;
    const y = horizontal ? crossOriginValue + crossOffset : cursor;
    changed = moveBranch(document, child, x, y) || changed;
    cursor += mainSize(child, horizontal) + gap;
  }
  return changed;
}

function layoutWrappedFrame(document, frame, children, horizontal, initialChanged) {
  const paddingMainStart = horizontal ? frame.paddingLeft : frame.paddingTop;
  const paddingMainEnd = horizontal ? frame.paddingRight : frame.paddingBottom;
  const paddingCrossStart = horizontal ? frame.paddingTop : frame.paddingLeft;
  const paddingCrossEnd = horizontal ? frame.paddingBottom : frame.paddingRight;
  const mainSizing = horizontal ? frame.layoutSizingHorizontal : frame.layoutSizingVertical;
  const crossSizing = horizontal ? frame.layoutSizingVertical : frame.layoutSizingHorizontal;
  const innerMain = Math.max(0, mainSize(frame, horizontal) - paddingMainStart - paddingMainEnd);
  const lines = [];
  let line = [];
  let occupied = 0;
  for (const child of children) {
    const fill = mainSizing !== LAYOUT_SIZING.HUG &&
      childSizing(child, horizontal) === LAYOUT_SIZING.FILL && canResize(child);
    const basis = fill ? clampSize(child, horizontal, MIN_SIZE) : mainSize(child, horizontal);
    const required = line.length ? frame.layoutGap + basis : basis;
    if (line.length && occupied + required > innerMain + EPSILON) {
      lines.push(line);
      line = [];
      occupied = 0;
    }
    line.push(child);
    occupied += (line.length > 1 ? frame.layoutGap : 0) + basis;
  }
  if (line.length) lines.push(line);

  let changed = initialChanged;
  const lineCrossSizes = [];
  for (const items of lines) {
    const fillChildren = mainSizing === LAYOUT_SIZING.HUG ? [] : items.filter((child) =>
      childSizing(child, horizontal) === LAYOUT_SIZING.FILL && canResize(child));
    const fixedMain = items.reduce((total, child) =>
      total + (fillChildren.includes(child) ? 0 : mainSize(child, horizontal)), 0);
    const available = Math.max(0, innerMain - frame.layoutGap * Math.max(0, items.length - 1) - fixedMain);
    const fillSizes = distributeFillSpace(fillChildren, horizontal, available);
    for (const child of items) {
      const targetMain = fillSizes.get(child) ?? mainSize(child, horizontal);
      changed = resizeNode(document, child, horizontal, targetMain, crossSize(child, horizontal)) || changed;
    }
    lineCrossSizes.push(crossLineMetrics(items, horizontal, frame.counterAxisAlign));
  }

  const contentCross = lineCrossSizes.reduce((total, metrics) => total + metrics.size, 0) +
    frame.layoutGap * Math.max(0, lines.length - 1);
  if (crossSizing === LAYOUT_SIZING.HUG) {
    changed = setFrameAxisSize(frame, !horizontal,
      clampSize(frame, !horizontal, paddingCrossStart + contentCross + paddingCrossEnd)) || changed;
  }

  let crossCursor = crossOrigin(frame, horizontal) + paddingCrossStart;
  for (let index = 0; index < lines.length; index += 1) {
    const items = lines[index];
    const lineMetrics = lineCrossSizes[index];
    const lineCross = lineMetrics.size;
    for (const child of items) {
      if (canResize(child) && (childSizing(child, !horizontal) === LAYOUT_SIZING.FILL ||
        frame.counterAxisAlign === COUNTER_AXIS_ALIGNS.STRETCH)) {
        changed = resizeNode(document, child, horizontal, mainSize(child, horizontal), lineCross) || changed;
      }
    }
    const occupiedMain = items.reduce((total, child) => total + mainSize(child, horizontal), 0);
    let gap = frame.layoutGap;
    const freeMain = innerMain - occupiedMain - gap * Math.max(0, items.length - 1);
    let mainOffset = frame.primaryAxisAlign === PRIMARY_AXIS_ALIGNS.CENTER ? freeMain / 2 :
      frame.primaryAxisAlign === PRIMARY_AXIS_ALIGNS.END ? freeMain : 0;
    if (frame.primaryAxisAlign === PRIMARY_AXIS_ALIGNS.SPACE_BETWEEN && items.length > 1) {
      gap = Math.max(0, (innerMain - occupiedMain) / (items.length - 1));
      mainOffset = 0;
    }
    let mainCursor = mainOrigin(frame, horizontal) + paddingMainStart + mainOffset;
    for (const child of items) {
      const freeCross = lineCross - crossSize(child, horizontal);
      const crossOffset = frame.counterAxisAlign === COUNTER_AXIS_ALIGNS.CENTER ? freeCross / 2 :
        frame.counterAxisAlign === COUNTER_AXIS_ALIGNS.END ? freeCross :
          horizontal && frame.counterAxisAlign === COUNTER_AXIS_ALIGNS.BASELINE
            ? lineMetrics.baseline - baselineOffset(child) : 0;
      changed = moveBranch(document, child,
        horizontal ? mainCursor : crossCursor + crossOffset,
        horizontal ? crossCursor + crossOffset : mainCursor) || changed;
      mainCursor += mainSize(child, horizontal) + gap;
    }
    crossCursor += lineCross + frame.layoutGap;
  }
  return changed;
}

function baselineOffset(node) {
  return node.type === NODE_TYPES.TEXT
    ? Math.min(node.height, node.fontSize * 0.8)
    : node.height;
}

function crossLineMetrics(children, horizontal, alignment) {
  if (horizontal && alignment === COUNTER_AXIS_ALIGNS.BASELINE && children.length) {
    const baseline = children.reduce((maximum, child) => Math.max(maximum, baselineOffset(child)), 0);
    const descent = children.reduce((maximum, child) =>
      Math.max(maximum, child.height - baselineOffset(child)), 0);
    return { size: baseline + descent, baseline };
  }
  return {
    size: children.reduce((maximum, child) => Math.max(maximum, crossSize(child, horizontal)), 0),
    baseline: 0,
  };
}

function clampSize(node, horizontal, value) {
  const minimum = horizontal ? node.minWidth : node.minHeight;
  const maximum = horizontal ? node.maxWidth : node.maxHeight;
  return Math.min(maximum, Math.max(minimum, value));
}

function distributeFillSpace(children, horizontal, available) {
  const sizes = new Map();
  const pending = new Set(children);
  let remaining = available;
  while (pending.size) {
    const share = remaining / pending.size;
    const constrained = [...pending].filter((child) => !almostEqual(clampSize(child, horizontal, share), share));
    if (!constrained.length) {
      for (const child of pending) sizes.set(child, share);
      break;
    }
    for (const child of constrained) {
      const size = clampSize(child, horizontal, share);
      sizes.set(child, size);
      remaining -= size;
      pending.delete(child);
    }
  }
  return sizes;
}

export function resizeFrameChildren(document, originalFrame, resizedFrame, originalNodes) {
  if (!originalFrame || !resizedFrame || resizedFrame.type !== NODE_TYPES.FRAME) return false;
  const snapshots = toSnapshotMap(originalNodes);
  let changed = false;
  const children = getChildNodes(document, resizedFrame.id);
  for (const child of children) {
    if (isAutoLayoutFrame(resizedFrame) && child.layoutPositioning !== LAYOUT_POSITIONING.ABSOLUTE) {
      continue;
    }
    const source = snapshots.get(child.id);
    if (!source) continue;
    const target = constrainedBox(source, originalFrame, resizedFrame);
    changed = applySnapshotBox(document, child, source, target, snapshots) || changed;
    if (child.type === NODE_TYPES.FRAME) {
      changed = resizeFrameChildren(document, source, child, snapshots) || changed;
    }
  }
  return changed;
}

function constrainedBox(node, originalFrame, resizedFrame) {
  const horizontalScale = resizedFrame.width / Math.max(MIN_SIZE, originalFrame.width);
  const verticalScale = resizedFrame.height / Math.max(MIN_SIZE, originalFrame.height);
  const left = node.x - originalFrame.x;
  const right = originalFrame.x + originalFrame.width - node.x - node.width;
  const top = node.y - originalFrame.y;
  const bottom = originalFrame.y + originalFrame.height - node.y - node.height;
  const box = { x: node.x, y: node.y, width: node.width, height: node.height };

  if (node.constraintHorizontal === HORIZONTAL_CONSTRAINTS.RIGHT) {
    box.x = resizedFrame.x + resizedFrame.width - right - node.width;
  } else if (node.constraintHorizontal === HORIZONTAL_CONSTRAINTS.LEFT_RIGHT) {
    box.x = resizedFrame.x + left;
    box.width = Math.max(MIN_SIZE, resizedFrame.width - left - right);
  } else if (node.constraintHorizontal === HORIZONTAL_CONSTRAINTS.CENTER) {
    const centerOffset = node.x + node.width / 2 - (originalFrame.x + originalFrame.width / 2);
    box.x = resizedFrame.x + resizedFrame.width / 2 + centerOffset - node.width / 2;
  } else if (node.constraintHorizontal === HORIZONTAL_CONSTRAINTS.SCALE) {
    box.x = resizedFrame.x + left * horizontalScale;
    box.width = Math.max(MIN_SIZE, node.width * horizontalScale);
  } else {
    box.x = resizedFrame.x + left;
  }

  if (node.constraintVertical === VERTICAL_CONSTRAINTS.BOTTOM) {
    box.y = resizedFrame.y + resizedFrame.height - bottom - node.height;
  } else if (node.constraintVertical === VERTICAL_CONSTRAINTS.TOP_BOTTOM) {
    box.y = resizedFrame.y + top;
    box.height = Math.max(MIN_SIZE, resizedFrame.height - top - bottom);
  } else if (node.constraintVertical === VERTICAL_CONSTRAINTS.CENTER) {
    const centerOffset = node.y + node.height / 2 - (originalFrame.y + originalFrame.height / 2);
    box.y = resizedFrame.y + resizedFrame.height / 2 + centerOffset - node.height / 2;
  } else if (node.constraintVertical === VERTICAL_CONSTRAINTS.SCALE) {
    box.y = resizedFrame.y + top * verticalScale;
    box.height = Math.max(MIN_SIZE, node.height * verticalScale);
  } else {
    box.y = resizedFrame.y + top;
  }
  return box;
}

function applySnapshotBox(document, node, source, target, snapshots) {
  if (AUTO_BOUNDS_TYPES.has(node.type)) {
    const scaleX = target.width / Math.max(MIN_SIZE, source.width);
    const scaleY = target.height / Math.max(MIN_SIZE, source.height);
    let changed = false;
    for (const item of getNodesWithDescendants(document, [node.id])) {
      const itemSource = snapshots.get(item.id);
      if (!itemSource) continue;
      const itemTarget = {
        x: target.x + (itemSource.x - source.x) * scaleX,
        y: target.y + (itemSource.y - source.y) * scaleY,
        width: Math.max(MIN_SIZE, itemSource.width * scaleX),
        height: Math.max(MIN_SIZE, itemSource.height * scaleY),
      };
      changed = setGeometryFromSnapshot(item, itemSource, itemTarget) || changed;
    }
    return changed;
  }

  if (node.type === NODE_TYPES.FRAME) {
    const deltaX = target.x - source.x;
    const deltaY = target.y - source.y;
    let changed = setGeometryFromSnapshot(node, source, target);
    for (const descendant of getNodesWithDescendants(document, [node.id])) {
      if (descendant.id === node.id) continue;
      const descendantSource = snapshots.get(descendant.id);
      if (!descendantSource) continue;
      changed = setGeometryFromSnapshot(descendant, descendantSource, {
        x: descendantSource.x + deltaX,
        y: descendantSource.y + deltaY,
        width: descendantSource.width,
        height: descendantSource.height,
      }) || changed;
    }
    return changed;
  }
  return setGeometryFromSnapshot(node, source, target);
}

function setGeometryFromSnapshot(node, source, target) {
  let changed = false;
  changed = setNumber(node, "x", target.x) || changed;
  changed = setNumber(node, "y", target.y) || changed;
  changed = setNumber(node, "width", target.width) || changed;
  changed = setNumber(node, "height", target.height) || changed;
  if (node.type === NODE_TYPES.VECTOR && Array.isArray(source.vectorPoints)) {
    const scaleX = target.width / Math.max(MIN_SIZE, source.width);
    const scaleY = target.height / Math.max(MIN_SIZE, source.height);
    node.vectorPoints = source.vectorPoints.map((point) => scaleVectorPoint(point, scaleX, scaleY));
    node.vectorContours = (source.vectorContours ?? []).map((contour, index) => ({
      ...contour,
      points: index === 0
        ? node.vectorPoints
        : contour.points.map((point) => scaleVectorPoint(point, scaleX, scaleY)),
    }));
  }
  return changed;
}

export function createAutoLayoutFrame(document, ids, mode = LAYOUT_MODES.HORIZONTAL) {
  const layoutMode = mode === LAYOUT_MODES.VERTICAL ? LAYOUT_MODES.VERTICAL : LAYOUT_MODES.HORIZONTAL;
  const roots = getTopLevelNodeIds(document, ids)
    .map((id) => getNode(document, id))
    .filter(Boolean);
  if (!roots.length) return null;
  const parentId = roots[0].parentId ?? null;
  if (roots.some((node) => (node.parentId ?? null) !== parentId)) return null;

  const horizontal = layoutMode === LAYOUT_MODES.HORIZONTAL;
  const orderedRoots = [...roots].sort((left, right) => {
    const leftBox = getNodeAABB(left);
    const rightBox = getNodeAABB(right);
    return horizontal ? leftBox.x - rightBox.x : leftBox.y - rightBox.y;
  });
  const boxes = orderedRoots.map(getNodeAABB);
  const bounds = combinedBounds(boxes);
  const measuredGaps = boxes.slice(1).map((box, index) => {
    const previous = boxes[index];
    return horizontal
      ? box.x - previous.x - previous.width
      : box.y - previous.y - previous.height;
  });
  const positiveGaps = measuredGaps.filter((gap) => gap >= 0);
  const gap = positiveGaps.length
    ? Math.min(10_000, Math.round(positiveGaps.reduce((total, value) => total + value, 0) / positiveGaps.length))
    : 16;
  const padding = 16;
  const frame = createNode(NODE_TYPES.FRAME, bounds.x - padding, bounds.y - padding, {
    name: "Auto layout",
    parentId,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
    layoutMode,
    layoutGap: gap,
    paddingTop: padding,
    paddingRight: padding,
    paddingBottom: padding,
    paddingLeft: padding,
    layoutSizingHorizontal: LAYOUT_SIZING.HUG,
    layoutSizingVertical: LAYOUT_SIZING.HUG,
    fill: "transparent",
    stroke: "transparent",
    strokeWidth: 0,
    shadow: { enabled: false },
  });

  const branchMap = new Map(orderedRoots.map((root) => [
    root.id,
    getNodesWithDescendants(document, [root.id]),
  ]));
  const selectedIds = new Set([...branchMap.values()].flat().map((node) => node.id));
  const firstIndex = Math.min(...roots.map((node) => document.nodes.indexOf(node)));
  const remaining = document.nodes.filter((node) => !selectedIds.has(node.id));
  const insertIndex = document.nodes
    .slice(0, firstIndex)
    .filter((node) => !selectedIds.has(node.id)).length;
  for (const root of orderedRoots) root.parentId = frame.id;
  document.nodes = [
    ...remaining.slice(0, insertIndex),
    frame,
    ...orderedRoots.flatMap((root) => branchMap.get(root.id)),
    ...remaining.slice(insertIndex),
  ];
  sortNodesByHierarchy(document);
  resolvePageLayout(document);
  return frame;
}

export function reorderAutoLayoutChild(document, id) {
  const node = getNode(document, id);
  const parent = node?.parentId ? getNode(document, node.parentId) : null;
  if (!node || !isAutoLayoutFrame(parent) || node.layoutPositioning === LAYOUT_POSITIONING.ABSOLUTE) {
    return false;
  }
  const horizontal = parent.layoutMode === LAYOUT_MODES.HORIZONTAL;
  const siblings = getChildNodes(document, parent.id)
    .filter((item) => item.visible !== false && item.layoutPositioning !== LAYOUT_POSITIONING.ABSOLUTE);
  const currentIndex = siblings.findIndex((item) => item.id === id);
  if (currentIndex < 0) return false;
  const center = horizontal ? node.x + node.width / 2 : node.y + node.height / 2;
  const others = siblings.filter((item) => item.id !== id);
  const targetIndex = others.filter((item) => {
    const itemCenter = horizontal ? item.x + item.width / 2 : item.y + item.height / 2;
    return itemCenter < center;
  }).length;
  if (targetIndex === currentIndex) return false;

  let changed = false;
  let index = currentIndex;
  while (index < targetIndex) {
    changed = reorderNode(document, id, "front") || changed;
    const ordered = getChildNodes(document, parent.id)
      .filter((item) => item.visible !== false && item.layoutPositioning !== LAYOUT_POSITIONING.ABSOLUTE);
    index = ordered.findIndex((item) => item.id === id);
    if (index < 0 || index === ordered.length - 1) break;
  }
  while (index > targetIndex) {
    changed = reorderNode(document, id, "back") || changed;
    const ordered = getChildNodes(document, parent.id)
      .filter((item) => item.visible !== false && item.layoutPositioning !== LAYOUT_POSITIONING.ABSOLUTE);
    index = ordered.findIndex((item) => item.id === id);
    if (index <= 0) break;
  }
  return changed;
}

function resizeNode(document, node, horizontal, targetMain, targetCross) {
  if (!canResize(node)) return false;
  const targetWidth = horizontal ? targetMain : targetCross;
  const targetHeight = horizontal ? targetCross : targetMain;
  const width = clampSize(node, true, Math.max(MIN_SIZE, targetWidth));
  const height = clampSize(node, false, Math.max(MIN_SIZE, targetHeight));
  if (almostEqual(node.width, width) && almostEqual(node.height, height)) return false;
  const source = {
    ...node,
    vectorPoints: node.vectorPoints?.map((point) => ({
      ...point,
      in: point.in ? { ...point.in } : null,
      out: point.out ? { ...point.out } : null,
    })),
    vectorContours: node.vectorContours?.map((contour) => ({
      ...contour,
      points: contour.points.map((point) => ({
        ...point,
        in: point.in ? { ...point.in } : null,
        out: point.out ? { ...point.out } : null,
      })),
    })),
  };
  return setGeometryFromSnapshot(node, source, { x: node.x, y: node.y, width, height });
}

function moveBranch(document, node, x, y) {
  const deltaX = x - node.x;
  const deltaY = y - node.y;
  if (almostEqual(deltaX, 0) && almostEqual(deltaY, 0)) return false;
  for (const item of getNodesWithDescendants(document, [node.id])) {
    item.x += deltaX;
    item.y += deltaY;
  }
  return true;
}

function canResize(node) {
  return !AUTO_BOUNDS_TYPES.has(node.type);
}

function mainSize(node, horizontal) {
  return horizontal ? node.width : node.height;
}

function crossSize(node, horizontal) {
  return horizontal ? node.height : node.width;
}

function mainOrigin(node, horizontal) {
  return horizontal ? node.x : node.y;
}

function crossOrigin(node, horizontal) {
  return horizontal ? node.y : node.x;
}

function childSizing(node, horizontal) {
  return horizontal ? node.layoutSizingHorizontal : node.layoutSizingVertical;
}

function setFrameAxisSize(frame, horizontal, value) {
  return setNumber(frame, horizontal ? "width" : "height", value);
}

function setNumber(target, property, value) {
  if (!Number.isFinite(value) || almostEqual(target[property], value)) return false;
  target[property] = value;
  return true;
}

function almostEqual(left, right) {
  return Math.abs(left - right) <= EPSILON;
}

function toSnapshotMap(source) {
  if (source instanceof Map) return source;
  return new Map((Array.isArray(source) ? source : []).map((node) => [node.id, node]));
}

function combinedBounds(bounds) {
  const minX = Math.min(...bounds.map((box) => box.x));
  const minY = Math.min(...bounds.map((box) => box.y));
  const maxX = Math.max(...bounds.map((box) => box.x + box.width));
  const maxY = Math.max(...bounds.map((box) => box.y + box.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
