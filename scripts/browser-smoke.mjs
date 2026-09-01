import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPort = Number.parseInt(process.env.TSYAIKO_TEST_PORT || "8091", 10);
const debugPort = Number.parseInt(process.env.TSYAIKO_CDP_PORT || "9225", 10);
const shapeScreenshotPath = process.env.TSYAIKO_SHAPE_SCREENSHOT ||
  process.argv.find((argument) => argument.startsWith("--shape-screenshot="))?.split("=").slice(1).join("=");
const profileDirectory = mkdtempSync(path.join(tmpdir(), "tsyaiko-browser-"));
const chromiumBinary = findChromium();
let server;
let browser;
let socket;

try {
  server = spawn("go", ["run", ".", "-port", String(serverPort)], {
    cwd: projectRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      GOCACHE: path.join(projectRoot, ".cache", "go-build"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHTTP(`http://127.0.0.1:${serverPort}/api/health`, "development server");

  browser = spawn(chromiumBinary, [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDirectory}`,
    "--window-size=1440,900",
    `http://127.0.0.1:${serverPort}/`,
  ], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "ignore"],
  });

  const targets = await waitForJSON(`http://127.0.0.1:${debugPort}/json/list`, "Chromium debugger");
  const target = targets.find((item) => item.type === "page");
  if (!target) throw new Error("Chromium did not expose a page target.");

  const connection = await connectToTarget(target.webSocketDebuggerUrl);
  socket = connection.socket;
  const { command, evaluate, waitFor } = connection;
  await command("Runtime.enable");

  await waitFor(
    `document.readyState === "complete" && document.querySelectorAll(".layer-row").length === 11`,
    "starter document",
  );

  const svgPaintExport = await evaluate(`
    (async () => {
      const {
        BOOLEAN_OPERATIONS,
        booleanGroupNodes,
        createNode,
        createPage,
        createVectorNodeFromWorldPoints,
        getDocumentBounds,
        LAYOUT_MODES,
        maskNodes,
        NODE_TYPES
      } = await import("/src/model.js");
      const { documentToSVG } = await import("/src/export.js");
      const { CanvasRenderer, renderDocumentToCanvas } = await import("/src/renderer.js");
      const page = createPage("Paint export");
      page.nodes.push(createNode(NODE_TYPES.RECTANGLE, 0, 0, {
        fillType: "linear-gradient",
        gradient: { angle: 32, stops: [
          { position: 0, color: "#2563eb" },
          { position: 1, color: "#ec4899" }
        ] },
        shadow: { enabled: true, color: "#000000", opacity: 0.35, offsetX: 6, offsetY: 14, blur: 22 }
      }));
      page.nodes.push(createVectorNodeFromWorldPoints([
        { x: 180, y: 10, out: { x: 205, y: -10 }, handleMode: "free" },
        { x: 250, y: 40, in: { x: 225, y: 70 }, handleMode: "free" },
        { x: 200, y: 100 }
      ], true));
      const svg = documentToSVG(page);
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
      const compositePage = createPage("Composite export");
      const base = createNode(NODE_TYPES.RECTANGLE, 0, 0, { width: 120, height: 100 });
      const cutter = createNode(NODE_TYPES.ELLIPSE, 45, 10, { width: 90, height: 80 });
      const content = createNode(NODE_TYPES.RECTANGLE, 10, 5, { width: 150, height: 90, fill: "#22c55e" });
      compositePage.nodes.push(base, cutter, content);
      const boolean = booleanGroupNodes(compositePage, [base.id, cutter.id], BOOLEAN_OPERATIONS.SUBTRACT);
      boolean.stroke = "#ffffff";
      boolean.strokeWidth = 5;
      maskNodes(compositePage, [boolean.id, content.id]);
      const compositeSVG = documentToSVG(compositePage);
      const compositeParsed = new DOMParser().parseFromString(compositeSVG, "image/svg+xml");

      const renderSamples = (samplePage, sampleNode, operations) => {
        const canvas = document.createElement("canvas");
        canvas.width = 160;
        canvas.height = 110;
        const renderer = new CanvasRenderer(canvas);
        renderer.width = 160;
        renderer.height = 110;
        renderer.pixelRatio = 1;
        const sample = (x, y) => [...renderer.context.getImageData(x, y, 1, 1).data];
        const isPainted = (pixel, channel) => pixel[channel] > 180 && pixel[(channel + 1) % 3] < 80;
        const results = {};
        for (const operation of operations) {
          sampleNode.booleanOperation = operation;
          renderer.render(samplePage, [], { x: 0, y: 0, zoom: 1 }, {
            background: "#ffffff", grid: false, selection: false, frameLabels: false
          });
          results[operation] = {
            base: isPainted(sample(30, 50), 0),
            overlap: isPainted(sample(65, 50), 0),
            operand: isPainted(sample(105, 50), 0)
          };
        }
        return results;
      };
      const canvasPage = createPage("Canvas Boolean");
      const canvasBase = createNode(NODE_TYPES.RECTANGLE, 10, 10, { width: 70, height: 80, fill: "#ff0000" });
      const canvasOperand = createNode(NODE_TYPES.RECTANGLE, 50, 10, { width: 70, height: 80 });
      canvasPage.nodes.push(canvasBase, canvasOperand);
      const canvasBoolean = booleanGroupNodes(canvasPage, [canvasBase.id, canvasOperand.id]);
      canvasBoolean.fill = "#ff0000";
      canvasBoolean.strokeWidth = 0;
      const canvasBooleanSamples = renderSamples(
        canvasPage,
        canvasBoolean,
        Object.values(BOOLEAN_OPERATIONS)
      );

      const maskPage = createPage("Canvas mask");
      const maskSource = createNode(NODE_TYPES.RECTANGLE, 10, 10, { width: 70, height: 80 });
      const maskContent = createNode(NODE_TYPES.RECTANGLE, 50, 10, { width: 70, height: 80, fill: "#00ff00" });
      maskPage.nodes.push(maskSource, maskContent);
      maskNodes(maskPage, [maskSource.id, maskContent.id]);
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = 160;
      maskCanvas.height = 110;
      const maskRenderer = new CanvasRenderer(maskCanvas);
      maskRenderer.width = 160;
      maskRenderer.height = 110;
      maskRenderer.pixelRatio = 1;
      maskRenderer.render(maskPage, [], { x: 0, y: 0, zoom: 1 }, {
        background: "#ffffff", grid: false, selection: false, frameLabels: false
      });
      const maskPixel = (x) => [...maskRenderer.context.getImageData(x, 50, 1, 1).data];
      const isGreen = (pixel) => pixel[1] > 180 && pixel[0] < 80 && pixel[2] < 80;

      const sampleSVG = async (samplePage, points, channel) => {
        const svgSource = documentToSVG(samplePage);
        const parsedSource = new DOMParser().parseFromString(svgSource, "image/svg+xml");
        const viewBox = parsedSource.documentElement.getAttribute("viewBox").trim().split(" ").map(Number);
        const image = new Image();
        const url = URL.createObjectURL(new Blob([svgSource], { type: "image/svg+xml" }));
        await new Promise((resolve, reject) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", reject, { once: true });
          image.src = url;
        });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, image.naturalWidth);
        canvas.height = Math.max(1, image.naturalHeight);
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        URL.revokeObjectURL(url);
        const painted = {};
        for (const [name, point] of Object.entries(points)) {
          const x = Math.max(0, Math.min(canvas.width - 1, Math.round((point.x - viewBox[0]) * canvas.width / viewBox[2])));
          const y = Math.max(0, Math.min(canvas.height - 1, Math.round((point.y - viewBox[1]) * canvas.height / viewBox[3])));
          const pixel = context.getImageData(x, y, 1, 1).data;
          painted[name] = pixel[channel] > 180 && pixel[3] > 180;
        }
        return painted;
      };
      const svgBooleanSamples = {};
      for (const operation of Object.values(BOOLEAN_OPERATIONS)) {
        canvasBoolean.booleanOperation = operation;
        svgBooleanSamples[operation] = await sampleSVG(canvasPage, {
          base: { x: 30, y: 50 },
          overlap: { x: 65, y: 50 },
          operand: { x: 105, y: 50 }
        }, 0);
      }
      const svgMaskSamples = await sampleSVG(maskPage, {
        sourceOnly: { x: 30, y: 50 },
        overlap: { x: 65, y: 50 },
        contentOnly: { x: 105, y: 50 }
      }, 1);

      const responsivePage = createPage("Responsive export");
      const responsiveFrame = createNode(NODE_TYPES.FRAME, 0, 0, {
        width: 200,
        height: 80,
        fill: "transparent",
        stroke: "transparent",
        shadow: { enabled: false },
        layoutMode: LAYOUT_MODES.HORIZONTAL,
        paddingTop: 10,
        paddingRight: 10,
        paddingBottom: 10,
        paddingLeft: 10
      });
      const responsiveChild = createNode(NODE_TYPES.RECTANGLE, 99, 99, {
        parentId: responsiveFrame.id,
        width: 40,
        height: 20,
        cornerRadius: 0,
        fill: "#ff0000",
        strokeWidth: 0
      });
      responsivePage.nodes.push(responsiveFrame, responsiveChild);
      const responsiveSVG = documentToSVG(responsivePage);
      const responsiveParsed = new DOMParser().parseFromString(responsiveSVG, "image/svg+xml");
      const responsiveCanvas = renderDocumentToCanvas(responsivePage, null, 1);
      const responsivePixel = [...responsiveCanvas.getContext("2d").getImageData(30, 20, 1, 1).data];

      const shapePage = createPage("Parametric export");
      const polygon = createNode(NODE_TYPES.POLYGON, 0, 0, {
        width: 100, height: 100, polygonSides: 6, cornerRadius: 8,
        fill: "#ff0000", strokeWidth: 0
      });
      const star = createNode(NODE_TYPES.STAR, 120, 0, {
        width: 100, height: 100, starPoints: 7, starInnerRatio: 0.46,
        fill: "#00ff00", strokeWidth: 0
      });
      const arrow = createNode(NODE_TYPES.LINE, 250, 50, {
        width: 100, height: 1, stroke: "#0000ff", strokeWidth: 6,
        arrowStart: "circle", arrowEnd: "triangle"
      });
      shapePage.nodes.push(polygon, star, arrow);
      const shapeBounds = getDocumentBounds(shapePage);
      const shapeCanvas = renderDocumentToCanvas(shapePage, null, 1);
      const shapeContext = shapeCanvas.getContext("2d");
      const shapePixel = (x, y) => [...shapeContext.getImageData(
        Math.max(0, Math.min(shapeCanvas.width - 1, Math.round(x - shapeBounds.x))),
        Math.max(0, Math.min(shapeCanvas.height - 1, Math.round(y - shapeBounds.y))),
        1, 1
      ).data];
      const shapeSVG = documentToSVG(shapePage);
      const shapeParsed = new DOMParser().parseFromString(shapeSVG, "image/svg+xml");
      const svgShapePolygon = await sampleSVG(shapePage, { center: { x: 50, y: 50 } }, 0);
      const svgShapeStar = await sampleSVG(shapePage, { center: { x: 170, y: 50 } }, 1);
      const svgShapeArrow = await sampleSVG(shapePage, { center: { x: 300, y: 50.5 } }, 2);
      const polygonPixel = shapePixel(50, 50);
      const starPixel = shapePixel(170, 50);
      const arrowPixel = shapePixel(300, 50.5);
      return {
        valid: !parsed.querySelector("parsererror"),
        gradient: Boolean(parsed.querySelector("linearGradient")),
        shadow: Boolean(parsed.querySelector("feDropShadow")),
        vector: Boolean(parsed.querySelector("path")),
        curve: parsed.querySelector("path")?.getAttribute("d").includes("C "),
        compositeValid: !compositeParsed.querySelector("parsererror"),
        booleanMask: Boolean(compositeParsed.querySelector('[id^="boolean-mask-"]')),
        expandedStroke: Boolean(compositeParsed.querySelector("feMorphology")),
        maskGroup: Boolean(compositeParsed.querySelector('[id^="mask-mask_"]')),
        canvasBoolean: canvasBooleanSamples,
        canvasMask: {
          sourceOnly: isGreen(maskPixel(30)),
          overlap: isGreen(maskPixel(65)),
          contentOnly: isGreen(maskPixel(105))
        },
        svgBoolean: svgBooleanSamples,
        svgMask: svgMaskSamples,
        responsiveExport: {
          sourceUntouched: responsiveChild.x === 99 && responsiveChild.y === 99,
          svgResolved: Boolean(responsiveParsed.querySelector('rect[x="10"][y="10"][width="40"][height="20"][fill="#ff0000"]')),
          canvasResolved: responsivePixel[0] > 200 && responsivePixel[1] < 80 && responsivePixel[2] < 80
        },
        parametricExport: {
          svgValid: !shapeParsed.querySelector("parsererror"),
          svgPaths: shapeParsed.querySelectorAll("path").length >= 4,
          svgCircleArrowhead: Boolean(shapeParsed.querySelector("circle")),
          canvasPolygon: polygonPixel[0] > 200 && polygonPixel[1] < 80,
          canvasStar: starPixel[1] > 200 && starPixel[0] < 80,
          canvasArrow: arrowPixel[2] > 200 && arrowPixel[0] < 80,
          svgPolygon: svgShapePolygon.center,
          svgStar: svgShapeStar.center,
          svgArrow: svgShapeArrow.center
        }
      };
    })()
  `);
  if (!svgPaintExport.valid || !svgPaintExport.gradient || !svgPaintExport.shadow || !svgPaintExport.vector || !svgPaintExport.curve ||
      !svgPaintExport.compositeValid || !svgPaintExport.booleanMask || !svgPaintExport.expandedStroke || !svgPaintExport.maskGroup) {
    throw new Error(`SVG paint export validation failed: ${JSON.stringify(svgPaintExport)}`);
  }
  if (!Object.values(svgPaintExport.responsiveExport).every(Boolean)) {
    throw new Error(`Responsive export validation failed: ${JSON.stringify(svgPaintExport.responsiveExport)}`);
  }
  if (!Object.values(svgPaintExport.parametricExport).every(Boolean)) {
    throw new Error(`Parametric shape export validation failed: ${JSON.stringify(svgPaintExport.parametricExport)}`);
  }
  const canvasBoolean = svgPaintExport.canvasBoolean;
  const canvasModesValid =
    canvasBoolean.union.base && canvasBoolean.union.overlap && canvasBoolean.union.operand &&
    canvasBoolean.subtract.base && !canvasBoolean.subtract.overlap && !canvasBoolean.subtract.operand &&
    !canvasBoolean.intersect.base && canvasBoolean.intersect.overlap && !canvasBoolean.intersect.operand &&
    canvasBoolean.exclude.base && !canvasBoolean.exclude.overlap && canvasBoolean.exclude.operand;
  const canvasMask = svgPaintExport.canvasMask;
  if (!canvasModesValid || canvasMask.sourceOnly || !canvasMask.overlap || canvasMask.contentOnly) {
    throw new Error(`Canvas composite pixel validation failed: ${JSON.stringify({ canvasBoolean, canvasMask })}`);
  }
  const svgBoolean = svgPaintExport.svgBoolean;
  const svgModesValid =
    svgBoolean.union.base && svgBoolean.union.overlap && svgBoolean.union.operand &&
    svgBoolean.subtract.base && !svgBoolean.subtract.overlap && !svgBoolean.subtract.operand &&
    !svgBoolean.intersect.base && svgBoolean.intersect.overlap && !svgBoolean.intersect.operand &&
    svgBoolean.exclude.base && !svgBoolean.exclude.overlap && svgBoolean.exclude.operand;
  const svgMask = svgPaintExport.svgMask;
  if (!svgModesValid || svgMask.sourceOnly || !svgMask.overlap || svgMask.contentOnly) {
    throw new Error(`SVG composite pixel validation failed: ${JSON.stringify({ svgBoolean, svgMask })}`);
  }

  await evaluate(`
    document.querySelector("#pageSwitcher").click();
    document.querySelector("[data-add-page]").click();
    true;
  `);
  await waitFor(
    `document.querySelectorAll(".page-list-row").length === 2 &&
     document.querySelector("#currentPageName").textContent === "Page 2" &&
     document.querySelectorAll(".layer-row").length === 0`,
    "page creation",
  );

  await evaluate(`document.querySelectorAll(".page-list-main")[0].click(); true`);
  await waitFor(
    `document.querySelector("#currentPageName").textContent === "Landing page" &&
     document.querySelectorAll(".layer-row").length === 11`,
    "switch to the starter page",
  );

  await evaluate(`
    document.querySelector("#pageSwitcher").click();
    document.querySelectorAll(".page-list-main")[1].click();
    document.querySelector("[data-tool=" + "rectangle" + "]").click();
    true;
  `);
  await waitFor(
    `document.querySelector("#currentPageName").textContent === "Page 2"`,
    "switch to the new page",
  );

  const canvas = await evaluate(`
    (() => {
      const box = document.querySelector("#designCanvas").getBoundingClientRect();
      return { left: box.left, top: box.top, width: box.width, height: box.height };
    })()
  `);
  const start = { x: canvas.left + canvas.width * 0.25, y: canvas.top + canvas.height * 0.3 };
  const end = { x: start.x + 150, y: start.y + 100 };
  await command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: start.x,
    y: start.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: end.x,
    y: end.y,
    button: "left",
    buttons: 1,
  });
  await command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: end.x,
    y: end.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await waitFor(
    `document.querySelectorAll(".layer-row").length === 1 &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "drawing and autosave on page 2",
  );

  await evaluate(`
    document.querySelector('[data-inspector-action="fill-mode"][data-value="linear-gradient"]').click();
    (() => {
      const startColor = document.querySelector('[data-gradient-stop="0"][type="color"]');
      const endColor = document.querySelector('[data-gradient-stop="last"][type="color"]');
      const angle = document.querySelector('[data-gradient-property="angle"]');
      startColor.value = "#2563eb";
      startColor.dispatchEvent(new Event("input", { bubbles: true }));
      endColor.value = "#ec4899";
      endColor.dispatchEvent(new Event("input", { bubbles: true }));
      angle.value = "32";
      angle.dispatchEvent(new Event("input", { bubbles: true }));
      angle.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
  await evaluate(`document.querySelector('[data-inspector-action="toggle-shadow"]').click(); true`);
  await evaluate(`
    (() => {
      const values = { offsetX: "6", offsetY: "14", blur: "22", opacity: "35" };
      for (const [property, value] of Object.entries(values)) {
        const input = document.querySelector('[data-shadow-property="' + property + '"]');
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      document.querySelector('[data-shadow-property="blur"]')
        .dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
  await waitFor(
    `document.querySelector('[data-inspector-action="fill-mode"][data-value="linear-gradient"]')?.classList.contains("active") &&
     document.querySelector('[data-gradient-property="angle"]')?.value === "32" &&
     document.querySelector('[data-inspector-action="toggle-shadow"]')?.classList.contains("active") &&
     document.querySelector('[data-shadow-property="blur"]')?.value === "22" &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "gradient and shadow inspector editing",
  );

  await evaluate(`document.querySelector('[data-tool="pen"]').click(); true`);
  const pathPoints = [
    { x: canvas.left + canvas.width * 0.58, y: canvas.top + canvas.height * 0.3 },
    { x: canvas.left + canvas.width * 0.72, y: canvas.top + canvas.height * 0.42 },
    { x: canvas.left + canvas.width * 0.58, y: canvas.top + canvas.height * 0.55 },
  ];
  await dispatchClick(command, pathPoints[0]);
  const penHandle = { x: pathPoints[1].x + 45, y: pathPoints[1].y - 26 };
  await command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: pathPoints[1].x,
    y: pathPoints[1].y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: penHandle.x,
    y: penHandle.y,
    button: "left",
    buttons: 1,
  });
  await command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: penHandle.x,
    y: penHandle.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await dispatchClick(command, pathPoints[2]);
  await dispatchClick(command, pathPoints[0]);
  await waitFor(
    `document.querySelectorAll(".layer-row").length === 2 &&
     document.querySelector(".selection-summary input")?.value === "Vector path" &&
     document.querySelector("[data-vector-point-count]")?.textContent === "3" &&
     document.querySelector("[data-vector-curve-count]")?.textContent === "2" &&
     document.querySelector('[data-inspector-action="vector-closed"][data-value="true"]')?.classList.contains("active")`,
    "closed Bézier path creation with pen-drag handles",
  );

  await evaluate(`
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    true;
  `);
  await waitFor(
    `document.querySelector('[data-inspector-action="edit-vector"]')?.textContent.includes("Done editing")`,
    "vector point edit mode",
  );

  const movedPoint = { x: pathPoints[1].x + 34, y: pathPoints[1].y - 18 };
  await command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: pathPoints[1].x,
    y: pathPoints[1].y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: movedPoint.x,
    y: movedPoint.y,
    button: "left",
    buttons: 1,
  });
  await command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: movedPoint.x,
    y: movedPoint.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await waitFor(
    `document.querySelector("[data-vector-point-count]")?.textContent === "3" &&
     document.querySelector("[data-vector-handle-mode]")?.textContent === "Mirrored" &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "vector anchor dragging",
  );

  const movedHandle = { x: penHandle.x + 34, y: penHandle.y - 18 };
  const mirroredHandleTarget = { x: movedHandle.x + 20, y: movedHandle.y + 28 };
  await dragPointer(command, movedHandle, mirroredHandleTarget);
  await waitFor(
    `document.querySelector("[data-vector-handle-mode]")?.textContent === "Mirrored" &&
     document.querySelector("[data-vector-curve-count]")?.textContent === "2" &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "mirrored Bézier handle editing",
  );

  const freeHandleTarget = {
    x: mirroredHandleTarget.x + 16,
    y: mirroredHandleTarget.y - 22,
  };
  await dragPointer(command, mirroredHandleTarget, freeHandleTarget, 1);
  await waitFor(
    `document.querySelector("[data-vector-handle-mode]")?.textContent === "Free"`,
    "Alt-drag disconnected handle editing",
  );

  await evaluate(`document.querySelector('[data-inspector-action="vector-point-corner"]').click(); true`);
  await waitFor(
    `document.querySelector("[data-vector-handle-mode]")?.textContent === "Corner" &&
     document.querySelector("[data-vector-curve-count]")?.textContent === "0"`,
    "corner anchor conversion",
  );
  await evaluate(`document.querySelector('[data-inspector-action="vector-point-smooth"]').click(); true`);
  await waitFor(
    `document.querySelector("[data-vector-handle-mode]")?.textContent === "Mirrored" &&
     document.querySelector("[data-vector-curve-count]")?.textContent === "2"`,
    "smooth anchor conversion",
  );
  if (process.env.TSYAIKO_CURVE_SCREENSHOT) {
    const screenshot = await command("Page.captureScreenshot", { format: "png" });
    writeFileSync(process.env.TSYAIKO_CURVE_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
  }

  const segmentMidpoint = {
    x: (pathPoints[2].x + pathPoints[0].x) / 2,
    y: (pathPoints[2].y + pathPoints[0].y) / 2,
  };
  await dispatchClick(command, segmentMidpoint, 1);
  await waitFor(
    `document.querySelector("[data-vector-point-count]")?.textContent === "4"`,
    "Alt-click anchor insertion",
  );
  await evaluate(`
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", code: "Delete", bubbles: true }));
    true;
  `);
  await waitFor(
    `document.querySelector("[data-vector-point-count]")?.textContent === "3"`,
    "vector anchor deletion",
  );

  await evaluate(`document.querySelector('[data-inspector-action="vector-closed"][data-value="false"]').click(); true`);
  await waitFor(
    `document.querySelector('[data-inspector-action="vector-closed"][data-value="false"]')?.classList.contains("active")`,
    "opening a vector path",
  );
  await evaluate(`document.querySelector('[data-inspector-action="vector-closed"][data-value="true"]').click(); true`);
  await waitFor(
    `document.querySelector('[data-inspector-action="vector-closed"][data-value="true"]')?.classList.contains("active")`,
    "closing a vector path",
  );
  await evaluate(`
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    true;
  `);

  const imagePath = path.join(profileDirectory, "smoke-image.png");
  writeFileSync(
    imagePath,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  );
  await evaluate(`document.querySelector("[data-tool=" + "image" + "]").click(); true`);
  const inputResult = await command("Runtime.evaluate", {
    expression: `document.querySelector("#imageFileInput")`,
    returnByValue: false,
  });
  await command("DOM.setFileInputFiles", {
    files: [imagePath],
    objectId: inputResult.result.objectId,
  });
  await evaluate(`
    document.querySelector("#imageFileInput").dispatchEvent(new Event("change", { bubbles: true }));
    true;
  `);
  await waitFor(
    `document.querySelectorAll(".layer-row").length === 3 &&
     document.querySelector(".selection-summary input")?.value === "smoke-image" &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "image import and IndexedDB autosave",
  );

  await evaluate(`
    (() => {
      const selectLayer = (name, shiftKey) => [...document.querySelectorAll(".layer-row")]
        .find((row) => row.querySelector(".layer-name")?.textContent === name)
        .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey }));
      selectLayer("smoke-image", false);
      selectLayer("Vector path", true);
      selectLayer("Rectangle", true);
      return true;
    })()
  `);
  await waitFor(
    `document.querySelectorAll('[data-multi-action="align"]').length === 6 &&
     !document.querySelector('[data-multi-action="align"][data-alignment="top"]')?.disabled &&
     !document.querySelector('[data-multi-action="distribute"][data-axis="horizontal"]')?.disabled`,
    "multi-selection arrangement controls",
  );
  await evaluate(`document.querySelector('[data-multi-action="align"][data-alignment="top"]').click(); true`);
  await waitFor(`document.querySelector("#saveState").textContent === "Saved locally"`, "top alignment autosave");
  await evaluate(`document.querySelector('[data-multi-action="distribute"][data-axis="horizontal"]').click(); true`);
  await waitFor(`document.querySelector("#saveState").textContent === "Saved locally"`, "spacing distribution autosave");
  const arrangedLayers = await evaluate(`
    (() => {
      const result = {};
      for (const name of ["smoke-image", "Vector path", "Rectangle"]) {
        [...document.querySelectorAll(".layer-row")]
          .find((row) => row.querySelector(".layer-name")?.textContent === name)
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        const value = (property) => Number(document.querySelector('[data-property="' + property + '"]')?.value);
        result[name] = { x: value("x"), y: value("y"), width: value("width") };
      }
      const selectLayer = (name, shiftKey) => [...document.querySelectorAll(".layer-row")]
        .find((row) => row.querySelector(".layer-name")?.textContent === name)
        .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey }));
      selectLayer("smoke-image", false);
      selectLayer("Vector path", true);
      selectLayer("Rectangle", true);
      return result;
    })()
  `);
  const arrangedValues = Object.values(arrangedLayers).sort((left, right) => left.x - right.x);
  const arrangedGaps = arrangedValues.slice(1).map((layer, index) =>
    layer.x - arrangedValues[index].x - arrangedValues[index].width);
  if (Math.max(...arrangedValues.map((layer) => layer.y)) - Math.min(...arrangedValues.map((layer) => layer.y)) > 0.05 ||
      Math.abs(arrangedGaps[0] - arrangedGaps[1]) > 0.05) {
    throw new Error(`Alignment/distribution validation failed: ${JSON.stringify(arrangedLayers)}`);
  }
  await evaluate(`
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "g",
      code: "KeyG",
      ctrlKey: true,
      bubbles: true,
    }));
    true;
  `);
  if (process.env.TSYAIKO_DEBUG_SMOKE) {
    await delay(300);
    const hierarchyState = await evaluate(`({
      rows: [...document.querySelectorAll(".layer-row")].map((row) => ({
        name: row.querySelector(".layer-name")?.textContent,
        style: row.getAttribute("style"),
        selected: row.classList.contains("selected")
      })),
      inspector: document.querySelector(".selection-summary input")?.value,
      save: document.querySelector("#saveState").textContent,
      toast: document.querySelector(".toast:last-child")?.textContent
    })`);
    process.stdout.write(`Hierarchy debug: ${JSON.stringify(hierarchyState)}\n`);
  }
  await waitFor(
    `document.querySelectorAll(".layer-row").length === 4 &&
     document.querySelectorAll('.layer-row[style*="--layer-depth: 1"]').length === 3 &&
     document.querySelector(".selection-summary input")?.value === "Group" &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "keyboard grouping and nested layers",
  );

  await evaluate(`document.querySelector('[data-layer-action="collapse"]').click(); true`);
  await waitFor(`document.querySelectorAll(".layer-row").length === 1`, "collapsed group");
  await evaluate(`document.querySelector('[data-layer-action="collapse"]').click(); true`);
  await waitFor(`document.querySelectorAll(".layer-row").length === 4`, "expanded group");

  await command("Page.reload", { ignoreCache: true });
  await waitFor(
    `document.readyState === "complete" &&
     document.querySelector("#currentPageName")?.textContent === "Page 2" &&
     document.querySelectorAll(".page-list-row").length === 2 &&
     document.querySelectorAll(".layer-row").length === 4 &&
     document.querySelectorAll('.layer-row[style*="--layer-depth: 1"]').length === 3`,
    "hierarchical multi-page reload persistence",
  );

  await evaluate(`
    [...document.querySelectorAll(".layer-row")]
      .find((row) => row.querySelector(".layer-name")?.textContent === "Vector path")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    true;
  `);
  await waitFor(
    `document.querySelector("[data-vector-point-count]")?.textContent === "3" &&
     document.querySelector("[data-vector-curve-count]")?.textContent === "2" &&
     document.querySelector('[data-inspector-action="vector-closed"][data-value="true"]')?.classList.contains("active")`,
    "Bézier path reload persistence",
  );
  const reloadedCurveCount = await evaluate(
    `document.querySelector("[data-vector-curve-count]")?.textContent`,
  );

  await evaluate(`
    [...document.querySelectorAll(".layer-row")]
      .find((row) => row.querySelector(".layer-name")?.textContent === "Rectangle")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    true;
  `);
  await waitFor(
    `document.querySelector('[data-inspector-action="fill-mode"][data-value="linear-gradient"]')?.classList.contains("active") &&
     document.querySelector('[data-gradient-property="angle"]')?.value === "32" &&
     document.querySelector('[data-inspector-action="toggle-shadow"]')?.classList.contains("active") &&
     document.querySelector('[data-shadow-property="offsetX"]')?.value === "6" &&
     document.querySelector('[data-shadow-property="offsetY"]')?.value === "14" &&
     document.querySelector('[data-shadow-property="opacity"]')?.value === "35"`,
    "paint and effect reload persistence",
  );

  const paintState = await evaluate(`({
    gradient: document.querySelector('[data-gradient-property="angle"]')?.value,
    shadowBlur: document.querySelector('[data-shadow-property="blur"]')?.value
  })`);

  await evaluate(`
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "d",
      code: "KeyD",
      ctrlKey: true,
      bubbles: true
    }));
    true;
  `);
  await waitFor(
    `document.querySelectorAll(".layer-row").length === 5 &&
     document.querySelector(".selection-summary input")?.value === "Rectangle copy"`,
    "duplicate Boolean operand",
  );

  await evaluate(`
    (() => {
      const selectLayer = (name, shiftKey) => [...document.querySelectorAll(".layer-row")]
        .find((row) => row.querySelector(".layer-name")?.textContent === name)
        .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey }));
      selectLayer("Rectangle", false);
      selectLayer("Rectangle copy", true);
      return true;
    })()
  `);
  await waitFor(
    `document.querySelector('[data-multi-action="boolean"][data-operation="subtract"]')`,
    "Boolean multi-selection controls",
  );
  await evaluate(`document.querySelector('[data-multi-action="boolean"][data-operation="subtract"]').click(); true`);
  await waitFor(
    `document.querySelectorAll(".layer-row").length === 6 &&
     document.querySelector(".selection-summary input")?.value === "Subtract" &&
     document.querySelectorAll('.layer-row[style*="--layer-depth: 2"]').length === 2 &&
     [...document.querySelectorAll(".layer-composite-role")].some((item) => item.textContent === "BASE") &&
     [...document.querySelectorAll(".layer-composite-role")].some((item) => item.textContent === "CUT")`,
    "non-destructive Subtract Boolean",
  );

  for (const operation of ["union", "intersect", "exclude", "subtract"]) {
    await evaluate(`document.querySelector('[data-inspector-action="boolean-operation"][data-value="${operation}"]').click(); true`);
    await waitFor(
      `document.querySelector('[data-inspector-action="boolean-operation"][data-value="${operation}"]')?.classList.contains("active")`,
      `${operation} Boolean mode`,
    );
  }

  await evaluate(`
    (() => {
      const stroke = document.querySelector('[data-property="strokeWidth"]');
      stroke.value = "8";
      stroke.dispatchEvent(new Event("input", { bubbles: true }));
      stroke.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
  await waitFor(
    `document.querySelector('[data-property="strokeWidth"]')?.value === "8" &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "Boolean expanded stroke editing",
  );
  if (process.env.TSYAIKO_BOOLEAN_SCREENSHOT) {
    const screenshot = await command("Page.captureScreenshot", { format: "png" });
    writeFileSync(process.env.TSYAIKO_BOOLEAN_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
  }

  await evaluate(`
    (() => {
      const selectLayer = (name, shiftKey) => [...document.querySelectorAll(".layer-row")]
        .find((row) => row.querySelector(".layer-name")?.textContent === name)
        .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey }));
      selectLayer("Subtract", false);
      selectLayer("smoke-image", true);
      return true;
    })()
  `);
  await waitFor(`document.querySelector('[data-multi-action="mask"]')`, "mask multi-selection control");
  await evaluate(`document.querySelector('[data-multi-action="mask"]').click(); true`);
  await waitFor(
    `document.querySelectorAll(".layer-row").length === 7 &&
     document.querySelector(".selection-summary input")?.value === "Mask group" &&
     [...document.querySelectorAll(".layer-composite-role")].some((item) => item.textContent === "MASK") &&
     [...document.querySelectorAll(".layer-composite-role")].some((item) => item.textContent === "CONTENT")`,
    "nested mask group creation",
  );

  await evaluate(`document.querySelector('[data-inspector-action="ungroup"]').click(); true`);
  await waitFor(
    `document.querySelectorAll(".layer-row").length === 6 &&
     document.querySelector('[data-multi-action="mask"]')`,
    "release mask sources",
  );
  await evaluate(`document.querySelector('[data-multi-action="mask"]').click(); true`);
  await waitFor(
    `document.querySelectorAll(".layer-row").length === 7 &&
     document.querySelector(".selection-summary input")?.value === "Mask group" &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "recreate mask group",
  );

  await command("Page.reload", { ignoreCache: true });
  await waitFor(
    `document.readyState === "complete" &&
     document.querySelectorAll(".layer-row").length === 7 &&
     document.querySelectorAll('.layer-row[style*="--layer-depth: 3"]').length === 2`,
    "Boolean and mask hierarchy reload persistence",
  );
  await evaluate(`
    [...document.querySelectorAll(".layer-row")]
      .find((row) => row.querySelector(".layer-name")?.textContent === "Subtract")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    true;
  `);
  await waitFor(
    `document.querySelector('[data-inspector-action="boolean-operation"][data-value="subtract"]')?.classList.contains("active") &&
     document.querySelector('[data-property="strokeWidth"]')?.value === "8"`,
    "Boolean operation reload persistence",
  );

  await evaluate(`
    [...document.querySelectorAll(".layer-row")]
      .find((row) => row.querySelector(".layer-name")?.textContent === "Mask group")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    true;
  `);
  await waitFor(
    `document.querySelector(".selection-summary input")?.value === "Mask group" &&
     [...document.querySelectorAll(".composite-summary")].some((item) => item.textContent.includes("Subtract"))`,
    "mask inspector reload persistence",
  );

  await evaluate(`
    (() => {
      const selectLayer = (name, shiftKey) => [...document.querySelectorAll(".layer-row")]
        .find((row) => row.querySelector(".layer-name")?.textContent === name)
        .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey }));
      selectLayer("Vector path", false);
      selectLayer("Mask group", true);
      return true;
    })()
  `);
  await waitFor(
    `document.querySelector('[data-multi-action="auto-layout"][data-mode="vertical"]')`,
    "Auto Layout multi-selection controls",
  );
  await evaluate(`
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "A",
      code: "KeyQ",
      shiftKey: true,
      bubbles: true
    }));
    true
  `);
  await waitFor(
    `document.querySelectorAll(".layer-row").length === 8 &&
     document.querySelector(".selection-summary input")?.value === "Auto layout"`,
    "keyboard-layout-independent Shift+A Auto Layout wrapping",
  );
  await evaluate(`document.querySelector('[data-inspector-action="layout-mode"][data-value="vertical"]').click(); true`);
  await waitFor(
    `document.querySelectorAll(".layer-row").length === 8 &&
     document.querySelector(".selection-summary input")?.value === "Auto layout" &&
     document.querySelector('[data-inspector-action="layout-mode"][data-value="vertical"]')?.classList.contains("active") &&
     [...document.querySelectorAll(".layer-composite-role")].some((item) => item.textContent === "AUTO V")`,
    "vertical Auto Layout mode",
  );

  const autoLayoutDragFixture = await evaluate(`
    (() => {
      const select = (name) => [...document.querySelectorAll(".layer-row")]
        .find((row) => row.querySelector(".layer-name")?.textContent === name)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const geometry = () => ({
        x: Number(document.querySelector('[data-property="x"]')?.value),
        y: Number(document.querySelector('[data-property="y"]')?.value),
        width: Number(document.querySelector('[data-property="width"]')?.value),
        height: Number(document.querySelector('[data-property="height"]')?.value)
      });
      select("Vector path");
      const child = geometry();
      select("Auto layout");
      const frame = geometry();
      select("Vector path");
      document.querySelector("#zoomValue").click();
      return { child, frame, rows: document.querySelectorAll(".layer-row").length };
    })()
  `);
  await delay(100);
  const autoLayoutDragZoom = await evaluate(`Number.parseInt(document.querySelector("#zoomValue").textContent, 10) / 100`);
  const beforeFrame = autoLayoutDragFixture.frame.y - autoLayoutDragFixture.child.height - 20;
  const afterFrame = autoLayoutDragFixture.frame.y + autoLayoutDragFixture.frame.height + 20;
  const autoLayoutDragDelta = Math.abs(beforeFrame - autoLayoutDragFixture.child.y) <
      Math.abs(afterFrame - autoLayoutDragFixture.child.y)
    ? beforeFrame - autoLayoutDragFixture.child.y
    : afterFrame - autoLayoutDragFixture.child.y;
  const autoLayoutDragStart = {
    x: canvas.left + canvas.width / 2,
    y: canvas.top + canvas.height / 2,
  };
  await dragPointer(command, autoLayoutDragStart, {
    x: autoLayoutDragStart.x,
    y: autoLayoutDragStart.y + autoLayoutDragDelta * autoLayoutDragZoom,
  }, 9);
  if (process.env.TSYAIKO_DEBUG_SMOKE) {
    const autoLayoutDragState = await evaluate(`({
      selection: document.querySelector(".selection-summary input")?.value,
      positioning: document.querySelector('[data-inspector-action="layout-positioning"].active')?.dataset.value,
      duplicateDrag: document.querySelector("#designCanvas")?.dataset.duplicateDrag,
      rows: [...document.querySelectorAll(".layer-row")].map((row) => ({
        name: row.querySelector(".layer-name")?.textContent,
        style: row.getAttribute("style"),
        selected: row.classList.contains("selected")
      }))
    })`);
    process.stdout.write(`Auto Layout drag debug: ${JSON.stringify({ autoLayoutDragFixture, autoLayoutDragZoom, autoLayoutDragDelta, autoLayoutDragState })}\n`);
  }
  await waitFor(
    `(() => {
       const rows = [...document.querySelectorAll(".layer-row")];
       const frame = rows.find((row) => row.querySelector(".layer-name")?.textContent === "Auto layout");
       const copy = rows.find((row) => row.querySelector(".layer-name")?.textContent === "Vector path copy");
       return frame && copy &&
         Number(copy.style.getPropertyValue("--layer-depth")) ===
           Number(frame.style.getPropertyValue("--layer-depth")) + 1;
     })() &&
     document.querySelector('[data-inspector-action="layout-positioning"][data-value="auto"]')?.classList.contains("active")`,
    "Auto Layout child drag duplication remains in flow",
  );
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true })); true`);
  await waitFor(
    `document.querySelectorAll(".layer-row").length === ${autoLayoutDragFixture.rows} &&
     ![...document.querySelectorAll(".layer-name")].some((item) => item.textContent === "Vector path copy")`,
    "Auto Layout drag duplication undo",
  );
  await evaluate(`
    [...document.querySelectorAll(".layer-row")]
      .find((row) => row.querySelector(".layer-name")?.textContent === "Auto layout")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    true
  `);

  await evaluate(`
    document.querySelector('[data-inspector-action="layout-sizing-horizontal"][data-value="fixed"]').click();
    document.querySelector('[data-inspector-action="layout-sizing-vertical"][data-value="fixed"]').click();
    true;
  `);
  await evaluate(`
    (() => {
      const setInput = (selector, value) => {
        const input = document.querySelector(selector);
        input.value = String(value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };
      setInput('[data-property="width"]', 420);
      setInput('[data-property="height"]', 360);
      for (const property of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]) {
        setInput('[data-layout-property="' + property + '"]', 24);
      }
      setInput('[data-layout-property="layoutGap"]', 20);
      return true;
    })()
  `);
  await waitFor(
    `document.querySelector('[data-property="width"]')?.value === "420" &&
     document.querySelector('[data-property="height"]')?.value === "360" &&
     document.querySelector('[data-layout-property="layoutGap"]')?.value === "20" &&
     [...document.querySelectorAll('[data-layout-property^="padding"]')].every((input) => input.value === "24") &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "Auto Layout fixed sizing, padding, and gap editing",
  );

  await evaluate(`
    [...document.querySelectorAll(".layer-row")]
      .find((row) => row.querySelector(".layer-name")?.textContent === "Vector path")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    true;
  `);
  await waitFor(
    `document.querySelector('[data-inspector-action="layout-sizing-horizontal"][data-value="fill"]')`,
    "Auto Layout child sizing controls",
  );
  await evaluate(`document.querySelector('[data-inspector-action="layout-sizing-horizontal"][data-value="fill"]').click(); true`);
  await waitFor(
    `document.querySelector('[data-inspector-action="layout-sizing-horizontal"][data-value="fill"]')?.classList.contains("active") &&
     document.querySelector('[data-property="width"]')?.disabled === true &&
     document.querySelector('[data-property="width"]')?.value === "372"`,
    "fill-width Auto Layout child",
  );

  await evaluate(`document.querySelector('[data-inspector-action="layout-positioning"][data-value="absolute"]').click(); true`);
  await waitFor(
    `document.querySelector('[data-inspector-action="layout-positioning"][data-value="absolute"]')?.classList.contains("active") &&
     document.querySelector('[data-layout-property="constraintHorizontal"]')`,
    "absolute Auto Layout child positioning",
  );
  await evaluate(`
    (() => {
      const horizontal = document.querySelector('[data-layout-property="constraintHorizontal"]');
      horizontal.value = "right";
      horizontal.dispatchEvent(new Event("input", { bubbles: true }));
      horizontal.dispatchEvent(new Event("change", { bubbles: true }));
      const vertical = document.querySelector('[data-layout-property="constraintVertical"]');
      vertical.value = "bottom";
      vertical.dispatchEvent(new Event("input", { bubbles: true }));
      vertical.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
  const constrainedBefore = await evaluate(`({
    x: Number(document.querySelector('[data-property="x"]').value),
    y: Number(document.querySelector('[data-property="y"]').value)
  })`);

  await evaluate(`
    [...document.querySelectorAll(".layer-row")]
      .find((row) => row.querySelector(".layer-name")?.textContent === "Auto layout")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    true;
  `);
  await evaluate(`
    (() => {
      const setInput = (property, value) => {
        const input = document.querySelector('[data-property="' + property + '"]');
        input.value = String(value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };
      setInput("width", 520);
      setInput("height", 440);
      return true;
    })()
  `);
  await evaluate(`
    [...document.querySelectorAll(".layer-row")]
      .find((row) => row.querySelector(".layer-name")?.textContent === "Vector path")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    true;
  `);
  const constrainedAfter = await evaluate(`({
    x: Number(document.querySelector('[data-property="x"]').value),
    y: Number(document.querySelector('[data-property="y"]').value)
  })`);
  if (Math.abs(constrainedAfter.x - constrainedBefore.x - 100) > 0.01 ||
      Math.abs(constrainedAfter.y - constrainedBefore.y - 80) > 0.01) {
    throw new Error(`Frame constraint resize failed: ${JSON.stringify({ constrainedBefore, constrainedAfter })}`);
  }

  await evaluate(`
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true }));
    true;
  `);
  await waitFor(
    `Math.abs(Number(document.querySelector('[data-property="y"]')?.value) - ${constrainedBefore.y}) < 0.01`,
    "constraint resize undo",
  );
  await evaluate(`
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true, bubbles: true }));
    true;
  `);
  await waitFor(
    `Math.abs(Number(document.querySelector('[data-property="y"]')?.value) - ${constrainedAfter.y}) < 0.01 &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "constraint resize redo",
  );

  await command("Page.reload", { ignoreCache: true });
  await waitFor(
    `document.readyState === "complete" &&
     document.querySelectorAll(".layer-row").length === 8 &&
     [...document.querySelectorAll(".layer-composite-role")].some((item) => item.textContent === "AUTO V")`,
    "Auto Layout hierarchy reload persistence",
  );
  await evaluate(`
    [...document.querySelectorAll(".layer-row")]
      .find((row) => row.querySelector(".layer-name")?.textContent === "Auto layout")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    true;
  `);
  await waitFor(
    `document.querySelector('[data-inspector-action="layout-mode"][data-value="vertical"]')?.classList.contains("active") &&
     document.querySelector('[data-property="width"]')?.value === "520" &&
     document.querySelector('[data-property="height"]')?.value === "440" &&
     document.querySelector('[data-layout-property="layoutGap"]')?.value === "20"`,
    "Auto Layout inspector reload persistence",
  );
  const layoutState = await evaluate(`({
    mode: document.querySelector('[data-inspector-action="layout-mode"].active')?.dataset.value,
    gap: document.querySelector('[data-layout-property="layoutGap"]')?.value,
    width: document.querySelector('[data-property="width"]')?.value,
    height: document.querySelector('[data-property="height"]')?.value
  })`);
  const storedDocumentVersion = await evaluate(`
    new Promise((resolve, reject) => {
      const request = indexedDB.open("tsyaiko-editor", 1);
      request.addEventListener("success", () => {
        const transaction = request.result.transaction("workspaces", "readonly");
        const record = transaction.objectStore("workspaces").get("active");
        record.addEventListener("success", () => resolve(record.result?.document?.version));
        record.addEventListener("error", () => reject(record.error));
      }, { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    })
  `);
  if (storedDocumentVersion !== 13) {
    throw new Error(`Expected persisted document v13, received ${storedDocumentVersion}.`);
  }
  await evaluate(`
    [...document.querySelectorAll(".layer-row")]
      .find((row) => row.querySelector(".layer-name")?.textContent === "Vector path")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    true;
  `);
  await waitFor(
    `document.querySelector('[data-inspector-action="layout-positioning"][data-value="absolute"]')?.classList.contains("active") &&
     document.querySelector('[data-layout-property="constraintHorizontal"]')?.value === "right" &&
     document.querySelector('[data-layout-property="constraintVertical"]')?.value === "bottom"`,
    "absolute child constraint reload persistence",
  );

  const layersBeforeComponents = await evaluate(`document.querySelectorAll(".layer-row").length`);
  await evaluate(`
    (() => {
      const main = [...document.querySelectorAll(".layer-row")]
        .find((row) => row.querySelector(".layer-name")?.textContent === "Auto layout");
      main.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      document.querySelector('[data-panel="assets"]').click();
      document.querySelector("#createComponentButton").click();
      return true;
    })()
  `);
  await waitFor(
    `document.querySelectorAll(".component-card").length === 1 &&
     [...document.querySelectorAll(".layer-composite-role")].some((item) => item.textContent === "MAIN")`,
    "local component creation",
  );
  await evaluate(`document.querySelector(".component-card-main").click(); true`);
  await waitFor(
    `document.querySelectorAll(".layer-row").length > ${layersBeforeComponents} &&
     [...document.querySelectorAll(".layer-composite-role")].filter((item) => item.textContent === "INSTANCE").length === 1 &&
     document.querySelector('[data-inspector-action="reset-component-overrides"]')`,
    "first linked component instance insertion",
  );
  await evaluate(`document.querySelector(".component-card-main").click(); true`);
  await waitFor(
    `[...document.querySelectorAll(".layer-composite-role")].filter((item) => item.textContent === "INSTANCE").length === 2 &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "second linked component instance insertion",
  );

  await evaluate(`
    (() => {
      const instance = [...document.querySelectorAll(".layer-row")]
        .find((row) => row.querySelector(".layer-composite-role")?.textContent === "INSTANCE");
      instance.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const fill = document.querySelector('[data-property="fill"][type="color"]');
      fill.value = "#fef3c7";
      fill.dispatchEvent(new Event("input", { bubbles: true }));
      fill.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
  await waitFor(
    `document.querySelector('[data-property="fill"][type="color"]')?.value === "#fef3c7" &&
     document.querySelector('[data-inspector-action="reset-component-override"][data-component-property="fill"]') &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "instance visual override",
  );
  await evaluate(`
    (() => {
      const main = [...document.querySelectorAll(".layer-row")]
        .find((row) => row.querySelector(".layer-composite-role")?.textContent === "MAIN");
      main.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const fill = document.querySelector('[data-property="fill"][type="color"]');
      fill.value = "#0f766e";
      fill.dispatchEvent(new Event("input", { bubbles: true }));
      fill.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
  await waitFor(
    `document.querySelector("#saveState").textContent === "Saved locally"`,
    "main component source update",
  );
  await evaluate(`
    (() => {
      const instance = [...document.querySelectorAll(".layer-row")]
        .find((row) => row.querySelector(".layer-composite-role")?.textContent === "INSTANCE");
      instance.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return true;
    })()
  `);
  await waitFor(
    `document.querySelector('[data-property="fill"][type="color"]')?.value === "#fef3c7" &&
     !document.querySelector('[data-inspector-action="reset-component-overrides"]')?.disabled`,
    "instance override survives a main component update",
  );
  await evaluate(`document.querySelector('[data-inspector-action="reset-component-override"][data-component-property="fill"]').click(); true`);
  await waitFor(
    `document.querySelector('[data-property="fill"][type="color"]')?.value === "#0f766e" &&
     document.querySelector('[data-inspector-action="reset-component-overrides"]')?.disabled === true`,
    "single instance override reset",
  );
  await evaluate(`
    (() => {
      const name = document.querySelector('[data-property="name"]');
      name.value = "Detached auto layout";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      name.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
  await evaluate(`document.querySelector('[data-inspector-action="detach-component-instance"]').click(); true`);
  await waitFor(
    `document.querySelector('.selection-summary input')?.value === "Detached auto layout" &&
     !document.querySelector('[data-inspector-action="detach-component-instance"]')`,
    "instance detach",
  );
  await evaluate(`
    (() => {
      const main = [...document.querySelectorAll(".layer-row")]
        .find((row) => row.querySelector(".layer-composite-role")?.textContent === "MAIN");
      main.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const fill = document.querySelector('[data-property="fill"][type="color"]');
      fill.value = "#dc2626";
      fill.dispatchEvent(new Event("input", { bubbles: true }));
      fill.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
  await waitFor(`document.querySelector("#saveState").textContent === "Saved locally"`, "post-detach source update");
  await evaluate(`
    [...document.querySelectorAll(".layer-row")]
      .find((row) => row.querySelector(".layer-name")?.textContent === "Detached auto layout")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    true
  `);
  await waitFor(
    `document.querySelector('[data-property="fill"][type="color"]')?.value === "#0f766e"`,
    "detached instance remains independent",
  );
  await evaluate(`
    [...document.querySelectorAll(".layer-row")]
      .find((row) => row.querySelector(".layer-composite-role")?.textContent === "INSTANCE")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    true
  `);
  await waitFor(
    `document.querySelector('[data-property="fill"][type="color"]')?.value === "#dc2626"`,
    "remaining linked instance receives source update",
  );

  await evaluate(`
    (() => {
      const detached = [...document.querySelectorAll(".layer-row")]
        .find((row) => row.querySelector(".layer-name")?.textContent === "Detached auto layout");
      detached.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      document.querySelector("#createComponentButton").click();
      return true;
    })()
  `);
  await waitFor(
    `document.querySelectorAll(".component-card").length === 2 &&
     [...document.querySelectorAll(".component-card-copy strong")].some((item) => item.textContent === "Detached auto layout") &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "second local component creation",
  );
  await evaluate(`
    (() => {
      const firstCard = [...document.querySelectorAll(".component-card")]
        .find((card) => card.querySelector(".component-card-copy strong")?.textContent === "Auto layout");
      firstCard.querySelector('[data-component-action="reveal"]').click();
      return true;
    })()
  `);
  await waitFor(
    `document.querySelector(".layer-row.selected .layer-composite-role")?.textContent === "MAIN" &&
     document.querySelector(".component-inspector-summary strong")?.textContent === "Auto layout"`,
    "reveal main component from Assets",
  );
  await evaluate(`
    (() => {
      const instance = [...document.querySelectorAll(".layer-row")]
        .find((row) => row.querySelector(".layer-composite-role")?.textContent === "INSTANCE");
      instance.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const swap = document.querySelector("[data-component-swap]");
      const option = [...swap.options].find((item) => item.textContent === "Detached auto layout");
      swap.value = option.value;
      swap.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
  await waitFor(
    `document.querySelector(".component-inspector-summary strong")?.textContent === "Detached auto layout" &&
     document.querySelector('[data-property="fill"][type="color"]')?.value === "#0f766e" &&
     [...document.querySelectorAll(".component-card")].find((card) => card.querySelector("strong")?.textContent === "Auto layout")?.querySelector("small")?.textContent === "0 instances" &&
     [...document.querySelectorAll(".component-card")].find((card) => card.querySelector("strong")?.textContent === "Detached auto layout")?.querySelector("small")?.textContent === "1 instance" &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "linked component instance swap",
  );

  await evaluate(`
    (() => {
      const findMain = (name) => [...document.querySelectorAll(".layer-row")]
        .find((row) => row.querySelector(".layer-composite-role")?.textContent === "MAIN" &&
          row.querySelector(".layer-name")?.textContent === name);
      findMain("Auto layout").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      findMain("Detached auto layout").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
      document.querySelector("#createVariantSetButton").click();
      return true;
    })()
  `);
  await waitFor(
    `document.querySelectorAll(".component-set-card").length === 1 &&
     document.querySelector(".component-set-heading strong")?.textContent === "Local variants" &&
     [...document.querySelectorAll(".layer-composite-role")].filter((item) => item.textContent === "VARIANT").length === 2 &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "local component variant-set creation",
  );
  await evaluate(`
    (() => {
      const instance = [...document.querySelectorAll(".layer-row")]
        .find((row) => row.querySelector(".layer-composite-role")?.textContent === "INSTANCE");
      instance.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const variant = document.querySelector('[data-component-variant][data-variant-property="Variant"]');
      variant.value = "Auto layout";
      variant.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
  await waitFor(
    `document.querySelector(".component-inspector-summary strong")?.textContent === "Local variants" &&
     document.querySelector('[data-component-variant][data-variant-property="Variant"]')?.value === "Auto layout" &&
     document.querySelector('[data-property="fill"][type="color"]')?.value === "#dc2626" &&
     [...document.querySelectorAll(".component-card")].find((card) => card.querySelector("strong")?.textContent === "Auto layout")?.querySelector("small")?.textContent === "1 instance" &&
     [...document.querySelectorAll(".component-card")].find((card) => card.querySelector("strong")?.textContent === "Detached auto layout")?.querySelector("small")?.textContent === "0 instances" &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "component variant switch",
  );

  await command("Page.reload", { ignoreCache: true });
  await waitFor(
    `document.readyState === "complete" &&
     document.querySelectorAll(".component-set-card").length === 1 &&
     document.querySelectorAll(".component-card").length === 2 &&
     [...document.querySelectorAll(".component-card")].find((card) => card.querySelector("strong")?.textContent === "Auto layout")?.querySelector("small")?.textContent === "1 instance" &&
     [...document.querySelectorAll(".component-card")].find((card) => card.querySelector("strong")?.textContent === "Detached auto layout")?.querySelector("small")?.textContent === "0 instances" &&
     [...document.querySelectorAll(".layer-composite-role")].some((item) => item.textContent === "INSTANCE")`,
    "component variant persistence",
  );
  await evaluate(`
    [...document.querySelectorAll(".layer-row")]
      .find((row) => row.querySelector(".layer-composite-role")?.textContent === "INSTANCE")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    true
  `);
  await waitFor(
    `document.querySelector('[data-component-variant][data-variant-property="Variant"]')?.value === "Auto layout"`,
    "variant Inspector reload persistence",
  );
  if (process.env.TSYAIKO_COMPONENT_SCREENSHOT) {
    await evaluate(`
      (() => {
        const instance = [...document.querySelectorAll(".layer-row")]
          .find((row) => row.querySelector(".layer-composite-role")?.textContent === "INSTANCE");
        instance?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        document.querySelector('[data-panel="assets"]').click();
        return true;
      })()
    `);
    await delay(150);
    const screenshot = await command("Page.captureScreenshot", { format: "png" });
    writeFileSync(process.env.TSYAIKO_COMPONENT_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
  }

  await evaluate(`document.querySelector("#addPageButton").click(); true`);
  await waitFor(
    `document.querySelector("#currentPageName")?.textContent === "Page 3" &&
     document.querySelectorAll(".layer-row").length === 0`,
    "fresh multi-transform page",
  );
  const transformRects = [
    { x: canvas.left + canvas.width * 0.22, y: canvas.top + canvas.height * 0.28, width: 60, height: 40 },
    { x: canvas.left + canvas.width * 0.42, y: canvas.top + canvas.height * 0.40, width: 70, height: 50 },
    { x: canvas.left + canvas.width * 0.64, y: canvas.top + canvas.height * 0.52, width: 50, height: 70 },
  ];
  for (const rectangle of transformRects) {
    await evaluate(`document.querySelector('[data-tool="rectangle"]').click(); true`);
    await dragPointer(command, { x: rectangle.x, y: rectangle.y }, {
      x: rectangle.x + rectangle.width,
      y: rectangle.y + rectangle.height,
    });
  }
  await waitFor(
    `document.querySelectorAll(".layer-row").length === 3 &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "multi-transform fixture creation",
  );
  const measurementTarget = {
    x: transformRects[0].x + transformRects[0].width / 2,
    y: transformRects[0].y + transformRects[0].height / 2,
  };
  await command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: measurementTarget.x,
    y: measurementTarget.y,
    button: "none",
    buttons: 0,
    modifiers: 1,
  });
  await waitFor(
    `Number(document.querySelector("#designCanvas")?.dataset.measurementCount) > 0`,
    "Alt distance inspection",
  );
  await command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: measurementTarget.x,
    y: measurementTarget.y,
    button: "none",
    buttons: 0,
    modifiers: 0,
  });
  await waitFor(
    `document.querySelector("#designCanvas")?.dataset.measurementCount === "0"`,
    "distance inspection cleanup",
  );
  await evaluate(`
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", code: "Delete", bubbles: true }));
    true
  `);
  await waitFor(
    `document.querySelectorAll(".layer-row").length === 2 &&
     document.querySelector("#designCanvas")?.dataset.fullRedraw === "true"`,
    "structural deletion cleanup redraw",
  );
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true })); true`);
  await waitFor(
    `document.querySelectorAll(".layer-row").length === 3 &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "structural deletion undo",
  );
  const readGeometryByLayer = async (index) => {
    await evaluate(`
      document.querySelectorAll(".layer-row")[${index}]
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      true
    `);
    return evaluate(`({
      x: Number(document.querySelector('[data-property="x"]')?.value),
      y: Number(document.querySelector('[data-property="y"]')?.value),
      width: Number(document.querySelector('[data-property="width"]')?.value),
      height: Number(document.querySelector('[data-property="height"]')?.value),
      rotation: Number(document.querySelector('[data-property="rotation"]')?.value)
    })`);
  };
  const sourceCenters = transformRects.map((rectangle) => ({
    x: rectangle.x + rectangle.width / 2,
    y: rectangle.y + rectangle.height / 2,
  }));
  const sourceGeometry = [];
  for (const index of sourceCenters.keys()) sourceGeometry.push(await readGeometryByLayer(index));
  const sourceBounds = {
    x: Math.min(...sourceGeometry.map((item) => item.x)),
    y: Math.min(...sourceGeometry.map((item) => item.y)),
    width: Math.max(...sourceGeometry.map((item) => item.x + item.width)) - Math.min(...sourceGeometry.map((item) => item.x)),
    height: Math.max(...sourceGeometry.map((item) => item.y + item.height)) - Math.min(...sourceGeometry.map((item) => item.y)),
  };

  await evaluate(`document.querySelector('[data-tool="select"]').click(); true`);
  for (const [index, center] of sourceCenters.entries()) {
    await dispatchClick(command, center, index ? 8 : 0);
  }
  await waitFor(
    `document.querySelector(".selection-summary input")?.value === "3 layers selected"`,
    "multi-transform selection",
  );
  const sourceScreenBounds = {
    x: Math.min(...transformRects.map((item) => item.x)),
    y: Math.min(...transformRects.map((item) => item.y)),
    width: Math.max(...transformRects.map((item) => item.x + item.width)) - Math.min(...transformRects.map((item) => item.x)),
    height: Math.max(...transformRects.map((item) => item.y + item.height)) - Math.min(...transformRects.map((item) => item.y)),
  };
  const resizedScreenBounds = {
    x: sourceScreenBounds.x,
    y: sourceScreenBounds.y,
    width: sourceScreenBounds.width * 2,
    height: sourceScreenBounds.height * 2,
  };
  await dragPointer(command, {
    x: sourceScreenBounds.x + sourceScreenBounds.width,
    y: sourceScreenBounds.y + sourceScreenBounds.height,
  }, {
    x: resizedScreenBounds.x + resizedScreenBounds.width,
    y: resizedScreenBounds.y + resizedScreenBounds.height,
  });
  await waitFor(
    `document.querySelector("#saveState").textContent === "Saved locally"`,
    "multi-selection resize autosave",
  );
  const resizedCenters = sourceCenters.map((center) => ({
    x: resizedScreenBounds.x + (center.x - sourceScreenBounds.x) * 2,
    y: resizedScreenBounds.y + (center.y - sourceScreenBounds.y) * 2,
  }));
  const resizedGeometry = [];
  for (const index of resizedCenters.keys()) resizedGeometry.push(await readGeometryByLayer(index));
  for (const [index, geometry] of resizedGeometry.entries()) {
    const source = sourceGeometry[index];
    const expected = {
      x: sourceBounds.x + (source.x - sourceBounds.x) * 2,
      y: sourceBounds.y + (source.y - sourceBounds.y) * 2,
      width: source.width * 2,
      height: source.height * 2,
    };
    if (Object.entries(expected).some(([property, value]) => Math.abs(geometry[property] - value) > 0.2)) {
      throw new Error(`Multi-selection resize validation failed: ${JSON.stringify({ source, geometry, expected })}`);
    }
  }

  for (let index = 0; index < 3; index += 1) {
    await evaluate(`
      document.querySelectorAll(".layer-row")[${index}]
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: ${index > 0} }));
      true
    `);
  }
  await waitFor(
    `document.querySelector(".selection-summary input")?.value === "3 layers selected"`,
    "resized multi-transform selection",
  );
  const rotationCenter = {
    x: resizedScreenBounds.x + resizedScreenBounds.width / 2,
    y: resizedScreenBounds.y + resizedScreenBounds.height / 2,
  };
  await dragPointer(command, {
    x: rotationCenter.x,
    y: resizedScreenBounds.y - 25,
  }, {
    x: rotationCenter.x + 25,
    y: rotationCenter.y,
  }, 8);
  await waitFor(
    `document.querySelector("#saveState").textContent === "Saved locally"`,
    "multi-selection rotation autosave",
  );
  const rotatedCenters = resizedCenters.map((center) => ({
    x: rotationCenter.x - (center.y - rotationCenter.y),
    y: rotationCenter.y + (center.x - rotationCenter.x),
  }));
  const rotatedGeometry = [];
  for (const index of rotatedCenters.keys()) rotatedGeometry.push(await readGeometryByLayer(index));
  if (rotatedGeometry.some((geometry, index) =>
    Math.abs(geometry.rotation - 90) > 0.1 ||
    Math.abs(geometry.width - resizedGeometry[index].width) > 0.1 ||
    Math.abs(geometry.height - resizedGeometry[index].height) > 0.1)) {
    throw new Error(`Multi-selection rotation validation failed: ${JSON.stringify(rotatedGeometry)}`);
  }
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true })); true`);
  const undoGeometry = await readGeometryByLayer(0);
  if (Math.abs(undoGeometry.rotation) > 0.1) {
    throw new Error(`Multi-selection rotation undo failed: ${JSON.stringify(undoGeometry)}`);
  }
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true, bubbles: true })); true`);
  const redoGeometry = await readGeometryByLayer(0);
  if (Math.abs(redoGeometry.rotation - 90) > 0.1) {
    throw new Error(`Multi-selection rotation redo failed: ${JSON.stringify(redoGeometry)}`);
  }
  await waitFor(
    `document.querySelector("#saveState").textContent === "Saved locally"`,
    "multi-transform history autosave",
  );

  await evaluate(`
    [...document.querySelectorAll(".layer-row")].map((row) => row.dataset.layerId).forEach((id, index) => {
      document.querySelector('[data-layer-id="' + id + '"]')
        .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: index > 0 }));
    });
    true
  `);
  await waitFor(
    `document.querySelectorAll("[data-multi-transform-property]").length === 4 &&
     document.querySelector('[data-multi-transform-property="x"]')?.disabled === false &&
     document.querySelector('[data-multi-transform-property="width"]')?.disabled === false &&
     document.querySelector('[data-multi-transform-action="rotate"][data-degrees="90"]')?.disabled === false`,
    "multi-transform precision controls",
  );
  const precisionBoundsBeforeMove = await evaluate(`Object.fromEntries(
    [...document.querySelectorAll("[data-multi-transform-property]")]
      .map((input) => [input.dataset.multiTransformProperty, Number(input.value)])
  )`);
  const precisionMoveX = precisionBoundsBeforeMove.x + 37;
  await evaluate(`
    (() => {
      const input = document.querySelector('[data-multi-transform-property="x"]');
      input.value = ${precisionMoveX};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
  await waitFor(
    `Math.abs(Number(document.querySelector('[data-multi-transform-property="x"]')?.value) - ${precisionMoveX}) < 0.2 &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "exact multi-selection position",
  );
  const movedGeometry = [];
  for (const index of rotatedGeometry.keys()) movedGeometry.push(await readGeometryByLayer(index));
  if (movedGeometry.some((geometry, index) =>
    Math.abs(geometry.x - rotatedGeometry[index].x - 37) > 0.2 ||
    Math.abs(geometry.y - rotatedGeometry[index].y) > 0.2 ||
    Math.abs(geometry.rotation - rotatedGeometry[index].rotation) > 0.1)) {
    throw new Error(`Exact multi-selection position validation failed: ${JSON.stringify({ rotatedGeometry, movedGeometry })}`);
  }

  await evaluate(`
    [...document.querySelectorAll(".layer-row")].map((row) => row.dataset.layerId).forEach((id, index) => {
      document.querySelector('[data-layer-id="' + id + '"]')
        .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: index > 0 }));
    });
    document.querySelector('[data-multi-transform-action="toggle-aspect"]')?.click();
    true
  `);
  await waitFor(
    `document.querySelector('[data-multi-transform-action="toggle-aspect"]')?.getAttribute("aria-pressed") === "true"`,
    "multi-transform aspect ratio lock",
  );
  const precisionBoundsBeforeScale = await evaluate(`Object.fromEntries(
    [...document.querySelectorAll("[data-multi-transform-property]")]
      .map((input) => [input.dataset.multiTransformProperty, Number(input.value)])
  )`);
  const precisionScaleWidth = precisionBoundsBeforeScale.width * 1.25;
  await evaluate(`
    (() => {
      const input = document.querySelector('[data-multi-transform-property="width"]');
      input.value = ${precisionScaleWidth};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
  await waitFor(
    `Math.abs(Number(document.querySelector('[data-multi-transform-property="width"]')?.value) - ${precisionScaleWidth}) < 0.3 &&
     Math.abs(Number(document.querySelector('[data-multi-transform-property="height"]')?.value) - ${precisionBoundsBeforeScale.height * 1.25}) < 0.3 &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "locked-ratio multi-selection size",
  );
  const scaledGeometry = [];
  for (const index of movedGeometry.keys()) scaledGeometry.push(await readGeometryByLayer(index));
  if (scaledGeometry.some((geometry, index) =>
    Math.abs(geometry.width - movedGeometry[index].width * 1.25) > 0.3 ||
    Math.abs(geometry.height - movedGeometry[index].height * 1.25) > 0.3 ||
    Math.abs(geometry.rotation - 90) > 0.1)) {
    throw new Error(`Locked-ratio multi-selection size validation failed: ${JSON.stringify({ movedGeometry, scaledGeometry })}`);
  }

  await evaluate(`
    [...document.querySelectorAll(".layer-row")].map((row) => row.dataset.layerId).forEach((id, index) => {
      document.querySelector('[data-layer-id="' + id + '"]')
        .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: index > 0 }));
    });
    document.querySelector('[data-multi-transform-action="rotate"][data-degrees="90"]')?.click();
    true
  `);
  await waitFor(
    `document.querySelector("#saveState").textContent === "Saved locally"`,
    "quick multi-selection rotation",
  );
  const quickRotatedGeometry = [];
  for (const index of scaledGeometry.keys()) quickRotatedGeometry.push(await readGeometryByLayer(index));
  if (quickRotatedGeometry.some((geometry) => Math.abs(geometry.rotation - 180) > 0.1)) {
    throw new Error(`Quick multi-selection rotation validation failed: ${JSON.stringify(quickRotatedGeometry)}`);
  }
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true })); true`);
  const quickRotationUndo = await readGeometryByLayer(0);
  if (Math.abs(quickRotationUndo.rotation - 90) > 0.1) {
    throw new Error(`Quick multi-selection rotation undo failed: ${JSON.stringify(quickRotationUndo)}`);
  }
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true, bubbles: true })); true`);
  const quickRotationRedo = await readGeometryByLayer(0);
  if (Math.abs(quickRotationRedo.rotation - 180) > 0.1) {
    throw new Error(`Quick multi-selection rotation redo failed: ${JSON.stringify(quickRotationRedo)}`);
  }
  await waitFor(
    `document.querySelector("#saveState").textContent === "Saved locally"`,
    "precision multi-transform history autosave",
  );

  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })); true`);
  await waitFor(
    `document.querySelector('[data-canvas-aid-action="toggle-rulers"]')?.classList.contains("active") &&
     document.querySelector('[data-canvas-aid-action="toggle-guides"]')?.classList.contains("active") &&
     document.querySelector('[data-page-grid-size]')?.value === "16"`,
    "canvas aid inspector",
  );
  await evaluate(`
    (() => {
      const input = document.querySelector("[data-page-grid-size]");
      input.value = "24";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector('[data-canvas-aid-action="toggle-grid-snap"]').click();
      return true;
    })()
  `);
  await waitFor(
    `document.querySelector('[data-page-grid-size]')?.value === "24" &&
     document.querySelector('[data-canvas-aid-action="toggle-grid-snap"]')?.classList.contains("active") &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "custom grid settings",
  );

  const verticalGuideX = canvas.left + canvas.width * 0.34;
  const horizontalGuideY = canvas.top + canvas.height * 0.63;
  await dragPointer(command, {
    x: canvas.left + 10,
    y: canvas.top + canvas.height * 0.72,
  }, {
    x: verticalGuideX,
    y: canvas.top + canvas.height * 0.72,
  });
  await dragPointer(command, {
    x: canvas.left + canvas.width * 0.82,
    y: canvas.top + 10,
  }, {
    x: canvas.left + canvas.width * 0.82,
    y: horizontalGuideY,
  });
  await waitFor(
    `document.querySelectorAll("[data-page-guide-id]").length === 2 &&
     [...document.querySelectorAll(".page-guide-axis")].some((item) => item.textContent === "V") &&
     [...document.querySelectorAll(".page-guide-axis")].some((item) => item.textContent === "H") &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "ruler guide creation",
  );
  const guidePositionsBeforeMove = await evaluate(`Object.fromEntries(
    [...document.querySelectorAll("[data-page-guide-id]")].map((row) => [
      row.querySelector(".page-guide-axis").textContent,
      Number(row.querySelector("[data-page-guide-position]").value)
    ])
  )`);
  await dragPointer(command, {
    x: verticalGuideX,
    y: canvas.top + canvas.height * 0.82,
  }, {
    x: verticalGuideX + 53,
    y: canvas.top + canvas.height * 0.82,
  });
  await waitFor(
    `Math.abs(Number([...document.querySelectorAll("[data-page-guide-id]")]
       .find((row) => row.querySelector(".page-guide-axis")?.textContent === "V")
       ?.querySelector("[data-page-guide-position]")?.value) - ${guidePositionsBeforeMove.V}) > 10`,
    "guide repositioning",
  );
  await dragPointer(command, {
    x: canvas.left + canvas.width * 0.88,
    y: horizontalGuideY,
  }, {
    x: canvas.left + canvas.width * 0.88,
    y: canvas.top + 10,
  });
  await waitFor(
    `document.querySelectorAll("[data-page-guide-id]").length === 1`,
    "guide removal through ruler",
  );
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true })); true`);
  await waitFor(`document.querySelectorAll("[data-page-guide-id]").length === 2`, "guide removal undo");
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true, bubbles: true })); true`);
  await waitFor(
    `document.querySelectorAll("[data-page-guide-id]").length === 1 &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "guide removal redo",
  );

  await command("Page.reload", { ignoreCache: true });
  await waitFor(
    `document.readyState === "complete" &&
     document.querySelector("#currentPageName")?.textContent === "Page 3" &&
     document.querySelectorAll(".layer-row").length === 3 &&
     document.querySelectorAll("[data-page-guide-id]").length === 1 &&
     document.querySelector('[data-page-grid-size]')?.value === "24" &&
     document.querySelector('[data-canvas-aid-action="toggle-grid-snap"]')?.classList.contains("active")`,
    "canvas aid reload persistence",
  );
  const canvasAidState = await evaluate(`({
    guides: document.querySelectorAll("[data-page-guide-id]").length,
    verticalPosition: Number(document.querySelector("[data-page-guide-position]")?.value),
    gridSize: Number(document.querySelector("[data-page-grid-size]")?.value),
    snapToGrid: document.querySelector('[data-canvas-aid-action="toggle-grid-snap"]')?.classList.contains("active"),
    rulersVisible: document.querySelector('[data-canvas-aid-action="toggle-rulers"]')?.classList.contains("active")
  })`);

  const result = await evaluate(`({
    currentPage: document.querySelector("#currentPageName").textContent,
    pageCount: document.querySelectorAll(".page-list-row").length,
    layerCount: document.querySelectorAll(".layer-row").length,
    saved: document.querySelector("#saveState").textContent,
    booleans: [...document.querySelectorAll(".layer-name")].filter((item) => item.textContent === "Subtract").length,
    masks: [...document.querySelectorAll(".layer-name")].filter((item) => item.textContent === "Mask group").length,
    autoLayouts: [...document.querySelectorAll(".layer-composite-role")].filter((item) => item.textContent === "AUTO V").length
  })`);
  result.gradient = paintState.gradient;
  result.shadowBlur = paintState.shadowBlur;
  result.curves = reloadedCurveCount;
  result.layout = layoutState;
  result.documentVersion = storedDocumentVersion;
  result.precisionTransform = {
    movedBy: movedGeometry[0].x - rotatedGeometry[0].x,
    scale: scaledGeometry[0].width / movedGeometry[0].width,
    rotation: quickRotationRedo.rotation
  };
  result.canvasAids = canvasAidState;
  result.distanceInspection = true;
  if (process.env.TSYAIKO_SCREENSHOT) {
    await evaluate(`
      [...document.querySelectorAll(".layer-row")].map((row) => row.dataset.layerId).forEach((id, index) => {
        document.querySelector('[data-layer-id="' + id + '"]')
          .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: index > 0 }));
      });
      true
    `);
    await delay(150);
    const screenshot = await command("Page.captureScreenshot", { format: "png" });
    writeFileSync(process.env.TSYAIKO_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
  }

  await evaluate(`
    document.querySelectorAll(".layer-row")[0]
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.querySelector("#zoomValue").click();
    true
  `);
  await delay(100);
  const duplicateSource = await evaluate(`({
    x: Number(document.querySelector('[data-property="x"]')?.value),
    y: Number(document.querySelector('[data-property="y"]')?.value)
  })`);
  const duplicateStart = {
    x: canvas.left + canvas.width / 2,
    y: canvas.top + canvas.height / 2,
  };
  await dragPointer(command, duplicateStart, {
    x: duplicateStart.x + 120,
    y: duplicateStart.y + 8,
  }, 9);
  await waitFor(
    `document.querySelectorAll(".layer-row").length === 4 &&
     document.querySelector(".layer-row.selected .layer-name")?.textContent.endsWith("copy")`,
    "Alt/Option+Shift drag duplication",
  );
  const firstDragCopy = await evaluate(`({
    x: Number(document.querySelector('[data-property="x"]')?.value),
    y: Number(document.querySelector('[data-property="y"]')?.value)
  })`);
  await evaluate(`
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "d", code: "KeyD", ctrlKey: true, bubbles: true
    }));
    true
  `);
  await waitFor(`document.querySelectorAll(".layer-row").length === 5`, "repeat duplicate transform");
  const repeatedDragCopy = await evaluate(`({
    x: Number(document.querySelector('[data-property="x"]')?.value),
    y: Number(document.querySelector('[data-property="y"]')?.value)
  })`);
  const firstDuplicateOffset = {
    x: firstDragCopy.x - duplicateSource.x,
    y: firstDragCopy.y - duplicateSource.y,
  };
  const repeatedDuplicateOffset = {
    x: repeatedDragCopy.x - firstDragCopy.x,
    y: repeatedDragCopy.y - firstDragCopy.y,
  };
  if (Math.abs(firstDuplicateOffset.x - repeatedDuplicateOffset.x) > 0.2 ||
      Math.abs(firstDuplicateOffset.y - repeatedDuplicateOffset.y) > 0.2) {
    throw new Error(`Repeated duplicate transform validation failed: ${JSON.stringify({
      duplicateSource,
      firstDragCopy,
      repeatedDragCopy,
    })}`);
  }
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true })); true`);
  await waitFor(`document.querySelectorAll(".layer-row").length === 4`, "repeat duplicate undo");
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true })); true`);
  await waitFor(`document.querySelectorAll(".layer-row").length === 3`, "drag duplicate atomic undo");

  await evaluate(`
    (() => {
      const ids = [...document.querySelectorAll(".layer-row")].map((row) => row.dataset.layerId);
      document.querySelector('[data-layer-id="' + ids[0] + '"]')
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      document.querySelector("#zoomValue").click();
      document.querySelector('[data-layer-id="' + ids[1] + '"]')
        .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
      return true;
    })()
  `);
  await delay(100);
  await dragPointer(command, duplicateStart, {
    x: duplicateStart.x + 100,
    y: duplicateStart.y + 6,
  }, 9);
  await waitFor(`document.querySelectorAll(".layer-row").length === 5`, "multi-selection drag duplication");
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true })); true`);
  await waitFor(`document.querySelectorAll(".layer-row").length === 3`, "multi-selection duplicate atomic undo");

  await evaluate(`
    document.querySelectorAll(".layer-row")[0]
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.querySelector("#zoomValue").click();
    true
  `);
  await delay(100);
  await command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: duplicateStart.x,
    y: duplicateStart.y,
    button: "left",
    buttons: 1,
    modifiers: 9,
    clickCount: 1,
  });
  await command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: duplicateStart.x + 90,
    y: duplicateStart.y + 5,
    button: "left",
    buttons: 1,
    modifiers: 9,
  });
  await waitFor(
    `document.querySelector("#designCanvas")?.dataset.duplicateDrag === "true"`,
    "temporary drag duplicate",
  );
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })); true`);
  await waitFor(
    `document.querySelector("#designCanvas")?.dataset.duplicateDrag === "false" &&
     document.querySelectorAll(".layer-row").length === 3`,
    "drag duplicate cancellation cleanup",
  );
  await command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: duplicateStart.x + 90,
    y: duplicateStart.y + 5,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });

  await evaluate(`
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    document.querySelector('[data-canvas-aid-action="toggle-grid-snap"]')?.click();
    true
  `);
  const spacingLayerIds = await evaluate(`
    (() => {
      const ids = [...document.querySelectorAll(".layer-row")].map((row) => row.dataset.layerId);
      const values = [0, 40, 100];
      const setProperty = (property, value) => {
        const input = document.querySelector('[data-property="' + property + '"]');
        input.value = String(value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };
      ids.forEach((id, index) => {
        document.querySelector('[data-layer-id="' + id + '"]')
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        setProperty("x", values[index]);
        setProperty("y", 0);
        setProperty("width", 20);
        setProperty("height", 20);
        setProperty("rotation", 0);
      });
      ids.forEach((id, index) => {
        document.querySelector('[data-layer-id="' + id + '"]')
          .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: index > 0 }));
      });
      document.querySelector("#zoomValue").click();
      document.querySelector('[data-layer-id="' + ids[1] + '"]')
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return ids;
    })()
  `);
  await delay(100);
  const spacingZoom = await evaluate(`Number.parseInt(document.querySelector("#zoomValue").textContent, 10) / 100`);
  const spacingStart = {
    x: canvas.left + canvas.width / 2 - 10 * spacingZoom,
    y: canvas.top + canvas.height / 2,
  };
  const spacingEnd = {
    x: spacingStart.x + 10 * spacingZoom + 3,
    y: spacingStart.y,
  };
  await command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: spacingStart.x,
    y: spacingStart.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: spacingEnd.x,
    y: spacingEnd.y,
    button: "left",
    buttons: 1,
  });
  await waitFor(
    `Number(document.querySelector("#designCanvas")?.dataset.smartSpacingCount) >= 2`,
    "live equal-spacing guides",
  );
  await command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: spacingEnd.x,
    y: spacingEnd.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  const smartSpacingX = await evaluate(`Number(document.querySelector('[data-property="x"]')?.value)`);
  if (Math.abs(smartSpacingX - 50) > 0.2) {
    throw new Error(`Smart spacing snap validation failed: ${JSON.stringify({ spacingLayerIds, spacingZoom, smartSpacingX })}`);
  }
  result.smartDuplication = {
    offset: firstDuplicateOffset,
    repeat: repeatedDuplicateOffset,
    multiSelection: true,
    cancellation: true,
    smartSpacing: smartSpacingX,
  };

  await evaluate(`
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "L", code: "KeyL", shiftKey: true, bubbles: true
    }));
    true
  `);
  await waitFor(
    `document.querySelector("#shapeToolButton")?.dataset.tool === "arrow" &&
     document.querySelector("#designCanvas")?.dataset.cursor === "crosshair"`,
    "Shift+L arrow shortcut",
  );
  const arrowDrawStart = {
    x: canvas.left + canvas.width * 0.24,
    y: canvas.top + canvas.height * 0.25,
  };
  await dragPointer(command, arrowDrawStart, {
    x: arrowDrawStart.x + 90,
    y: arrowDrawStart.y + 35,
  }, 9);
  await waitFor(
    `document.querySelectorAll(".layer-row").length === 4 &&
     document.querySelector(".selection-summary input")?.value === "Arrow" &&
     document.querySelector('[data-property="arrowEnd"]')?.value === "triangle"`,
    "centered constrained arrow drawing",
  );
  const arrowGeometry = await evaluate(`({
    width: Number(document.querySelector('[data-property="width"]')?.value),
    height: Number(document.querySelector('[data-property="height"]')?.value),
    end: document.querySelector('[data-property="arrowEnd"]')?.value,
    zoom: Number.parseInt(document.querySelector("#zoomValue")?.textContent, 10) / 100
  })`);
  const expectedCenteredArrowWidth = Math.hypot(90, 35) * 2 / arrowGeometry.zoom;
  if (Math.abs(arrowGeometry.width - expectedCenteredArrowWidth) > 0.2 ||
      arrowGeometry.height > 1.1 || arrowGeometry.end !== "triangle") {
    throw new Error(`Arrow modifier validation failed: ${JSON.stringify(arrowGeometry)}`);
  }
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true })); true`);
  await waitFor(`document.querySelectorAll(".layer-row").length === 3`, "arrow creation undo");
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true, bubbles: true })); true`);
  await waitFor(
    `document.querySelectorAll(".layer-row").length === 4 &&
     [...document.querySelectorAll(".layer-name")].some((item) => item.textContent === "Arrow")`,
    "arrow creation redo",
  );
  await evaluate(`
    [...document.querySelectorAll(".layer-row")]
      .find((row) => row.querySelector(".layer-name")?.textContent === "Arrow")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", code: "Delete", bubbles: true }));
    true
  `);
  await waitFor(`document.querySelectorAll(".layer-row").length === 3`, "arrow cleanup");

  await evaluate(`document.querySelector("#shapeMenuButton").click(); true`);
  await waitFor(`document.querySelector("#shapeToolMenu")?.hidden === false`, "shape flyout opening");
  await evaluate(`document.querySelector("#shapeMenuButton").click(); true`);
  await waitFor(`document.querySelector("#shapeToolMenu")?.hidden === true`, "shape flyout toggling closed");
  await evaluate(`document.querySelector("#shapeMenuButton").click(); true`);
  await waitFor(`document.querySelector("#shapeToolMenu")?.hidden === false`, "shape flyout reopening");
  await evaluate(`document.querySelector('[data-shape-tool="polygon"]').click(); true`);
  await waitFor(
    `document.querySelector("#shapeToolButton")?.dataset.tool === "polygon" &&
     document.querySelector("#shapeToolMenu")?.hidden === true`,
    "polygon flyout selection",
  );
  const polygonDrawStart = {
    x: canvas.left + canvas.width * 0.38,
    y: canvas.top + canvas.height * 0.25,
  };
  await dragPointer(command, polygonDrawStart, {
    x: polygonDrawStart.x + 92,
    y: polygonDrawStart.y + 54,
  }, 8);
  await waitFor(
    `document.querySelectorAll(".layer-row").length === 4 &&
     document.querySelector(".selection-summary input")?.value === "Polygon" &&
     document.querySelector('[data-property="polygonSides"]')?.value === "3"`,
    "polygon drawing",
  );
  await evaluate(`
    (() => {
      const sides = document.querySelector('[data-property="polygonSides"]');
      const radius = document.querySelector('[data-property="cornerRadius"]:not([disabled])');
      sides.value = "8";
      sides.dispatchEvent(new Event("input", { bubbles: true }));
      radius.value = "6";
      radius.dispatchEvent(new Event("input", { bubbles: true }));
      radius.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
  await waitFor(
    `document.querySelector('[data-property="polygonSides"]')?.value === "8" &&
     Number(document.querySelector('[data-property="cornerRadius"]:not([disabled])')?.value) === 6`,
    "polygon Inspector parameters",
  );
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", code: "Delete", bubbles: true })); true`);
  await waitFor(`document.querySelectorAll(".layer-row").length === 3`, "polygon cleanup");

  await evaluate(`
    document.querySelector("#shapeMenuButton").click();
    document.querySelector('[data-shape-tool="star"]').click();
    true
  `);
  const starDrawStart = {
    x: canvas.left + canvas.width * 0.54,
    y: canvas.top + canvas.height * 0.25,
  };
  await dragPointer(command, starDrawStart, {
    x: starDrawStart.x + 90,
    y: starDrawStart.y + 56,
  }, 8);
  await waitFor(
    `document.querySelectorAll(".layer-row").length === 4 &&
     document.querySelector(".selection-summary input")?.value === "Star" &&
     document.querySelector('[data-property="starPoints"]')?.value === "5" &&
     document.querySelector('[data-property="starInnerRatio"]')?.value === "40"`,
    "star drawing",
  );
  await evaluate(`document.querySelector("#zoomValue").click(); true`);
  await delay(150);
  const starHandleState = await evaluate(`
    (() => {
      const box = document.querySelector("#designCanvas").getBoundingClientRect();
      const zoom = Number.parseInt(document.querySelector("#zoomValue").textContent, 10) / 100;
      const width = Number(document.querySelector('[data-property="width"]')?.value);
      const height = Number(document.querySelector('[data-property="height"]')?.value);
      return {
        centerX: box.left + box.width / 2,
        centerY: box.top + box.height / 2,
        zoom,
        width,
        height
      };
    })()
  `);
  const starCountHandle = {
    x: starHandleState.centerX + starHandleState.width * 0.26 * starHandleState.zoom,
    y: starHandleState.centerY,
  };
  await dragPointer(command, starCountHandle, {
    x: starCountHandle.x + 24,
    y: starCountHandle.y,
  });
  await waitFor(
    `document.querySelector('[data-property="starPoints"]')?.value === "7"`,
    "direct star point-count handle",
  );
  const starAngle = -Math.PI / 2 + Math.PI / 7;
  const starInnerStart = {
    x: starHandleState.centerX + Math.cos(starAngle) * starHandleState.width / 2 * 0.4 * starHandleState.zoom,
    y: starHandleState.centerY + Math.sin(starAngle) * starHandleState.height / 2 * 0.4 * starHandleState.zoom,
  };
  const starInnerEnd = {
    x: starHandleState.centerX + Math.cos(starAngle) * starHandleState.width / 2 * 0.7 * starHandleState.zoom,
    y: starHandleState.centerY + Math.sin(starAngle) * starHandleState.height / 2 * 0.7 * starHandleState.zoom,
  };
  await dragPointer(command, starInnerStart, starInnerEnd);
  await waitFor(
    `Math.abs(Number(document.querySelector('[data-property="starInnerRatio"]')?.value) - 70) <= 1`,
    "direct star inner-ratio handle",
  );
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true })); true`);
  await waitFor(
    `document.querySelector('[data-property="starInnerRatio"]')?.value === "40"`,
    "star handle undo",
  );
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true, bubbles: true })); true`);
  await waitFor(
    `Math.abs(Number(document.querySelector('[data-property="starInnerRatio"]')?.value) - 70) <= 1`,
    "star handle redo",
  );
  result.parametricShapes = {
    arrowModifiers: arrowGeometry,
    polygonSides: 8,
    starPoints: 7,
    starInnerRatio: Number(await evaluate(`document.querySelector('[data-property="starInnerRatio"]')?.value`)),
    exportParity: svgPaintExport.parametricExport,
  };
  if (shapeScreenshotPath) {
    const screenshot = await command("Page.captureScreenshot", { format: "png" });
    writeFileSync(shapeScreenshotPath, Buffer.from(screenshot.data, "base64"));
  }
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", code: "Delete", bubbles: true })); true`);
  await waitFor(`document.querySelectorAll(".layer-row").length === 3`, "star cleanup");

  const hostedCreateResponse = await fetch(`http://127.0.0.1:${serverPort}/v1/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Browser hosted file",
      document: {
        version: 10,
        id: "document_hosted_smoke",
        name: "Hosted smoke",
        background: "#101114",
        components: [],
        componentSets: [],
        pages: [{
          id: "page_hosted_smoke",
          name: "Hosted page",
          background: "#101114",
          nodes: [],
        }],
      },
    }),
  });
  if (!hostedCreateResponse.ok) {
    throw new Error(`Hosted file creation failed with ${hostedCreateResponse.status}.`);
  }
  const hostedFile = await hostedCreateResponse.json();
  await command("Page.navigate", {
    url: `http://127.0.0.1:${serverPort}/?file=${hostedFile.id}`,
  });
  await waitFor(
    `document.readyState === "complete" &&
     document.querySelector("#documentTitle")?.value === "Hosted smoke" &&
     document.querySelector("#saveState")?.textContent.startsWith("Hosted · revision 1")`,
    "hosted file load",
  );
  await evaluate(`
    (() => {
      const title = document.querySelector("#documentTitle");
      title.value = "Hosted smoke updated";
      title.dispatchEvent(new Event("input", { bubbles: true }));
      title.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
  await waitFor(
    `document.querySelector("#saveState")?.textContent.startsWith("Hosted · revision 2")`,
    "hosted revision autosave",
  );
  const hostedReload = await fetch(`http://127.0.0.1:${serverPort}/v1/files/${hostedFile.id}`);
  const hostedSavedFile = await hostedReload.json();
  if (!hostedReload.ok || hostedSavedFile.document?.name !== "Hosted smoke updated" || hostedSavedFile.revision !== 2) {
    throw new Error(`Hosted autosave verification failed: ${JSON.stringify(hostedSavedFile)}`);
  }
  hostedSavedFile.document.name = "Remote collaborator update";
  const remoteUpdate = await fetch(`http://127.0.0.1:${serverPort}/v1/files/${hostedFile.id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "If-Match": `"${hostedSavedFile.revision}"`,
      "X-Tsyaiko-Client": "browser-smoke-remote",
    },
    body: JSON.stringify({ document: hostedSavedFile.document }),
  });
  if (!remoteUpdate.ok) {
    throw new Error(`Remote collaborator update failed with ${remoteUpdate.status}.`);
  }
  await waitFor(
    `document.querySelector("#documentTitle")?.value === "Remote collaborator update" &&
     document.querySelector("#saveState")?.textContent.startsWith("Hosted · revision 3")`,
    "live hosted revision update",
  );
  result.hostedRevision = 3;
  process.stdout.write(`Browser smoke test passed: ${JSON.stringify(result)}\n`);
} finally {
  socket?.close();
  terminateProcess(browser);
  terminateProcess(server);
  rmSync(profileDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

function findChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find(existsSync) ?? "chromium";
}

async function connectToTarget(webSocketURL) {
  const targetSocket = new WebSocket(webSocketURL);
  await new Promise((resolve, reject) => {
    targetSocket.addEventListener("open", resolve, { once: true });
    targetSocket.addEventListener("error", reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  targetSocket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(message.error.message));
    else handler.resolve(message.result);
  });

  function command(method, params = {}) {
    const id = ++nextId;
    targetSocket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  async function evaluate(expression) {
    const response = await command("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    }
    return response.result.value;
  }

  async function waitFor(expression, label) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(expression)) return;
      } catch {
        // Page reloads briefly invalidate the JavaScript execution context.
      }
      await delay(75);
    }
    throw new Error(`Timed out while waiting for ${label}.`);
  }

  return { socket: targetSocket, command, evaluate, waitFor };
}

async function waitForHTTP(url, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The process may still be compiling or binding its port.
    }
    await delay(100);
  }
  throw new Error(`Timed out while waiting for ${label}.`);
}

async function waitForJSON(url, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Chromium may still be initializing its debugging endpoint.
    }
    await delay(100);
  }
  throw new Error(`Timed out while waiting for ${label}.`);
}

async function dispatchClick(command, point, modifiers = 0, clickCount = 1) {
  await command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    modifiers,
    clickCount,
  });
  await command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    modifiers,
    clickCount,
  });
}

async function dragPointer(command, start, end, modifiers = 0) {
  await command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: start.x,
    y: start.y,
    button: "left",
    buttons: 1,
    modifiers,
    clickCount: 1,
  });
  await command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: end.x,
    y: end.y,
    button: "left",
    buttons: 1,
    modifiers,
  });
  await command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: end.x,
    y: end.y,
    button: "left",
    buttons: 0,
    modifiers,
    clickCount: 1,
  });
}

function terminateProcess(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill();
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
