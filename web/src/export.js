import {
  getChildNodes,
  getDocumentBounds,
  getEffectiveOpacity,
  getRenderableNodeIds,
  isNodeEffectivelyVisible,
  NODE_TYPES,
} from "./model.js";
import { wrapTextLines } from "./text.js";
import { createResolvedLayoutSnapshot } from "./layout.js";
import { getVectorSegments } from "./vector.js";

export function documentToSVG(sourceDocument, ids = null) {
  const document = createResolvedLayoutSnapshot(sourceDocument);
  const bounds = getDocumentBounds(document, ids);
  const idSet = ids
    ? getRenderableNodeIds(document, ids)
    : null;
  const nodes = document.nodes.filter(
    (node) => isNodeEffectivelyVisible(document, node) && branchIntersectsSet(document, node, idSet),
  );
  const width = Math.max(1, Math.ceil(bounds.width));
  const height = Math.max(1, Math.ceil(bounds.height));
  const frameClips = nodes
    .filter((node) => node.type === NODE_TYPES.FRAME)
    .map(frameClipToSVG)
    .join("");
  const paintDefinitions = nodes
    .flatMap((node) => [
      node.fillType === "linear-gradient" &&
        ![NODE_TYPES.GROUP, NODE_TYPES.MASK].includes(node.type) &&
        (node.type !== NODE_TYPES.VECTOR || node.vectorClosed)
        ? gradientToSVG(node)
        : "",
      node.type !== NODE_TYPES.GROUP &&
        node.shadow?.enabled && node.shadow.opacity > 0
        ? shadowToSVG(node)
        : "",
    ])
    .join("");
  const compositeDefinitions = nodes
    .filter((node) => [NODE_TYPES.BOOLEAN, NODE_TYPES.MASK].includes(node.type))
    .map((node) => compositeDefinitionToSVG(document, node))
    .join("");
  const definitions = `${frameClips}${paintDefinitions}${compositeDefinitions}`;
  const body = getChildNodes(document)
    .map((node) => branchToSVG(document, node, idSet))
    .filter(Boolean)
    .join("\n  ");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${round(bounds.x)} ${round(bounds.y)} ${round(bounds.width)} ${round(bounds.height)}">`,
    `  <title>${escapeXML(document.name)}</title>`,
    definitions ? `  <defs>${definitions}</defs>` : "",
    `  ${body}`,
    `</svg>`,
  ].join("\n");
}

function branchToSVG(document, node, idSet, opacityStopId = null) {
  if (!isNodeEffectivelyVisible(document, node) || !branchIntersectsSet(document, node, idSet)) return "";
  const children = getChildNodes(document, node.id);

  if (node.type === NODE_TYPES.GROUP) {
    return children
      .map((child) => branchToSVG(document, child, idSet, opacityStopId))
      .filter(Boolean)
      .join("");
  }

  if (node.type === NODE_TYPES.BOOLEAN) {
    return booleanNodeToSVG(document, node, opacityStopId);
  }

  if (node.type === NODE_TYPES.MASK) {
    if (children.length < 2) return "";
    const content = children.slice(1)
      .map((child) => branchToSVG(document, child, null, node.id))
      .filter(Boolean)
      .join("");
    const opacity = getOpacityUntil(document, node, opacityStopId);
    const filter = node.shadow?.enabled && node.shadow.opacity > 0
      ? ` filter="url(#shadow-${safeId(node.id)})"`
      : "";
    return `<g opacity="${round(opacity)}" mask="url(#mask-${safeId(node.id)})"${filter}>${content}</g>`;
  }

  const ownOutput = !idSet || idSet.has(node.id)
    ? nodeToSVG(node, getOpacityUntil(document, node, opacityStopId))
    : "";
  if (node.type !== NODE_TYPES.FRAME || !children.length) return ownOutput;
  const descendants = children
    .map((child) => branchToSVG(document, child, idSet, opacityStopId))
    .filter(Boolean)
    .join("");
  return `${ownOutput}${descendants ? `<g clip-path="url(#frame-clip-${safeId(node.id)})">${descendants}</g>` : ""}`;
}

