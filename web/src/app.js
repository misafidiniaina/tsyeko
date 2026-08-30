import {
  cloneDocument,
  createEmptyDocument,
  createNode,
  createPage,
  createStarterDocument,
  deleteNodes,
  duplicatePage,
  duplicateNodes,
  findContainingFrame,
  getAncestors,
  getChildNodes,
  getDocumentBounds,
  getNode,
  getNodeAABB,
  getNodes,
  getNodesWithDescendants,
  getPage,
  getTopLevelNodeIds,
  groupNodes,
  isContainerNode,
  isNodeEffectivelyLocked,
  isNodeEffectivelyVisible,
  localToWorld,
  NODE_TYPES,
  normalizeDocument,
  reorderNode,
  sortNodesByHierarchy,
  syncGroupBounds,
  ungroupNodes,
  worldToLocal,
} from "./model.js";
import { DocumentHistory } from "./history.js";
import { documentToSVG, downloadBlob, safeFilename } from "./export.js";
import { loadWorkspace, saveWorkspace } from "./persistence.js";
import {
  CanvasRenderer,
  preloadDocumentImages,
  renderDocumentToCanvas,
  resizeCursorForHandle,
} from "./renderer.js";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;
const SNAP_DISTANCE_PX = 6;

const elements = {
  canvas: document.querySelector("#designCanvas"),
  workspace: document.querySelector("#workspace"),
  textEditor: document.querySelector("#textEditor"),
  documentTitle: document.querySelector("#documentTitle"),
  saveState: document.querySelector("#saveState"),
  layersList: document.querySelector("#layersList"),
  emptyLayers: document.querySelector("#emptyLayers"),
  inspector: document.querySelector("#inspector"),
  zoomValue: document.querySelector("#zoomValue"),
  mainMenuButton: document.querySelector("#mainMenuButton"),
  mainMenu: document.querySelector("#mainMenu"),
  exportButton: document.querySelector("#exportButton"),
  exportMenu: document.querySelector("#exportMenu"),
  fileInput: document.querySelector("#fileInput"),
  previewModal: document.querySelector("#previewModal"),
  previewStage: document.querySelector("#previewStage"),
  toastRegion: document.querySelector("#toastRegion"),
  canvasHelp: document.querySelector("#canvasHelp"),
  pageSwitcher: document.querySelector("#pageSwitcher"),
  currentPageName: document.querySelector("#currentPageName"),
  pagesPopover: document.querySelector("#pagesPopover"),
  pagesList: document.querySelector("#pagesList"),
  imageFileInput: document.querySelector("#imageFileInput"),
};

const renderer = new CanvasRenderer(elements.canvas);
renderer.onInvalidate = () => requestRender();
const restoredWorkspace = await restoreWorkspace();
let designDocument = restoredWorkspace?.document ?? createStarterDocument();
let activePageId = getPage(designDocument, restoredWorkspace?.activePageId)?.id ?? designDocument.pages[0].id;
let pageViews = restoredWorkspace?.pageViews ?? {};
let camera = pageViews[activePageId] ?? restoredWorkspace?.camera ?? { x: 0, y: 0, zoom: 1 };
let history = new DocumentHistory(designDocument);
let selectedIds = [];
let activeTool = "select";
let interaction = null;
let editingTextId = null;
let clipboardNodes = [];
let guides = [];
let spacePressed = false;
let saveTimer = null;
let saveVersion = 0;
let frameRequest = null;
let helpTimer = null;
let imagePickerTarget = null;
const collapsedLayerIds = new Set();

initialize();

function initialize() {
  elements.documentTitle.value = designDocument.name;
  bindToolbar();
  bindCanvas();
  bindPanels();
  bindInspector();
  bindMenus();
  bindKeyboard();

  const resizeObserver = new ResizeObserver(() => {
    renderer.resize();
    requestRender();
  });
  resizeObserver.observe(elements.workspace);

  refreshUI();
  requestAnimationFrame(() => {
    renderer.resize();
    if (!restoredWorkspace) fitToContent();
    requestRender();
  });

  helpTimer = window.setTimeout(() => {
    elements.canvasHelp.style.opacity = "0";
    elements.canvasHelp.style.transition = "opacity 400ms ease";
  }, 7_000);
}

function bindToolbar() {
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.tool === "image") openImagePicker();
      else setTool(button.dataset.tool);
    });
  });

  document.querySelector("#zoomInButton").addEventListener("click", () => {
    zoomAt({ x: renderer.width / 2, y: renderer.height / 2 }, 1.2);
  });
  document.querySelector("#zoomOutButton").addEventListener("click", () => {
    zoomAt({ x: renderer.width / 2, y: renderer.height / 2 }, 1 / 1.2);
  });
  elements.zoomValue.addEventListener("click", () => {
    if (selectedIds.length) fitToContent(selectedIds);
    else fitToContent();
  });

  document.querySelector("#playButton").addEventListener("click", openPreview);
  document.querySelector("#addPageButton").addEventListener("click", addPage);
  document.querySelector("#importImageButton").addEventListener("click", () => openImagePicker());
  document.querySelector("#createComponentButton").addEventListener("click", () => {
    if (!selectedIds.length) {
      showToast("Select one or more layers first.");
      return;
    }
    showToast("Component definitions and instances are planned for the design-system milestone.");
  });
}

function bindCanvas() {
  elements.canvas.addEventListener("pointerdown", onPointerDown);
  elements.canvas.addEventListener("pointermove", onPointerMove);
  elements.canvas.addEventListener("pointerup", onPointerUp);
  elements.canvas.addEventListener("pointercancel", onPointerCancel);
  elements.canvas.addEventListener("dblclick", onDoubleClick);
  elements.canvas.addEventListener("wheel", onWheel, { passive: false });
  elements.canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  elements.textEditor.addEventListener("input", onTextEditInput);
  elements.textEditor.addEventListener("blur", () => finishTextEditing(true));
  elements.textEditor.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      finishTextEditing(true);
      elements.canvas.focus();
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      finishTextEditing(true);
      elements.canvas.focus();
    }
  });
}

function bindPanels() {
  document.querySelectorAll("[data-panel]").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("[data-panel]").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      document.querySelectorAll(".panel-content").forEach((panel) => panel.classList.remove("active-panel"));
      document.querySelector(`#${tab.dataset.panel}Panel`).classList.add("active-panel");
    });
  });

  elements.layersList.addEventListener("click", (event) => {
    const action = event.target.closest("[data-layer-action]");
    const row = event.target.closest("[data-layer-id]");
    if (!row) return;
    const id = row.dataset.layerId;
    const node = getNode(currentPage(), id);
    if (!node) return;

    if (action) {
      event.stopPropagation();
      if (action.dataset.layerAction === "collapse") {
        if (collapsedLayerIds.has(id)) collapsedLayerIds.delete(id);
        else collapsedLayerIds.add(id);
        renderLayers();
        return;
      }
      if (action.dataset.layerAction === "visibility") node.visible = !node.visible;
      if (action.dataset.layerAction === "lock") node.locked = !node.locked;
      commitDocument();
      return;
    }

    if (event.shiftKey) {
      selectedIds = selectedIds.includes(id)
        ? selectedIds.filter((selectedId) => selectedId !== id)
        : [...selectedIds, id];
    } else {
      selectedIds = [id];
    }
    refreshUI();
  });

  elements.pageSwitcher.addEventListener("click", (event) => {
    event.stopPropagation();
    elements.pagesPopover.hidden = !elements.pagesPopover.hidden;
    elements.pageSwitcher.setAttribute("aria-expanded", String(!elements.pagesPopover.hidden));
    elements.mainMenu.hidden = true;
    elements.exportMenu.hidden = true;
    if (!elements.pagesPopover.hidden) renderPages();
  });

  elements.pagesPopover.addEventListener("click", (event) => {
    const addButton = event.target.closest("[data-add-page]");
    if (addButton) {
      addPage();
      return;
    }
    const action = event.target.closest("[data-page-action]");
    const pageButton = event.target.closest("[data-page-id]");
    const pageId = action?.dataset.pageId ?? pageButton?.dataset.pageId;
    if (!pageId) return;

    if (action?.dataset.pageAction === "rename") renamePage(pageId);
    else if (action?.dataset.pageAction === "duplicate") duplicateCurrentPage(pageId);
    else if (action?.dataset.pageAction === "delete") deletePage(pageId);
    else switchPage(pageId);
  });

}

