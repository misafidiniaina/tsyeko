const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 48;

export class BoundsSurfaceCache {
  constructor(options = {}) {
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.entries = new Map();
    this.bytes = 0;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key, surface, metadata = {}) {
    if (!key || !surface) return null;
    const bytes = Math.max(4, Math.ceil(surface.width) * Math.ceil(surface.height) * 4);
    if (bytes > this.maxBytes) return null;
    this.delete(key);
    const entry = { key, surface, bytes, metadata };
    this.entries.set(key, entry);
    this.bytes += bytes;
    this.trim();
    return entry;
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    return true;
  }

  deleteWhere(predicate) {
    let deleted = 0;
    for (const [key, entry] of this.entries) {
      if (!predicate(entry, key)) continue;
      this.delete(key);
      deleted += 1;
    }
    return deleted;
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }

  trim() {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      this.delete(this.entries.keys().next().value);
    }
  }

  get stats() {
    return { entries: this.entries.size, bytes: this.bytes };
  }
}

export function renderBranchSignature(nodes) {
  const serialized = JSON.stringify(nodes, (key, value) => {
    if (key === "updatedAt") return undefined;
    if (key === "imageData" && typeof value === "string") {
      return `${value.length}:${hashString(value)}`;
    }
    return value;
  });
  return hashString(serialized);
}

export function summarizeFrameProfiles(frames) {
  const samples = (frames ?? []).filter((frame) => Number.isFinite(frame?.frameMs));
  if (!samples.length) return { samples: 0, averageFrameMs: 0, p95FrameMs: 0, maximumFrameMs: 0 };
  const durations = samples.map((frame) => frame.frameMs).sort((left, right) => left - right);
  const total = durations.reduce((sum, duration) => sum + duration, 0);
  return {
    samples: durations.length,
    averageFrameMs: total / durations.length,
    p95FrameMs: durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))],
    maximumFrameMs: durations.at(-1),
  };
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function positiveInteger(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
