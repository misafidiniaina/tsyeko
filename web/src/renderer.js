import {
  getAncestors,
  getChildNodes,
  getDocumentBounds,
  getEffectiveOpacity,
  getNodeAABB,
  getNodesWithDescendants,
  getVectorContours,
  getRenderableNodeIds,
  isCompositeNode,
  isNodeEffectivelyLocked,
  isNodeEffectivelyVisible,
  localToWorld,
  NODE_TYPES,
  pointInNode,
  worldToLocal,
} from "./model.js";
import { layoutRichText, wrapTextLines } from "./text.js";
import { createResolvedLayoutSnapshot } from "./layout.js";
import {
  flattenVectorPath,
  getVectorSegments,
  nearestPointOnCubic,
} from "./vector.js";
import {
  BoundsSurfaceCache,
  renderBranchSignature,
  summarizeFrameProfiles,
} from "./render-cache.js";

const HANDLE_SIZE = 8;
const HANDLE_HIT_RADIUS = 8;
const ROTATION_HANDLE_OFFSET = 25;
const MAX_LOCAL_SURFACE_PIXELS = 16_777_216;
const PROFILE_HISTORY_LIMIT = 120;
const imageCache = new Map();

const HANDLE_POINTS = Object.freeze({
  nw: [0, 0],
  n: [0.5, 0],
  ne: [1, 0],
  e: [1, 0.5],
  se: [1, 1],
  s: [0.5, 1],
  sw: [0, 1],
  w: [0, 0.5],
});

