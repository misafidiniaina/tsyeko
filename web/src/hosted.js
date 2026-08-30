const HOSTED_FILE_PATTERN = /^file_[0-9a-f]{24}$/;

export class HostedFileError extends Error {
  constructor(message, code, status, currentRevision = null) {
    super(message);
    this.name = "HostedFileError";
    this.code = code;
    this.status = status;
    this.currentRevision = currentRevision;
  }
}

export function requestedHostedFileId(location = globalThis.location) {
  const id = new URLSearchParams(location?.search ?? "").get("file") ?? "";
  return HOSTED_FILE_PATTERN.test(id) ? id : null;
}

export async function loadHostedFile(id, fetchImplementation = globalThis.fetch) {
  const response = await fetchImplementation(`/v1/files/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const body = await readJSON(response);
  if (!response.ok) throw responseError(response, body, "Could not load the hosted file.");
  return body;
}

export async function saveHostedFile(id, revision, document, fetchImplementation = globalThis.fetch) {
  const response = await fetchImplementation(`/v1/files/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "If-Match": `"${revision}"`,
    },
    body: JSON.stringify({ document }),
  });
  const body = await readJSON(response);
  if (!response.ok) throw responseError(response, body, "Could not save the hosted file.");
  return body;
}

async function readJSON(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function responseError(response, body, fallback) {
  return new HostedFileError(
    body?.error?.message ?? fallback,
    body?.error?.code ?? "hosted_request_failed",
    response.status,
    body?.currentRevision ?? null,
  );
}
