export const MAX_ASSET_BYTES = 15 * 1024 * 1024;
export const MAX_DOCUMENT_ASSET_BYTES = 100 * 1024 * 1024;

export async function registerAsset(document, data, options = {}) {
  const mimeType = assetMimeType(data);
  const bytes = assetDataBytes(data);
  if (!bytes.length || bytes.length > MAX_ASSET_BYTES) {
    throw new Error("Assets must be supported images or WOFF fonts no larger than 15 MB.");
  }
  const hash = await sha256Hex(bytes);
  document.assets ??= [];
  const existing = document.assets.find((asset) => asset.hash === hash);
  if (existing) return existing;
  const currentBytes = document.assets.reduce((total, asset) => total + (asset.bytes || 0), 0);
  if (currentBytes + bytes.length > MAX_DOCUMENT_ASSET_BYTES) {
    throw new Error("This document has reached its 100 MB embedded asset quota.");
  }
  const asset = {
    id: `asset_${hash}`,
    hash,
    kind: isFontMimeType(mimeType) ? "font" : "image",
    mimeType,
    name: String(options.name || (isFontMimeType(mimeType) ? "Font" : "Image")).slice(0, 200),
    bytes: bytes.length,
    data,
    createdAt: new Date().toISOString(),
  };
  if (asset.kind === "font") {
    asset.fontFamily = String(options.fontFamily || asset.name.replace(/\.(?:woff2?|ttf|otf)$/i, "") || "Embedded font").slice(0, 200);
    asset.fontWeight = Math.max(100, Math.min(900, Number.parseInt(options.fontWeight, 10) || 400));
    asset.fontStyle = options.fontStyle === "italic" ? "italic" : "normal";
  }
  document.assets.push(asset);
  return asset;
}

export async function repairDocumentAssets(document) {
  const sourceAssets = Array.isArray(document?.assets) ? document.assets : [];
  const repaired = [];
  const byHash = new Map();
  const remappedIDs = new Map();
  let totalBytes = 0;
  let removed = 0;
  let deduplicated = 0;
  let migrated = 0;

  for (const source of sourceAssets) {
    const bytes = assetDataBytes(source.data);
    if (!bytes.length || bytes.length > MAX_ASSET_BYTES) {
      removed += 1;
      continue;
    }
    const hash = await sha256Hex(bytes);
    const existing = byHash.get(hash);
    if (existing) {
      remappedIDs.set(source.id, existing.id);
      deduplicated += 1;
      continue;
    }
    if (totalBytes + bytes.length > MAX_DOCUMENT_ASSET_BYTES) {
      removed += 1;
      continue;
    }
    const id = `asset_${hash}`;
    const mimeType = assetMimeType(source.data);
    const kind = isFontMimeType(mimeType) ? "font" : "image";
    const asset = {
      id,
      hash,
      kind,
      mimeType,
      name: String(source.name || (kind === "font" ? "Font" : "Image")).slice(0, 200),
      bytes: bytes.length,
      data: source.data,
      createdAt: source.createdAt || new Date().toISOString(),
    };
    if (kind === "font") {
      asset.fontFamily = String(source.fontFamily || asset.name.replace(/\.(?:woff2?)$/i, "") || "Embedded font").slice(0, 200);
      asset.fontWeight = Math.max(100, Math.min(900, Number.parseInt(source.fontWeight, 10) || 400));
      asset.fontStyle = source.fontStyle === "italic" ? "italic" : "normal";
    }
    repaired.push(asset);
    byHash.set(hash, asset);
    remappedIDs.set(source.id, id);
    totalBytes += bytes.length;
  }

  const migrateInlineImage = async (holder, name) => {
    if (!holder?.imageData) return;
    const data = holder.imageData;
    holder.imageData = "";
    const bytes = assetDataBytes(data);
    if (!bytes.length || bytes.length > MAX_ASSET_BYTES) {
      holder.assetId = null;
      removed += 1;
      return;
    }
    const hash = await sha256Hex(bytes);
    let asset = byHash.get(hash);
    if (!asset) {
      if (totalBytes + bytes.length > MAX_DOCUMENT_ASSET_BYTES) {
        holder.assetId = null;
        removed += 1;
        return;
      }
      asset = {
        id: `asset_${hash}`,
        hash,
        kind: "image",
        mimeType: assetMimeType(data),
        name: String(name || "Image").slice(0, 200),
        bytes: bytes.length,
        data,
        createdAt: new Date().toISOString(),
      };
      repaired.push(asset);
      byHash.set(hash, asset);
      totalBytes += bytes.length;
    } else {
      deduplicated += 1;
    }
    remappedIDs.set(asset.id, asset.id);
    holder.assetId = asset.id;
    migrated += 1;
  };

  for (const page of document.pages ?? []) {
    for (const node of page.nodes ?? []) {
      await migrateInlineImage(node, node.name);
      for (const properties of Object.values(node.componentOverrides ?? {})) {
        if (properties && typeof properties === "object") {
          await migrateInlineImage(properties, `${node.name || "Image"} override`);
        }
      }
    }
  }

  document.assets = repaired;
  for (const page of document.pages ?? []) {
    for (const node of page.nodes ?? []) remapNodeAssets(node, remappedIDs);
  }
  return {
    assets: repaired.length,
    bytes: totalBytes,
    removed,
    deduplicated,
    migrated,
    changed: migrated > 0 || removed > 0 || deduplicated > 0 || sourceAssets.some((asset) => remappedIDs.get(asset.id) !== asset.id),
  };
}