function bindInspector() {
  elements.inspector.addEventListener("input", (event) => {
    const pageInput = event.target.closest("[data-page-property]");
    if (pageInput) {
      const property = pageInput.dataset.pageProperty;
      let value = pageInput.value;
      if (property === "background") {
        value = normalizeInspectorColor(value);
        if (!isRenderableColor(value)) return;
      }
      currentPage()[property] = value;
      liveDocumentChange();
      return;
    }

    const gradientStopInput = event.target.closest("[data-gradient-stop]");
    if (gradientStopInput && selectedIds.length === 1) {
      const node = getNode(currentPage(), selectedIds[0]);
      if (!node?.gradient?.stops?.length) return;
      const index = gradientStopInput.dataset.gradientStop === "last"
        ? node.gradient.stops.length - 1
        : Number.parseInt(gradientStopInput.dataset.gradientStop, 10);
      const value = normalizeInspectorColor(gradientStopInput.value);
      if (!node.gradient.stops[index] || !isRenderableColor(value)) return;
      node.gradient.stops[index].color = value;
      liveDocumentChange();
      return;
    }

    const gradientInput = event.target.closest("[data-gradient-property]");
    if (gradientInput && selectedIds.length === 1) {
      const node = getNode(currentPage(), selectedIds[0]);
      if (!node?.gradient) return;
      let value = Number.parseFloat(gradientInput.value);
      if (!Number.isFinite(value)) return;
      if (gradientInput.dataset.gradientProperty === "angle") value = ((value % 360) + 360) % 360;
      node.gradient[gradientInput.dataset.gradientProperty] = value;
      liveDocumentChange();
      return;
    }

    const shadowInput = event.target.closest("[data-shadow-property]");
    if (shadowInput && selectedIds.length === 1) {
      const node = getNode(currentPage(), selectedIds[0]);
      if (!node?.shadow) return;
      const property = shadowInput.dataset.shadowProperty;
      let value = shadowInput.value;
      if (property === "color") {
        value = normalizeInspectorColor(value);
        if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) return;
      } else {
        value = Number.parseFloat(value);
        if (!Number.isFinite(value)) return;
        value *= Number.parseFloat(shadowInput.dataset.scale || "1");
        if (property === "opacity") value = clamp(value, 0, 1);
        if (property === "blur") value = clamp(value, 0, 500);
        if (["offsetX", "offsetY"].includes(property)) value = clamp(value, -10_000, 10_000);
      }
      node.shadow[property] = value;
      liveDocumentChange();
      return;
    }

    const input = event.target.closest("[data-property]");
    if (!input || selectedIds.length !== 1) return;
    const node = getNode(currentPage(), selectedIds[0]);
    if (!node) return;

    const property = input.dataset.property;
    let value = input.value;
    if (input.dataset.valueType === "number") {
      value = Number.parseFloat(value);
      if (!Number.isFinite(value)) return;
      value *= Number.parseFloat(input.dataset.scale || "1");
    }
    if (["fill", "stroke"].includes(property)) {
      value = normalizeInspectorColor(value);
      if (!isRenderableColor(value)) return;
    }

    if (["width", "height"].includes(property)) value = Math.max(1, value);
    if (property === "rotation") value = normalizeDegrees(value);
    if (property === "opacity") value = clamp(value, 0, 1);
    if (property === "strokeWidth" || property === "cornerRadius") value = Math.max(0, value);
    if (property === "fontSize") value = Math.max(1, value);
    const previousValue = node[property];
    node[property] = value;
    if (isContainerNode(node) && ["x", "y"].includes(property)) {
      const delta = value - previousValue;
      for (const child of getNodesWithDescendants(currentPage(), [node.id])) {
        if (child.id !== node.id) child[property] += delta;
      }
    }
    if (isContainerNode(node) && property === "rotation") {
      const delta = normalizeDegrees(value - previousValue);
      const radians = (delta * Math.PI) / 180;
      const cosine = Math.cos(radians);
      const sine = Math.sin(radians);
      const center = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
      for (const child of getNodesWithDescendants(currentPage(), [node.id])) {
        if (child.id === node.id || child.type === NODE_TYPES.GROUP) continue;
        const childCenter = { x: child.x + child.width / 2, y: child.y + child.height / 2 };
        const offsetX = childCenter.x - center.x;
        const offsetY = childCenter.y - center.y;
        child.x = center.x + offsetX * cosine - offsetY * sine - child.width / 2;
        child.y = center.y + offsetX * sine + offsetY * cosine - child.height / 2;
        child.rotation = normalizeDegrees(child.rotation + delta);
      }
    }
    liveDocumentChange();

    if (property === "name") renderLayers();
  });

  elements.inspector.addEventListener("change", (event) => {
    if (event.target.closest("[data-property], [data-page-property], [data-gradient-stop], [data-gradient-property], [data-shadow-property]")) commitDocument();
  });

  elements.inspector.addEventListener("click", (event) => {
    const button = event.target.closest("[data-inspector-action]");
    if (!button || selectedIds.length !== 1) return;
    const node = getNode(currentPage(), selectedIds[0]);
    if (!node) return;
    const action = button.dataset.inspectorAction;

    if (action === "toggle-visible") node.visible = !node.visible;
    if (action === "toggle-lock") node.locked = !node.locked;
    if (action === "bring-forward") reorderNode(currentPage(), node.id, "front");
    if (action === "send-backward") reorderNode(currentPage(), node.id, "back");
    if (action === "delete") {
      deleteSelection();
      return;
    }
    if (action === "ungroup") {
      ungroupSelection();
      return;
    }
    if (action === "align") node.textAlign = button.dataset.value;
    if (action === "fill-mode") node.fillType = button.dataset.value;
    if (action === "toggle-shadow") node.shadow.enabled = !node.shadow.enabled;
    if (action === "image-fit") node.imageFit = button.dataset.value;
    if (action === "replace-image") {
      openImagePicker(node.id);
      return;
    }
    commitDocument();
  });

  document.querySelectorAll(".inspector-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".inspector-tab").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      if (tab.textContent.trim() === "Prototype") {
        elements.inspector.innerHTML = `
          <div class="no-selection">
            <strong>Prototype interactions</strong>
            Connect frames and define transitions in the next product increment. Preview already renders the current document.
          </div>`;
      } else {
        renderInspector();
      }
    });
  });
}

function bindMenus() {
  elements.mainMenuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePopover(elements.mainMenu);
    elements.exportMenu.hidden = true;
    elements.pagesPopover.hidden = true;
    elements.pageSwitcher.setAttribute("aria-expanded", "false");
  });
  elements.exportButton.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePopover(elements.exportMenu);
    elements.mainMenu.hidden = true;
    elements.pagesPopover.hidden = true;
    elements.pageSwitcher.setAttribute("aria-expanded", "false");
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".popover") && !event.target.closest("#mainMenuButton") && !event.target.closest("#exportButton") && !event.target.closest("#pageSwitcher")) {
      closePopovers();
    }
  });

  elements.mainMenu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-action]");
    if (!item) return;
    closePopovers();
    const action = item.dataset.action;
    if (action === "new") newDocument();
    if (action === "import") elements.fileInput.click();
    if (action === "undo") undo();
    if (action === "redo") redo();
    if (action === "fit") fitToContent();
    if (action === "shortcuts") {
      showToast("V move · F frame · R rectangle · T text · ⌘G group · ⇧⌘G ungroup · ⌘D duplicate · ⌫ delete");
    }
  });

  elements.exportMenu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-export]");
    if (!item) return;
    closePopovers();
    exportDocument(item.dataset.export);
  });

  elements.fileInput.addEventListener("change", importDocument);
  elements.imageFileInput.addEventListener("change", importImage);
  elements.documentTitle.addEventListener("input", () => {
    designDocument.name = elements.documentTitle.value || "Untitled design";
    liveDocumentChange();
  });
  elements.documentTitle.addEventListener("change", commitDocument);

  elements.previewModal.addEventListener("click", (event) => {
    if (event.target === elements.previewModal || event.target.closest("[data-close-modal]")) {
      closePreview();
    }
  });
}

function bindKeyboard() {
  window.addEventListener("keydown", (event) => {
    if (event.code === "Space" && !isTypingTarget(event.target)) {
      spacePressed = true;
      updateCanvasCursor();
      event.preventDefault();
    }

    if (isTypingTarget(event.target)) return;
    const command = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (command && key === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (command && key === "d") {
      event.preventDefault();
      duplicateSelection();
      return;
    }
    if (command && key === "g") {
      event.preventDefault();
      if (event.shiftKey) ungroupSelection();
      else groupSelection();
      return;
    }
    if (command && key === "c") {
      event.preventDefault();
      copySelection();
      return;
    }
    if (command && key === "x") {
      event.preventDefault();
      copySelection();
      deleteSelection();
      return;
    }
    if (command && key === "v") {
      event.preventDefault();
      pasteClipboard();
      return;
    }
    if (command && key === "a") {
      event.preventDefault();
      selectedIds = getChildNodes(currentPage(), null)
        .filter((node) => isNodeEffectivelyVisible(currentPage(), node))
        .map((node) => node.id);
      refreshUI();
      return;
    }

    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      deleteSelection();
      return;
    }

    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      nudgeSelection(event.key, event.shiftKey ? 10 : 1);
      return;
    }

    if (event.key === "Escape") {
      closePopovers();
      if (!elements.previewModal.hidden) closePreview();
      else if (activeTool !== "select") setTool("select");
      else {
        selectedIds = [];
        refreshUI();
      }
      return;
    }

    if (event.key === "Enter" && selectedIds.length === 1) {
      const node = getNode(currentPage(), selectedIds[0]);
      if (node?.type === NODE_TYPES.TEXT) startTextEditing(node);
      return;
    }

    if (!command && !event.altKey) {
      const tools = { v: "select", h: "hand", f: "frame", r: "rectangle", o: "ellipse", t: "text" };
      if (tools[key]) {
        event.preventDefault();
        setTool(tools[key]);
        return;
      }
      if (key === "i") {
        event.preventDefault();
        openImagePicker();
        return;
      }
      if (key === "1") fitToContent();
      if (key === "2" && selectedIds.length) fitToContent(selectedIds);
      if (key === "0") setZoom(1);
      if (event.key === "]") arrangeSelection("front");
      if (event.key === "[") arrangeSelection("back");
    }
  });

  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") {
      spacePressed = false;
      updateCanvasCursor();
    }
  });

  window.addEventListener("blur", () => {
    spacePressed = false;
    if (interaction?.type === "pan") interaction = null;
    updateCanvasCursor();
  });
}

