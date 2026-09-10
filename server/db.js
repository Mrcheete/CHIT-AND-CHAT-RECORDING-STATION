// SQLite storage for the studio server. Single file on disk, no external
// database service to stand up — real transactions/indices instead of the
// old hand-rolled JSON file.
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "studio.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER REFERENCES teachers(id),
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    teacher_id INTEGER REFERENCES teachers(id),
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

// Single-teacher setup: seed the one account from env on boot if it doesn't
// exist yet. Nothing happens (and the server stays unusable) until both are
// set — that's intentional, there's no default password to leave exposed.
function seedTeacherFromEnv() {
  const email = process.env.TEACHER_EMAIL;
  const password = process.env.TEACHER_PASSWORD;
  if (!email || !password) {
    console.warn(
      "⚠️  TEACHER_EMAIL / TEACHER_PASSWORD are not set in server/.env — no teacher account exists yet, so nobody can log in until you set them and restart."
    );
    return;
  }
  const existing = db.prepare("SELECT id FROM teachers WHERE email = ?").get(email);
  if (existing) return;
  const passwordHash = bcrypt.hashSync(password, 10);
  db.prepare("INSERT INTO teachers (email, password_hash, created_at) VALUES (?, ?, ?)").run(email, passwordHash, Date.now());
  console.log(`Seeded teacher account for ${email}`);
}
seedTeacherFromEnv();

module.exports = db;
