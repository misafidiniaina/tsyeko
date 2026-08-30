import {
  getAncestors,
  getChildNodes,
  getDocumentBounds,
  getEffectiveOpacity,
  getRenderableNodeIds,
  isCompositeNode,
  isNodeEffectivelyLocked,
  isNodeEffectivelyVisible,
  localToWorld,
  NODE_TYPES,
  pointInNode,
  worldToLocal,
} from "./model.js";
import {
  flattenVectorPath,
  getVectorSegments,
  nearestPointOnCubic,
} from "./vector.js";

const HANDLE_SIZE = 8;
const HANDLE_HIT_RADIUS = 8;
const ROTATION_HANDLE_OFFSET = 25;
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
    }
    return changed;
  }

  render(document, selectedIds, camera, options = {}) {
    const context = this.context;
    const selectedSet = new Set(selectedIds);
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
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
  }

  drawSceneNode(document, node, camera, options = {}) {
    if (!isNodeEffectivelyVisible(document, node) || !branchIntersectsSet(document, node, options.idSet)) return;
    const children = getChildNodes(document, node.id);

    if (node.type === NODE_TYPES.GROUP) {
      for (const child of children) this.drawSceneNode(document, child, camera, options);
      return;
    }

    if (node.type === NODE_TYPES.BOOLEAN) {
      this.drawBooleanComposite(document, node, camera, options);
      return;
    }

    if (node.type === NODE_TYPES.MASK) {
      this.drawMaskComposite(document, node, camera, options);
      return;
    }

    const shouldDrawNode = !options.idSet || options.idSet.has(node.id);
    if (shouldDrawNode && node.id !== options.editingId) {
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
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
  }

  drawBooleanComposite(document, node, camera, options = {}) {
    const mask = this.createBooleanMaskLayer(document, node, camera, options);
    const painted = this.colorizeMask(mask, node, camera, false);
    const output = this.createLayer();
    const outputContext = output.getContext("2d");
    outputContext.drawImage(painted, 0, 0);

    if (node.strokeWidth > 0 && node.stroke !== "transparent") {
      const expanded = this.expandMask(mask, node.strokeWidth * camera.zoom);
      const stroke = this.colorizeMask(expanded, node, camera, true);
      outputContext.globalCompositeOperation = "destination-over";
      outputContext.drawImage(stroke, 0, 0);
    }

    this.drawCompositeLayer(output, document, node, camera, options);
  }

  drawMaskComposite(document, node, camera, options = {}) {
    const output = this.createMaskOutputLayer(document, node, camera, options);
    this.drawCompositeLayer(output, document, node, camera, options);
  }

  drawCompositeLayer(layer, document, node, camera, options = {}) {
    const context = this.context;
    context.save();
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    context.globalAlpha = getOpacityUntil(document, node, options.opacityStopId);
    this.applyNodeShadow(node, camera.zoom, options);
    context.drawImage(layer, 0, 0, this.width, this.height);
    context.restore();

    if (isNodeEffectivelyLocked(document, node) && options.lockIndicators !== false) {
      this.drawLockIndicator(node, camera);
    }
  }

  createBooleanMaskLayer(document, node, camera, options = {}) {
    const children = getChildNodes(document, node.id)
      .filter((child) => isNodeEffectivelyVisible(document, child));
    const output = this.createLayer();
    if (!children.length) return output;
    const context = output.getContext("2d");

    children.forEach((child, index) => {
      const source = this.createBranchMaskLayer(document, child, camera, options);
      context.globalCompositeOperation = index === 0
        ? "source-over"
        : booleanCompositeOperation(node.booleanOperation);
      context.drawImage(source, 0, 0);
    });
    context.globalCompositeOperation = "source-over";
    return output;
  }

  createMaskOutputLayer(document, node, camera, options = {}) {
    const children = getChildNodes(document, node.id);
    const output = this.createLayer();
    if (children.length < 2 || !isNodeEffectivelyVisible(document, children[0])) return output;

    const source = this.createBranchMaskLayer(document, children[0], camera, options);
    const context = output.getContext("2d");
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
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
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalCompositeOperation = "destination-in";
    context.drawImage(source, 0, 0);
    context.restore();
    return output;
  }

  createBranchMaskLayer(document, root, camera, options = {}) {
    const output = this.createLayer();
    const context = output.getContext("2d");
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
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
      this.drawText({ ...node, fill: "#ffffff", fillType: "solid" }, width, height, zoom);
    } else {
      const radius = Math.min(node.cornerRadius * zoom, width / 2, height / 2);
      context.beginPath();
      roundedRect(context, -width / 2, -height / 2, width, height, radius);
      context.fill();
    }
    context.restore();
  }

  colorizeMask(mask, node, camera, useStroke) {
    const output = this.createLayer();
    const context = output.getContext("2d");
    const center = this.worldToScreen(
      { x: node.x + node.width / 2, y: node.y + node.height / 2 },
      camera,
    );
    const width = node.width * camera.zoom;
    const height = node.height * camera.zoom;
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    context.translate(center.x, center.y);
    context.rotate((node.rotation * Math.PI) / 180);
    context.fillStyle = useStroke
      ? node.stroke
      : createNodeFill(context, node, width, height);
    const paintExtent = Math.max(this.width, this.height) * 3 + width + height;
    context.fillRect(-paintExtent, -paintExtent, paintExtent * 2, paintExtent * 2);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalCompositeOperation = "destination-in";
    context.drawImage(mask, 0, 0);
    return output;
  }

  expandMask(mask, screenRadius) {
    const output = this.createLayer();
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
    const context = this.context;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(layer, 0, 0);
    context.restore();
  }

  createLayer() {
    const canvas = this.canvas.ownerDocument.createElement("canvas");
    canvas.width = Math.max(1, Math.round(this.width * this.pixelRatio));
    canvas.height = Math.max(1, Math.round(this.height * this.pixelRatio));
    return canvas;
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
    if (options.shadows === false || !node.shadow?.enabled || node.shadow.opacity <= 0) {
      context.shadowColor = "transparent";
      return;
    }
    context.shadowColor = colorWithOpacity(node.shadow.color, node.shadow.opacity);
    context.shadowBlur = Math.min(250, node.shadow.blur * zoom);
    context.shadowOffsetX = Math.max(-10_000, Math.min(10_000, node.shadow.offsetX * zoom));
    context.shadowOffsetY = Math.max(-10_000, Math.min(10_000, node.shadow.offsetY * zoom));
  }

  paintPath(node, width, height, zoom, options = {}) {
    const context = this.context;
    const shouldFill = options.fill !== false;
    if (shouldFill) {
      context.fillStyle = createNodeFill(context, node, width, height);
      context.fill(options.fillRule ?? "nonzero");
      context.shadowColor = "transparent";
    }
    if (node.strokeWidth > 0) {
      context.lineWidth = Math.max(0.5, node.strokeWidth * zoom);
      context.strokeStyle = node.stroke;
      context.lineJoin = "round";
      context.lineCap = "round";
      context.stroke();
    }
    context.shadowColor = "transparent";
  }

  drawText(node, width, height, zoom) {
    const context = this.context;
    const fontSize = node.fontSize * zoom;
    if (fontSize < 2) return;

    context.fillStyle = createNodeFill(context, node, width, height);
    context.font = `${node.fontWeight} ${fontSize}px ${node.fontFamily}`;
    context.textBaseline = "top";
    context.textAlign = node.textAlign;

    const left = -width / 2;
    const textX = node.textAlign === "center"
      ? 0
      : node.textAlign === "right"
        ? width / 2
        : left;
    const lines = wrapCanvasText(context, node.text, width);
    const lineHeight = fontSize * node.lineHeight;
    let y = -height / 2;
    for (const line of lines) {
      if (y > height / 2) break;
      context.fillText(line, textX, y);
      y += lineHeight;
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
    context.fillStyle = createNodeFill(context, node, width, height);
    context.fill();
    context.shadowColor = "transparent";
    context.clip();

    const entry = node.imageData ? getImageEntry(node.imageData) : null;
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
          this.onInvalidate?.();
        });
      }
    }
    context.restore();

    if (node.strokeWidth > 0) {
      context.beginPath();
      roundedRect(context, x, y, width, height, radius);
      context.lineWidth = Math.max(0.5, node.strokeWidth * zoom);
      context.strokeStyle = node.stroke;
      context.stroke();
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

export function renderDocumentToCanvas(document, ids = null, requestedScale = 2) {
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

function wrapCanvasText(context, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    const words = paragraph.split(/\s+/);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (context.measureText(candidate).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
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
  const [first] = node.vectorPoints;
  if (!first) return;
  const offsetX = (node.width * zoom) / 2;
  const offsetY = (node.height * zoom) / 2;
  const project = (point) => ({
    x: point.x * zoom - offsetX,
    y: point.y * zoom - offsetY,
  });
  const start = project(first);
  context.moveTo(start.x, start.y);
  for (const segment of getVectorSegments(node)) {
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
  if (node.vectorClosed) context.closePath();
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
    const flattened = flattenVectorPath(node);
    const inside = node.vectorClosed && (
      node.vectorFillRule === "evenodd"
        ? pointInPolygon(local, flattened)
        : pointInPolygonNonZero(local, flattened)
    );
    const pathPadding = Math.max(padding, node.strokeWidth / 2 + padding);
    const nearPath = flattened.slice(1).some((end, flattenedIndex) =>
      distanceToSegment(local, flattened[flattenedIndex], end) <= pathPadding);
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
  let winding = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const side = (end.x - start.x) * (point.y - start.y) -
      (point.x - start.x) * (end.y - start.y);
    if (start.y <= point.y && end.y > point.y && side > 0) winding += 1;
    if (start.y > point.y && end.y <= point.y && side < 0) winding -= 1;
  }
  return winding !== 0;
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

function createNodeFill(context, node, width, height) {
  if (node.fillType !== "linear-gradient" || !node.gradient?.stops?.length) return node.fill;
  const radians = ((node.gradient.angle ?? 0) * Math.PI) / 180;
  const directionX = Math.cos(radians);
  const directionY = Math.sin(radians);
  const halfLength = Math.max(
    0.5,
    (Math.abs(width * directionX) + Math.abs(height * directionY)) / 2,
  );
  const gradient = context.createLinearGradient(
    -directionX * halfLength,
    -directionY * halfLength,
    directionX * halfLength,
    directionY * halfLength,
  );
  for (const stop of node.gradient.stops) {
    gradient.addColorStop(stop.position, stop.color);
  }
  return gradient;
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