function onPointerDown(event) {
  if (event.button !== 0 && event.button !== 1) return;
  closePopovers();
  if (editingTextId) finishTextEditing(true);
  elements.canvas.focus();
  const screen = eventPoint(event);
  const world = renderer.screenToWorld(screen, camera);

  if (event.button === 1 || spacePressed || activeTool === "hand") {
    interaction = {
      type: "pan",
      pointerId: event.pointerId,
      start: screen,
      camera: { ...camera },
    };
    capturePointer(event);
    updateCanvasCursor("grabbing");
    return;
  }

  if (activeTool === "text") {
    const node = createNode(NODE_TYPES.TEXT, world.x, world.y, {
      width: 260,
      height: 76,
      text: "Type something",
    });
    currentPage().nodes.push(node);
    assignNodeToFrame(currentPage(), node);
    selectedIds = [node.id];
    commitDocument();
    setTool("select");
    startTextEditing(node, true);
    return;
  }

  if (["frame", "rectangle", "ellipse"].includes(activeTool)) {
    const node = createNode(activeTool, world.x, world.y, { width: 1, height: 1 });
    currentPage().nodes.push(node);
    selectedIds = [node.id];
    interaction = {
      type: "draw",
      pointerId: event.pointerId,
      startWorld: world,
      nodeId: node.id,
      tool: activeTool,
    };
    capturePointer(event);
    requestRender();
    return;
  }

  if (activeTool !== "select") return;
  const selectedNode = selectedIds.length === 1 ? getNode(currentPage(), selectedIds[0]) : null;
  const handle = selectedNode ? renderer.getHandleAt(screen, selectedNode, camera) : null;

  if (handle && selectedNode && !isNodeEffectivelyLocked(currentPage(), selectedNode)) {
    interaction = handle === "rotate"
      ? createRotateInteraction(event, selectedNode, world)
      : createResizeInteraction(event, selectedNode, handle);
    capturePointer(event);
    return;
  }

  const hit = renderer.hitTest(currentPage(), screen, camera);
  if (hit) {
    if (event.shiftKey) {
      selectedIds = selectedIds.includes(hit.id)
        ? selectedIds.filter((id) => id !== hit.id)
        : [...selectedIds, hit.id];
    } else if (!selectedIds.includes(hit.id)) {
      selectedIds = [hit.id];
    }

    if (!isNodeEffectivelyLocked(currentPage(), hit) && selectedIds.includes(hit.id)) {
      const rootIds = getTopLevelNodeIds(currentPage(), selectedIds)
        .filter((id) => !isNodeEffectivelyLocked(currentPage(), id));
      const movableNodes = getNodesWithDescendants(currentPage(), rootIds);
      interaction = {
        type: "move",
        pointerId: event.pointerId,
        startWorld: world,
        nodes: movableNodes.map((node) => ({ id: node.id, x: node.x, y: node.y })),
        rootIds,
        axis: null,
      };
      capturePointer(event);
      updateCanvasCursor("move");
    }
    refreshUI();
    return;
  }

  if (!event.shiftKey) selectedIds = [];
  interaction = {
    type: "marquee",
    pointerId: event.pointerId,
    start: screen,
    current: screen,
    additive: event.shiftKey,
    previousSelection: [...selectedIds],
  };
  capturePointer(event);
  refreshUI();
}

function onPointerMove(event) {
  const screen = eventPoint(event);
  if (!interaction) {
    updateHoverCursor(screen);
    return;
  }
  if (interaction.pointerId !== event.pointerId) return;

  if (interaction.type === "pan") {
    camera.x = interaction.camera.x + screen.x - interaction.start.x;
    camera.y = interaction.camera.y + screen.y - interaction.start.y;
    requestRender();
    return;
  }

  const world = renderer.screenToWorld(screen, camera);
  if (interaction.type === "draw") updateDrawing(world, event);
  if (interaction.type === "move") updateMove(world, event);
  if (interaction.type === "resize") updateResize(world, event);
  if (interaction.type === "rotate") updateRotation(world, event);
  if (interaction.type === "marquee") updateMarquee(screen);
  requestRender();
}

function onPointerUp(event) {
  if (!interaction || interaction.pointerId !== event.pointerId) return;
  const completedType = interaction.type;

  if (completedType === "draw") {
    const node = getNode(currentPage(), interaction.nodeId);
    if (node && node.width * camera.zoom < 3 && node.height * camera.zoom < 3) {
      const defaults = createNode(node.type, interaction.startWorld.x, interaction.startWorld.y);
      node.width = defaults.width;
      node.height = defaults.height;
    }
    if (node) assignNodeToFrame(currentPage(), node);
    syncGroupBounds(currentPage());
    commitDocument();
    setTool("select");
  } else if (["move", "resize", "rotate"].includes(completedType)) {
    if (completedType === "move") reparentMovedRoots(interaction.rootIds);
    syncGroupBounds(currentPage());
    commitDocument();
  } else if (completedType === "marquee") {
    refreshUI();
  }

  releasePointer(event);
  interaction = null;
  guides = [];
  updateCanvasCursor();
  refreshUI();
}

function onPointerCancel(event) {
  if (!interaction || interaction.pointerId !== event.pointerId) return;
  if (interaction.type === "draw") {
    currentPage().nodes = currentPage().nodes.filter((node) => node.id !== interaction.nodeId);
    selectedIds = [];
  }
  if (interaction.type === "move") {
    for (const original of interaction.nodes) {
      const node = getNode(currentPage(), original.id);
      if (node) Object.assign(node, { x: original.x, y: original.y });
    }
  }
  if (interaction.type === "resize") {
    for (const original of interaction.nodes) {
      const node = getNode(currentPage(), original.id);
      if (node) Object.assign(node, original);
    }
  }
  if (interaction.type === "rotate") {
    for (const original of interaction.nodes) {
      const node = getNode(currentPage(), original.id);
      if (node) Object.assign(node, original);
    }
  }
  syncGroupBounds(currentPage());
  releasePointer(event);
  interaction = null;
  guides = [];
  updateCanvasCursor();
  refreshUI();
}

function onDoubleClick(event) {
  const screen = eventPoint(event);
  const node = renderer.hitTest(currentPage(), screen, camera);
  if (node?.type === NODE_TYPES.TEXT && !isNodeEffectivelyLocked(currentPage(), node)) {
    selectedIds = [node.id];
    refreshUI();
    startTextEditing(node);
  }
}

function onWheel(event) {
  event.preventDefault();
  const screen = eventPoint(event);
  if (event.ctrlKey || event.metaKey) {
    const factor = Math.exp(-event.deltaY * 0.007);
    zoomAt(screen, factor);
  } else {
    camera.x -= event.deltaX;
    camera.y -= event.deltaY;
    requestRender();
    scheduleSave();
  }
}

function updateDrawing(world, event) {
  const node = getNode(currentPage(), interaction.nodeId);
  if (!node) return;
  let deltaX = world.x - interaction.startWorld.x;
  let deltaY = world.y - interaction.startWorld.y;

  if (event.shiftKey) {
    const size = Math.max(Math.abs(deltaX), Math.abs(deltaY));
    deltaX = Math.sign(deltaX || 1) * size;
    deltaY = Math.sign(deltaY || 1) * size;
  }

  if (event.altKey) {
    node.x = interaction.startWorld.x - Math.abs(deltaX);
    node.y = interaction.startWorld.y - Math.abs(deltaY);
    node.width = Math.max(1, Math.abs(deltaX) * 2);
    node.height = Math.max(1, Math.abs(deltaY) * 2);
  } else {
    node.x = Math.min(interaction.startWorld.x, interaction.startWorld.x + deltaX);
    node.y = Math.min(interaction.startWorld.y, interaction.startWorld.y + deltaY);
    node.width = Math.max(1, Math.abs(deltaX));
    node.height = Math.max(1, Math.abs(deltaY));
  }
}

function updateMove(world, event) {
  let deltaX = world.x - interaction.startWorld.x;
  let deltaY = world.y - interaction.startWorld.y;
  if (event.shiftKey) {
    if (!interaction.axis && Math.hypot(deltaX, deltaY) > 3 / camera.zoom) {
      interaction.axis = Math.abs(deltaX) > Math.abs(deltaY) ? "x" : "y";
    }
    if (interaction.axis === "x") deltaY = 0;
    if (interaction.axis === "y") deltaX = 0;
  } else {
    interaction.axis = null;
  }

  for (const original of interaction.nodes) {
    const node = getNode(currentPage(), original.id);
    if (!node) continue;
    node.x = original.x + deltaX;
    node.y = original.y + deltaY;
  }

  guides = event.altKey ? [] : snapSelection(interaction.nodes.map((item) => item.id));
  syncGroupBounds(currentPage());
}

function createResizeInteraction(event, node, handle) {
  const nodes = node.type === NODE_TYPES.GROUP
    ? getNodesWithDescendants(currentPage(), [node.id])
    : [node];
  return {
    type: "resize",
    pointerId: event.pointerId,
    nodeId: node.id,
    handle,
    original: cloneNode(node),
    nodes: nodes.map(cloneNode),
    aspectRatio: node.width / node.height,
  };
}

