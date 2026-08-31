import test from "node:test";
import assert from "node:assert/strict";

import { createNode, NODE_TYPES } from "./model.js";
import {
  estimateTextWidth,
  intrinsicTextSize,
  layoutRichText,
  measureTextWidth,
  rebaseTextRuns,
} from "./text.js";

test("text metrics share one deterministic measurement pipeline", () => {
  const style = {
    fontFamily: "sans-serif",
    fontSize: 20,
    fontWeight: 600,
    fontStyle: "normal",
    letterSpacing: 1,
  };
  assert.equal(measureTextWidth("Design", style), measureTextWidth("Design", style));
  assert.ok(estimateTextWidth("WWW", 20) > estimateTextWidth("iii", 20));
});

test("rich text layout preserves run styles while wrapping long words", () => {
  const node = createNode(NODE_TYPES.TEXT, 0, 0, {
    width: 45,
    text: "Supercalifragilistic",
    fontSize: 16,
    textRuns: [{ start: 0, end: 5, fontWeight: 700, fill: "#ff0000" }],
  });
  const lines = layoutRichText(node, node.width);
  assert.ok(lines.length > 1);
  assert.equal(lines[0].fragments[0].style.fontWeight, 700);
  assert.equal(lines.map((line) => line.text).join(""), node.text);
  const intrinsic = intrinsicTextSize(node, node.width);
  assert.equal(intrinsic.richLines.length, lines.length);
  assert.ok(intrinsic.height > node.fontSize);
});

test("rich text ranges follow insertions, replacements, and deletions", () => {
  const runs = [
    { start: 0, end: 5, fontWeight: 700 },
    { start: 6, end: 11, fontStyle: "italic" },
  ];
  assert.deepEqual(
    rebaseTextRuns(runs, "hello world", "hello vivid world"),
    [
      { start: 0, end: 5, fontWeight: 700 },
      { start: 12, end: 17, fontStyle: "italic" },
    ],
  );
  assert.deepEqual(
    rebaseTextRuns(runs, "hello world", "hey world"),
    [
      { start: 0, end: 3, fontWeight: 700 },
      { start: 4, end: 9, fontStyle: "italic" },
    ],
  );
  assert.deepEqual(
    rebaseTextRuns([{ start: 0, end: 11, fill: "#f00" }], "hello world", "hello editor"),
    [{ start: 0, end: 12, fill: "#f00" }],
  );
});
