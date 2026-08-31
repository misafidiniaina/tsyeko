import test from "node:test";
import assert from "node:assert/strict";

import { applyDocumentCommand, createDocumentCommand, DocumentHistory } from "./history.js";

test("structural edits are stored as reversible splice commands", () => {
  const before = { pages: [{ id: "page", nodes: [{ id: "a", x: 1 }, { id: "b", x: 2 }] }] };
  const after = { pages: [{ id: "page", nodes: [{ id: "a", x: 4 }, { id: "c", x: 3 }, { id: "b", x: 2 }] }] };
  const command = createDocumentCommand(before, after, "Insert layer");
  assert.equal(command.label, "Insert layer");
  assert.ok(command.forward.some((operation) => operation.op === "splice"));
  assert.deepEqual(applyDocumentCommand(before, command), after);
  assert.deepEqual(applyDocumentCommand(after, command, "reverse"), before);
});

test("history exposes undo and redo labels without snapshotting the full document", () => {
  const history = new DocumentHistory({ id: "document", pages: [] });
  history.commit({ id: "document", name: "Named", pages: [] }, "Rename document");
  assert.equal(history.undoLabel, "Rename document");
  assert.ok(history.commands[0].forward.every((operation) => operation.path.length > 0));
  history.undo();
  assert.equal(history.redoLabel, "Rename document");
});

test("command history round-trips randomized structural and property edits", () => {
  let seed = 0xc0decafe;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  let document = { id: "document", name: "Fuzz", pages: [{ id: "page", nodes: [] }] };
  const history = new DocumentHistory(document, 200);
  const states = [structuredClone(document)];

  for (let step = 0; step < 120; step += 1) {
    document = structuredClone(document);
    const nodes = document.pages[0].nodes;
    const operation = nodes.length ? Math.floor(random() * 4) : 0;
    if (operation === 0) {
      const index = Math.floor(random() * (nodes.length + 1));
      nodes.splice(index, 0, {
        id: `node_${step}`,
        x: Math.round(random() * 1_000),
        fills: [{ id: `paint_${step}`, color: "#ffffff", opacity: 1 }],
      });
    } else if (operation === 1) {
      nodes[Math.floor(random() * nodes.length)].x += 1 + Math.floor(random() * 20);
    } else if (operation === 2 && nodes.length > 1) {
      const [node] = nodes.splice(Math.floor(random() * nodes.length), 1);
      nodes.splice(Math.floor(random() * (nodes.length + 1)), 0, node);
    } else {
      nodes.splice(Math.floor(random() * nodes.length), 1);
    }
    if (!history.commit(document, `Step ${step}`)) {
      step -= 1;
      continue;
    }
    states.push(structuredClone(document));
  }

  for (let index = states.length - 2; index >= 0; index -= 1) {
    assert.deepEqual(history.undo(), states[index]);
  }
  for (let index = 1; index < states.length; index += 1) {
    assert.deepEqual(history.redo(), states[index]);
  }

  history.undo();
  document = structuredClone(history.current);
  document.name = "Branched";
  history.commit(document, "Branch");
  assert.equal(history.canRedo, false);
});