export class CanvasRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false, desynchronized: true });
    this.width = 1;
    this.height = 1;
    this.pixelRatio = 1;
    this.onInvalidate = null;
    this.resolveAsset = null;
    this.compositeCache = new BoundsSurfaceCache();
    this.frameStats = emptyFrameStats();
    this.lastFrameStats = emptyFrameStats();
    this.profileHistory = [];
    this.previousRenderState = null;
    this.sceneInvalidated = true;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const pixelRatio = Math.min(2.5, window.devicePixelRatio || 1);
    const changed =
      width !== this.width ||
      height !== this.height ||
      pixelRatio !== this.pixelRatio;

    if (changed) {
      this.width = width;
      this.height = height;
      this.pixelRatio = pixelRatio;
      this.canvas.width = Math.round(width * pixelRatio);
      this.canvas.height = Math.round(height * pixelRatio);
      this.compositeCache.clear();
      this.previousRenderState = null;
      this.sceneInvalidated = true;
    }
    return changed;
  }

  render(document, selectedIds, camera, options = {}) {
    const startedAt = monotonicNow();
    this.frameStats = emptyFrameStats();
    const context = this.context;
    const selectedSet = new Set(selectedIds);
    const renderState = this.captureRenderState(document, selectedIds, camera, options);
    const dirtyPlan = this.createDirtyPlan(renderState);
    this.previousRenderState = renderState;
    this.sceneInvalidated = false;
    this.frameStats.fullRedraw = dirtyPlan.full;
    this.frameStats.dirtyRegions = dirtyPlan.regions.length;
    if (dirtyPlan.skip) {
      this.frameStats.skipped = true;
      this.finishFrameProfile(startedAt, options);
      return;
    }

    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    if (!dirtyPlan.full) {
      context.save();
      context.beginPath();
      for (const region of dirtyPlan.regions) {
        context.rect(region.x, region.y, region.width, region.height);
      }
      context.clip();
    }
    context.clearRect(0, 0, this.width, this.height);
    context.fillStyle = options.background ?? document.background ?? "#101114";
    context.fillRect(0, 0, this.width, this.height);

    if (options.grid !== false) {
      this.drawGrid(camera);
    }

    const idSet = options.ids
      ? getRenderableNodeIds(document, options.ids)
      : null;
    const sceneOptions = { ...options, idSet };
    for (const node of getChildNodes(document)) {
      this.drawSceneNode(document, node, camera, sceneOptions);
    }

    if (options.guides?.length) {
      this.drawGuides(options.guides, camera);
    }

    if (options.marquee) {
      this.drawMarquee(options.marquee);
    }

    if (options.penDraft) {
      this.drawPenDraft(options.penDraft, camera);
    }

    if (options.selection !== false) {
      const selectedNodes = document.nodes.filter(
        (node) => selectedSet.has(node.id) && isNodeEffectivelyVisible(document, node),
      );
      this.drawSelection(selectedNodes, camera, document, options.vectorEdit?.nodeId ?? null);
    }

    if (options.vectorEdit) {
      const vector = document.nodes.find((node) => node.id === options.vectorEdit.nodeId);
      if (vector?.type === NODE_TYPES.VECTOR && isNodeEffectivelyVisible(document, vector)) {
        this.drawVectorEdit(vector, camera, options.vectorEdit);
      }
    }
    if (!dirtyPlan.full) context.restore();
    this.finishFrameProfile(startedAt, options);
  }

  drawSceneNode(document, node, camera, options = {}) {
    this.frameStats.nodesVisited += 1;
    if (!isNodeEffectivelyVisible(document, node) || !branchIntersectsSet(document, node, options.idSet)) return;
    if (node.type !== NODE_TYPES.GROUP && !this.nodeIntersectsViewport(node, camera)) {
      this.frameStats.nodesCulled += 1;
      return;
    }
    const children = getChildNodes(document, node.id);

    if (node.type === NODE_TYPES.GROUP) {
      for (const child of children) this.drawSceneNode(document, child, camera, options);
      return;
    }

    if (node.type === NODE_TYPES.BOOLEAN) {
      this.frameStats.nodesDrawn += 1;
      this.drawBooleanComposite(document, node, camera, options);
      return;
    }

    if (node.type === NODE_TYPES.MASK) {
      this.frameStats.nodesDrawn += 1;
      this.drawMaskComposite(document, node, camera, options);
      return;
    }

    const shouldDrawNode = !options.idSet || options.idSet.has(node.id);
    if (shouldDrawNode && node.id !== options.editingId) {
      this.frameStats.nodesDrawn += 1;
      this.drawNode(node, camera, {
        ...options,
        effectiveOpacity: getOpacityUntil(document, node, options.opacityStopId),
        effectiveLocked: isNodeEffectivelyLocked(document, node),
      });
    }

    if (node.type !== NODE_TYPES.FRAME || !children.length) return;
    const context = this.context;
    context.save();
    this.clipToFrame(node, camera);
    for (const child of children) this.drawSceneNode(document, child, camera, options);
    context.restore();
  }

  clipToFrame(frame, camera) {
    const context = this.context;
    const center = this.worldToScreen(
      { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 },
      camera,
    );
    const width = frame.width * camera.zoom;
    const height = frame.height * camera.zoom;
    const radius = Math.min(frame.cornerRadius * camera.zoom, width / 2, height / 2);
    context.translate(center.x, center.y);
    context.rotate((frame.rotation * Math.PI) / 180);
    context.beginPath();
    roundedRect(context, -width / 2, -height / 2, width, height, radius);
    context.clip();
    this.setScreenTransform(context);
  }

  drawBooleanComposite(document, node, camera, options = {}) {
    const bounds = this.getCompositeLayerBounds(node, camera);
    const cached = this.getCachedComposite(document, node, camera, options, "boolean", bounds);
    if (cached) {
      this.drawCompositeLayer(cached, document, node, camera, options);
      return;
    }
    const mask = this.createBooleanMaskLayer(document, node, camera, options, bounds);
    const output = this.createLayer(bounds);
    const outputContext = output.getContext("2d");
    const fills = visiblePaints(node.fills, {
      type: node.fillType,
      color: node.fill,
      gradient: node.gradient,
    }, "fill");
    for (const paint of fills) {
      const painted = this.colorizeMask(mask, node, camera, paint);
      outputContext.save();
      outputContext.globalAlpha = paint.opacity ?? 1;
      outputContext.globalCompositeOperation = paintBlendMode(paint.blendMode);
      this.drawScreenLayer(outputContext, painted);
      outputContext.restore();
    }

    const strokes = visiblePaints(node.strokes, { type: "solid", color: node.stroke }, "stroke")
      .filter((paint) => paint.color !== "transparent" || paint.type !== "solid");
    if (node.strokeWidth > 0 && strokes.length) {
      const expanded = this.expandMask(mask, node.strokeWidth * camera.zoom);
      for (const paint of strokes) {
        const stroke = this.colorizeMask(expanded, node, camera, paint);
        outputContext.save();
        outputContext.globalAlpha = paint.opacity ?? 1;
        outputContext.globalCompositeOperation = "destination-over";
        this.drawScreenLayer(outputContext, stroke);
        outputContext.restore();
      }
    }

    this.cacheComposite(document, node, camera, options, "boolean", bounds, output);
    this.drawCompositeLayer(output, document, node, camera, options);
  }

  drawMaskComposite(document, node, camera, options = {}) {
    const bounds = this.getCompositeLayerBounds(node, camera);
    const cached = this.getCachedComposite(document, node, camera, options, "mask", bounds);
    if (cached) {
      this.drawCompositeLayer(cached, document, node, camera, options);
      return;
    }
    const output = this.createMaskOutputLayer(document, node, camera, options, bounds);
    this.cacheComposite(document, node, camera, options, "mask", bounds, output);
    this.drawCompositeLayer(output, document, node, camera, options);
  }

  drawCompositeLayer(layer, document, node, camera, options = {}) {
    const context = this.context;
    context.save();
    this.setScreenTransform(context);
    context.globalAlpha = getOpacityUntil(document, node, options.opacityStopId);
    const layerBlur = effectiveNodeLayerBlur(node);
    context.filter = layerBlur > 0 ? `blur(${Math.min(250, layerBlur * camera.zoom)}px)` : "none";
    this.applyNodeShadow(node, camera.zoom, options);
    this.drawScreenLayer(context, layer);
    context.restore();

    if (isNodeEffectivelyLocked(document, node) && options.lockIndicators !== false) {
      this.drawLockIndicator(node, camera);
    }
  }

  createBooleanMaskLayer(document, node, camera, options = {}, bounds = this.getCompositeLayerBounds(node, camera)) {
    const children = getChildNodes(document, node.id)
      .filter((child) => isNodeEffectivelyVisible(document, child));
    const output = this.createLayer(bounds);
    if (!children.length) return output;
    const context = output.getContext("2d");

    children.forEach((child, index) => {
      const source = this.createBranchMaskLayer(document, child, camera, options, bounds);
      context.globalCompositeOperation = index === 0
        ? "source-over"
        : booleanCompositeOperation(node.booleanOperation);
      this.drawScreenLayer(context, source);
    });
    context.globalCompositeOperation = "source-over";
    return output;
  }

  createMaskOutputLayer(document, node, camera, options = {}, bounds = this.getCompositeLayerBounds(node, camera)) {
    const children = getChildNodes(document, node.id);
    const output = this.createLayer(bounds);
    if (children.length < 2 || !isNodeEffectivelyVisible(document, children[0])) return output;

    const source = this.createBranchMaskLayer(document, children[0], camera, options, bounds);
    const context = output.getContext("2d");
    this.setScreenTransform(context);
    this.withContext(context, () => {
      const contentOptions = {
        ...options,
        idSet: null,
        opacityStopId: node.id,
        frameLabels: false,
        lockIndicators: false,
      };
      for (const child of children.slice(1).filter((item) => isNodeEffectivelyVisible(document, item))) {
        this.drawSceneNode(document, child, camera, contentOptions);
      }
    });
    context.save();
    context.globalCompositeOperation = "destination-in";
    this.drawScreenLayer(context, source);
    context.restore();
    return output;
  }

  createBranchMaskLayer(document, root, camera, options = {}, bounds = this.getCompositeLayerBounds(root, camera)) {
    const output = this.createLayer(bounds);
    const context = output.getContext("2d");
    this.setScreenTransform(context);
    this.withContext(context, () => this.drawBranchMask(document, root, camera, options));
    return output;
  }

  drawBranchMask(document, node, camera, options = {}) {
    if (!isNodeEffectivelyVisible(document, node)) return;
    const children = getChildNodes(document, node.id);
    if (node.type === NODE_TYPES.GROUP) {
      for (const child of children) this.drawBranchMask(document, child, camera, options);
      return;
    }
    if (node.type === NODE_TYPES.BOOLEAN) {
      this.drawPhysicalLayer(this.createBooleanMaskLayer(document, node, camera, options));
      return;
    }
    if (node.type === NODE_TYPES.MASK) {
      this.drawPhysicalLayer(this.createMaskOutputLayer(document, node, camera, options));
      return;
    }

    this.drawNodeMaskGeometry(node, camera);
    if (node.type !== NODE_TYPES.FRAME || !children.length) return;
    const context = this.context;
    context.save();
    this.clipToFrame(node, camera);
    for (const child of children) this.drawBranchMask(document, child, camera, options);
    context.restore();
  }

  drawNodeMaskGeometry(node, camera) {
    const context = this.context;
    const zoom = camera.zoom;
    const center = this.worldToScreen(
      { x: node.x + node.width / 2, y: node.y + node.height / 2 },
      camera,
    );
    const width = node.width * zoom;
    const height = node.height * zoom;
    context.save();
    context.translate(center.x, center.y);
    context.rotate((node.rotation * Math.PI) / 180);
    context.fillStyle = "#ffffff";
    context.strokeStyle = "#ffffff";
    context.shadowColor = "transparent";

    if (node.type === NODE_TYPES.VECTOR) {
      context.beginPath();
      buildVectorPath(context, node, zoom);
      if (node.vectorClosed) context.fill(node.vectorFillRule);
      if (!node.vectorClosed || node.strokeWidth > 0) {
        context.lineWidth = Math.max(1, node.strokeWidth * zoom);
        context.lineCap = "round";
        context.lineJoin = "round";
        context.stroke();
      }
    } else if (node.type === NODE_TYPES.ELLIPSE) {
      context.beginPath();
      context.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2);
      context.fill();
    } else if (node.type === NODE_TYPES.TEXT) {
      this.drawText({
        ...node,
        fill: "#ffffff",
        fillType: "solid",
        fills: [{ type: "solid", color: "#ffffff", opacity: 1, visible: true, blendMode: "normal" }],
        textRuns: (node.textRuns ?? []).map((run) => ({ ...run, fill: "#ffffff" })),
      }, width, height, zoom);
    } else {
      const radius = Math.min(node.cornerRadius * zoom, width / 2, height / 2);
      context.beginPath();
      roundedRect(context, -width / 2, -height / 2, width, height, radius);
      context.fill();
    }
    context.restore();
  }

  colorizeMask(mask, node, camera, paint) {
    const output = this.createLayer(getLayerBounds(mask));
    const context = output.getContext("2d");
    const center = this.worldToScreen(
      { x: node.x + node.width / 2, y: node.y + node.height / 2 },
      camera,
    );
    const width = node.width * camera.zoom;
    const height = node.height * camera.zoom;
    this.setScreenTransform(context);
    context.translate(center.x, center.y);
    context.rotate((node.rotation * Math.PI) / 180);
    context.fillStyle = createNodeFill(context, node, width, height, paint);
    const paintExtent = Math.max(this.width, this.height) * 3 + width + height;
    context.fillRect(-paintExtent, -paintExtent, paintExtent * 2, paintExtent * 2);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalCompositeOperation = "destination-in";
    context.drawImage(mask, 0, 0);
    return output;
  }

  expandMask(mask, screenRadius) {
    const output = this.createLayer(getLayerBounds(mask));
    const context = output.getContext("2d");
    const radius = Math.max(0, screenRadius * this.pixelRatio);
    context.drawImage(mask, 0, 0);
    if (radius < 0.5) return output;
    const steps = Math.max(16, Math.min(64, Math.ceil(radius * 3)));
    for (let index = 0; index < steps; index += 1) {
      const angle = (index / steps) * Math.PI * 2;
      context.drawImage(mask, Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
    return output;
  }

  drawPhysicalLayer(layer) {
    this.drawScreenLayer(this.context, layer);
  }

  createLayer(bounds = { x: 0, y: 0, width: this.width, height: this.height }) {
    const normalized = normalizeSurfaceBounds(bounds, this.pixelRatio);
    const canvas = this.canvas.ownerDocument.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(normalized.width * this.pixelRatio));
    canvas.height = Math.max(1, Math.ceil(normalized.height * this.pixelRatio));
    canvas.__tsyaikoBounds = {
      ...normalized,
      width: canvas.width / this.pixelRatio,
      height: canvas.height / this.pixelRatio,
    };
    return canvas;
  }

  setScreenTransform(context) {
    const bounds = getLayerBounds(context.canvas);
    context.setTransform(
      this.pixelRatio,
      0,
      0,
      this.pixelRatio,
      -bounds.x * this.pixelRatio,
      -bounds.y * this.pixelRatio,
    );
  }

  drawScreenLayer(context, layer) {
    const bounds = getLayerBounds(layer);
    context.save();
    this.setScreenTransform(context);
    context.drawImage(layer, bounds.x, bounds.y, bounds.width, bounds.height);
    context.restore();
  }

  getCompositeLayerBounds(node, camera) {
    const world = getNodeAABB(node);
    const stroke = Math.max(2, (node.strokeWidth ?? 0) * camera.zoom + 2);
    let bounds = {
      x: world.x * camera.zoom + camera.x - stroke,
      y: world.y * camera.zoom + camera.y - stroke,
      width: world.width * camera.zoom + stroke * 2,
      height: world.height * camera.zoom + stroke * 2,
      clipped: false,
    };
    const physicalPixels = bounds.width * this.pixelRatio * bounds.height * this.pixelRatio;
    if (physicalPixels > MAX_LOCAL_SURFACE_PIXELS) {
      bounds = intersectBounds(bounds, {
        x: -256,
        y: -256,
        width: this.width + 512,
        height: this.height + 512,
      });
      bounds.clipped = true;
    }
    return normalizeSurfaceBounds(bounds, this.pixelRatio);
  }

  getNodeScreenBounds(node, camera, extraPadding = 0) {
    const world = getNodeAABB(node);
    const shadow = effectiveNodeShadow(node);
    const blur = Math.max(
      shadow ? shadow.blur * 2 + Math.abs(shadow.offsetX) + Math.abs(shadow.offsetY) : 0,
      effectiveNodeLayerBlur(node) * 2,
    ) * camera.zoom;
    const padding = Math.max(8, blur, (node.strokeWidth ?? 0) * camera.zoom) + extraPadding;
    let bounds = {
      x: world.x * camera.zoom + camera.x - padding,
      y: world.y * camera.zoom + camera.y - padding,
      width: world.width * camera.zoom + padding * 2,
      height: world.height * camera.zoom + padding * 2,
    };
    if (node.type === NODE_TYPES.FRAME) {
      const topLeft = this.worldToScreen(localToWorld(node, { x: 0, y: 0 }), camera);
      const estimatedLabelWidth = Math.min(900, Math.max(24, String(node.name).length * 6.5));
      bounds = unionBounds(bounds, {
        x: topLeft.x - 2,
        y: topLeft.y - 20,
        width: estimatedLabelWidth + 4,
        height: 22,
      });
    }
    return bounds;
  }

  nodeIntersectsViewport(node, camera) {
    return boundsIntersect(
      this.getNodeScreenBounds(node, camera),
      { x: 0, y: 0, width: this.width, height: this.height },
    );
  }

  captureRenderState(document, selectedIds, camera, options) {
    const selectedSet = new Set(options.selection === false ? [] : selectedIds);
    const nodes = new Map(document.nodes.map((node, index) => {
      const signatureNodes = isCompositeNode(node)
        ? getNodesWithDescendants(document, [node.id])
        : [node];
      return [node.id, {
        signature: `${index}:${renderBranchSignature(signatureNodes)}`,
        bounds: selectedSet.has(node.id)
          ? expandBounds(this.getNodeScreenBounds(node, camera), 40)
          : this.getNodeScreenBounds(node, camera),
      }];
    }));
    const transient = Boolean(
      options.guides?.length || options.marquee || options.penDraft || options.vectorEdit,
    );
    return {
      nodes,
      selectedIds: selectedSet,
      camera: { x: camera.x, y: camera.y, zoom: camera.zoom },
      transient,
      baseKey: JSON.stringify({
        width: this.width,
        height: this.height,
        pixelRatio: this.pixelRatio,
        background: options.background ?? document.background ?? "#101114",
        grid: options.grid !== false,
        ids: options.ids ?? null,
        editingId: options.editingId ?? null,
        frameLabels: options.frameLabels !== false,
        lockIndicators: options.lockIndicators !== false,
      }),
    };
  }

  createDirtyPlan(current) {
    const previous = this.previousRenderState;
    if (
      this.sceneInvalidated ||
      !previous ||
      previous.baseKey !== current.baseKey ||
      previous.transient ||
      current.transient ||
      previous.camera.x !== current.camera.x ||
      previous.camera.y !== current.camera.y ||
      previous.camera.zoom !== current.camera.zoom
    ) {
      return { full: true, skip: false, regions: [] };
    }

    const dirty = [];
    const ids = new Set([...previous.nodes.keys(), ...current.nodes.keys()]);
    for (const id of ids) {
      const before = previous.nodes.get(id);
      const after = current.nodes.get(id);
      if (before?.signature === after?.signature) continue;
      if (before) dirty.push(before.bounds);
      if (after) dirty.push(after.bounds);
    }

    const selected = new Set([...previous.selectedIds, ...current.selectedIds]);
    for (const id of selected) {
      if (previous.selectedIds.has(id) === current.selectedIds.has(id)) continue;
      const before = previous.nodes.get(id)?.bounds;
      const after = current.nodes.get(id)?.bounds;
      if (before) dirty.push(expandBounds(before, 40));
      if (after) dirty.push(expandBounds(after, 40));
    }

    const viewport = { x: 0, y: 0, width: this.width, height: this.height };
    const regions = mergeDirtyBounds(dirty
      .filter((bounds) => boundsIntersect(bounds, viewport))
      .map((bounds) => intersectBounds(expandBounds(bounds, 2), viewport)));
    if (!regions.length) return { full: false, skip: true, regions: [] };
    const dirtyArea = regions.reduce((total, region) => total + region.width * region.height, 0);
    if (regions.length > 16 || dirtyArea > this.width * this.height * 0.65) {
      return { full: true, skip: false, regions: [] };
    }
    return { full: false, skip: false, regions };
  }

  finishFrameProfile(startedAt, options) {
    this.frameStats.frameMs = monotonicNow() - startedAt;
    this.frameStats.cacheEntries = this.compositeCache.stats.entries;
    this.frameStats.cacheBytes = this.compositeCache.stats.bytes;
    this.lastFrameStats = { ...this.frameStats };
    this.profileHistory.push(this.lastFrameStats);
    if (this.profileHistory.length > PROFILE_HISTORY_LIMIT) this.profileHistory.shift();
    options.onProfile?.(this.getPerformanceStats());
  }

  compositeDescriptor(document, node, camera, options, kind, bounds) {
    if (options.idSet || options.editingId || options.opacityStopId) return null;
    const branch = getNodesWithDescendants(document, [node.id]);
    const dimensions = `${Math.round(bounds.width * this.pixelRatio)}x${Math.round(bounds.height * this.pixelRatio)}`;
    const clipKey = bounds.clipped ? `:${bounds.x.toFixed(2)}:${bounds.y.toFixed(2)}` : "";
    const phaseKey = `${subpixelPhase(camera.x - bounds.x, this.pixelRatio)}:${subpixelPhase(camera.y - bounds.y, this.pixelRatio)}`;
    return {
      key: `${kind}:${renderBranchSignature(branch)}:${camera.zoom.toFixed(5)}:${this.pixelRatio}:${dimensions}:${phaseKey}:${options.shadows !== false}${clipKey}`,
      nodeIds: branch.map((item) => item.id),
    };
  }

  getCachedComposite(document, node, camera, options, kind, bounds) {
    const descriptor = this.compositeDescriptor(document, node, camera, options, kind, bounds);
    if (!descriptor) return null;
    const entry = this.compositeCache.get(descriptor.key);
    if (!entry) {
      this.frameStats.compositeCacheMisses += 1;
      return null;
    }
    entry.surface.__tsyaikoBounds = { ...getLayerBounds(entry.surface), x: bounds.x, y: bounds.y };
    this.frameStats.compositeCacheHits += 1;
    return entry.surface;
  }

  cacheComposite(document, node, camera, options, kind, bounds, surface) {
    const descriptor = this.compositeDescriptor(document, node, camera, options, kind, bounds);
    if (!descriptor) return;
    this.compositeCache.set(descriptor.key, surface, {
      rootId: node.id,
      nodeIds: descriptor.nodeIds,
      kind,
    });
  }

  invalidateCompositeCache(nodeIds = null) {
    this.sceneInvalidated = true;
    if (!nodeIds) {
      this.compositeCache.clear();
      return;
    }
    const dirty = new Set(Array.isArray(nodeIds) ? nodeIds : [nodeIds]);
    this.compositeCache.deleteWhere((entry) =>
      entry.metadata.nodeIds?.some((id) => dirty.has(id)));
  }

  getPerformanceStats() {
    return {
      ...this.lastFrameStats,
      history: summarizeFrameProfiles(this.profileHistory),
    };
  }

  withContext(context, callback) {
    const previous = this.context;
    this.context = context;
    try {
      return callback();
    } finally {
      this.context = previous;
    }
  }

  drawGrid(camera) {
    const context = this.context;
    let worldStep = 16;
    while (worldStep * camera.zoom < 12) worldStep *= 2;
    while (worldStep * camera.zoom > 32) worldStep /= 2;
    const step = worldStep * camera.zoom;
    const offsetX = modulo(camera.x, step);
    const offsetY = modulo(camera.y, step);

    context.save();
    context.fillStyle = "rgba(255,255,255,0.085)";
    for (let x = offsetX; x < this.width; x += step) {
      for (let y = offsetY; y < this.height; y += step) {
        context.fillRect(Math.round(x), Math.round(y), 1, 1);
      }
    }
    context.restore();
  }

  drawNode(node, camera, options = {}) {
    if (node.type === NODE_TYPES.GROUP) return;
    const context = this.context;
    const zoom = camera.zoom;
    const center = this.worldToScreen(
      { x: node.x + node.width / 2, y: node.y + node.height / 2 },
      camera,
    );
    const width = node.width * zoom;
    const height = node.height * zoom;

    context.save();
    context.translate(center.x, center.y);
    context.rotate((node.rotation * Math.PI) / 180);
    context.globalAlpha = options.effectiveOpacity ?? node.opacity;
    const layerBlur = effectiveNodeLayerBlur(node);
    context.filter = layerBlur > 0 ? `blur(${Math.min(250, layerBlur * zoom)}px)` : "none";

    this.applyNodeShadow(node, zoom, options);

    if (node.type === NODE_TYPES.VECTOR) {
      context.beginPath();
      buildVectorPath(context, node, zoom);
      this.paintPath(node, width, height, zoom, {
        fill: node.vectorClosed,
        fillRule: node.vectorFillRule,
      });
    } else if (node.type === NODE_TYPES.ELLIPSE) {
      context.beginPath();
      context.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2);
      this.paintPath(node, width, height, zoom);
    } else if (node.type === NODE_TYPES.IMAGE) {
      this.drawImageNode(node, width, height, zoom);
    } else if (node.type === NODE_TYPES.TEXT) {
      this.drawText(node, width, height, zoom);
    } else {
      const radius = Math.min(
        node.cornerRadius * zoom,
        width / 2,
        height / 2,
      );
      context.beginPath();
      roundedRect(context, -width / 2, -height / 2, width, height, radius);
      this.paintPath(node, width, height, zoom);
    }
    context.restore();

    if (node.type === NODE_TYPES.FRAME && options.frameLabels !== false) {
      this.drawFrameLabel(node, camera);
    }

    if ((options.effectiveLocked ?? node.locked) && options.lockIndicators !== false) {
      this.drawLockIndicator(node, camera);
    }
  }

  applyNodeShadow(node, zoom, options = {}) {
    const context = this.context;
    const shadow = effectiveNodeShadow(node);
    if (options.shadows === false || !shadow || shadow.enabled === false || shadow.opacity <= 0) {
      context.shadowColor = "transparent";
      return;
    }
    context.shadowColor = colorWithOpacity(shadow.color, shadow.opacity);
    context.shadowBlur = Math.min(250, shadow.blur * zoom);
    context.shadowOffsetX = Math.max(-10_000, Math.min(10_000, shadow.offsetX * zoom));
    context.shadowOffsetY = Math.max(-10_000, Math.min(10_000, shadow.offsetY * zoom));
  }

  paintPath(node, width, height, zoom, options = {}) {
    const context = this.context;
    const shouldFill = options.fill !== false;
    if (shouldFill) {
      const fills = visiblePaints(node.fills, {
        type: node.fillType,
        color: node.fill,
        gradient: node.gradient,
      }, "fill");
      for (const paint of fills) {
        context.save();
        context.globalAlpha *= paint.opacity ?? 1;
        context.globalCompositeOperation = paintBlendMode(paint.blendMode);
        context.fillStyle = createNodeFill(context, node, width, height, paint);
        context.fill(options.fillRule ?? "nonzero");
        context.restore();
        context.shadowColor = "transparent";
      }
      context.shadowColor = "transparent";
    }
    if (node.strokeWidth > 0) {
      context.lineWidth = Math.max(0.5, node.strokeWidth * zoom);
      context.lineJoin = "round";
      context.lineCap = "round";
      const strokes = visiblePaints(node.strokes, { type: "solid", color: node.stroke }, "stroke");
      for (const paint of strokes) {
        context.save();
        context.globalAlpha *= paint.opacity ?? 1;
        context.globalCompositeOperation = paintBlendMode(paint.blendMode);
        context.strokeStyle = createNodeFill(context, node, width, height, paint);
        context.stroke();
        context.restore();
      }
    }
    context.shadowColor = "transparent";
  }

  drawText(node, width, height, zoom) {
    const context = this.context;
    const fontSize = node.fontSize * zoom;
    if (fontSize < 2) return;

    context.textBaseline = "top";
    context.textAlign = node.textAlign;

    if (node.textRuns?.length) {
      const lines = layoutRichText(node, width / zoom);
      let y = -height / 2;
      for (const line of lines) {
        let x = node.textAlign === "center"
          ? -line.width * zoom / 2
          : node.textAlign === "right"
            ? width / 2 - line.width * zoom
            : -width / 2;
        for (const fragment of line.fragments) {
          const style = fragment.style;
          context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize * zoom}px ${style.fontFamily}`;
          context.textAlign = "left";
          context.fillStyle = style.fill;
          if ("letterSpacing" in context) context.letterSpacing = `${style.letterSpacing * zoom}px`;
          context.fillText(fragment.text, x, y);
          if (style.textDecoration !== "none") {
            const decorationY = style.textDecoration === "underline"
              ? y + style.fontSize * zoom
              : y + style.fontSize * zoom * 0.55;
            context.beginPath();
            context.moveTo(x, decorationY);
            context.lineTo(x + fragment.width * zoom, decorationY);
            context.lineWidth = Math.max(1, style.fontSize * zoom / 16);
            context.strokeStyle = style.fill;
            context.stroke();
          }
          x += fragment.width * zoom;
        }
        y += line.height * zoom;
        if (y > height / 2) break;
      }
      return;
    }

    context.font = `${node.fontWeight} ${fontSize}px ${node.fontFamily}`;

    const left = -width / 2;
    const textX = node.textAlign === "center"
      ? 0
      : node.textAlign === "right"
        ? width / 2
        : left;
    const lines = wrapTextLines(node.text, width / zoom, node.fontSize, node.fontWeight, node.fontFamily);
    const lineHeight = fontSize * node.lineHeight;
    let y = -height / 2;
    const fills = visiblePaints(node.fills, {
      type: node.fillType,
      color: node.fill,
      gradient: node.gradient,
    }, "fill");
    for (const paint of fills) {
      context.save();
      context.globalAlpha *= paint.opacity ?? 1;
      context.globalCompositeOperation = paintBlendMode(paint.blendMode);
      context.fillStyle = createNodeFill(context, node, width, height, paint);
      y = -height / 2;
      for (const line of lines) {
        if (y > height / 2) break;
        context.fillText(line, textX, y);
        y += lineHeight;
      }
      context.restore();
    }
  }

  drawImageNode(node, width, height, zoom) {
    const context = this.context;
    const x = -width / 2;
    const y = -height / 2;
    const radius = Math.min(node.cornerRadius * zoom, width / 2, height / 2);

    context.save();
    context.beginPath();
    roundedRect(context, x, y, width, height, radius);
    const fills = visiblePaints(node.fills, {
      type: node.fillType,
      color: node.fill,
      gradient: node.gradient,
    }, "fill");
    for (const paint of fills) {
      context.save();
      context.globalAlpha *= paint.opacity ?? 1;
      context.globalCompositeOperation = paintBlendMode(paint.blendMode);
      context.fillStyle = createNodeFill(context, node, width, height, paint);
      context.fill();
      context.restore();
      context.shadowColor = "transparent";
    }
    context.clip();

    const imageSource = this.resolveAsset?.(node) ?? node.imageData;
    const entry = imageSource ? getImageEntry(imageSource) : null;
    if (entry?.status === "loaded") {
      const image = entry.image;
      const scale = node.imageFit === "contain"
        ? Math.min(width / image.naturalWidth, height / image.naturalHeight)
        : Math.max(width / image.naturalWidth, height / image.naturalHeight);
      const drawWidth = image.naturalWidth * scale;
      const drawHeight = image.naturalHeight * scale;
      context.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    } else {
      this.drawImagePlaceholder(width, height);
      if (entry?.status === "loading" && !entry.renderers.has(this)) {
        entry.renderers.add(this);
        entry.promise.finally(() => {
          entry.renderers.delete(this);
          this.invalidateCompositeCache();
          this.onInvalidate?.();
        });
      }
    }
    context.restore();

    if (node.strokeWidth > 0) {
      const strokes = visiblePaints(node.strokes, { type: "solid", color: node.stroke }, "stroke");
      for (const paint of strokes) {
        context.save();
        context.beginPath();
        roundedRect(context, x, y, width, height, radius);
        context.lineWidth = Math.max(0.5, node.strokeWidth * zoom);
        context.globalAlpha *= paint.opacity ?? 1;
        context.globalCompositeOperation = paintBlendMode(paint.blendMode);
        context.strokeStyle = createNodeFill(context, node, width, height, paint);
        context.stroke();
        context.restore();
      }
    }
  }

  drawImagePlaceholder(width, height) {
    const context = this.context;
    const tile = Math.max(8, Math.min(18, Math.min(width, height) / 8));
    context.fillStyle = "rgba(0,0,0,0.06)";
    for (let row = 0, y = -height / 2; y < height / 2; row += 1, y += tile) {
      for (let column = 0, x = -width / 2; x < width / 2; column += 1, x += tile) {
        if ((row + column) % 2 === 0) context.fillRect(x, y, tile, tile);
      }
    }
    if (width > 44 && height > 44) {
      context.strokeStyle = "rgba(80,80,90,0.4)";
      context.lineWidth = 1.5;
      context.beginPath();
      context.moveTo(-width * 0.25, height * 0.2);
      context.lineTo(-width * 0.05, -height * 0.04);
      context.lineTo(width * 0.08, height * 0.1);
      context.lineTo(width * 0.24, -height * 0.12);
      context.stroke();
      context.beginPath();
      context.arc(width * 0.16, -height * 0.2, Math.min(width, height) * 0.055, 0, Math.PI * 2);
      context.stroke();
    }
  }

  drawFrameLabel(node, camera) {
    const context = this.context;
    const topLeft = localToWorld(node, { x: 0, y: 0 });
    const point = this.worldToScreen(topLeft, camera);
    context.save();
    context.fillStyle = "rgba(205, 194, 255, 0.9)";
    context.font = "500 11px Inter, ui-sans-serif, sans-serif";
    context.textBaseline = "bottom";
    context.fillText(node.name, point.x, point.y - 5);
    context.restore();
  }

  drawLockIndicator(node, camera) {
    const context = this.context;
    const point = this.worldToScreen(localToWorld(node, { x: node.width, y: 0 }), camera);
    context.save();
    context.translate(point.x - 10, point.y + 10);
    context.fillStyle = "rgba(25,25,28,0.75)";
    context.beginPath();
    context.roundRect(-8, -8, 16, 16, 4);
    context.fill();
    context.strokeStyle = "#d8d8dc";
    context.lineWidth = 1;
    context.beginPath();
    context.rect(-3.5, -1, 7, 5.5);
    context.moveTo(-2.5, -1);
    context.arc(0, -1, 2.5, Math.PI, 0);
    context.stroke();
    context.restore();
  }

  drawSelection(nodes, camera, document = null, vectorEditId = null) {
    if (!nodes.length) return;
    for (const node of nodes) {
      this.drawSelectionOutline(
        node,
        camera,
        nodes.length === 1 && node.id !== vectorEditId,
        document ? isNodeEffectivelyLocked(document, node) : node.locked,
      );
    }
  }

  drawVectorEdit(node, camera, editState = {}) {
    const points = node.vectorPoints.map((point) =>
      this.worldToScreen(localToWorld(node, point), camera));
    if (points.length < 2) return;
    const context = this.context;
    context.save();
    context.strokeStyle = "rgba(236, 72, 153, 0.95)";
    context.lineWidth = 1.5;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.beginPath();
    traceVectorPathOnScreen(context, node, camera, this);
    context.stroke();

    const selectedPoint = node.vectorPoints[editState.pointIndex];
    if (selectedPoint) {
      const anchorScreen = points[editState.pointIndex];
      for (const kind of ["in", "out"]) {
        if (!selectedPoint[kind]) continue;
        const handleScreen = this.worldToScreen(localToWorld(node, selectedPoint[kind]), camera);
        context.strokeStyle = "rgba(196, 181, 253, 0.9)";
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(anchorScreen.x, anchorScreen.y);
        context.lineTo(handleScreen.x, handleScreen.y);
        context.stroke();
        context.fillStyle = editState.handleKind === kind ? "#ec4899" : "#ffffff";
        context.strokeStyle = "#7c3aed";
        context.lineWidth = 1.5;
        context.beginPath();
        context.arc(handleScreen.x, handleScreen.y, editState.handleKind === kind ? 5 : 4, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      }
    }

    points.forEach((point, index) => {
      const selected = editState.pointIndex === index;
      const size = selected ? 9 : 7;
      context.fillStyle = selected ? "#ec4899" : "#ffffff";
      context.strokeStyle = selected ? "#ffffff" : "#7c3aed";
      context.lineWidth = selected ? 2 : 1.5;
      context.beginPath();
      context.rect(point.x - size / 2, point.y - size / 2, size, size);
      context.fill();
      context.stroke();
    });
    context.restore();
  }

  drawPenDraft(draft, camera) {
    if (!draft?.points?.length) return;
    const context = this.context;
    const points = draft.points.map((point) => this.worldToScreen(point, camera));
    const hover = draft.hoverWorld ? this.worldToScreen(draft.hoverWorld, camera) : null;
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#c4b5fd";
    context.lineWidth = 2;
    context.beginPath();
    traceWorldVectorPathOnScreen(context, draft.points, camera, this);
    context.stroke();
    if (hover && distance(points.at(-1), hover) > 0.5) {
      context.setLineDash([5, 4]);
      context.beginPath();
      context.moveTo(points.at(-1).x, points.at(-1).y);
      const outgoing = draft.points.at(-1).out;
      if (outgoing) {
        const control = this.worldToScreen(outgoing, camera);
        context.bezierCurveTo(control.x, control.y, hover.x, hover.y, hover.x, hover.y);
      } else {
        context.lineTo(hover.x, hover.y);
      }
      context.stroke();
      context.setLineDash([]);
    }
    draft.points.forEach((point, index) => {
      const anchor = points[index];
      for (const kind of ["in", "out"]) {
        if (!point[kind]) continue;
        const handle = this.worldToScreen(point[kind], camera);
        context.strokeStyle = "rgba(196, 181, 253, 0.7)";
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(anchor.x, anchor.y);
        context.lineTo(handle.x, handle.y);
        context.stroke();
        context.fillStyle = "#ffffff";
        context.beginPath();
        context.arc(handle.x, handle.y, 3, 0, Math.PI * 2);
        context.fill();
      }
    });
    points.forEach((point, index) => {
      context.fillStyle = index === 0 ? "#ec4899" : "#ffffff";
      context.strokeStyle = "#7c3aed";
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(point.x, point.y, index === 0 ? 5 : 4, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    });
    context.restore();
  }

  drawSelectionOutline(node, camera, showHandles, locked = node.locked) {
    const context = this.context;
    const center = this.worldToScreen(
      { x: node.x + node.width / 2, y: node.y + node.height / 2 },
      camera,
    );
    const width = node.width * camera.zoom;
    const height = node.height * camera.zoom;
    context.save();
    context.translate(center.x, center.y);
    context.rotate((node.rotation * Math.PI) / 180);
    context.strokeStyle = "#a78bfa";
    context.lineWidth = 1;
    context.setLineDash(locked ? [4, 3] : []);
    context.strokeRect(-width / 2 - 0.5, -height / 2 - 0.5, width + 1, height + 1);

    if (showHandles && !locked) {
      context.setLineDash([]);
      context.strokeStyle = "#7c3aed";
      context.fillStyle = "#ffffff";
      for (const [handle, [xRatio, yRatio]] of Object.entries(HANDLE_POINTS)) {
        if ((width < 34 || height < 34) && ["n", "e", "s", "w"].includes(handle)) continue;
        const x = -width / 2 + width * xRatio;
        const y = -height / 2 + height * yRatio;
        context.fillRect(x - HANDLE_SIZE / 2, y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
        context.strokeRect(x - HANDLE_SIZE / 2, y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
      }

      context.beginPath();
      context.moveTo(0, -height / 2);
      context.lineTo(0, -height / 2 - ROTATION_HANDLE_OFFSET);
      context.stroke();
      context.beginPath();
      context.arc(0, -height / 2 - ROTATION_HANDLE_OFFSET, 4, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
    context.restore();

    if (showHandles && !locked && camera.zoom > 0.3) {
      this.drawDimensions(node, camera);
    }
  }

  drawDimensions(node, camera) {
    const context = this.context;
    const bottom = this.worldToScreen(
      localToWorld(node, { x: node.width / 2, y: node.height }),
      camera,
    );
    const label = `${Math.round(node.width)} × ${Math.round(node.height)}`;
    context.save();
    context.font = "500 10px Inter, ui-sans-serif, sans-serif";
    const labelWidth = context.measureText(label).width + 10;
    const x = bottom.x - labelWidth / 2;
    const y = bottom.y + 9;
    context.fillStyle = "rgba(124, 58, 237, 0.95)";
    context.beginPath();
    context.roundRect(x, y, labelWidth, 18, 4);
    context.fill();
    context.fillStyle = "white";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, bottom.x, y + 9);
    context.restore();
  }

  drawGuides(guides, camera) {
    const context = this.context;
    context.save();
    context.strokeStyle = "#ec4899";
    context.lineWidth = 1;
    context.setLineDash([4, 3]);
    for (const guide of guides) {
      context.beginPath();
      if (guide.axis === "x") {
        const x = this.worldToScreen({ x: guide.value, y: 0 }, camera).x;
        context.moveTo(x, 0);
        context.lineTo(x, this.height);
      } else {
        const y = this.worldToScreen({ x: 0, y: guide.value }, camera).y;
        context.moveTo(0, y);
        context.lineTo(this.width, y);
      }
      context.stroke();
    }
    context.restore();
  }

  drawMarquee(marquee) {
    const context = this.context;
    context.save();
    context.fillStyle = "rgba(139, 92, 246, 0.12)";
    context.strokeStyle = "#a78bfa";
    context.lineWidth = 1;
    context.fillRect(marquee.x, marquee.y, marquee.width, marquee.height);
    context.strokeRect(
      Math.round(marquee.x) + 0.5,
      Math.round(marquee.y) + 0.5,
      Math.round(marquee.width),
      Math.round(marquee.height),
    );
    context.restore();
  }

  hitTest(document, screenPoint, camera) {
    const worldPoint = this.screenToWorld(screenPoint, camera);
    const padding = 4 / camera.zoom;
    for (let index = document.nodes.length - 1; index >= 0; index -= 1) {
      const node = document.nodes[index];
      if (node.type === NODE_TYPES.GROUP ||
        !isNodeEffectivelyVisible(document, node) ||
        getAncestors(document, node).some(isCompositeNode) ||
        !pointInNode(node, worldPoint, padding)) continue;
      const clipped = getAncestors(document, node)
        .filter((ancestor) => ancestor.type === NODE_TYPES.FRAME)
        .some((frame) => !pointInNode(frame, worldPoint));
      if (clipped) continue;
      if (!pointInSceneNode(document, node, worldPoint, padding)) continue;
      return node;
    }
    return null;
  }

  getVectorPointAt(screenPoint, node, camera, radius = 9) {
    if (node?.type !== NODE_TYPES.VECTOR) return null;
    let best = null;
    node.vectorPoints.forEach((point, index) => {
      const screen = this.worldToScreen(localToWorld(node, point), camera);
      const pointDistance = distance(screenPoint, screen);
      if (pointDistance <= radius && (!best || pointDistance < best.distance)) {
        best = { index, distance: pointDistance };
      }
    });
    return best?.index ?? null;
  }

  getVectorSegmentAt(screenPoint, node, camera, radius = 8) {
    if (node?.type !== NODE_TYPES.VECTOR) return null;
    let best = null;
    for (const segment of getVectorSegments(node)) {
      const screenSegment = mapSegment(segment, (point) =>
        this.worldToScreen(localToWorld(node, point), camera));
      const nearest = nearestPointOnCubic(screenSegment, screenPoint);
      if (nearest.distance <= radius && (!best || nearest.distance < best.distance)) {
        const world = this.screenToWorld(nearest.point, camera);
        best = {
          index: segment.index,
          endIndex: segment.endIndex,
          t: nearest.t,
          distance: nearest.distance,
          world,
          local: worldToLocal(node, world),
        };
      }
    }
    return best;
  }

  getVectorHandleAt(screenPoint, node, camera, pointIndex, radius = 9) {
    if (node?.type !== NODE_TYPES.VECTOR) return null;
    const point = node.vectorPoints[pointIndex];
    if (!point) return null;
    let best = null;
    for (const kind of ["in", "out"]) {
      if (!point[kind]) continue;
      const screen = this.worldToScreen(localToWorld(node, point[kind]), camera);
      const handleDistance = distance(screenPoint, screen);
      if (handleDistance <= radius && (!best || handleDistance < best.distance)) {
        best = { kind, distance: handleDistance };
      }
    }
    return best?.kind ?? null;
  }

  getHandleAt(screenPoint, node, camera) {
    if (!node || node.locked) return null;
    const localScreenPoint = screenToNodeScreen(node, screenPoint, camera, this);
    const width = node.width * camera.zoom;
    const height = node.height * camera.zoom;
    const rotationPoint = { x: width / 2, y: -ROTATION_HANDLE_OFFSET };
    if (distance(localScreenPoint, rotationPoint) <= HANDLE_HIT_RADIUS) {
      return "rotate";
    }

    for (const [handle, [xRatio, yRatio]] of Object.entries(HANDLE_POINTS)) {
      const point = { x: width * xRatio, y: height * yRatio };
      if (distance(localScreenPoint, point) <= HANDLE_HIT_RADIUS) return handle;
    }
    return null;
  }

  worldToScreen(point, camera) {
    return {
      x: point.x * camera.zoom + camera.x,
      y: point.y * camera.zoom + camera.y,
    };
  }

  screenToWorld(point, camera) {
    return {
      x: (point.x - camera.x) / camera.zoom,
      y: (point.y - camera.y) / camera.zoom,
    };
  }
}

export function renderDocumentToCanvas(sourceDocument, ids = null, requestedScale = 2) {
  const document = createResolvedLayoutSnapshot(sourceDocument);
  const bounds = getDocumentBounds(document, ids);
  const maxDimension = 8192;
  const scale = Math.min(
    requestedScale,
    maxDimension / Math.max(1, bounds.width),
    maxDimension / Math.max(1, bounds.height),
  );
  const canvas = window.document.createElement("canvas");
  const renderer = new CanvasRenderer(canvas);
  renderer.width = Math.max(1, Math.ceil(bounds.width));
  renderer.height = Math.max(1, Math.ceil(bounds.height));
  renderer.pixelRatio = Math.max(0.1, scale);
  canvas.width = Math.max(1, Math.ceil(renderer.width * renderer.pixelRatio));
  canvas.height = Math.max(1, Math.ceil(renderer.height * renderer.pixelRatio));
  renderer.render(document, [], {
    x: -bounds.x,
    y: -bounds.y,
    zoom: 1,
  }, {
    ids,
    grid: false,
    selection: false,
    frameLabels: false,
    lockIndicators: false,
    shadows: true,
    background: "#ffffff",
  });
  return canvas;
}

export async function preloadDocumentImages(document, ids = null) {
  const idSet = ids
    ? getRenderableNodeIds(document, ids)
    : null;
  const sources = document.nodes
    .filter((node) => isNodeEffectivelyVisible(document, node) && node.type === NODE_TYPES.IMAGE && node.imageData && (!idSet || idSet.has(node.id)))
    .map((node) => node.imageData);
  await Promise.all([...new Set(sources)].map((source) => getImageEntry(source).promise));
}

export function resizeCursorForHandle(handle, rotation = 0) {
  if (handle === "rotate") return "crosshair";
  const baseAngles = {
    e: 0,
    ne: 45,
    n: 90,
    nw: 135,
    w: 180,
    sw: 225,
    s: 270,
    se: 315,
  };
  const angle = modulo((baseAngles[handle] ?? 0) + rotation, 180);
  if (angle < 22.5 || angle >= 157.5) return "ew-resize";
  if (angle < 67.5) return "nesw-resize";
  if (angle < 112.5) return "ns-resize";
  return "nwse-resize";
}

function screenToNodeScreen(node, screenPoint, camera, renderer) {
  const center = renderer.worldToScreen(
    { x: node.x + node.width / 2, y: node.y + node.height / 2 },
    camera,
  );
  const radians = (-node.rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const offsetX = screenPoint.x - center.x;
  const offsetY = screenPoint.y - center.y;
  return {
    x: node.width * camera.zoom / 2 + offsetX * cosine - offsetY * sine,
    y: node.height * camera.zoom / 2 + offsetX * sine + offsetY * cosine,
  };
}

function roundedRect(context, x, y, width, height, radius) {
  if (typeof context.roundRect === "function") {
    context.roundRect(x, y, width, height, radius);
    return;
  }
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
}

function booleanCompositeOperation(operation) {
  if (operation === "subtract") return "destination-out";
  if (operation === "intersect") return "destination-in";
  if (operation === "exclude") return "xor";
  return "source-over";
}

function branchIntersectsSet(document, node, idSet) {
  if (!idSet || idSet.has(node.id)) return true;
  return getChildNodes(document, node.id)
    .some((child) => branchIntersectsSet(document, child, idSet));
}

function getOpacityUntil(document, node, stopId = null) {
  if (!stopId) return getEffectiveOpacity(document, node);
  let opacity = node.opacity;
  let cursor = node;
  const visited = new Set([node.id]);
  while (cursor.parentId && cursor.parentId !== stopId && !visited.has(cursor.parentId)) {
    visited.add(cursor.parentId);
    cursor = document.nodes.find((item) => item.id === cursor.parentId);
    if (!cursor) break;
    opacity *= cursor.opacity;
  }
  return opacity;
}

function buildVectorPath(context, node, zoom) {
  const offsetX = (node.width * zoom) / 2;
  const offsetY = (node.height * zoom) / 2;
  const project = (point) => ({
    x: point.x * zoom - offsetX,
    y: point.y * zoom - offsetY,
  });
  for (const contour of getVectorContours(node)) {
    const [first] = contour.points;
    if (!first) continue;
    const start = project(first);
    context.moveTo(start.x, start.y);
    for (const segment of getVectorSegments(contour.points, contour.closed)) {
      const mapped = mapSegment(segment, project);
      if (segment.curved) {
        context.bezierCurveTo(
          mapped.c1.x,
          mapped.c1.y,
          mapped.c2.x,
          mapped.c2.y,
          mapped.p3.x,
          mapped.p3.y,
        );
      } else {
        context.lineTo(mapped.p3.x, mapped.p3.y);
      }
    }
    if (contour.closed) context.closePath();
  }
}

function traceVectorPathOnScreen(context, node, camera, renderer) {
  const first = node.vectorPoints[0];
  if (!first) return;
  const start = renderer.worldToScreen(localToWorld(node, first), camera);
  context.moveTo(start.x, start.y);
  for (const segment of getVectorSegments(node)) {
    const mapped = mapSegment(segment, (point) =>
      renderer.worldToScreen(localToWorld(node, point), camera));
    if (segment.curved) {
      context.bezierCurveTo(
        mapped.c1.x,
        mapped.c1.y,
        mapped.c2.x,
        mapped.c2.y,
        mapped.p3.x,
        mapped.p3.y,
      );
    } else {
      context.lineTo(mapped.p3.x, mapped.p3.y);
    }
  }
  if (node.vectorClosed) context.closePath();
}

function traceWorldVectorPathOnScreen(context, points, camera, renderer) {
  if (!points.length) return;
  const start = renderer.worldToScreen(points[0], camera);
  context.moveTo(start.x, start.y);
  for (const segment of getVectorSegments(points, false)) {
    const mapped = mapSegment(segment, (point) => renderer.worldToScreen(point, camera));
    if (segment.curved) {
      context.bezierCurveTo(
        mapped.c1.x,
        mapped.c1.y,
        mapped.c2.x,
        mapped.c2.y,
        mapped.p3.x,
        mapped.p3.y,
      );
    } else {
      context.lineTo(mapped.p3.x, mapped.p3.y);
    }
  }
}

function mapSegment(segment, mapper) {
  return {
    ...segment,
    p0: mapper(segment.p0),
    c1: mapper(segment.c1),
    c2: mapper(segment.c2),
    p3: mapper(segment.p3),
  };
}

export function pointInSceneNode(document, node, worldPoint, padding = 0) {
  if (!node || !isNodeEffectivelyVisible(document, node)) return false;
  const allChildren = getChildNodes(document, node.id);
  const children = allChildren
    .filter((child) => isNodeEffectivelyVisible(document, child));

  if (node.type === NODE_TYPES.GROUP) {
    return children.some((child) => pointInSceneNode(document, child, worldPoint, padding));
  }

  if (node.type === NODE_TYPES.BOOLEAN) {
    const matches = children.map((child) =>
      pointInSceneNode(document, child, worldPoint, padding));
    if (!matches.length) return false;
    if (node.booleanOperation === "subtract") {
      return matches[0] && !matches.slice(1).some(Boolean);
    }
    if (node.booleanOperation === "intersect") return matches.every(Boolean);
    if (node.booleanOperation === "exclude") {
      return matches.filter(Boolean).length % 2 === 1;
    }
    return matches.some(Boolean);
  }

  if (node.type === NODE_TYPES.MASK) {
    const source = allChildren[0];
    if (allChildren.length < 2 || !isNodeEffectivelyVisible(document, source)) return false;
    return pointInSceneNode(document, source, worldPoint, padding) &&
      allChildren.slice(1).some((child) =>
        pointInSceneNode(document, child, worldPoint, padding));
  }

  if (!pointInNode(node, worldPoint, padding)) return false;
  if (node.type === NODE_TYPES.ELLIPSE) {
    const local = worldToLocal(node, worldPoint);
    const x = (local.x - node.width / 2) / (node.width / 2 + padding);
    const y = (local.y - node.height / 2) / (node.height / 2 + padding);
    return x * x + y * y <= 1;
  }
  if (node.type === NODE_TYPES.VECTOR) {
    const local = worldToLocal(node, worldPoint);
    const contours = getVectorContours(node).map((contour) => ({
      ...contour,
      flattened: flattenVectorPath(contour.points, contour.closed),
    }));
    const closedContours = contours.filter((contour) => contour.closed);
    const inside = node.vectorFillRule === "evenodd"
      ? closedContours.filter((contour) => pointInPolygon(local, contour.flattened)).length % 2 === 1
      : closedContours.reduce((total, contour) => total + polygonWinding(local, contour.flattened), 0) !== 0;
    const pathPadding = Math.max(padding, node.strokeWidth / 2 + padding);
    const nearPath = contours.some(({ flattened }) => flattened.slice(1).some((end, flattenedIndex) =>
      distanceToSegment(local, flattened[flattenedIndex], end) <= pathPadding));
    return inside || nearPath;
  }
  return true;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const crosses = (currentPoint.y > point.y) !== (previousPoint.y > point.y) &&
      point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
        (previousPoint.y - currentPoint.y) + currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygonNonZero(point, polygon) {
  return polygonWinding(point, polygon) !== 0;
}

function polygonWinding(point, polygon) {
  let winding = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const side = (end.x - start.x) * (point.y - start.y) -
      (point.x - start.x) * (end.y - start.y);
    if (start.y <= point.y && end.y > point.y && side > 0) winding += 1;
    if (start.y > point.y && end.y <= point.y && side < 0) winding -= 1;
  }
  return winding;
}

function projectPointToSegment(point, start, end) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared === 0) return { ...start };
  const ratio = Math.max(0, Math.min(1,
    ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared));
  return {
    x: start.x + deltaX * ratio,
    y: start.y + deltaY * ratio,
  };
}

function distanceToSegment(point, start, end) {
  return distance(point, projectPointToSegment(point, start, end));
}

function createNodeFill(context, node, width, height, paint = null) {
  const source = paint ?? {
    type: node.fillType,
    color: node.fill,
    gradient: node.gradient,
  };
  if (source.type === "solid" || !source.gradient?.stops?.length) return source.color ?? node.fill;
  const gradientData = source.gradient;
  const centerX = (gradientData.centerX - 0.5) * width;
  const centerY = (gradientData.centerY - 0.5) * height;
  let gradient;
  if (source.type === "radial-gradient") {
    gradient = context.createRadialGradient(
      centerX, centerY, 0,
      centerX, centerY, Math.max(0.5, Math.max(width, height) * gradientData.radius),
    );
  } else if (source.type === "angular-gradient" && typeof context.createConicGradient === "function") {
    gradient = context.createConicGradient(
      ((gradientData.angle ?? 0) * Math.PI) / 180,
      centerX,
      centerY,
    );
  } else {
    const radians = ((gradientData.angle ?? 0) * Math.PI) / 180;
  const directionX = Math.cos(radians);
  const directionY = Math.sin(radians);
  const halfLength = Math.max(
    0.5,
    (Math.abs(width * directionX) + Math.abs(height * directionY)) / 2,
  );
    gradient = context.createLinearGradient(
      centerX - directionX * halfLength,
      centerY - directionY * halfLength,
      centerX + directionX * halfLength,
      centerY + directionY * halfLength,
    );
  }
  for (const stop of gradientData.stops) {
    gradient.addColorStop(stop.position, stop.color);
  }
  return gradient;
}

function visiblePaints(stack, fallback, legacyKind = null) {
  let paints = Array.isArray(stack) && stack.length ? stack : [fallback];
  if (Array.isArray(stack) && stack.length && legacyKind === "fill") {
    paints = [{
      ...stack[0],
      type: fallback.type,
      color: fallback.color,
      gradient: fallback.gradient,
    }, ...stack.slice(1)];
  } else if (Array.isArray(stack) && stack.length && legacyKind === "stroke") {
    paints = [{ ...stack[0], color: fallback.color }, ...stack.slice(1)];
  }
  return paints.filter((paint) => paint && paint.visible !== false && (paint.opacity ?? 1) > 0);
}

function paintBlendMode(mode) {
  return ({
    multiply: "multiply",
    screen: "screen",
    overlay: "overlay",
    darken: "darken",
    lighten: "lighten",
  })[mode] ?? "source-over";
}

function colorWithOpacity(color, opacity) {
  const normalized = String(color).replace("#", "");
  const expanded = normalized.length === 3
    ? [...normalized].map((character) => character + character).join("")
    : normalized;
  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function modulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function getLayerBounds(canvas) {
  return canvas?.__tsyaikoBounds ?? {
    x: 0,
    y: 0,
    width: Math.max(1, canvas?.width ?? 1),
    height: Math.max(1, canvas?.height ?? 1),
    clipped: false,
  };
}

function normalizeSurfaceBounds(bounds, pixelRatio = 1) {
  const width = Math.max(1 / pixelRatio, Number.isFinite(bounds?.width) ? bounds.width : 1);
  const height = Math.max(1 / pixelRatio, Number.isFinite(bounds?.height) ? bounds.height : 1);
  return {
    x: Number.isFinite(bounds?.x) ? bounds.x : 0,
    y: Number.isFinite(bounds?.y) ? bounds.y : 0,
    width,
    height,
    clipped: bounds?.clipped === true,
  };
}

function expandBounds(bounds, padding) {
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  };
}

function unionBounds(left, right) {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maximumX = Math.max(left.x + left.width, right.x + right.width);
  const maximumY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: maximumX - x, height: maximumY - y };
}

function mergeDirtyBounds(bounds) {
  const regions = [];
  for (const candidate of bounds) {
    let merged = { ...candidate };
    let index = 0;
    while (index < regions.length) {
      const region = regions[index];
      if (!boundsIntersect(expandBounds(merged, 4), region)) {
        index += 1;
        continue;
      }
      const x = Math.min(merged.x, region.x);
      const y = Math.min(merged.y, region.y);
      const maximumX = Math.max(merged.x + merged.width, region.x + region.width);
      const maximumY = Math.max(merged.y + merged.height, region.y + region.height);
      merged = { x, y, width: maximumX - x, height: maximumY - y };
      regions.splice(index, 1);
      index = 0;
    }
    regions.push(merged);
  }
  return regions;
}

function boundsIntersect(left, right) {
  return left.x <= right.x + right.width &&
    left.x + left.width >= right.x &&
    left.y <= right.y + right.height &&
    left.y + left.height >= right.y;
}

function intersectBounds(left, right) {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const maximumX = Math.min(left.x + left.width, right.x + right.width);
  const maximumY = Math.min(left.y + left.height, right.y + right.height);
  return {
    x,
    y,
    width: Math.max(1, maximumX - x),
    height: Math.max(1, maximumY - y),
  };
}

function emptyFrameStats() {
  return {
    frameMs: 0,
    nodesVisited: 0,
    nodesDrawn: 0,
    nodesCulled: 0,
    compositeCacheHits: 0,
    compositeCacheMisses: 0,
    cacheEntries: 0,
    cacheBytes: 0,
    fullRedraw: true,
    dirtyRegions: 0,
    skipped: false,
  };
}

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function subpixelPhase(value, pixelRatio) {
  return modulo(value * pixelRatio, 1).toFixed(3);
}

function effectiveNodeLayerBlur(node) {
  const effects = node.effects ?? [];
  if (effects.some((effect) => effect.type === "layer-blur")) {
    return effects.find((effect) =>
      effect.type === "layer-blur" && effect.visible !== false && effect.radius > 0)?.radius ?? 0;
  }
  return node.layerBlur ?? 0;
}

function effectiveNodeShadow(node) {
  const effects = node.effects ?? [];
  if (effects.some((effect) => effect.type === "drop-shadow")) {
    return effects.find((effect) =>
      effect.type === "drop-shadow" && effect.visible !== false && effect.enabled !== false && effect.opacity > 0) ?? null;
  }
  return node.shadow?.enabled && node.shadow.opacity > 0 ? node.shadow : null;
}

function getImageEntry(source) {
  const cached = imageCache.get(source);
  if (cached) return cached;

  const image = new Image();
  const entry = {
    image,
    status: "loading",
    renderers: new Set(),
    promise: null,
  };
  entry.promise = new Promise((resolve) => {
    image.addEventListener("load", () => {
      entry.status = "loaded";
      resolve(image);
    }, { once: true });
    image.addEventListener("error", () => {
      entry.status = "error";
      resolve(null);
    }, { once: true });
  });
  image.src = source;
  imageCache.set(source, entry);
  return entry;
}
