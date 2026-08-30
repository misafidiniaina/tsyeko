const DEFAULT_WIDTH_FACTOR = 0.54;

export function estimateTextWidth(text, fontSize, fontWeight = 400) {
  const weightFactor = 1 + Math.max(0, fontWeight - 400) / 5000;
  let units = 0;
  for (const character of String(text)) {
    if (/\s/.test(character)) units += 0.32;
    else if (/[ilI1.,'!:;|]/.test(character)) units += 0.28;
    else if (/[MW@#%&]/.test(character)) units += 0.86;
    else if (/[A-Z0-9]/.test(character)) units += 0.62;
    else units += DEFAULT_WIDTH_FACTOR;
  }
  return units * fontSize * weightFactor;
}

export function wrapTextLines(text, maxWidth, fontSize, fontWeight = 400) {
  const lines = [];
  for (const paragraph of String(text).split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    const words = paragraph.split(/\s+/);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (estimateTextWidth(candidate, fontSize, fontWeight) > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

export function intrinsicTextSize(node, width = node.width) {
  const paragraphs = String(node.text).split("\n");
  const naturalWidth = Math.max(1, ...paragraphs.map((line) =>
    estimateTextWidth(line, node.fontSize, node.fontWeight)));
  const resolvedWidth = Math.max(1, width);
  const lines = wrapTextLines(node.text, resolvedWidth, node.fontSize, node.fontWeight);
  return {
    width: naturalWidth,
    height: Math.max(1, lines.length * node.fontSize * node.lineHeight),
    lines,
  };
}
