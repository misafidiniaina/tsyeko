import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkspace, saveWorkspace } from "./persistence.js";

test("loads a v12 recovery copy and promotes it to the v13 key on save", async (context) => {
  const entries = new Map();
  const localStorage = {
    getItem(key) {
      return entries.get(key) ?? null;
    },
    setItem(key, value) {
      entries.set(key, String(value));
    },
    removeItem(key) {
      entries.delete(key);
    },
  };
  const workspace = { document: { version: 12, name: "Recovered file" } };
  localStorage.setItem("tsyaiko.workspace.v12", JSON.stringify(workspace));

  replaceGlobal(context, "indexedDB", undefined);
  replaceGlobal(context, "localStorage", localStorage);

  assert.deepEqual(await loadWorkspace(), workspace);
  assert.deepEqual(await saveWorkspace(workspace), { backend: "localStorage" });
  assert.deepEqual(JSON.parse(localStorage.getItem("tsyaiko.workspace.v13")), workspace);
  assert.equal(localStorage.getItem("tsyaiko.workspace.v12"), null);
});

function replaceGlobal(context, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  context.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  });
}