export function resolveAssetData(document, nodeOrID) {
  const id = typeof nodeOrID === "string" ? nodeOrID : nodeOrID?.assetId;
  if (!id) return typeof nodeOrID === "object" ? nodeOrID.imageData ?? "" : "";
  return document.assets?.find((asset) => asset.id === id)?.data ??
    (typeof nodeOrID === "object" ? nodeOrID.imageData ?? "" : "");
}

export function resolvePageAssets(document, page) {
  return {
    ...page,
    nodes: page.nodes.map((node) => node.type === "image"
      ? { ...node, imageData: resolveAssetData(document, node) }
      : node),
  };
}

export function collectAssetUsage(document) {
  const references = new Map((document.assets ?? []).map((asset) => [asset.id, 0]));
  for (const page of document.pages ?? []) {
    for (const node of page.nodes ?? []) {
      for (const id of nodeAssetReferences(node)) {
        if (references.has(id)) references.set(id, references.get(id) + 1);
      }
    }
  }
  return (document.assets ?? []).map((asset) => ({
    ...asset,
    references: references.get(asset.id) ?? 0,
  }));
}

export function removeUnusedAssets(document) {
  const used = new Set((document.pages ?? []).flatMap((page) =>
    page.nodes.flatMap(nodeAssetReferences)));
  const previous = document.assets?.length ?? 0;
  document.assets = (document.assets ?? []).filter((asset) => used.has(asset.id));
  return previous - document.assets.length;
}

export function assetDataBytes(data) {
  if (!assetMimeType(data)) {
    return new Uint8Array();
  }
  const encoded = data.slice(data.indexOf(",") + 1).replace(/\s/g, "");
  try {
    const binary = typeof atob === "function"
      ? atob(encoded)
      : globalThis.Buffer.from(encoded, "base64").toString("binary");
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

function assetMimeType(data) {
  if (typeof data !== "string") return "";
  const mimeType = /^data:([^;,]+);base64,/i.exec(data)?.[1]?.toLowerCase() ?? "";
  return [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "font/woff",
    "font/woff2",
    "application/font-woff",
    "application/font-woff2",
  ].includes(mimeType) ? mimeType : "";
}

function isFontMimeType(mimeType) {
  return mimeType.startsWith("font/") || mimeType.includes("font-woff");
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function remapNodeAssets(node, remappedIDs) {
  if ("assetId" in node) node.assetId = remapAssetID(node.assetId, remappedIDs);
  if ("fontRef" in node) node.fontRef = remapAssetID(node.fontRef, remappedIDs);
  for (const run of node.textRuns ?? []) {
    run.fontRef = remapAssetID(run.fontRef, remappedIDs);
  }
  for (const properties of Object.values(node.componentOverrides ?? {})) {
    if (!properties || typeof properties !== "object") continue;
    if ("assetId" in properties) properties.assetId = remapAssetID(properties.assetId, remappedIDs);
    if ("fontRef" in properties) properties.fontRef = remapAssetID(properties.fontRef, remappedIDs);
    for (const run of properties.textRuns ?? []) {
      run.fontRef = remapAssetID(run.fontRef, remappedIDs);
    }
  }
}

function remapAssetID(id, remappedIDs) {
  if (!id) return null;
  return remappedIDs.get(id) ?? null;
}

function nodeAssetReferences(node) {
  const references = [
    node.assetId,
    node.fontRef,
    ...(node.textRuns ?? []).map((run) => run.fontRef),
  ];
  for (const properties of Object.values(node.componentOverrides ?? {})) {
    if (!properties || typeof properties !== "object") continue;
    references.push(
      properties.assetId,
      properties.fontRef,
      ...(properties.textRuns ?? []).map((run) => run.fontRef),
    );
  }
  return references.filter(Boolean);
}
