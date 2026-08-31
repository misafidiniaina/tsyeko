const DATABASE_NAME = "tsyaiko-editor";
const DATABASE_VERSION = 1;
const STORE_NAME = "workspaces";
const ACTIVE_WORKSPACE_KEY = "active";
const STORAGE_KEY = "tsyaiko.workspace.v12";
const LEGACY_STORAGE_KEYS = [
  "tsyaiko.workspace.v11",
  "tsyaiko.workspace.v10",
  "tsyaiko.workspace.v9",
  "tsyaiko.workspace.v8",
  "tsyaiko.workspace.v7",
  "tsyaiko.workspace.v6",
  "tsyaiko.workspace.v5",
  "tsyaiko.workspace.v4",
  "tsyaiko.workspace.v3",
  "tsyaiko.workspace.v2",
  "tsyaiko.workspace.v1",
];
const MAX_RECOVERY_COPY_LENGTH = 2_000_000;

let databasePromise = null;
let writeQueue = Promise.resolve();

export async function loadWorkspace() {
  let database = null;
  try {
    database = await openDatabase();
    const workspace = await readRecord(database, ACTIVE_WORKSPACE_KEY);
    if (workspace) return workspace;
  } catch {
    // IndexedDB can be disabled by browser privacy or storage policies.
  }

  const recovery = readRecoveryCopy();
  if (recovery && database) {
    try {
      await writeRecord(database, ACTIVE_WORKSPACE_KEY, recovery);
    } catch {
      // The local recovery copy remains available if migration cannot complete.
    }
  }
  return recovery;
}

export function saveWorkspace(workspace) {
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => {
      let backend = "localStorage";
      try {
        const database = await openDatabase();
        await writeRecord(database, ACTIVE_WORKSPACE_KEY, workspace);
        backend = "IndexedDB";
      } catch {
        // A compact recovery copy below is also the fallback persistence path.
      }

      const recoverySaved = writeRecoveryCopy(workspace);
      if (backend !== "IndexedDB" && !recoverySaved) {
        throw new Error("Browser storage is unavailable or full.");
      }
      return { backend };
    });
  return writeQueue;
}

function openDatabase() {
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error("IndexedDB is unavailable."));
  }
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener("blocked", () => reject(new Error("IndexedDB upgrade was blocked.")), { once: true });
  });
  return databasePromise;
}

function readRecord(database, key) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.addEventListener("success", () => resolve(request.result ?? null), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
  });
}

function writeRecord(database, key, value) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(value, key);
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
  });
}

function readRecoveryCopy() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
      ?? LEGACY_STORAGE_KEYS.map((key) => localStorage.getItem(key)).find(Boolean);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeRecoveryCopy(workspace) {
  try {
    const serialized = JSON.stringify(workspace);
    if (serialized.length > MAX_RECOVERY_COPY_LENGTH) {
      localStorage.removeItem(STORAGE_KEY);
      for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key);
      return false;
    }
    localStorage.setItem(STORAGE_KEY, serialized);
    for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