function updateResize(world, event) {
  const node = getNode(currentPage(), interaction.nodeId);
  const original = interaction.original;
  if (!node || !original) return;
  const pointer = worldToLocal(original, world);
  const handle = interaction.handle;
  let left = 0;
  let top = 0;
  let right = original.width;
  let bottom = original.height;

  if (handle.includes("w")) left = Math.min(pointer.x, right - 1);
  if (handle.includes("e")) right = Math.max(pointer.x, left + 1);
  if (handle.includes("n")) top = Math.min(pointer.y, bottom - 1);
  if (handle.includes("s")) bottom = Math.max(pointer.y, top + 1);

  if (event.altKey) {
    if (handle.includes("w")) right = original.width - left;
    if (handle.includes("e")) left = original.width - right;
    if (handle.includes("n")) bottom = original.height - top;
    if (handle.includes("s")) top = original.height - bottom;
  }

  let width = Math.max(1, right - left);
  let height = Math.max(1, bottom - top);
  if (event.shiftKey && handle.length === 2) {
    if (width / height > interaction.aspectRatio) {
      height = width / interaction.aspectRatio;
      if (handle.includes("n")) top = bottom - height;
      else bottom = top + height;
    } else {
      width = height * interaction.aspectRatio;
      if (handle.includes("w")) left = right - width;
      else right = left + width;
    }
  }

  const newCenter = localToWorld(original, {
    x: left + width / 2,
    y: top + height / 2,
  });
  node.width = width;
  node.height = height;
  node.x = newCenter.x - width / 2;
  node.y = newCenter.y - height / 2;

  if (node.type === NODE_TYPES.GROUP) {
    const scaleX = width / original.width;
    const scaleY = height / original.height;
    for (const snapshot of interaction.nodes) {
      if (snapshot.id === node.id || snapshot.type === NODE_TYPES.GROUP) continue;
      const child = getNode(currentPage(), snapshot.id);
      if (!child) continue;
      child.x = node.x + (snapshot.x - original.x) * scaleX;
      child.y = node.y + (snapshot.y - original.y) * scaleY;
      child.width = Math.max(1, snapshot.width * scaleX);
      child.height = Math.max(1, snapshot.height * scaleY);
      if (child.type === NODE_TYPES.TEXT) {
        child.fontSize = Math.max(1, snapshot.fontSize * Math.min(scaleX, scaleY));
      }
    }
    syncGroupBounds(currentPage());
  } else {
    syncGroupBounds(currentPage());
  }
}

function createRotateInteraction(event, node, world) {
  const center = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  const nodes = isContainerNode(node)
    ? getNodesWithDescendants(currentPage(), [node.id])
    : [node];
  return {
    type: "rotate",
    pointerId: event.pointerId,
    nodeId: node.id,
    center,
    startAngle: Math.atan2(world.y - center.y, world.x - center.x),
    startRotation: node.rotation,
    nodes: nodes.map(cloneNode),
  };
}

function updateRotation(world, event) {
  const node = getNode(currentPage(), interaction.nodeId);
  if (!node) return;
  const angle = Math.atan2(world.y - interaction.center.y, world.x - interaction.center.x);
  let degrees = interaction.startRotation + ((angle - interaction.startAngle) * 180) / Math.PI;
  if (event.shiftKey) degrees = Math.round(degrees / 15) * 15;
  const delta = normalizeDegrees(degrees - interaction.startRotation);
  if (node.type === NODE_TYPES.GROUP) node.rotation = 0;
  else node.rotation = normalizeDegrees(degrees);

  if (isContainerNode(node)) {
    const radians = (delta * Math.PI) / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    for (const snapshot of interaction.nodes) {
      if (snapshot.id === node.id || snapshot.type === NODE_TYPES.GROUP) continue;
      const child = getNode(currentPage(), snapshot.id);
      if (!child) continue;
      const childCenter = {
        x: snapshot.x + snapshot.width / 2,
        y: snapshot.y + snapshot.height / 2,
      };
      const offsetX = childCenter.x - interaction.center.x;
      const offsetY = childCenter.y - interaction.center.y;
      const rotatedCenter = {
        x: interaction.center.x + offsetX * cosine - offsetY * sine,
        y: interaction.center.y + offsetX * sine + offsetY * cosine,
      };
      child.x = rotatedCenter.x - child.width / 2;
      child.y = rotatedCenter.y - child.height / 2;
      child.rotation = normalizeDegrees(snapshot.rotation + delta);
    }
    syncGroupBounds(currentPage());
  }
}

function updateMarquee(screen) {
  interaction.current = screen;
  const worldStart = renderer.screenToWorld(interaction.start, camera);
  const worldEnd = renderer.screenToWorld(interaction.current, camera);
  const marquee = normalizedRect(worldStart, worldEnd);
  const matching = currentPage().nodes
    .filter((node) => isNodeEffectivelyVisible(currentPage(), node) && rectanglesIntersect(marquee, getNodeAABB(node)))
    .map((node) => node.id);
  selectedIds = interaction.additive
    ? [...new Set([...interaction.previousSelection, ...matching])]
    : matching;
}

function snapSelection(ids) {
  const idSet = new Set(ids);
  const selected = currentPage().nodes.filter((node) => idSet.has(node.id));
  const references = currentPage().nodes.filter((node) => isNodeEffectivelyVisible(currentPage(), node) && !idSet.has(node.id));
  if (!selected.length || !references.length) return [];

  const selectionBounds = combinedBounds(selected.map(getNodeAABB));
  const xTargets = edgeValues(selectionBounds, "x");
  const yTargets = edgeValues(selectionBounds, "y");
  const referenceX = references.flatMap((node) => edgeValues(getNodeAABB(node), "x"));
  const referenceY = references.flatMap((node) => edgeValues(getNodeAABB(node), "y"));
  const threshold = SNAP_DISTANCE_PX / camera.zoom;
  const xSnap = closestSnap(xTargets, referenceX, threshold);
  const ySnap = closestSnap(yTargets, referenceY, threshold);

  if (xSnap) selected.forEach((node) => { node.x += xSnap.delta; });
  if (ySnap) selected.forEach((node) => { node.y += ySnap.delta; });

  return [
    ...(xSnap ? [{ axis: "x", value: xSnap.value }] : []),
    ...(ySnap ? [{ axis: "y", value: ySnap.value }] : []),
  ];
}

function setTool(tool) {
  if (editingTextId) finishTextEditing(true);
  activeTool = tool;
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === activeTool);
  });
  updateCanvasCursor();
}

function updateCanvasCursor(forced = null) {
  if (forced) {
    elements.canvas.dataset.cursor = forced;
    return;
  }
  if (interaction?.type === "pan") elements.canvas.dataset.cursor = "grabbing";
  else if (spacePressed || activeTool === "hand") elements.canvas.dataset.cursor = "grab";
  else if (["frame", "rectangle", "ellipse"].includes(activeTool)) elements.canvas.dataset.cursor = "crosshair";
  else if (activeTool === "text") elements.canvas.dataset.cursor = "text";
  else elements.canvas.dataset.cursor = "default";
  elements.canvas.style.cursor = "";
}

function updateHoverCursor(screen) {
  if (activeTool !== "select" || spacePressed) {
    updateCanvasCursor();
    return;
  }
  const selected = selectedIds.length === 1 ? getNode(currentPage(), selectedIds[0]) : null;
  const handle = selected ? renderer.getHandleAt(screen, selected, camera) : null;
  if (handle) {
    elements.canvas.dataset.cursor = "";
    elements.canvas.style.cursor = resizeCursorForHandle(handle, selected.rotation);
    return;
  }
  const hit = renderer.hitTest(currentPage(), screen, camera);
  elements.canvas.style.cursor = "";
  elements.canvas.dataset.cursor = hit && !isNodeEffectivelyLocked(currentPage(), hit) ? "move" : "default";
}

function startTextEditing(node, selectAll = false) {
  if (!node || node.type !== NODE_TYPES.TEXT || isNodeEffectivelyLocked(currentPage(), node)) return;
  editingTextId = node.id;
  const center = renderer.worldToScreen(
    { x: node.x + node.width / 2, y: node.y + node.height / 2 },
    camera,
  );
  const editor = elements.textEditor;
  editor.value = node.text;
  editor.style.display = "block";
  editor.style.left = `${center.x}px`;
  editor.style.top = `${center.y}px`;
  editor.style.width = `${Math.max(20, node.width * camera.zoom)}px`;
  editor.style.height = `${Math.max(20, node.height * camera.zoom)}px`;
  editor.style.transform = `translate(-50%, -50%) rotate(${node.rotation}deg)`;
  editor.style.font = `${node.fontWeight} ${node.fontSize * camera.zoom}px/${node.lineHeight} ${node.fontFamily}`;
  editor.style.textAlign = node.textAlign;
  editor.style.color = node.fill;
  requestRender();
  requestAnimationFrame(() => {
    editor.focus();
    if (selectAll) editor.select();
    else editor.setSelectionRange(editor.value.length, editor.value.length);
  });
}

function onTextEditInput() {
  const node = getNode(currentPage(), editingTextId);
  if (!node) return;
  node.text = elements.textEditor.value;
  liveDocumentChange();
}

function finishTextEditing(shouldCommit) {
  if (!editingTextId) return;
  editingTextId = null;
  elements.textEditor.style.display = "none";
  if (shouldCommit) commitDocument();
  else requestRender();
}

function deleteSelection() {
  if (!selectedIds.length) return;
  const ids = getTopLevelNodeIds(currentPage(), selectedIds)
    .filter((id) => !isNodeEffectivelyLocked(currentPage(), id));
  deleteNodes(currentPage(), ids);
  selectedIds = selectedIds.filter((id) => getNode(currentPage(), id));
  commitDocument();
}

function duplicateSelection() {
  if (!selectedIds.length) return;
  const copies = duplicateNodes(currentPage(), selectedIds, 20 / camera.zoom);
  const copyIds = new Set(copies.map((node) => node.id));
  selectedIds = copies.filter((node) => !copyIds.has(node.parentId)).map((node) => node.id);
  commitDocument();
}

function copySelection() {
  clipboardNodes = getNodesWithDescendants(currentPage(), selectedIds).map(cloneNode);
  if (clipboardNodes.length) showToast(`${clipboardNodes.length} layer${clipboardNodes.length === 1 ? "" : "s"} copied`);
}

