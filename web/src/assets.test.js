import test from "node:test";
import assert from "node:assert/strict";

import { createEmptyDocument, createNode, NODE_TYPES, normalizeDocument } from "./model.js";
import {
  collectAssetUsage,
  repairDocumentAssets,
  registerAsset,
  removeUnusedAssets,
  resolveAssetData,
} from "./assets.js";

const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";

test("content-addressed assets deduplicate and track references", async () => {
  const document = createEmptyDocument();
  const first = await registerAsset(document, pixel, { name: "Pixel" });
  const second = await registerAsset(document, pixel, { name: "Duplicate" });
  assert.equal(first.id, second.id);
  assert.equal(document.assets.length, 1);
  assert.match(first.hash, /^[a-f\d]{64}$/);

  const node = createNode(NODE_TYPES.IMAGE, 0, 0, { assetId: first.id });
  document.pages[0].nodes.push(node);
  assert.equal(resolveAssetData(document, node), pixel);
  assert.equal(collectAssetUsage(document)[0].references, 1);
  document.pages[0].nodes = [];
  assert.equal(removeUnusedAssets(document), 1);
});

test("asset repair verifies hashes, canonicalizes ids, and remaps references", async () => {
  const document = createEmptyDocument();
  const claimedID = `asset_${"0".repeat(64)}`;
  document.assets = [{
    id: claimedID,
    hash: "0".repeat(64),
    kind: "image",
    name: "Unverified.png",
    data: pixel,
  }];
  const node = createNode(NODE_TYPES.IMAGE, 0, 0, { assetId: claimedID });
  document.pages[0].nodes.push(node);
  const result = await repairDocumentAssets(document);
  assert.equal(result.changed, true);
  assert.notEqual(document.assets[0].id, claimedID);
  assert.equal(node.assetId, document.assets[0].id);
  assert.equal(document.assets[0].id, `asset_${document.assets[0].hash}`);
});

test("asset repair deduplicates font references without polluting unrelated nodes", async () => {
  const document = createEmptyDocument();
  const fontData = "data:font/woff2;base64,d09GRg==";
  document.assets = [
    { id: "old_font_a", kind: "font", name: "Studio A", fontFamily: "Studio", data: fontData },
    { id: "old_font_b", kind: "font", name: "Studio B", fontFamily: "Studio", data: fontData },
  ];
  const rectangle = createNode(NODE_TYPES.RECTANGLE, 0, 0);
  const text = createNode(NODE_TYPES.TEXT, 0, 0, {
    text: "Font",
    fontRef: "old_font_b",
    textRuns: [{ start: 0, end: 4, fontRef: "old_font_a" }],
    componentOverrides: {
      source_text: { fontRef: "old_font_b", textRuns: [{ start: 0, end: 4, fontRef: "old_font_a" }] },
    },
  });
  document.pages[0].nodes.push(rectangle, text);

  const result = await repairDocumentAssets(document);
  const canonicalID = document.assets[0].id;
  assert.equal(result.deduplicated, 1);
  assert.equal(document.assets.length, 1);
  assert.equal(text.fontRef, canonicalID);
  assert.equal(text.textRuns[0].fontRef, canonicalID);
  assert.equal(text.componentOverrides.source_text.fontRef, canonicalID);
  assert.equal(text.componentOverrides.source_text.textRuns[0].fontRef, canonicalID);
  assert.equal(collectAssetUsage(document)[0].references, 4);
  assert.equal(removeUnusedAssets(document), 0);
  assert.equal("assetId" in rectangle, false);
  assert.equal("fontRef" in rectangle, false);
});

test("normalization does not trust claimed hashes when distinct assets collide", async () => {
  const claimedHash = "a".repeat(64);
  const document = normalizeDocument({
    version: 11,
    pages: [{ id: "page", name: "Page", nodes: [] }],
    assets: [
      { id: "claimed_a", hash: claimedHash, kind: "image", data: pixel },
      { id: "claimed_b", hash: claimedHash, kind: "image", data: "data:image/png;base64,aGVsbG8=" },
    ],
  });
  assert.equal(document.assets.length, 2);
  await repairDocumentAssets(document);
  assert.equal(document.assets.length, 2);
  assert.notEqual(document.assets[0].hash, document.assets[1].hash);
});

test("legacy inline images migrate into dedicated content-addressed records", async () => {
  const document = normalizeDocument({
    version: 10,
    pages: [{
      id: "page",
      name: "Legacy",
      nodes: [{ id: "image", type: "image", name: "Legacy pixel", imageData: pixel }],
    }],
  });
  const node = document.pages[0].nodes[0];
  assert.equal(document.assets.length, 0);
  assert.equal(node.imageData, pixel);

  const result = await repairDocumentAssets(document);
  assert.equal(result.migrated, 1);
  assert.equal(document.assets.length, 1);
  assert.equal(node.imageData, "");
  assert.equal(node.assetId, document.assets[0].id);
  assert.equal(resolveAssetData(document, node), pixel);
});

test("font assets share quotas and count base and rich-text references", async () => {
  const document = createEmptyDocument();
  const font = await registerAsset(document, "data:font/woff2;base64,d09GRg==", {
    kind: "font",
    name: "Studio.woff2",
    fontFamily: "Studio",
  });
  document.pages[0].nodes.push(createNode(NODE_TYPES.TEXT, 0, 0, {
    text: "Typeface",
    fontFamily: "Studio",
    fontRef: font.id,
    textRuns: [{ start: 0, end: 4, fontFamily: "Studio", fontRef: font.id }],
  }));
  assert.equal(font.kind, "font");
  assert.equal(font.fontFamily, "Studio");
  assert.equal(collectAssetUsage(document)[0].references, 2);
  assert.equal(removeUnusedAssets(document), 0);
});
