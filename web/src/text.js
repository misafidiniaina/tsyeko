const DEFAULT_WIDTH_FACTOR = 0.54;
const METRIC_CACHE_LIMIT = 10_000;
const metricCache = new Map();
let metricContext;

export function invalidateTextMetrics() {
  metricCache.clear();
  metricContext = undefined;
}

export function estimateTextWidth(text, fontSize, fontWeight = 400, letterSpacing = 0) {
  const weightFactor = 1 + Math.max(0, fontWeight - 400) / 5000;
  let units = 0;
  for (const character of String(text)) {
    if (/\s/.test(character)) units += 0.32;
    else if (/[ilI1.,'!:;|]/.test(character)) units += 0.28;
    else if (/[MW@#%&]/.test(character)) units += 0.86;
    else if (/[A-Z0-9]/.test(character)) units += 0.62;
    else units += DEFAULT_WIDTH_FACTOR;
  }
  return units * fontSize * weightFactor + Math.max(0, String(text).length - 1) * letterSpacing;
}

export function measureTextWidth(text, style) {
  const value = String(text);
  const key = `${style.fontStyle ?? "normal"}|${style.fontWeight}|${style.fontSize}|${style.fontFamily}|${style.letterSpacing ?? 0}|${value}`;
  const cached = metricCache.get(key);
  if (cached !== undefined) return cached;
  const context = getMetricContext();
  let width;
  if (context) {
    context.font = `${style.fontStyle ?? "normal"} ${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
    width = context.measureText(value).width + Math.max(0, value.length - 1) * (style.letterSpacing ?? 0);
  } else {
    width = estimateTextWidth(value, style.fontSize, style.fontWeight, style.letterSpacing);
  }
  if (metricCache.size >= METRIC_CACHE_LIMIT) metricCache.delete(metricCache.keys().next().value);
  metricCache.set(key, width);
  return width;
}

export function wrapTextLines(text, maxWidth, fontSize, fontWeight = 400, fontFamily = "sans-serif") {
  const node = {
    text: String(text), fontSize, fontWeight, fontFamily,
    fontStyle: "normal", fill: "#000000", textRuns: [], lineHeight: 1.2,
  };
  return layoutRichText(node, maxWidth).map((line) => line.text);
}

export function layoutRichText(node, maxWidth = Infinity) {
  const lines = [];
  let line = createLine();
  let pendingWhitespace = null;
  const tokens = [...String(node.text).matchAll(/[^\S\n]+|\n|[^\s\n]+/g)];

  const finishLine = () => {
    lines.push(line);
    line = createLine();
    pendingWhitespace = null;
  };

  for (const match of tokens) {
    const value = match[0];
    const start = match.index;
    if (value === "\n") {
      finishLine();
      continue;
    }
    const fragments = fragmentsForRange(node, start, start + value.length);
    const width = fragments.reduce((total, fragment) => total + fragment.width, 0);
    if (/^\s+$/.test(value)) {
      pendingWhitespace = { fragments, width };
      continue;
    }
    const pendingWidth = line.fragments.length ? pendingWhitespace?.width ?? 0 : 0;
    if (line.fragments.length && line.width + pendingWidth + width > maxWidth) finishLine();
    if (width > maxWidth && Number.isFinite(maxWidth)) {
      appendLongToken(fragments, maxWidth, () => line, finishLine);
      pendingWhitespace = null;
      continue;
    }
    if (line.fragments.length && pendingWhitespace) appendFragments(line, pendingWhitespace.fragments);
    appendFragments(line, fragments);
    pendingWhitespace = null;
  }
  if (line.fragments.length || !lines.length || String(node.text).endsWith("\n")) lines.push(line);
  return lines.map((item) => ({
    ...item,
    text: item.fragments.map((fragment) => fragment.text).join(""),
    height: Math.max(node.fontSize, item.height || node.fontSize) * node.lineHeight,
  }));
}

export function intrinsicTextSize(node, width = node.width) {
  const naturalLines = layoutRichText(node, Infinity);
  const naturalWidth = Math.max(1, ...naturalLines.map((line) => line.width));
  const lines = layoutRichText(node, Math.max(1, width));
  return {
    width: naturalWidth,
    height: Math.max(1, lines.reduce((total, line) => total + line.height, 0)),
    lines: lines.map((line) => line.text),
    richLines: lines,
  };
}

export function baseTextStyle(node) {
  return {
    fontFamily: node.fontFamily,
    fontRef: node.fontRef ?? null,
    fontSize: node.fontSize,
    fontWeight: node.fontWeight,
    fontStyle: "normal",
    letterSpacing: 0,
    textDecoration: "none",
    fill: node.fill,
  };
}

export function rebaseTextRuns(runs, previousText, nextText) {
  const before = String(previousText);
  const after = String(nextText);
  if (before === after) return (runs ?? []).map((run) => ({ ...run }));
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let suffix = 0;
  while (
    suffix < before.length - start &&
    suffix < after.length - start &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  const beforeEnd = before.length - suffix;
  const afterEnd = after.length - suffix;
  const delta = afterEnd - beforeEnd;
  return (runs ?? []).map((run) => {
    if (run.end <= start) return { ...run };
    if (run.start >= beforeEnd) {
      return { ...run, start: run.start + delta, end: run.end + delta };
    }
    const nextStart = run.start <= start ? run.start : start;
    const nextEnd = run.end >= beforeEnd ? run.end + delta : afterEnd;
    return { ...run, start: nextStart, end: nextEnd };
  }).filter((run) => run.start >= 0 && run.end > run.start && run.end <= after.length);
}

function fragmentsForRange(node, start, end) {
  const boundaries = new Set([start, end]);
  for (const run of node.textRuns ?? []) {
    if (run.end <= start || run.start >= end) continue;
    boundaries.add(Math.max(start, run.start));
    boundaries.add(Math.min(end, run.end));
  }
  const points = [...boundaries].sort((left, right) => left - right);
  const fragments = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const fragmentStart = points[index];
    const fragmentEnd = points[index + 1];
    const run = (node.textRuns ?? []).find((candidate) =>
      candidate.start <= fragmentStart && candidate.end >= fragmentEnd);
    const style = run ? { ...baseTextStyle(node), ...run } : baseTextStyle(node);
    const text = node.text.slice(fragmentStart, fragmentEnd);
    fragments.push({
      text,
      start: fragmentStart,
      end: fragmentEnd,
      style,
      width: measureTextWidth(text, style),
    });
  }
  return fragments;
}

function createLine() {
  return { fragments: [], width: 0, height: 0 };
}

function appendFragments(line, fragments) {
  for (const fragment of fragments) {
    line.fragments.push(fragment);
    line.width += fragment.width;
    line.height = Math.max(line.height, fragment.style.fontSize);
  }
}

function appendLongToken(fragments, maxWidth, currentLine, finishLine) {
  for (const fragment of fragments) {
    let cursor = fragment.start;
    for (const character of fragment.text) {
      const end = cursor + character.length;
      const piece = {
        ...fragment,
        text: character,
        start: cursor,
        end,
        width: measureTextWidth(character, fragment.style),
      };
      const line = currentLine();
      if (line.fragments.length && line.width + piece.width > maxWidth) finishLine();
      appendFragments(currentLine(), [piece]);
      cursor = end;
    }
  }
}

function getMetricContext() {
  if (metricContext !== undefined) return metricContext;
  try {
    const canvas = typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(1, 1)
      : globalThis.document?.createElement?.("canvas");
    metricContext = canvas?.getContext?.("2d") ?? null;
  } catch {
    metricContext = null;
  }
  return metricContext;
}