function pasteClipboard() {
  if (!clipboardNodes.length) return;
  const idMap = new Map();
  const copies = clipboardNodes.map((source) => {
    const { id: _id, parentId: _parentId, ...properties } = source;
    const copy = createNode(source.type, source.x + 24, source.y + 24, {
      ...properties,
      locked: false,
      parentId: null,
    });
    idMap.set(source.id, copy.id);
    return copy;
  });
  for (let index = 0; index < copies.length; index += 1) {
    const source = clipboardNodes[index];
    const externalParent = source.parentId ? getNode(currentPage(), source.parentId) : null;
    copies[index].parentId = source.parentId
      ? idMap.get(source.parentId) ?? (isContainerNode(externalParent) ? externalParent.id : null)
      : null;
  }
  currentPage().nodes.push(...copies);
  sortNodesByHierarchy(currentPage());
  syncGroupBounds(currentPage());
  clipboardNodes = copies.map(cloneNode);
  const copyIds = new Set(copies.map((node) => node.id));
  selectedIds = copies.filter((node) => !copyIds.has(node.parentId)).map((node) => node.id);
  commitDocument();
}

function nudgeSelection(key, amount) {
  const rootIds = getTopLevelNodeIds(currentPage(), selectedIds)
    .filter((id) => !isNodeEffectivelyLocked(currentPage(), id));
  const nodes = getNodesWithDescendants(currentPage(), rootIds);
  if (!nodes.length) return;
  for (const node of nodes) {
    if (key === "ArrowLeft") node.x -= amount;
    if (key === "ArrowRight") node.x += amount;
    if (key === "ArrowUp") node.y -= amount;
    if (key === "ArrowDown") node.y += amount;
  }
  syncGroupBounds(currentPage());
  commitDocument();
}

function groupSelection() {
  if (!selectedIds.length) return;
  const group = groupNodes(currentPage(), selectedIds);
  if (!group) {
    showToast("Layers must share the same parent before they can be grouped.");
    return;
  }
  selectedIds = [group.id];
  commitDocument();
}

function ungroupSelection() {
  if (!selectedIds.length) return;
  const released = ungroupNodes(currentPage(), selectedIds);
  if (!released.length) {
    showToast("Select a group to ungroup it.");
    return;
  }
  selectedIds = released;
  commitDocument();
}

function arrangeSelection(direction) {
  if (selectedIds.length !== 1) return;
  if (reorderNode(currentPage(), selectedIds[0], direction)) commitDocument();
}

function assignNodeToFrame(page, node) {
  const frame = findContainingFrame(page, node);
  node.parentId = frame?.id ?? null;
  sortNodesByHierarchy(page);
}

function reparentMovedRoots(rootIds = []) {
  const page = currentPage();
  for (const id of rootIds) {
    const node = getNode(page, id);
    const currentParent = node?.parentId ? getNode(page, node.parentId) : null;
    if (!node || currentParent?.type === NODE_TYPES.GROUP) continue;
    node.parentId = findContainingFrame(page, node, rootIds)?.id ?? null;
  }
  sortNodesByHierarchy(page);
}

function currentPage() {
  return getPage(designDocument, activePageId) ?? designDocument.pages[0];
}

function ensureActivePage() {
  if (getPage(designDocument, activePageId)) return;
  activePageId = designDocument.pages[0].id;
  selectedIds = [];
  camera = pageViews[activePageId] ?? {
    x: renderer.width / 2,
    y: renderer.height / 2,
    zoom: 1,
  };
}

function addPage() {
  finishTextEditing(true);
  rememberCurrentView();
  const page = createPage(nextPageName(), { background: currentPage().background });
  designDocument.pages.push(page);
  activePageId = page.id;
  selectedIds = [];
  interaction = null;
  camera = { x: renderer.width / 2, y: renderer.height / 2, zoom: 1 };
  commitDocument();
  elements.pagesPopover.hidden = false;
  elements.pageSwitcher.setAttribute("aria-expanded", "true");
  showToast(`${page.name} created`);
}

function switchPage(pageId) {
  if (pageId === activePageId || !getPage(designDocument, pageId)) {
    closePopovers();
    return;
  }
  finishTextEditing(true);
  rememberCurrentView();
  activePageId = pageId;
  selectedIds = [];
  interaction = null;
  guides = [];
  const savedView = pageViews[pageId];
  camera = savedView
    ? { ...savedView }
    : { x: renderer.width / 2, y: renderer.height / 2, zoom: 1 };
  closePopovers();
  refreshUI();
  if (!savedView && currentPage().nodes.length) fitToContent();
  else scheduleSave();
}

function renamePage(pageId) {
  const page = getPage(designDocument, pageId);
  if (!page) return;
  const value = window.prompt("Page name", page.name);
  if (value === null) return;
  const name = value.trim().slice(0, 120);
  if (!name || name === page.name) return;
  page.name = name;
  commitDocument();
}

function duplicateCurrentPage(pageId) {
  finishTextEditing(true);
  rememberCurrentView();
  const page = duplicatePage(designDocument, pageId);
  if (!page) return;
  activePageId = page.id;
  selectedIds = [];
  const sourceView = pageViews[pageId];
  camera = sourceView
    ? { ...sourceView }
    : { x: renderer.width / 2, y: renderer.height / 2, zoom: 1 };
  pageViews[page.id] = { ...camera };
  commitDocument();
  showToast(`${page.name} created`);
}

function deletePage(pageId) {
  if (designDocument.pages.length === 1) {
    showToast("A document must contain at least one page.");
    return;
  }
  const index = designDocument.pages.findIndex((page) => page.id === pageId);
  if (index < 0) return;
  const page = designDocument.pages[index];
  if (page.nodes.length && !window.confirm(`Delete “${page.name}” and all of its layers?`)) return;

  const deletingActivePage = pageId === activePageId;
  designDocument.pages.splice(index, 1);
  delete pageViews[pageId];
  if (deletingActivePage) {
    const replacement = designDocument.pages[Math.min(index, designDocument.pages.length - 1)];
    activePageId = replacement.id;
    selectedIds = [];
    camera = pageViews[replacement.id] ?? {
      x: renderer.width / 2,
      y: renderer.height / 2,
      zoom: 1,
    };
  }
  commitDocument();
  showToast(`${page.name} deleted`);
}

function nextPageName() {
  const names = new Set(designDocument.pages.map((page) => page.name));
  let index = designDocument.pages.length + 1;
  while (names.has(`Page ${index}`)) index += 1;
  return `Page ${index}`;
}

function rememberCurrentView() {
  if (!activePageId || !camera) return;
  pageViews[activePageId] = { x: camera.x, y: camera.y, zoom: camera.zoom };
}

function hasDocumentContent() {
  return designDocument.pages.some((page) => page.nodes.length > 0);
}

function commitDocument() {
  syncGroupBounds(currentPage());
  designDocument.updatedAt = new Date().toISOString();
  history.commit(designDocument);
  scheduleSave();
  refreshUI();
}

function liveDocumentChange() {
  syncGroupBounds(currentPage());
  designDocument.updatedAt = new Date().toISOString();
  elements.saveState.textContent = "Saving…";
  scheduleSave();
  requestRender();
}

function undo() {
  finishTextEditing(false);
  const previous = history.undo();
  if (!previous) {
    showToast("Nothing to undo");
    return;
  }
  designDocument = previous;
  ensureActivePage();
  selectedIds = selectedIds.filter((id) => getNode(currentPage(), id));
  scheduleSave();
  refreshUI();
}

function redo() {
  finishTextEditing(false);
  const next = history.redo();
  if (!next) {
    showToast("Nothing to redo");
    return;
  }
  designDocument = next;
  ensureActivePage();
  selectedIds = selectedIds.filter((id) => getNode(currentPage(), id));
  scheduleSave();
  refreshUI();
}

function refreshUI() {
  elements.documentTitle.value = designDocument.name;
  elements.currentPageName.textContent = currentPage().name;
  renderPages();
  renderLayers();
  const designTab = [...document.querySelectorAll(".inspector-tab")].find((tab) => tab.textContent.trim() === "Design");
  if (designTab?.classList.contains("active")) renderInspector();
  requestRender();
}

function renderLayers() {
  const page = currentPage();
  elements.emptyLayers.hidden = page.nodes.length > 0;
  const childrenByParent = new Map();
  for (const node of page.nodes) {
    const parentId = node.parentId ?? null;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(node);
  }

  const renderBranch = (node, depth) => {
    const children = childrenByParent.get(node.id) ?? [];
    const hasChildren = children.length > 0;
    const collapsed = collapsedLayerIds.has(node.id);
    const visible = isNodeEffectivelyVisible(page, node);
    const locked = isNodeEffectivelyLocked(page, node);
    const row = `
      <div class="layer-row ${selectedIds.includes(node.id) ? "selected" : ""} ${visible ? "" : "hidden-layer"}" data-layer-id="${escapeAttribute(node.id)}" style="--layer-depth: ${depth}">
        ${hasChildren
          ? `<button class="layer-collapse" data-layer-action="collapse" title="${collapsed ? "Expand" : "Collapse"} layer" aria-label="${collapsed ? "Expand" : "Collapse"} ${escapeAttribute(node.name)}" aria-expanded="${!collapsed}"><svg viewBox="0 0 20 20"><path d="m6.5 8 3.5 3.5L13.5 8" /></svg></button>`
          : '<span class="layer-collapse-spacer"></span>'}
        <span class="layer-icon">${nodeIcon(node.type)}</span>
        <span class="layer-name" title="${escapeAttribute(node.name)}">${escapeHTML(node.name)}</span>
        <button class="layer-action" data-layer-action="visibility" title="${node.visible ? "Hide" : "Show"} layer" aria-label="${node.visible ? "Hide" : "Show"} ${escapeAttribute(node.name)}">${visibilityIcon(node.visible)}</button>
        <button class="layer-action ${locked && !node.locked ? "inherited" : ""}" data-layer-action="lock" title="${node.locked ? "Unlock" : "Lock"} layer" aria-label="${node.locked ? "Unlock" : "Lock"} ${escapeAttribute(node.name)}">${lockIcon(locked)}</button>
      </div>`;
    if (collapsed) return row;
    return row + [...children].reverse().map((child) => renderBranch(child, depth + 1)).join("");
  };

  elements.layersList.innerHTML = [...(childrenByParent.get(null) ?? [])]
    .reverse()
    .map((node) => renderBranch(node, 0))
    .join("");
}

