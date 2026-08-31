import { cloneDocument } from "./model.js";

const IGNORED_KEYS = new Set(["updatedAt"]);

export class DocumentHistory {
  constructor(document, limit = 100) {
    this.limit = Math.max(1, limit);
    this.commands = [];
    this.index = 0;
    this.current = cloneDocument(document);
  }

  commit(document, label = "Edit document") {
    const next = cloneDocument(document);
    const forward = [];
    const reverse = [];
    diffValue(this.current, next, [], forward, reverse);
    if (!forward.length) return false;

    this.commands.splice(this.index);
    this.commands.push({ label, forward, reverse });
    if (this.commands.length > this.limit) this.commands.shift();
    this.index = this.commands.length;
    this.current = next;
    return true;
  }

  undo() {
    if (!this.canUndo) return null;
    const command = this.commands[this.index - 1];
    this.current = applyOperations(this.current, command.reverse);
    this.index -= 1;
    return cloneDocument(this.current);
  }

  redo() {
    if (!this.canRedo) return null;
    const command = this.commands[this.index];
    this.current = applyOperations(this.current, command.forward);
    this.index += 1;
    return cloneDocument(this.current);
  }

  reset(document) {
    this.commands = [];
    this.index = 0;
    this.current = cloneDocument(document);
  }

  get canUndo() {
    return this.index > 0;
  }

  get canRedo() {
    return this.index < this.commands.length;
  }

  get undoLabel() {
    return this.canUndo ? this.commands[this.index - 1].label : null;
  }

  get redoLabel() {
    return this.canRedo ? this.commands[this.index].label : null;
  }
}

export function createDocumentCommand(before, after, label = "Edit document") {
  const forward = [];
  const reverse = [];
  diffValue(before, after, [], forward, reverse);
  return { label, forward, reverse };
}

export function applyDocumentCommand(document, command, direction = "forward") {
  return applyOperations(document, direction === "reverse" ? command.reverse : command.forward);
}

function diffValue(before, after, path, forward, reverse) {
  if (equivalentPrimitive(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    if (!arraysCanDiffByIndex(before, after)) {
      diffArrayStructure(before, after, path, forward, reverse);
      return;
    }
    for (let index = 0; index < before.length; index += 1) {
      diffValue(before[index], after[index], [...path, index], forward, reverse);
    }
    return;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      if (IGNORED_KEYS.has(key)) continue;
      const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
      const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
      if (!hasAfter) {
        forward.push({ op: "delete", path: [...path, key] });
        reverse.unshift({ op: "set", path: [...path, key], value: cloneValue(before[key]) });
      } else if (!hasBefore) {
        forward.push({ op: "set", path: [...path, key], value: cloneValue(after[key]) });
        reverse.unshift({ op: "delete", path: [...path, key] });
      } else {
        diffValue(before[key], after[key], [...path, key], forward, reverse);
      }
    }
    return;
  }
  pushSet(path, before, after, forward, reverse);
}

function pushSet(path, before, after, forward, reverse) {
  forward.push({ op: "set", path, value: cloneValue(after) });
  reverse.unshift({ op: "set", path, value: cloneValue(before) });
}

function diffArrayStructure(before, after, path, forward, reverse) {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && sameArrayIdentity(before[prefix], after[prefix])) {
    diffValue(before[prefix], after[prefix], [...path, prefix], forward, reverse);
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    sameArrayIdentity(before[before.length - 1 - suffix], after[after.length - 1 - suffix])
  ) {
    suffix += 1;
  }

  const removed = before.slice(prefix, before.length - suffix);
  const inserted = after.slice(prefix, after.length - suffix);
  if (removed.length || inserted.length) {
    forward.push({
      op: "splice",
      path,
      index: prefix,
      deleteCount: removed.length,
      values: cloneValue(inserted),
    });
    reverse.unshift({
      op: "splice",
      path,
      index: prefix,
      deleteCount: inserted.length,
      values: cloneValue(removed),
    });
  }

  for (let offset = suffix - 1; offset >= 0; offset -= 1) {
    const beforeIndex = before.length - 1 - offset;
    const afterIndex = after.length - 1 - offset;
    diffValue(before[beforeIndex], after[afterIndex], [...path, afterIndex], forward, reverse);
  }
}

function applyOperations(document, operations) {
  const output = cloneDocument(document);
  for (const operation of operations) {
    if (!operation.path.length && operation.op !== "splice") return cloneValue(operation.value);
    let target = output;
    const targetPathLength = operation.op === "splice" ? operation.path.length : operation.path.length - 1;
    for (let index = 0; index < targetPathLength; index += 1) {
      target = target[operation.path[index]];
    }
    if (operation.op === "splice") {
      target.splice(operation.index, operation.deleteCount, ...cloneValue(operation.values));
      continue;
    }
    const key = operation.path.at(-1);
    if (operation.op === "delete") {
      if (Array.isArray(target)) target.splice(Number(key), 1);
      else delete target[key];
    } else {
      target[key] = cloneValue(operation.value);
    }
  }
  return output;
}

function arraysCanDiffByIndex(before, after) {
  if (before.length !== after.length) return false;
  return before.every((value, index) => {
    const next = after[index];
    if (isPlainObject(value) && isPlainObject(next) && ("id" in value || "id" in next)) {
      return value.id === next.id;
    }
    return true;
  });
}

function sameArrayIdentity(left, right) {
  if (isPlainObject(left) && isPlainObject(right) && ("id" in left || "id" in right)) {
    return left.id === right.id;
  }
  return Object.is(left, right);
}

function equivalentPrimitive(before, after) {
  return Object.is(before, after) ||
    (typeof before === "number" && typeof after === "number" && Number.isNaN(before) && Number.isNaN(after));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneValue(value) {
  if (value === undefined || value === null || typeof value !== "object") return value;
  return globalThis.structuredClone
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}
