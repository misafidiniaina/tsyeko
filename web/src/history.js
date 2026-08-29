import { cloneDocument } from "./model.js";

export class DocumentHistory {
  constructor(document, limit = 100) {
    this.limit = limit;
    this.assetPool = new Map();
    this.assetTokens = new Map();
    this.entries = [this.createSnapshot(document)];
    this.signatures = [this.createSignature(document)];
    this.index = 0;
  }

  commit(document) {
    const signature = this.createSignature(document);
    if (this.signatures[this.index] === signature) return false;

    this.entries.splice(this.index + 1);
    this.signatures.splice(this.index + 1);
    this.entries.push(this.createSnapshot(document));
    this.signatures.push(signature);
    if (this.entries.length > this.limit) {
      this.entries.shift();
      this.signatures.shift();
    } else {
      this.index += 1;
    }
    this.index = this.entries.length - 1;
    return true;
  }

  undo() {
    if (!this.canUndo) return null;
    this.index -= 1;
    return this.createSnapshot(this.entries[this.index]);
  }

  redo() {
    if (!this.canRedo) return null;
    this.index += 1;
    return this.createSnapshot(this.entries[this.index]);
  }

  reset(document) {
    this.assetPool.clear();
    this.assetTokens.clear();
    this.entries = [this.createSnapshot(document)];
    this.signatures = [this.createSignature(document)];
    this.index = 0;
  }

  createSnapshot(document) {
    const snapshot = cloneDocument(document);
    for (const page of snapshot.pages ?? []) {
      for (const node of page.nodes ?? []) {
        if (!node.imageData) continue;
        const pooled = this.assetPool.get(node.imageData);
        if (pooled) node.imageData = pooled;
        else this.assetPool.set(node.imageData, node.imageData);
      }
    }
    return snapshot;
  }

  createSignature(document) {
    return JSON.stringify(document, (key, value) => {
      if (key === "updatedAt") return undefined;
      if (key !== "imageData" || !value) return value;
      let token = this.assetTokens.get(value);
      if (!token) {
        token = `embedded-asset-${this.assetTokens.size + 1}`;
        this.assetTokens.set(value, token);
      }
      return token;
    });
  }

  get canUndo() {
    return this.index > 0;
  }

  get canRedo() {
    return this.index < this.entries.length - 1;
  }
}
