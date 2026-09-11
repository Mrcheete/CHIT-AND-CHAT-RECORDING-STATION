// IndexedDB wrapper. Everything (recordings, in-progress chunks, intro clips,
// voiceover takes, translated copies) lives here — no server, no size cap
// besides whatever the browser/OS disk allows, so there is no artificial
// recording-length limit.
const DB_NAME = "cc_studio_db";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("recordings")) {
        const store = db.createObjectStore("recordings", { keyPath: "id", autoIncrement: true });
        store.createIndex("type", "type");
        store.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains("chunks")) {
        const store = db.createObjectStore("chunks", { keyPath: "id", autoIncrement: true });
        store.createIndex("sessionId", "sessionId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode = "readonly") {
  return db.transaction(store, mode).objectStore(store);
}

const CCDB = {
  // ---- recordings (finished videos: lessons, intros, voiceovers, music) ----
  async addRecording(record) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = tx(db, "recordings", "readwrite").add({
        title: "Untitled recording",
        type: "lesson", // lesson | intro | voiceover | music
        createdAt: Date.now(),
        durationSec: 0,
        blob: null,
        mimeType: "video/webm",
        translations: [], // [{lang, blob}]
        ...record,
      });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async updateRecording(id, patch) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const store = tx(db, "recordings", "readwrite");
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const rec = { ...getReq.result, ...patch };
        const putReq = store.put(rec);
        putReq.onsuccess = () => resolve(rec);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  },
  async getRecording(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = tx(db, "recordings").get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async getAllRecordings() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = tx(db, "recordings").getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => b.createdAt - a.createdAt));
      req.onerror = () => reject(req.error);
    });
  },
  async deleteRecording(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = tx(db, "recordings", "readwrite").delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },

  // ---- in-progress chunks (flushed to disk during a long recording) ----
  async addChunk(sessionId, blob) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = tx(db, "chunks", "readwrite").add({ sessionId, blob, ts: Date.now() });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async getChunks(sessionId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const idx = tx(db, "chunks").index("sessionId");
      const req = idx.getAll(IDBKeyRange.only(sessionId));
      req.onsuccess = () => resolve(req.result.sort((a, b) => a.ts - b.ts).map((c) => c.blob));
      req.onerror = () => reject(req.error);
    });
  },
  async clearChunks(sessionId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const idx = tx(db, "chunks", "readwrite").index("sessionId");
      const req = idx.openCursor(IDBKeyRange.only(sessionId));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else resolve();
      };
      req.onerror = () => reject(req.error);
    });
  },
};

window.CCDB = CCDB;
