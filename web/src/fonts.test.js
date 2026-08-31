import test from "node:test";
import assert from "node:assert/strict";

import { documentFontFamilies, loadDocumentFonts } from "./fonts.js";

test("embedded font records are discoverable without browser font APIs", async () => {
  const document = { assets: [{ kind: "font", hash: "font", fontFamily: "Studio Sans" }] };
  assert.deepEqual(documentFontFamilies(document), ["Studio Sans"]);
  const results = await loadDocumentFonts(document);
  assert.equal(results[0].status, "unsupported");
});