function booleanNodeToSVG(document, node, opacityStopId) {
  const fill = node.fillType === "linear-gradient"
    ? `url(#gradient-${safeId(node.id)})`
    : node.fill;
  const padding = Math.max(0, node.strokeWidth);
  const rectangle = (paint, maskId) =>
    `<rect x="${round(node.x - padding)}" y="${round(node.y - padding)}" width="${round(node.width + padding * 2)}" height="${round(node.height + padding * 2)}" fill="${escapeXML(paint)}" mask="url(#${maskId})" />`;
  const stroke = node.strokeWidth > 0 && node.stroke !== "transparent"
    ? rectangle(node.stroke, `boolean-stroke-mask-${safeId(node.id)}`)
    : "";
  const painted = rectangle(fill, `boolean-mask-${safeId(node.id)}`);
  const opacity = getOpacityUntil(document, node, opacityStopId);
  const filter = node.shadow?.enabled && node.shadow.opacity > 0
    ? ` filter="url(#shadow-${safeId(node.id)})"`
    : "";
  return `<g opacity="${round(opacity)}"${filter}>${stroke}${painted}</g>`;
}

function compositeDefinitionToSVG(document, node) {
  return node.type === NODE_TYPES.BOOLEAN
    ? booleanDefinitionToSVG(document, node)
    : maskDefinitionToSVG(document, node);
}

function booleanDefinitionToSVG(document, node) {
  const children = getChildNodes(document, node.id)
    .filter((child) => isNodeEffectivelyVisible(document, child));
  const id = safeId(node.id);
  const bounds = maskBounds(node, Math.max(2, node.strokeWidth * 2));
  const maskStart = `<mask id="boolean-mask-${id}" ${bounds} maskUnits="userSpaceOnUse" style="mask-type:luminance">`;
  let source = "";
  let supportingMasks = "";

  if (node.booleanOperation === "subtract") {
    source = children.length
      ? `${maskGeometryToSVG(document, children[0], "#ffffff")}${children.slice(1).map((child) => maskGeometryToSVG(document, child, "#000000")).join("")}`
      : "";
  } else if (node.booleanOperation === "intersect") {
    let intersection = `<rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" fill="#ffffff" />`;
    children.forEach((child, index) => {
      const childMaskId = `boolean-intersect-${id}-${index}`;
      supportingMasks += `<mask id="${childMaskId}" ${bounds} maskUnits="userSpaceOnUse" style="mask-type:luminance">${maskGeometryToSVG(document, child, "#ffffff")}</mask>`;
      intersection = `<g mask="url(#${childMaskId})">${intersection}</g>`;
    });
    source = children.length ? intersection : "";
  } else if (node.booleanOperation === "exclude") {
    source = `<g style="isolation:isolate">${children.map((child) =>
      `<g style="mix-blend-mode:exclusion">${maskGeometryToSVG(document, child, "#ffffff")}</g>`).join("")}</g>`;
  } else {
    source = children.map((child) => maskGeometryToSVG(document, child, "#ffffff")).join("");
  }

  const baseMask = `${supportingMasks}${maskStart}${source}</mask>`;
  if (node.strokeWidth <= 0 || node.stroke === "transparent") return baseMask;
  const extent = Math.max(1, node.strokeWidth);
  const expansion = `<filter id="boolean-expand-${id}" ${maskBounds(node, extent * 3)} filterUnits="userSpaceOnUse"><feMorphology in="SourceGraphic" operator="dilate" radius="${round(extent)}" /></filter>`;
  const expandedMask = `<mask id="boolean-stroke-mask-${id}" ${maskBounds(node, extent * 3)} maskUnits="userSpaceOnUse" style="mask-type:luminance"><g filter="url(#boolean-expand-${id})"><rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" fill="#ffffff" mask="url(#boolean-mask-${id})" /></g></mask>`;
  return `${baseMask}${expansion}${expandedMask}`;
}

function maskDefinitionToSVG(document, node) {
  const source = getChildNodes(document, node.id)[0];
  return `<mask id="mask-${safeId(node.id)}" ${maskBounds(node, 2)} maskUnits="userSpaceOnUse" style="mask-type:luminance">${source ? maskGeometryToSVG(document, source, "#ffffff") : ""}</mask>`;
}

