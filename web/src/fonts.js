import { invalidateTextMetrics } from "./text.js";

const loadedFonts = new Map();

export async function loadDocumentFonts(designDocument) {
  const fontSet = globalThis.document?.fonts;
  const FontFaceConstructor = globalThis.FontFace;
  const assets = (designDocument?.assets ?? []).filter((asset) => asset.kind === "font");
  if (!fontSet || typeof FontFaceConstructor !== "function") {
    return assets.map((asset) => ({ asset, status: "unsupported" }));
  }

  const results = await Promise.all(assets.map(async (asset) => {
    const key = `${asset.hash}:${asset.fontFamily}:${asset.fontWeight}:${asset.fontStyle}`;
    const existing = loadedFonts.get(key);
    if (existing) return existing;
    try {
      const face = new FontFaceConstructor(
        asset.fontFamily,
        `url(${asset.data})`,
        { weight: String(asset.fontWeight ?? 400), style: asset.fontStyle ?? "normal" },
      );
      await face.load();
      fontSet.add(face);
      const result = { asset, face, status: "loaded" };
      loadedFonts.set(key, result);
      return result;
    } catch (error) {
      return { asset, error, status: "error" };
    }
  }));
  if (results.some((result) => result.status === "loaded")) invalidateTextMetrics();
  return results;
}

export function documentFontFamilies(designDocument) {
  return [...new Set((designDocument?.assets ?? [])
    .filter((asset) => asset.kind === "font" && asset.fontFamily)
    .map((asset) => asset.fontFamily))];
}
