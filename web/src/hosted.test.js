import test from "node:test";
import assert from "node:assert/strict";

import {
  HostedFileError,
  loadHostedFile,
  requestedHostedFileId,
  saveHostedFile,
} from "./hosted.js";

const fileId = "file_0123456789abcdef01234567";

test("hosted file IDs are accepted only from a safe query parameter", () => {
  assert.equal(requestedHostedFileId({ search: `?file=${fileId}` }), fileId);
  assert.equal(requestedHostedFileId({ search: "?file=../../etc/passwd" }), null);
  assert.equal(requestedHostedFileId({ search: "" }), null);
});

test("hosted snapshots load and save with revision preconditions", async () => {
  const requests = [];
  const fetchImplementation = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "PATCH") {
      return new Response(JSON.stringify({ id: fileId, revision: 3, document: { version: 10, pages: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ id: fileId, revision: 2, document: { version: 10, pages: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const loaded = await loadHostedFile(fileId, fetchImplementation);
  assert.equal(loaded.revision, 2);
  const saved = await saveHostedFile(fileId, loaded.revision, loaded.document, fetchImplementation);
  assert.equal(saved.revision, 3);
  assert.equal(requests[1].options.headers["If-Match"], `"2"`);
  assert.deepEqual(JSON.parse(requests[1].options.body).document, loaded.document);
});

test("hosted revision conflicts expose the current server revision", async () => {
  const fetchImplementation = async () => new Response(JSON.stringify({
    error: { code: "revision_conflict", message: "Newer revision" },
    currentRevision: 7,
  }), {
    status: 409,
    headers: { "Content-Type": "application/json" },
  });

  await assert.rejects(
    saveHostedFile(fileId, 2, { version: 10, pages: [] }, fetchImplementation),
    (error) => error instanceof HostedFileError &&
      error.code === "revision_conflict" && error.currentRevision === 7,
  );
});