function renderPages() {
  elements.pagesList.innerHTML = designDocument.pages.map((page) => `
    <div class="page-list-row ${page.id === activePageId ? "active" : ""}">
      <button class="page-list-main" data-page-id="${escapeAttribute(page.id)}" title="Open ${escapeAttribute(page.name)}">
        <svg viewBox="0 0 20 20"><path d="M6 3.5h6l3 3v10H6zM12 3.5v3h3" /></svg>
        <span class="page-list-name">${escapeHTML(page.name)}</span>
        <span class="page-list-count">${page.nodes.length}</span>
      </button>
      <button class="page-list-action" data-page-action="rename" data-page-id="${escapeAttribute(page.id)}" title="Rename page" aria-label="Rename ${escapeAttribute(page.name)}">
        <svg viewBox="0 0 20 20"><path d="m4 14.5-.5 2 2-.5L15 6.5 13.5 5 4 14.5ZM12.5 6l1.5 1.5" /></svg>
      </button>
      <button class="page-list-action" data-page-action="duplicate" data-page-id="${escapeAttribute(page.id)}" title="Duplicate page" aria-label="Duplicate ${escapeAttribute(page.name)}">
        <svg viewBox="0 0 20 20"><rect x="6" y="6" width="10" height="10" rx="1" /><path d="M13 6V4H4v9h2" /></svg>
      </button>
      <button class="page-list-action" data-page-action="delete" data-page-id="${escapeAttribute(page.id)}" title="Delete page" aria-label="Delete ${escapeAttribute(page.name)}" ${designDocument.pages.length === 1 ? "disabled" : ""}>
        <svg viewBox="0 0 20 20"><path d="M4.5 6h11M8 3.5h4M6 6l.7 10h6.6L14 6M8.5 8.5v5M11.5 8.5v5" /></svg>
      </button>
    </div>`).join("");
}

function renderInspector() {
  if (!selectedIds.length) {
    const page = currentPage();
    elements.inspector.innerHTML = `
      <div class="inspector-section">
        <p class="inspector-section-title">Canvas</p>
        <div class="color-row">
          <span class="color-swatch"><input type="color" data-page-property="background" value="${toHexColor(page.background)}" /></span>
          <div class="field"><span class="field-label">#</span><input data-page-property="background" value="${escapeAttribute(page.background.replace("#", ""))}" /></div>
          <div class="field"><span class="field-label">%</span><input value="100" disabled /></div>
        </div>
      </div>
      <div class="no-selection">
        <strong>Nothing selected</strong>
        Choose a layer or draw a shape. Hold Space and drag to move around the canvas.
      </div>`;
    return;
  }

  if (selectedIds.length > 1) {
    elements.inspector.innerHTML = `
      <div class="selection-summary">
        <span class="selection-summary-icon">${nodeIcon("multiple")}</span>
        <input value="${selectedIds.length} layers selected" disabled />
      </div>
      <div class="inspector-section">
        <p class="inspector-section-title">Selection</p>
        <div class="field-grid one-column">
          <button class="button button-quiet" data-multi-action="group">Group selection</button>
          <button class="button button-quiet" data-multi-action="duplicate">Duplicate selection</button>
        </div>
      </div>`;
    elements.inspector.querySelector("[data-multi-action='group']")?.addEventListener("click", groupSelection);
    elements.inspector.querySelector("[data-multi-action='duplicate']")?.addEventListener("click", duplicateSelection);
    return;
  }

  const node = getNode(currentPage(), selectedIds[0]);
  if (!node) return;
  elements.inspector.innerHTML = `
    <div class="selection-summary">
      <span class="selection-summary-icon">${nodeIcon(node.type)}</span>
      <input data-property="name" value="${escapeAttribute(node.name)}" aria-label="Layer name" />
    </div>

    ${node.type !== NODE_TYPES.GROUP ? `<section class="inspector-section">
      <p class="inspector-section-title">Position</p>
      <div class="field-grid">
        ${numberField("X", "x", node.x)}
        ${numberField("Y", "y", node.y)}
        ${numberField("W", "width", node.width)}
        ${numberField("H", "height", node.height)}
        ${numberField("↻", "rotation", node.rotation)}
        ${numberField("R", "cornerRadius", node.cornerRadius, node.type === NODE_TYPES.ELLIPSE || node.type === NODE_TYPES.TEXT)}
      </div>
    </section>` : ""}

    ${node.type === NODE_TYPES.TEXT ? textInspector(node) : ""}
    ${node.type === NODE_TYPES.IMAGE ? imageInspector(node) : ""}

    ${node.type !== NODE_TYPES.GROUP ? `<section class="inspector-section">
      <p class="inspector-section-title">Fill</p>
      ${fillInspector(node)}
    </section>` : `
      <section class="inspector-section">
        <p class="inspector-section-title">Group</p>
        <label class="field"><span class="field-label">%</span><input type="number" data-property="opacity" data-value-type="number" data-scale="0.01" min="0" max="100" value="${Math.round(node.opacity * 100)}" aria-label="Group opacity" /></label>
        <button class="button button-quiet" data-inspector-action="ungroup" style="width: 100%; margin-top: 8px">Ungroup layers</button>
      </section>`}

    ${node.type !== NODE_TYPES.TEXT && node.type !== NODE_TYPES.GROUP ? `
      <section class="inspector-section">
        <p class="inspector-section-title">Stroke</p>
        <div class="color-row">
          <span class="color-swatch"><input type="color" data-property="stroke" value="${toHexColor(node.stroke)}" aria-label="Stroke color" /></span>
          <div class="field"><span class="field-label">#</span><input data-property="stroke" value="${escapeAttribute(stripHash(node.stroke))}" aria-label="Stroke hex color" /></div>
          <div class="field"><span class="field-label">W</span><input type="number" data-property="strokeWidth" data-value-type="number" min="0" step="1" value="${formatNumber(node.strokeWidth)}" aria-label="Stroke width" /></div>
        </div>
      </section>` : ""}

    ${node.type !== NODE_TYPES.GROUP ? shadowInspector(node) : ""}

    <section class="inspector-section">
      <p class="inspector-section-title">Layer</p>
      <div class="icon-toggle-row">
        <button class="icon-toggle ${node.visible ? "active" : ""}" data-inspector-action="toggle-visible">${node.visible ? "Visible" : "Hidden"}</button>
        <button class="icon-toggle ${node.locked ? "active" : ""}" data-inspector-action="toggle-lock">${node.locked ? "Locked" : "Unlocked"}</button>
      </div>
      <div class="icon-toggle-row" style="margin-top: 6px">
        <button class="icon-toggle" data-inspector-action="send-backward">Send backward</button>
        <button class="icon-toggle" data-inspector-action="bring-forward">Bring forward</button>
      </div>
      <button class="button button-quiet" data-inspector-action="delete" style="width: 100%; margin-top: 8px; color: #fca5a5">Delete layer</button>
    </section>`;
}

function textInspector(node) {
  return `
    <section class="inspector-section">
      <p class="inspector-section-title">Typography</p>
      <div class="field text-area-field"><textarea data-property="text" aria-label="Text content">${escapeHTML(node.text)}</textarea></div>
      <div class="field-grid" style="margin-top: 6px">
        <label class="field" style="grid-column: span 2"><span class="field-label">F</span><select data-property="fontFamily" aria-label="Font family">
          ${fontOption("Inter, ui-sans-serif, sans-serif", "Inter / System", node.fontFamily)}
          ${fontOption("Georgia, serif", "Georgia", node.fontFamily)}
          ${fontOption("ui-monospace, SFMono-Regular, monospace", "Monospace", node.fontFamily)}
        </select></label>
        ${numberField("S", "fontSize", node.fontSize)}
        <label class="field"><span class="field-label">W</span><select data-property="fontWeight" data-value-type="number" aria-label="Font weight">
          ${[400, 500, 600, 700, 800].map((weight) => `<option value="${weight}" ${node.fontWeight === weight ? "selected" : ""}>${weight}</option>`).join("")}
        </select></label>
      </div>
      <div class="icon-toggle-row" style="margin-top: 6px">
        ${["left", "center", "right"].map((align) => `<button class="icon-toggle ${node.textAlign === align ? "active" : ""}" data-inspector-action="align" data-value="${align}">${capitalize(align)}</button>`).join("")}
      </div>
    </section>`;
}

function imageInspector(node) {
  return `
    <section class="inspector-section">
      <p class="inspector-section-title">Image</p>
      <div class="icon-toggle-row">
        ${["cover", "contain"].map((fit) => `<button class="icon-toggle ${node.imageFit === fit ? "active" : ""}" data-inspector-action="image-fit" data-value="${fit}">${capitalize(fit)}</button>`).join("")}
      </div>
      <label class="field" style="margin-top: 6px"><span class="field-label">A</span><input data-property="altText" value="${escapeAttribute(node.altText)}" placeholder="Alt text" aria-label="Image alt text" /></label>
      <button class="button button-quiet" data-inspector-action="replace-image" style="width: 100%; margin-top: 8px">Replace image…</button>
    </section>`;
}