function maskGeometryToSVG(document, node, color) {
  if (!isNodeEffectivelyVisible(document, node)) return "";
  const children = getChildNodes(document, node.id);
  if (node.type === NODE_TYPES.GROUP) {
    return children.map((child) => maskGeometryToSVG(document, child, color)).join("");
  }
  if (node.type === NODE_TYPES.BOOLEAN) {
    return `<rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" fill="${color}" mask="url(#boolean-mask-${safeId(node.id)})" />`;
  }
  if (node.type === NODE_TYPES.MASK) {
    const content = children.slice(1)
      .map((child) => maskGeometryToSVG(document, child, color))
      .join("");
    return `<g mask="url(#mask-${safeId(node.id)})">${content}</g>`;
  }

  const shadow = { enabled: false, color: "#000000", opacity: 0, offsetX: 0, offsetY: 0, blur: 0 };
  if (node.type === NODE_TYPES.TEXT) {
    return nodeToSVG({ ...node, fill: color, fillType: "solid", shadow }, 1);
  }
  if (node.type === NODE_TYPES.VECTOR) {
    return nodeToSVG({
      ...node,
      fill: color,
      fillType: "solid",
      stroke: color,
      strokeWidth: node.vectorClosed ? node.strokeWidth : Math.max(1, node.strokeWidth),
      shadow,
    }, 1);
  }

  const transform = `transform="rotate(${round(node.rotation)} ${round(node.x + node.width / 2)} ${round(node.y + node.height / 2)})"`;
  if (node.type === NODE_TYPES.ELLIPSE) {
    return `<ellipse cx="${round(node.x + node.width / 2)}" cy="${round(node.y + node.height / 2)}" rx="${round(node.width / 2)}" ry="${round(node.height / 2)}" fill="${color}" ${transform} />`;
  }
  const radius = Math.min(node.cornerRadius, node.width / 2, node.height / 2);
  return `<rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" rx="${round(radius)}" fill="${color}" ${transform} />`;
}

function maskBounds(node, padding = 0) {
  return `x="${round(node.x - padding)}" y="${round(node.y - padding)}" width="${round(node.width + padding * 2)}" height="${round(node.height + padding * 2)}"`;
}

function branchIntersectsSet(document, node, idSet) {
  if (!idSet || idSet.has(node.id)) return true;
  return getChildNodes(document, node.id)
    .some((child) => branchIntersectsSet(document, child, idSet));
}

