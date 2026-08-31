const CORNER_HANDLES = new Set(["nw", "ne", "se", "sw"]);
const RESIZE_HANDLES = new Set(["nw", "n", "ne", "e", "se", "s", "sw", "w"]);

export function combineTransformBounds(boundsList) {
  if (!boundsList.length) return null;
  const left = Math.min(...boundsList.map((bounds) => bounds.x));
  const top = Math.min(...boundsList.map((bounds) => bounds.y));
  const right = Math.max(...boundsList.map((bounds) => bounds.x + bounds.width));
  const bottom = Math.max(...boundsList.map((bounds) => bounds.y + bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function resizeTransformBounds(source, handle, pointer, options = {}) {
  if (!source || !RESIZE_HANDLES.has(handle)) return source ? { ...source } : null;
  const minimum = Math.max(0.001, Number(options.minimumSize) || 1);
  const centered = options.centered === true;
  const preserveAspectRatio = options.preserveAspectRatio === true && CORNER_HANDLES.has(handle);
  const sourceRight = source.x + source.width;
  const sourceBottom = source.y + source.height;
  const centerX = source.x + source.width / 2;
  const centerY = source.y + source.height / 2;
  let left = source.x;
  let top = source.y;
  let right = sourceRight;
  let bottom = sourceBottom;

  if (handle.includes("w")) {
    if (centered) {
      const halfWidth = Math.max(minimum / 2, centerX - pointer.x);
      left = centerX - halfWidth;
      right = centerX + halfWidth;
    } else {
      left = Math.min(pointer.x, sourceRight - minimum);
    }
  }
  if (handle.includes("e")) {
    if (centered) {
      const halfWidth = Math.max(minimum / 2, pointer.x - centerX);
      left = centerX - halfWidth;
      right = centerX + halfWidth;
    } else {
      right = Math.max(pointer.x, source.x + minimum);
    }
  }
  if (handle.includes("n")) {
    if (centered) {
      const halfHeight = Math.max(minimum / 2, centerY - pointer.y);
      top = centerY - halfHeight;
      bottom = centerY + halfHeight;
    } else {
      top = Math.min(pointer.y, sourceBottom - minimum);
    }
  }
  if (handle.includes("s")) {
    if (centered) {
      const halfHeight = Math.max(minimum / 2, pointer.y - centerY);
      top = centerY - halfHeight;
      bottom = centerY + halfHeight;
    } else {
      bottom = Math.max(pointer.y, source.y + minimum);
    }
  }

  if (preserveAspectRatio) {
    const aspectRatio = source.width / Math.max(0.001, source.height);
    let width = right - left;
    let height = bottom - top;
    if (width / height > aspectRatio) height = width / aspectRatio;
    else width = height * aspectRatio;

    if (centered) {
      left = centerX - width / 2;
      right = centerX + width / 2;
      top = centerY - height / 2;
      bottom = centerY + height / 2;
    } else {
      if (handle.includes("w")) left = right - width;
      else right = left + width;
      if (handle.includes("n")) top = bottom - height;
      else bottom = top + height;
    }
  }

  return {
    x: left,
    y: top,
    width: Math.max(minimum, right - left),
    height: Math.max(minimum, bottom - top),
  };
}

export function resizeTransformBoundsToDimension(source, dimension, value, options = {}) {
  if (!["width", "height"].includes(dimension)) {
    throw new TypeError(`Unsupported transform dimension: ${dimension}`);
  }
  const minimum = Math.max(0.001, options.minimumSize ?? 1);
  const targetValue = Math.max(minimum, value);
  const otherDimension = dimension === "width" ? "height" : "width";
  const target = { ...source, [dimension]: targetValue };
  if (options.preserveAspectRatio) {
    const scale = targetValue / Math.max(0.001, source[dimension]);
    target[otherDimension] = Math.max(minimum, source[otherDimension] * scale);
  }
  return target;
}

export function scaleGeometryInBounds(geometry, sourceBounds, targetBounds) {
  const scaleX = targetBounds.width / Math.max(0.001, sourceBounds.width);
  const scaleY = targetBounds.height / Math.max(0.001, sourceBounds.height);
  const sourceCenterX = geometry.x + geometry.width / 2;
  const sourceCenterY = geometry.y + geometry.height / 2;
  const centerX = targetBounds.x + (sourceCenterX - sourceBounds.x) * scaleX;
  const centerY = targetBounds.y + (sourceCenterY - sourceBounds.y) * scaleY;
  const width = Math.max(0.001, geometry.width * scaleX);
  const height = Math.max(0.001, geometry.height * scaleY);
  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
    rotation: geometry.rotation ?? 0,
  };
}

export function rotationDelta(center, startPoint, currentPoint, snapIncrement = 0) {
  const start = Math.atan2(startPoint.y - center.y, startPoint.x - center.x);
  const current = Math.atan2(currentPoint.y - center.y, currentPoint.x - center.x);
  let degrees = normalizeTransformRotation(((current - start) * 180) / Math.PI);
  if (snapIncrement > 0) degrees = Math.round(degrees / snapIncrement) * snapIncrement;
  return normalizeTransformRotation(degrees);
}

export function rotateGeometryAroundPoint(geometry, center, degrees) {
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const sourceCenterX = geometry.x + geometry.width / 2;
  const sourceCenterY = geometry.y + geometry.height / 2;
  const offsetX = sourceCenterX - center.x;
  const offsetY = sourceCenterY - center.y;
  const centerX = center.x + offsetX * cosine - offsetY * sine;
  const centerY = center.y + offsetX * sine + offsetY * cosine;
  return {
    x: centerX - geometry.width / 2,
    y: centerY - geometry.height / 2,
    width: geometry.width,
    height: geometry.height,
    rotation: normalizeTransformRotation((geometry.rotation ?? 0) + degrees),
  };
}

export function normalizeTransformRotation(degrees) {
  const normalized = ((degrees % 360) + 360) % 360;
  return Math.round((normalized > 180 ? normalized - 360 : normalized) * 10) / 10;
}