function numberField(label, property, value, disabled = false) {
  return `<label class="field ${disabled ? "disabled" : ""}"><span class="field-label">${label}</span><input type="number" data-property="${property}" data-value-type="number" step="1" value="${formatNumber(value)}" ${disabled ? "disabled" : ""} /></label>`;
}

function colorField(property, color, opacity) {
  return `<div class="color-row">
    <span class="color-swatch"><input type="color" data-property="${property}" value="${toHexColor(color)}" aria-label="Fill color" /></span>
    <div class="field"><span class="field-label">#</span><input data-property="${property}" value="${escapeAttribute(stripHash(color))}" aria-label="Fill hex color" /></div>
    <div class="field"><span class="field-label">%</span><input type="number" data-property="opacity" data-value-type="number" data-scale="0.01" min="0" max="100" value="${Math.round(opacity * 100)}" aria-label="Opacity" /></div>
  </div>`;
}

function fillInspector(node) {
  const isGradient = node.fillType === "linear-gradient";
  const firstStop = node.gradient.stops[0];
  const lastStop = node.gradient.stops[node.gradient.stops.length - 1];
  const previewAngle = (node.gradient.angle + 90) % 360;
  return `
    <div class="icon-toggle-row paint-mode-row">
      <button class="icon-toggle ${isGradient ? "" : "active"}" data-inspector-action="fill-mode" data-value="solid">Solid</button>
      <button class="icon-toggle ${isGradient ? "active" : ""}" data-inspector-action="fill-mode" data-value="linear-gradient">Linear</button>
    </div>
    ${isGradient ? `
      <div class="gradient-preview" style="background: linear-gradient(${formatNumber(previewAngle)}deg, ${escapeAttribute(firstStop.color)}, ${escapeAttribute(lastStop.color)})"></div>
      <div class="gradient-color-row">
        <span class="color-swatch"><input type="color" data-gradient-stop="0" value="${toHexColor(firstStop.color)}" aria-label="Gradient start color" /></span>
        <label class="field"><span class="field-label">A</span><input data-gradient-stop="0" value="${escapeAttribute(stripHash(firstStop.color))}" aria-label="Gradient start hex color" /></label>
      </div>
      <div class="gradient-color-row">
        <span class="color-swatch"><input type="color" data-gradient-stop="last" value="${toHexColor(lastStop.color)}" aria-label="Gradient end color" /></span>
        <label class="field"><span class="field-label">B</span><input data-gradient-stop="last" value="${escapeAttribute(stripHash(lastStop.color))}" aria-label="Gradient end hex color" /></label>
      </div>
      <div class="field-grid paint-settings-grid">
        <label class="field"><span class="field-label">°</span><input type="number" data-gradient-property="angle" step="1" value="${formatNumber(node.gradient.angle)}" aria-label="Gradient angle" /></label>
        <label class="field"><span class="field-label">%</span><input type="number" data-property="opacity" data-value-type="number" data-scale="0.01" min="0" max="100" value="${Math.round(node.opacity * 100)}" aria-label="Opacity" /></label>
      </div>` : colorField("fill", node.fill, node.opacity)}
  `;
}

function shadowInspector(node) {
  const shadow = node.shadow;
  return `
    <section class="inspector-section">
      <p class="inspector-section-title">Effects</p>
      <button class="effect-toggle ${shadow.enabled ? "active" : ""}" data-inspector-action="toggle-shadow" aria-pressed="${shadow.enabled}">
        <span>Drop shadow</span><span>${shadow.enabled ? "On" : "Off"}</span>
      </button>
      ${shadow.enabled ? `
        <div class="gradient-color-row effect-color-row">
          <span class="color-swatch"><input type="color" data-shadow-property="color" value="${toHexColor(shadow.color)}" aria-label="Shadow color" /></span>
          <label class="field"><span class="field-label">#</span><input data-shadow-property="color" value="${escapeAttribute(stripHash(shadow.color))}" aria-label="Shadow hex color" /></label>
        </div>
        <div class="field-grid paint-settings-grid">
          <label class="field"><span class="field-label">X</span><input type="number" data-shadow-property="offsetX" step="1" value="${formatNumber(shadow.offsetX)}" aria-label="Shadow horizontal offset" /></label>
          <label class="field"><span class="field-label">Y</span><input type="number" data-shadow-property="offsetY" step="1" value="${formatNumber(shadow.offsetY)}" aria-label="Shadow vertical offset" /></label>
          <label class="field"><span class="field-label">B</span><input type="number" data-shadow-property="blur" min="0" step="1" value="${formatNumber(shadow.blur)}" aria-label="Shadow blur" /></label>
          <label class="field"><span class="field-label">%</span><input type="number" data-shadow-property="opacity" data-scale="0.01" min="0" max="100" value="${Math.round(shadow.opacity * 100)}" aria-label="Shadow opacity" /></label>
        </div>` : ""}
    </section>`;
}

function requestRender() {
  if (frameRequest) return;
  frameRequest = requestAnimationFrame(() => {
    frameRequest = null;
    renderer.resize();
    const marquee = interaction?.type === "marquee"
      ? normalizedRect(interaction.start, interaction.current)
      : null;
    renderer.render(currentPage(), selectedIds, camera, {
      guides,
      marquee,
      editingId: editingTextId,
    });
    elements.zoomValue.textContent = `${Math.round(camera.zoom * 100)}%`;
  });
}

function zoomAt(screenPoint, factor) {
  const worldBefore = renderer.screenToWorld(screenPoint, camera);
  camera.zoom = clamp(camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  camera.x = screenPoint.x - worldBefore.x * camera.zoom;
  camera.y = screenPoint.y - worldBefore.y * camera.zoom;
  requestRender();
  scheduleSave();
}

function setZoom(zoom) {
  const center = { x: renderer.width / 2, y: renderer.height / 2 };
  zoomAt(center, clamp(zoom, MIN_ZOOM, MAX_ZOOM) / camera.zoom);
}

function fitToContent(ids = null) {
  renderer.resize();
  const bounds = getDocumentBounds(currentPage(), ids);
  const padding = 110;
  const availableWidth = Math.max(100, renderer.width - padding * 2);
  const availableHeight = Math.max(100, renderer.height - padding * 2);
  camera.zoom = clamp(
    Math.min(availableWidth / Math.max(1, bounds.width), availableHeight / Math.max(1, bounds.height)),
    MIN_ZOOM,
    2,
  );
  camera.x = renderer.width / 2 - (bounds.x + bounds.width / 2) * camera.zoom;
  camera.y = renderer.height / 2 - (bounds.y + bounds.height / 2) * camera.zoom;
  requestRender();
  scheduleSave();
}

async function exportDocument(format) {
  const page = currentPage();
  if (format !== "json" && !page.nodes.some((node) => node.visible)) {
    showToast("Add at least one visible layer before exporting.");
    return;
  }

  if (format === "json") {
    downloadBlob(
      JSON.stringify(designDocument, null, 2),
      safeFilename(designDocument.name, "json"),
      "application/json",
    );
    showToast("Editable document exported");
  }

  if (format === "svg") {
    downloadBlob(
      documentToSVG(page),
      safeFilename(`${designDocument.name}-${page.name}`, "svg"),
      "image/svg+xml",
    );
    showToast("SVG exported");
  }

  if (format === "png") {
    await preloadDocumentImages(page);
    const canvas = renderDocumentToCanvas(page, null, 2);
    canvas.toBlob((blob) => {
      if (!blob) {
        showToast("PNG export failed in this browser.");
        return;
      }
      downloadBlob(blob, safeFilename(`${designDocument.name}-${page.name}`, "png"), "image/png");
      showToast("2× PNG exported");
    }, "image/png");
  }
}

function openImagePicker(nodeId = null) {
  setTool("select");
  imagePickerTarget = { pageId: activePageId, nodeId };
  elements.imageFileInput.value = "";
  elements.imageFileInput.click();
}

async function importImage() {
  const [file] = elements.imageFileInput.files;
  const target = imagePickerTarget;
  elements.imageFileInput.value = "";
  imagePickerTarget = null;
  if (!file || !target) return;

  const supportedTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  if (!supportedTypes.has(file.type)) {
    showToast("Choose a PNG, JPEG, WebP, or GIF image.");
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    showToast("Images must be 15 MB or smaller.");
    return;
  }

  try {
    const imageData = await readFileAsDataURL(file);
    const dimensions = await readImageDimensions(imageData);
    if (dimensions.width > 20_000 || dimensions.height > 20_000 || dimensions.width * dimensions.height > 80_000_000) {
      throw new Error("That image is too large to render safely.");
    }

    const page = getPage(designDocument, target.pageId) ?? currentPage();
    const replacement = target.nodeId ? getNode(page, target.nodeId) : null;
    if (replacement?.type === NODE_TYPES.IMAGE) {
      replacement.imageData = imageData;
      replacement.altText ||= file.name;
      commitDocument();
      showToast("Image replaced");
      return;
    }

    const maximumWidth = 600;
    const maximumHeight = 450;
    const scale = Math.min(1, maximumWidth / dimensions.width, maximumHeight / dimensions.height);
    const width = Math.max(1, Math.round(dimensions.width * scale));
    const height = Math.max(1, Math.round(dimensions.height * scale));
    const viewportCenter = renderer.screenToWorld(
      { x: renderer.width / 2, y: renderer.height / 2 },
      camera,
    );
    const node = createNode(NODE_TYPES.IMAGE, viewportCenter.x - width / 2, viewportCenter.y - height / 2, {
      name: file.name.replace(/\.[^.]+$/, "").slice(0, 120) || "Image",
      width,
      height,
      imageData,
      imageFit: "cover",
      altText: file.name,
      cornerRadius: 8,
    });
    page.nodes.push(node);
    assignNodeToFrame(page, node);
    if (page.id === activePageId) selectedIds = [node.id];
    commitDocument();
    showToast(`${file.name} placed`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Could not read that image.");
  }
}

async function importDocument() {
  const [file] = elements.fileInput.files;
  elements.fileInput.value = "";
  if (!file) return;
  try {
    const content = await file.text();
    const imported = normalizeDocument(JSON.parse(content));
    designDocument = imported;
    history = new DocumentHistory(designDocument);
    activePageId = designDocument.pages[0].id;
    pageViews = {};
    selectedIds = [];
    elements.documentTitle.value = designDocument.name;
    fitToContent();
    commitDocument();
    showToast("Document imported successfully");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Could not import that file.");
  }
}

function newDocument() {
  if (hasDocumentContent() && !window.confirm("Create a new document? This replaces the current local draft. Export it first if you need a separate copy.")) {
    return;
  }
  designDocument = createEmptyDocument();
  history = new DocumentHistory(designDocument);
  activePageId = designDocument.pages[0].id;
  pageViews = {};
  selectedIds = [];
  camera = { x: renderer.width / 2, y: renderer.height / 2, zoom: 1 };
  commitDocument();
  showToast("New document created");
}

async function openPreview() {
  const page = currentPage();
  if (!page.nodes.some((node) => node.visible)) {
    showToast("Add something to the canvas before previewing.");
    return;
  }
  elements.previewStage.innerHTML = "";
  await preloadDocumentImages(page);
  const canvas = renderDocumentToCanvas(page, null, 1.5);
  elements.previewStage.append(canvas);
  elements.previewModal.hidden = false;
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read the image.")), { once: true });
    reader.readAsDataURL(file);
  });
}