function getOpacityUntil(document, node, stopId = null) {
  if (!stopId) return getEffectiveOpacity(document, node);
  let opacity = node.opacity;
  let cursor = node;
  const visited = new Set([node.id]);
  while (cursor.parentId && cursor.parentId !== stopId && !visited.has(cursor.parentId)) {
    visited.add(cursor.parentId);
    cursor = document.nodes.find((item) => item.id === cursor.parentId);
    if (!cursor) break;
    opacity *= cursor.opacity;
  }
  return opacity;
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
    node.shadow?.enabled && node.shadow.opacity > 0
      ? `filter="url(#shadow-${safeId(node.id)})"`
      : "",
  ].filter(Boolean).join(" ");
  const fill = node.fillType === "linear-gradient"
    ? `url(#gradient-${safeId(node.id)})`
    : node.fill;
  const paint = `fill="${escapeXML(fill)}" stroke="${escapeXML(node.stroke)}" stroke-width="${round(node.strokeWidth)}"`;

  if (node.type === NODE_TYPES.ELLIPSE) {
    return `<ellipse cx="${round(node.x + node.width / 2)}" cy="${round(node.y + node.height / 2)}" rx="${round(node.width / 2)}" ry="${round(node.height / 2)}" ${paint} ${common} />`;
  }

  if (node.type === NODE_TYPES.VECTOR) {
    const first = node.vectorPoints[0];
    const commands = [`M ${round(node.x + first.x)} ${round(node.y + first.y)}`];
    for (const segment of getVectorSegments(node)) {
      if (node.vectorClosed && segment.endIndex === 0 && !segment.curved) continue;
      if (segment.curved) {
        commands.push(
          `C ${round(node.x + segment.c1.x)} ${round(node.y + segment.c1.y)} ` +
          `${round(node.x + segment.c2.x)} ${round(node.y + segment.c2.y)} ` +
          `${round(node.x + segment.p3.x)} ${round(node.y + segment.p3.y)}`,
        );
      } else {
        commands.push(`L ${round(node.x + segment.p3.x)} ${round(node.y + segment.p3.y)}`);
      }
    }
    const path = commands.join(" ");
    const fillPaint = node.vectorClosed ? fill : "none";
    const close = node.vectorClosed ? " Z" : "";
    return `<path d="${path}${close}" fill="${escapeXML(fillPaint)}" fill-rule="${node.vectorFillRule}" stroke="${escapeXML(node.stroke)}" stroke-width="${round(node.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round" ${common} />`;
  }

  if (node.type === NODE_TYPES.IMAGE) {
    const radius = Math.min(node.cornerRadius, node.width / 2, node.height / 2);
    const clipId = `image-clip-${String(node.id).replace(/[^a-z0-9_-]/gi, "-")}`;
    const fit = node.imageFit === "contain" ? "xMidYMid meet" : "xMidYMid slice";
    const image = node.imageData
      ? `<image x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" href="${escapeXML(node.imageData)}" preserveAspectRatio="${fit}" clip-path="url(#${clipId})" />`
      : "";
    return `<g ${common}><defs><clipPath id="${clipId}"><rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" rx="${round(radius)}" /></clipPath></defs><rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" rx="${round(radius)}" fill="${escapeXML(fill)}" />${image}<rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" rx="${round(radius)}" fill="none" stroke="${escapeXML(node.stroke)}" stroke-width="${round(node.strokeWidth)}" /></g>`;
  }

  if (node.type === NODE_TYPES.TEXT) {
    const anchor = node.textAlign === "center" ? "middle" : node.textAlign === "right" ? "end" : "start";
    const x = node.textAlign === "center"
      ? node.x + node.width / 2
      : node.textAlign === "right"
        ? node.x + node.width
        : node.x;
    const lineHeight = node.fontSize * node.lineHeight;
    const lines = wrapTextLines(node.text, node.width, node.fontSize, node.fontWeight);
    const tspans = lines.map((line, index) =>
      `<tspan x="${round(x)}" dy="${index === 0 ? round(node.fontSize) : round(lineHeight)}">${escapeXML(line)}</tspan>`,
    ).join("");
    return `<text x="${round(x)}" y="${round(node.y)}" width="${round(node.width)}" fill="${escapeXML(fill)}" text-anchor="${anchor}" font-family="${escapeXML(node.fontFamily)}" font-size="${round(node.fontSize)}" font-weight="${round(node.fontWeight)}" ${common}>${tspans}</text>`;
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

function gradientToSVG(node) {
  const radians = ((node.gradient?.angle ?? 0) * Math.PI) / 180;
  const directionX = Math.cos(radians);
  const directionY = Math.sin(radians);
  const halfLength = (
    Math.abs(node.width * directionX) + Math.abs(node.height * directionY)
  ) / 2;
  const normalizedX = (directionX * halfLength) / node.width;
  const normalizedY = (directionY * halfLength) / node.height;
  const stops = (node.gradient?.stops ?? []).map((stop) =>
    `<stop offset="${round(stop.position * 100)}%" stop-color="${escapeXML(stop.color)}" />`,
  ).join("");
  return `<linearGradient id="gradient-${safeId(node.id)}" x1="${round(0.5 - normalizedX)}" y1="${round(0.5 - normalizedY)}" x2="${round(0.5 + normalizedX)}" y2="${round(0.5 + normalizedY)}">${stops}</linearGradient>`;
}

function shadowToSVG(node) {
  const extent = node.shadow.blur * 2;
  const x = node.x + Math.min(0, node.shadow.offsetX) - extent;
  const y = node.y + Math.min(0, node.shadow.offsetY) - extent;
  const width = node.width + Math.abs(node.shadow.offsetX) + extent * 2;
  const height = node.height + Math.abs(node.shadow.offsetY) + extent * 2;
  return `<filter id="shadow-${safeId(node.id)}" x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feDropShadow dx="${round(node.shadow.offsetX)}" dy="${round(node.shadow.offsetY)}" stdDeviation="${round(node.shadow.blur / 2)}" flood-color="${escapeXML(node.shadow.color)}" flood-opacity="${round(node.shadow.opacity)}" /></filter>`;
}

function safeId(value) {
  return String(value).replace(/[^a-z0-9_-]/gi, "-");
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
