import {
  getAncestors,
  getDocumentBounds,
  getEffectiveOpacity,
  getNodesWithDescendants,
  isNodeEffectivelyVisible,
  NODE_TYPES,
} from "./model.js";

export function documentToSVG(document, ids = null) {
  const bounds = getDocumentBounds(document, ids);
  const idSet = ids
    ? new Set(getNodesWithDescendants(document, ids).map((node) => node.id))
    : null;
  const nodes = document.nodes.filter(
    (node) => node.type !== NODE_TYPES.GROUP && isNodeEffectivelyVisible(document, node) && (!idSet || idSet.has(node.id)),
  );
  const width = Math.max(1, Math.ceil(bounds.width));
  const height = Math.max(1, Math.ceil(bounds.height));
  const frameIds = new Set(nodes.flatMap((node) =>
    getAncestors(document, node)
      .filter((ancestor) => ancestor.type === NODE_TYPES.FRAME)
      .map((ancestor) => ancestor.id),
  ));
  const frameClips = document.nodes
    .filter((node) => frameIds.has(node.id))
    .map(frameClipToSVG)
    .join("");
  const body = nodes.map((node) => {
    let output = nodeToSVG(node, getEffectiveOpacity(document, node));
    for (const frame of getAncestors(document, node).filter((ancestor) => ancestor.type === NODE_TYPES.FRAME)) {
      output = `<g clip-path="url(#frame-clip-${safeId(frame.id)})">${output}</g>`;
    }
    return output;
  }).join("\n  ");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${round(bounds.x)} ${round(bounds.y)} ${round(bounds.width)} ${round(bounds.height)}">`,
    `  <title>${escapeXML(document.name)}</title>`,
    frameClips ? `  <defs>${frameClips}</defs>` : "",
    `  ${body}`,
    `</svg>`,
  ].join("\n");
}

export function downloadBlob(content, filename, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function safeFilename(name, extension) {
  const base = (name || "untitled-design")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "untitled-design";
  return `${base}.${extension}`;
}

function nodeToSVG(node, opacity = node.opacity) {
  const common = [
    `opacity="${round(opacity)}"`,
    `transform="rotate(${round(node.rotation)} ${round(node.x + node.width / 2)} ${round(node.y + node.height / 2)})"`,
  ].join(" ");
  const paint = `fill="${escapeXML(node.fill)}" stroke="${escapeXML(node.stroke)}" stroke-width="${round(node.strokeWidth)}"`;

  if (node.type === NODE_TYPES.ELLIPSE) {
    return `<ellipse cx="${round(node.x + node.width / 2)}" cy="${round(node.y + node.height / 2)}" rx="${round(node.width / 2)}" ry="${round(node.height / 2)}" ${paint} ${common} />`;
  }

  if (node.type === NODE_TYPES.IMAGE) {
    const radius = Math.min(node.cornerRadius, node.width / 2, node.height / 2);
    const clipId = `image-clip-${String(node.id).replace(/[^a-z0-9_-]/gi, "-")}`;
    const fit = node.imageFit === "contain" ? "xMidYMid meet" : "xMidYMid slice";
    const image = node.imageData
      ? `<image x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" href="${escapeXML(node.imageData)}" preserveAspectRatio="${fit}" clip-path="url(#${clipId})" />`
      : "";
    return `<g ${common}><defs><clipPath id="${clipId}"><rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" rx="${round(radius)}" /></clipPath></defs><rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" rx="${round(radius)}" fill="${escapeXML(node.fill)}" />${image}<rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" rx="${round(radius)}" fill="none" stroke="${escapeXML(node.stroke)}" stroke-width="${round(node.strokeWidth)}" /></g>`;
  }

  if (node.type === NODE_TYPES.TEXT) {
    const anchor = node.textAlign === "center" ? "middle" : node.textAlign === "right" ? "end" : "start";
    const x = node.textAlign === "center"
      ? node.x + node.width / 2
      : node.textAlign === "right"
        ? node.x + node.width
        : node.x;
    const lineHeight = node.fontSize * node.lineHeight;
    const lines = wrapTextForExport(node.text, node.width, node.fontSize);
    const tspans = lines.map((line, index) =>
      `<tspan x="${round(x)}" dy="${index === 0 ? round(node.fontSize) : round(lineHeight)}">${escapeXML(line)}</tspan>`,
    ).join("");
    return `<text x="${round(x)}" y="${round(node.y)}" width="${round(node.width)}" fill="${escapeXML(node.fill)}" opacity="${round(opacity)}" text-anchor="${anchor}" font-family="${escapeXML(node.fontFamily)}" font-size="${round(node.fontSize)}" font-weight="${round(node.fontWeight)}" transform="rotate(${round(node.rotation)} ${round(node.x + node.width / 2)} ${round(node.y + node.height / 2)})">${tspans}</text>`;
  }

  const radius = Math.min(node.cornerRadius, node.width / 2, node.height / 2);
  return `<rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" rx="${round(radius)}" ${paint} ${common} />`;
}

function frameClipToSVG(frame) {
  const radius = Math.min(frame.cornerRadius, frame.width / 2, frame.height / 2);
  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;
  return `<clipPath id="frame-clip-${safeId(frame.id)}" clipPathUnits="userSpaceOnUse"><rect x="${round(frame.x)}" y="${round(frame.y)}" width="${round(frame.width)}" height="${round(frame.height)}" rx="${round(radius)}" transform="rotate(${round(frame.rotation)} ${round(centerX)} ${round(centerY)})" /></clipPath>`;
}

function safeId(value) {
  return String(value).replace(/[^a-z0-9_-]/gi, "-");
}

function wrapTextForExport(text, width, fontSize) {
  const maxCharacters = Math.max(1, Math.floor(width / (fontSize * 0.54)));
  const output = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      output.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > maxCharacters && line) {
        output.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    output.push(line);
  }
  return output;
}

function escapeXML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function round(number) {
  return Math.round(number * 1000) / 1000;
}
