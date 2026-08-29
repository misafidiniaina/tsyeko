import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPort = Number.parseInt(process.env.TSYAIKO_TEST_PORT || "8091", 10);
const debugPort = Number.parseInt(process.env.TSYAIKO_CDP_PORT || "9225", 10);
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
    `document.readyState === "complete" && document.querySelectorAll(".layer-row").length === 10`,
    "starter document",
  );

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
     document.querySelectorAll(".layer-row").length === 10`,
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
    `document.querySelectorAll(".layer-row").length === 2 &&
     document.querySelector(".selection-summary input")?.value === "smoke-image" &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "image import and IndexedDB autosave",
  );

  await evaluate(`
    (() => {
      document.querySelectorAll(".layer-row")[0]
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      document.querySelectorAll(".layer-row")[1]
        .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
      return true;
    })()
  `);
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
    `document.querySelectorAll(".layer-row").length === 3 &&
     document.querySelectorAll('.layer-row[style*="--layer-depth: 1"]').length === 2 &&
     document.querySelector(".selection-summary input")?.value === "Group" &&
     document.querySelector("#saveState").textContent === "Saved locally"`,
    "keyboard grouping and nested layers",
  );

  await evaluate(`document.querySelector('[data-layer-action="collapse"]').click(); true`);
  await waitFor(`document.querySelectorAll(".layer-row").length === 1`, "collapsed group");
  await evaluate(`document.querySelector('[data-layer-action="collapse"]').click(); true`);
  await waitFor(`document.querySelectorAll(".layer-row").length === 3`, "expanded group");

  await command("Page.reload", { ignoreCache: true });
  await waitFor(
    `document.readyState === "complete" &&
     document.querySelector("#currentPageName")?.textContent === "Page 2" &&
     document.querySelectorAll(".page-list-row").length === 2 &&
     document.querySelectorAll(".layer-row").length === 3 &&
     document.querySelectorAll('.layer-row[style*="--layer-depth: 1"]').length === 2`,
    "hierarchical multi-page reload persistence",
  );

  const result = await evaluate(`({
    currentPage: document.querySelector("#currentPageName").textContent,
    pageCount: document.querySelectorAll(".page-list-row").length,
    layerCount: document.querySelectorAll(".layer-row").length,
    saved: document.querySelector("#saveState").textContent
  })`);
  if (process.env.TSYAIKO_SCREENSHOT) {
    const screenshot = await command("Page.captureScreenshot", { format: "png" });
    writeFileSync(process.env.TSYAIKO_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
  }
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
