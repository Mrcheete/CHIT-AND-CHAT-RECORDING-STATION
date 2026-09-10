// SQLite storage for the studio server. Single file on disk, no external
// database service to stand up — real transactions/indices instead of the
// old hand-rolled JSON file.
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "studio.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'lesson',
    duration_sec INTEGER NOT NULL DEFAULT 0,
    mime_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    edited INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_recordings_type ON recordings(type);
  CREATE INDEX IF NOT EXISTS idx_recordings_created ON recordings(created_at);

  CREATE TABLE IF NOT EXISTS translations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    lang TEXT NOT NULL,
    file_path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_translations_recording ON translations(recording_id);

  CREATE TABLE IF NOT EXISTS send_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recording_id TEXT,
    student_id INTEGER,
    student_email TEXT NOT NULL,
    share_url TEXT NOT NULL,
    emailed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`);

module.exports = db;