function readImageDimensions(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve({
      width: image.naturalWidth,
      height: image.naturalHeight,
    }), { once: true });
    image.addEventListener("error", () => reject(new Error("The selected image is invalid or unsupported.")), { once: true });
    image.src = source;
  });
}

function closePreview() {
  elements.previewModal.hidden = true;
  elements.previewStage.innerHTML = "";
}

function scheduleSave() {
  const version = ++saveVersion;
  elements.saveState.textContent = "Saving…";
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    try {
      rememberCurrentView();
      await saveWorkspace({
        document: designDocument,
        activePageId,
        pageViews,
        camera,
      });
      if (version === saveVersion) elements.saveState.textContent = "Saved locally";
    } catch {
      if (version === saveVersion) elements.saveState.textContent = "Storage unavailable";
      showToast("Browser storage is unavailable or full. Export the document as JSON to keep a copy.");
    }
  }, 280);
}

async function restoreWorkspace() {
  try {
    const stored = await loadWorkspace();
    if (!stored) return null;
    const inputDocument = stored.document ?? stored;
    const restoredDocument = normalizeDocument(inputDocument);
    const restoredActivePageId = getPage(restoredDocument, stored.activePageId)?.id ?? restoredDocument.pages[0].id;
    const restoredPageViews = {};
    if (stored.pageViews && typeof stored.pageViews === "object") {
      for (const [pageId, view] of Object.entries(stored.pageViews)) {
        if (!getPage(restoredDocument, pageId) || !isValidCamera(view)) continue;
        restoredPageViews[pageId] = {
          x: view.x,
          y: view.y,
          zoom: clamp(view.zoom, MIN_ZOOM, MAX_ZOOM),
        };
      }
    }
    const inputCamera = stored.camera;
    const restoredCamera = isValidCamera(inputCamera)
      ? {
          x: inputCamera.x,
          y: inputCamera.y,
          zoom: clamp(inputCamera.zoom, MIN_ZOOM, MAX_ZOOM),
        }
      : { x: 0, y: 0, zoom: 1 };
    if (!restoredPageViews[restoredActivePageId]) {
      restoredPageViews[restoredActivePageId] = restoredCamera;
    }
    return {
      document: restoredDocument,
      camera: restoredCamera,
      activePageId: restoredActivePageId,
      pageViews: restoredPageViews,
    };
  } catch {
    return null;
  }
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  elements.toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 3_000);
}

function togglePopover(popover) {
  popover.hidden = !popover.hidden;
}

function closePopovers() {
  elements.mainMenu.hidden = true;
  elements.exportMenu.hidden = true;
  elements.pagesPopover.hidden = true;
  elements.pageSwitcher.setAttribute("aria-expanded", "false");
}

function capturePointer(event) {
  elements.canvas.setPointerCapture(event.pointerId);
}

function releasePointer(event) {
  if (elements.canvas.hasPointerCapture(event.pointerId)) {
    elements.canvas.releasePointerCapture(event.pointerId);
  }
}

function eventPoint(event) {
  const rect = elements.canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function cloneNode(node) {
  return globalThis.structuredClone ? structuredClone(node) : JSON.parse(JSON.stringify(node));
}

function normalizedRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

function rectanglesIntersect(a, b) {
  return a.x <= b.x + b.width &&
    a.x + a.width >= b.x &&
    a.y <= b.y + b.height &&
    a.y + a.height >= b.y;
}

function combinedBounds(bounds) {
  const minX = Math.min(...bounds.map((box) => box.x));
  const minY = Math.min(...bounds.map((box) => box.y));
  const maxX = Math.max(...bounds.map((box) => box.x + box.width));
  const maxY = Math.max(...bounds.map((box) => box.y + box.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function edgeValues(bounds, axis) {
  if (axis === "x") return [bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width];
  return [bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height];
}

function closestSnap(targets, references, threshold) {
  let best = null;
  for (const target of targets) {
    for (const reference of references) {
      const delta = reference - target;
      if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
        best = { delta, value: reference };
      }
    }
  }
  return best;
}

function normalizeDegrees(degrees) {
  const normalized = ((degrees % 360) + 360) % 360;
  return Math.round((normalized > 180 ? normalized - 360 : normalized) * 10) / 10;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function isTypingTarget(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable;
}

function isValidCamera(value) {
  return value &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.zoom);
}

function isRenderableColor(value) {
  const style = new Option().style;
  style.color = value;
  return style.color !== "";
}

function normalizeInspectorColor(value) {
  const color = value.trim();
  if (/^[\da-f]{3,8}$/i.test(color)) return `#${color}`;
  return color;
}

function toHexColor(value) {
  if (/^#[\da-f]{6}$/i.test(value)) return value;
  if (/^#[\da-f]{8}$/i.test(value)) return value.slice(0, 7);
  if (/^#[\da-f]{3,4}$/i.test(value)) {
    return `#${[...value.slice(1, 4)].map((character) => character + character).join("")}`;
  }
  return "#000000";
}

function stripHash(value) {
  return value.startsWith("#") ? value.slice(1) : value;
}

function formatNumber(value) {
  return Math.round(value * 10) / 10;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function fontOption(value, label, current) {
  return `<option value="${escapeAttribute(value)}" ${value === current ? "selected" : ""}>${escapeHTML(label)}</option>`;
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHTML(value).replaceAll("`", "&#096;");
}

function nodeIcon(type) {
  const icons = {
    frame: '<svg viewBox="0 0 20 20"><path d="M4 2.5v15M16 2.5v15M2.5 4h15M2.5 16h15" /></svg>',
    group: '<svg viewBox="0 0 20 20"><rect x="3" y="3" width="5" height="5" /><rect x="12" y="3" width="5" height="5" /><rect x="3" y="12" width="5" height="5" /><rect x="12" y="12" width="5" height="5" /></svg>',
    rectangle: '<svg viewBox="0 0 20 20"><rect x="3.5" y="4" width="13" height="12" rx="1" /></svg>',
    ellipse: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.5" /></svg>',
    text: '<svg viewBox="0 0 20 20"><path d="M4 4h12M10 4v12M7 16h6" /></svg>',
    image: '<svg viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="1.5" /><circle cx="13.5" cy="7.5" r="1" /><path d="m5 14 3.5-3.5 2 2 1.5-1.5 3 3" /></svg>',
    multiple: '<svg viewBox="0 0 20 20"><rect x="3" y="3" width="9" height="9" /><rect x="8" y="8" width="9" height="9" /></svg>',
  };
  return icons[type] ?? icons.rectangle;
}

function visibilityIcon(visible) {
  return visible
    ? '<svg viewBox="0 0 20 20"><path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5Z" /><circle cx="10" cy="10" r="2" /></svg>'
    : '<svg viewBox="0 0 20 20"><path d="m3 3 14 14M7.5 5.5A7 7 0 0 1 10 5c4.7 0 7.5 5 7.5 5a10 10 0 0 1-2 2.5M12.5 14.5A7 7 0 0 1 10 15c-4.7 0-7.5-5-7.5-5a10 10 0 0 1 2-2.5" /></svg>';
}

function lockIcon(locked) {
  return locked
    ? '<svg viewBox="0 0 20 20"><rect x="4.5" y="8.5" width="11" height="8" rx="1.5" /><path d="M7 8.5V6a3 3 0 0 1 6 0v2.5" /></svg>'
    : '<svg viewBox="0 0 20 20"><rect x="4.5" y="8.5" width="11" height="8" rx="1.5" /><path d="M7 8.5V6a3 3 0 0 1 5.5-1.6" /></svg>';
}
