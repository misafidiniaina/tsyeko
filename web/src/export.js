import {
  getChildNodes,
  getDocumentBounds,
  getEffectiveOpacity,
  getVectorContours,
  getRenderableNodeIds,
  isNodeEffectivelyVisible,
  NODE_TYPES,
} from "./model.js";
import { layoutRichText, wrapTextLines } from "./text.js";
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
      ...visibleFills(node).map((paint, index) =>
        paint.type !== "solid" &&
          ![NODE_TYPES.GROUP, NODE_TYPES.MASK].includes(node.type) &&
          (node.type !== NODE_TYPES.VECTOR || node.vectorClosed)
          ? gradientToSVG(node, paint, index, "fill")
          : ""),
      ...visibleStrokes(node).map((paint, index) =>
        paint.type !== "solid" && ![NODE_TYPES.GROUP, NODE_TYPES.MASK].includes(node.type)
          ? gradientToSVG(node, paint, index, "stroke")
          : ""),
      node.type !== NODE_TYPES.GROUP &&
        hasFilterEffect(node)
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
    const filter = hasFilterEffect(node)
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
  const padding = Math.max(0, node.strokeWidth);
  const rectangle = (paint, index, stack, maskId) =>
    `<rect x="${round(node.x - padding)}" y="${round(node.y - padding)}" width="${round(node.width + padding * 2)}" height="${round(node.height + padding * 2)}" fill="${escapeXML(paintToSVG(node, paint, index, stack))}" fill-opacity="${round(paint.opacity ?? 1)}" style="mix-blend-mode:${paint.blendMode ?? "normal"}" mask="url(#${maskId})" />`;
  const stroke = node.strokeWidth > 0
    ? visibleStrokes(node).map((paint, index) =>
      rectangle(paint, index, "stroke", `boolean-stroke-mask-${safeId(node.id)}`)).join("")
    : "";
  const painted = visibleFills(node).map((paint, index) =>
    rectangle(paint, index, "fill", `boolean-mask-${safeId(node.id)}`)).join("");
  const opacity = getOpacityUntil(document, node, opacityStopId);
  const filter = hasFilterEffect(node)
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
  if (node.strokeWidth <= 0 || !visibleStrokes(node).length) return baseMask;
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
  const maskPaint = { type: "solid", color, opacity: 1, visible: true, blendMode: "normal" };
  if (node.type === NODE_TYPES.TEXT) {
    return nodeToSVG({
      ...node,
      fill: color,
      fillType: "solid",
      fills: [maskPaint],
      textRuns: (node.textRuns ?? []).map((run) => ({ ...run, fill: color })),
      effects: [],
      layerBlur: 0,
      shadow,
    }, 1);
  }
  if (node.type === NODE_TYPES.VECTOR) {
    return nodeToSVG({
      ...node,
      fill: color,
      fillType: "solid",
      fills: [maskPaint],
      stroke: color,
      strokes: [maskPaint],
      strokeWidth: node.vectorClosed ? node.strokeWidth : Math.max(1, node.strokeWidth),
      effects: [],
      layerBlur: 0,
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
  const fills = visibleFills(node);
  const strokes = visibleStrokes(node);
  const common = [
    `opacity="${round(opacity)}"`,
    `transform="rotate(${round(node.rotation)} ${round(node.x + node.width / 2)} ${round(node.y + node.height / 2)})"`,
    hasFilterEffect(node)
      ? `filter="url(#shadow-${safeId(node.id)})"`
      : "",
  ].filter(Boolean).join(" ");
  const fill = paintToSVG(node, fills[0], 0);

  if (node.type === NODE_TYPES.ELLIPSE) {
    const layers = fills.map((layer, index) => `<ellipse cx="${round(node.x + node.width / 2)}" cy="${round(node.y + node.height / 2)}" rx="${round(node.width / 2)}" ry="${round(node.height / 2)}" fill="${escapeXML(paintToSVG(node, layer, index))}" fill-opacity="${round(layer.opacity)}" style="mix-blend-mode:${layer.blendMode}" />`).join("");
    const stroke = node.strokeWidth > 0 ? strokes.map((layer, index) => `<ellipse cx="${round(node.x + node.width / 2)}" cy="${round(node.y + node.height / 2)}" rx="${round(node.width / 2)}" ry="${round(node.height / 2)}" fill="none" stroke="${escapeXML(paintToSVG(node, layer, index, "stroke"))}" stroke-opacity="${round(layer.opacity)}" stroke-width="${round(node.strokeWidth)}" style="mix-blend-mode:${layer.blendMode}" />`).join("") : "";
    return `<g ${common}>${layers}${stroke}</g>`;
  }

  if (node.type === NODE_TYPES.VECTOR) {
    const path = getVectorContours(node).map((contour) => {
      const first = contour.points[0];
      if (!first) return "";
      const commands = [`M ${round(node.x + first.x)} ${round(node.y + first.y)}`];
      for (const segment of getVectorSegments(contour.points, contour.closed)) {
        if (contour.closed && segment.endIndex === 0 && !segment.curved) continue;
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
      return `${commands.join(" ")}${contour.closed ? " Z" : ""}`;
    }).join(" ");
    const fillPaint = node.vectorClosed ? fill : "none";
    const layers = node.vectorClosed ? fills.map((layer, index) => `<path d="${path}" fill="${escapeXML(paintToSVG(node, layer, index))}" fill-opacity="${round(layer.opacity)}" fill-rule="${node.vectorFillRule}" style="mix-blend-mode:${layer.blendMode}" />`).join("") : "";
    const stroke = node.strokeWidth > 0 ? strokes.map((layer, index) => `<path d="${path}" fill="none" stroke="${escapeXML(paintToSVG(node, layer, index, "stroke"))}" stroke-opacity="${round(layer.opacity)}" stroke-width="${round(node.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round" style="mix-blend-mode:${layer.blendMode}" />`).join("") : "";
    return `<g ${common}>${layers || `<path d="${path}" fill="${escapeXML(fillPaint)}" />`}${stroke}</g>`;
  }

  if (node.type === NODE_TYPES.IMAGE) {
    const radius = Math.min(node.cornerRadius, node.width / 2, node.height / 2);
    const clipId = `image-clip-${String(node.id).replace(/[^a-z0-9_-]/gi, "-")}`;
    const fit = node.imageFit === "contain" ? "xMidYMid meet" : "xMidYMid slice";
    const image = node.imageData
      ? `<image x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" href="${escapeXML(node.imageData)}" preserveAspectRatio="${fit}" clip-path="url(#${clipId})" />`
      : "";
    const backgrounds = fills.map((layer, index) => `<rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" rx="${round(radius)}" fill="${escapeXML(paintToSVG(node, layer, index))}" fill-opacity="${round(layer.opacity)}" />`).join("");
    const outlines = node.strokeWidth > 0 ? strokes.map((layer, index) => `<rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" rx="${round(radius)}" fill="none" stroke="${escapeXML(paintToSVG(node, layer, index, "stroke"))}" stroke-opacity="${round(layer.opacity)}" stroke-width="${round(node.strokeWidth)}" style="mix-blend-mode:${layer.blendMode}" />`).join("") : "";
    return `<g ${common}><defs><clipPath id="${clipId}"><rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" rx="${round(radius)}" /></clipPath></defs>${backgrounds}${image}${outlines}</g>`;
  }

  if (node.type === NODE_TYPES.TEXT) {
    const anchor = node.textAlign === "center" ? "middle" : node.textAlign === "right" ? "end" : "start";
    const x = node.textAlign === "center"
      ? node.x + node.width / 2
      : node.textAlign === "right"
        ? node.x + node.width
        : node.x;
    const lineHeight = node.fontSize * node.lineHeight;
    const lines = wrapTextLines(node.text, node.width, node.fontSize, node.fontWeight, node.fontFamily);
    let tspans = lines.map((line, index) =>
      `<tspan x="${round(x)}" dy="${index === 0 ? round(node.fontSize) : round(lineHeight)}">${escapeXML(line)}</tspan>`,
    ).join("");
    if (node.textRuns?.length) {
      const richLines = layoutRichText(node, node.width);
      tspans = richLines.map((line, lineIndex) => `<tspan x="${round(x)}" dy="${lineIndex === 0 ? round(line.height / node.lineHeight) : round(line.height)}">${line.fragments.map((fragment) => {
        const style = fragment.style;
        return `<tspan fill="${escapeXML(style.fill)}" font-family="${escapeXML(style.fontFamily)}" font-size="${round(style.fontSize)}" font-weight="${round(style.fontWeight)}" font-style="${style.fontStyle}" text-decoration="${style.textDecoration}" letter-spacing="${round(style.letterSpacing)}">${escapeXML(fragment.text)}</tspan>`;
      }).join("")}</tspan>`).join("");
    }
    return `<g ${common}>${fills.map((layer, index) => `<text x="${round(x)}" y="${round(node.y)}" width="${round(node.width)}" fill="${escapeXML(paintToSVG(node, layer, index))}" fill-opacity="${round(layer.opacity)}" text-anchor="${anchor}" font-family="${escapeXML(node.fontFamily)}" font-size="${round(node.fontSize)}" font-weight="${round(node.fontWeight)}">${tspans}</text>`).join("")}</g>`;
  }

  const radius = Math.min(node.cornerRadius, node.width / 2, node.height / 2);
  const layers = fills.map((layer, index) => `<rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" rx="${round(radius)}" fill="${escapeXML(paintToSVG(node, layer, index))}" fill-opacity="${round(layer.opacity)}" style="mix-blend-mode:${layer.blendMode}" />`).join("");
  const stroke = node.strokeWidth > 0 ? strokes.map((layer, index) => `<rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" rx="${round(radius)}" fill="none" stroke="${escapeXML(paintToSVG(node, layer, index, "stroke"))}" stroke-opacity="${round(layer.opacity)}" stroke-width="${round(node.strokeWidth)}" style="mix-blend-mode:${layer.blendMode}" />`).join("") : "";
  return `<g ${common}>${layers}${stroke}</g>`;
}

function frameClipToSVG(frame) {
  const radius = Math.min(frame.cornerRadius, frame.width / 2, frame.height / 2);
  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;
  return `<clipPath id="frame-clip-${safeId(frame.id)}" clipPathUnits="userSpaceOnUse"><rect x="${round(frame.x)}" y="${round(frame.y)}" width="${round(frame.width)}" height="${round(frame.height)}" rx="${round(radius)}" transform="rotate(${round(frame.rotation)} ${round(centerX)} ${round(centerY)})" /></clipPath>`;
}

function gradientToSVG(node, paint, index, stack = "fill") {
  const data = paint.gradient;
  const id = gradientID(node, index, stack);
  const stops = (data?.stops ?? []).map((stop) =>
    `<stop offset="${round(stop.position * 100)}%" stop-color="${escapeXML(stop.color)}" />`,
  ).join("");
  if (paint.type === "radial-gradient") {
    const centerX = node.x + data.centerX * node.width;
    const centerY = node.y + data.centerY * node.height;
    const radius = Math.max(node.width, node.height) * data.radius;
    return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${round(centerX)}" cy="${round(centerY)}" r="${round(radius)}">${stops}</radialGradient>`;
  }
  if (paint.type === "angular-gradient") {
    return angularGradientToSVG(node, data, id);
  }
  const radians = ((data?.angle ?? 0) * Math.PI) / 180;
  const directionX = Math.cos(radians);
  const directionY = Math.sin(radians);
  const halfLength = (
    Math.abs(node.width * directionX) + Math.abs(node.height * directionY)
  ) / 2;
  const normalizedX = (directionX * halfLength) / node.width;
  const normalizedY = (directionY * halfLength) / node.height;
  return `<linearGradient id="${id}" x1="${round(data.centerX - normalizedX)}" y1="${round(data.centerY - normalizedY)}" x2="${round(data.centerX + normalizedX)}" y2="${round(data.centerY + normalizedY)}">${stops}</linearGradient>`;
}

function angularGradientToSVG(node, data, id) {
  const centerX = node.x + data.centerX * node.width;
  const centerY = node.y + data.centerY * node.height;
  const radius = Math.hypot(node.width, node.height) * 1.25;
  const segments = 96;
  const start = ((data.angle ?? 0) * Math.PI) / 180;
  const wedges = [];
  for (let index = 0; index < segments; index += 1) {
    const ratio = index / segments;
    const nextRatio = (index + 1) / segments;
    const firstAngle = start + ratio * Math.PI * 2 - 0.001;
    const secondAngle = start + nextRatio * Math.PI * 2 + 0.001;
    const first = {
      x: centerX + Math.cos(firstAngle) * radius,
      y: centerY + Math.sin(firstAngle) * radius,
    };
    const second = {
      x: centerX + Math.cos(secondAngle) * radius,
      y: centerY + Math.sin(secondAngle) * radius,
    };
    wedges.push(`<path d="M ${round(centerX)} ${round(centerY)} L ${round(first.x)} ${round(first.y)} L ${round(second.x)} ${round(second.y)} Z" fill="${escapeXML(sampleGradientColor(data.stops, (ratio + nextRatio) / 2))}" />`);
  }
  return `<pattern id="${id}" data-paint-type="angular-gradient" patternUnits="userSpaceOnUse" patternContentUnits="userSpaceOnUse" x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}">${wedges.join("")}</pattern>`;
}

function sampleGradientColor(stops, ratio) {
  const ordered = [...(stops ?? [])].sort((left, right) => left.position - right.position);
  if (!ordered.length) return "transparent";
  const nextIndex = ordered.findIndex((stop) => stop.position >= ratio);
  if (nextIndex <= 0) return ordered[Math.max(0, nextIndex)]?.color ?? ordered[0].color;
  if (nextIndex < 0) return ordered.at(-1).color;
  const left = ordered[nextIndex - 1];
  const right = ordered[nextIndex];
  const span = Math.max(0.000001, right.position - left.position);
  const amount = Math.max(0, Math.min(1, (ratio - left.position) / span));
  const leftColor = parseColorChannels(left.color);
  const rightColor = parseColorChannels(right.color);
  if (!leftColor || !rightColor) return amount < 0.5 ? left.color : right.color;
  const channels = leftColor.map((value, index) => value + (rightColor[index] - value) * amount);
  return `rgba(${Math.round(channels[0])},${Math.round(channels[1])},${Math.round(channels[2])},${round(channels[3])})`;
}

function parseColorChannels(value) {
  const color = String(value).trim();
  const hex = /^#([\da-f]{3,8})$/i.exec(color)?.[1];
  if (hex) {
    const expanded = [3, 4].includes(hex.length)
      ? [...hex].map((character) => character + character).join("")
      : hex;
    if (![6, 8].includes(expanded.length)) return null;
    return [
      Number.parseInt(expanded.slice(0, 2), 16),
      Number.parseInt(expanded.slice(2, 4), 16),
      Number.parseInt(expanded.slice(4, 6), 16),
      expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    ];
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(color);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])] : null;
}

function shadowToSVG(node) {
  const shadowEffect = effectiveShadow(node);
  const blurRadius = effectiveLayerBlur(node);
  const extent = Math.max(shadowEffect?.blur ?? 0, blurRadius) * 2;
  const x = node.x + Math.min(0, shadowEffect?.offsetX ?? 0) - extent;
  const y = node.y + Math.min(0, shadowEffect?.offsetY ?? 0) - extent;
  const width = node.width + Math.abs(shadowEffect?.offsetX ?? 0) + extent * 2;
  const height = node.height + Math.abs(shadowEffect?.offsetY ?? 0) + extent * 2;
  const layerBlur = blurRadius > 0 ? `<feGaussianBlur stdDeviation="${round(blurRadius / 2)}" />` : "";
  const shadow = shadowEffect ? `<feDropShadow dx="${round(shadowEffect.offsetX)}" dy="${round(shadowEffect.offsetY)}" stdDeviation="${round(shadowEffect.blur / 2)}" flood-color="${escapeXML(shadowEffect.color)}" flood-opacity="${round(shadowEffect.opacity)}" />` : "";
  return `<filter id="shadow-${safeId(node.id)}" x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">${layerBlur}${shadow}</filter>`;
}

function visibleFills(node) {
  const fills = Array.isArray(node.fills) && node.fills.length
    ? [{
        ...node.fills[0],
        type: node.fillType,
        color: node.fill,
        gradient: node.gradient,
      }, ...node.fills.slice(1)]
    : [{ type: node.fillType, color: node.fill, gradient: node.gradient, opacity: 1, blendMode: "normal" }];
  return fills.filter((paint) => paint.visible !== false && paint.opacity > 0);
}

function visibleStrokes(node) {
  const strokes = Array.isArray(node.strokes) && node.strokes.length
    ? [{ ...node.strokes[0], color: node.stroke }, ...node.strokes.slice(1)]
    : [{ type: "solid", color: node.stroke, gradient: node.gradient, opacity: 1, blendMode: "normal" }];
  return strokes.filter((paint) =>
    paint.visible !== false && paint.opacity > 0 && (paint.type !== "solid" || paint.color !== "transparent"));
}

function gradientID(node, index, stack = "fill") {
  if (stack === "stroke") return `stroke-gradient-${safeId(node.id)}-${index}`;
  return index === 0 ? `gradient-${safeId(node.id)}` : `gradient-${safeId(node.id)}-${index}`;
}

function paintToSVG(node, paint, index, stack = "fill") {
  if (!paint) return "transparent";
  return paint.type === "solid" ? paint.color : `url(#${gradientID(node, index, stack)})`;
}

function effectiveShadow(node) {
  const effects = node.effects ?? [];
  const effect = effects.find((item) =>
    item.type === "drop-shadow" && item.visible !== false && item.enabled !== false && item.opacity > 0);
  if (effects.some((item) => item.type === "drop-shadow")) return effect ?? null;
  return node.shadow?.enabled && node.shadow.opacity > 0 ? node.shadow : null;
}

function effectiveLayerBlur(node) {
  const effects = node.effects ?? [];
  if (effects.some((item) => item.type === "layer-blur")) {
    return effects.find((item) =>
      item.type === "layer-blur" && item.visible !== false && item.radius > 0)?.radius ?? 0;
  }
  return node.layerBlur ?? 0;
}

function hasFilterEffect(node) {
  return Boolean(effectiveShadow(node) || effectiveLayerBlur(node) > 0);
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
