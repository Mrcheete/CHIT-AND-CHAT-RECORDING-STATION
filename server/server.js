// Backend for the Chit & Chat recording studio.
// The front end (studio.html / editor.html / library.html) still works
// entirely standalone in the browser (whiteboard, recording, local ffmpeg.wasm
// editing all run client-side with IndexedDB storage). This server adds the
// parts that genuinely need one:
//   - a recordings library that persists across devices/browsers
//   - a student roster that persists across devices
//   - share links / emailing a lesson to students
//   - translation (needs a server-side API key — never put that in browser JS)
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const ffmpegPath = require("ffmpeg-static");
const ffmpeg = require("fluent-ffmpeg");
const FormData = require("form-data");
const fetch = require("node-fetch");

const db = require("./db");
const { requireAuth } = require("./auth");

ffmpeg.setFfmpegPath(ffmpegPath);

const PORT = process.env.PORT || 8787;
const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!process.env.STUDIO_PASSCODE) {
  console.warn(
    "⚠️  STUDIO_PASSCODE is not set — every API route is open to anyone who can reach this server. " +
      "Fine for local-only use; set it in server/.env before exposing this server to the internet."
  );
}

const app = express();
app.disable("x-powered-by");
app.use(cors()); // the static front end is opened from file:// or a plain localhost port — allow any origin
app.use(express.json());
// Range requests (video scrubbing) are handled automatically by express.static.
app.use("/share", express.static(UPLOAD_DIR, { maxAge: "1d" }));

const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const expensiveLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
app.use("/api", generalLimiter);

const VIDEO_TYPES = /^(video|audio)\//;
function extFor(originalname, mimetype) {
  const fromName = path.extname(originalname || "");
  if (fromName) return fromName;
  if (/mp4/.test(mimetype)) return ".mp4";
  if (/mpeg|mp3/.test(mimetype)) return ".mp3";
  if (/webm/.test(mimetype)) return ".webm";
  return ".bin";
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${extFor(file.originalname, file.mimetype)}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB per file — the real ceiling is your disk, not this app
  fileFilter: (req, file, cb) => cb(null, VIDEO_TYPES.test(file.mimetype) || file.mimetype === "application/octet-stream"),
});

function shareUrl(filename) {
  return `${process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`}/share/${filename}`;
}

function mailer() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ------------------------------------------------------------------ health
app.get("/api/health", (req, res) =>
  res.json({ ok: true, time: Date.now(), authRequired: Boolean(process.env.STUDIO_PASSCODE), translateConfigured: Boolean(process.env.OPENAI_API_KEY), emailConfigured: Boolean(process.env.SMTP_HOST) })
);

// --------------------------------------------------------------- students
app.get(
  "/api/students",
  requireAuth,
  asyncRoute((req, res) => {
    res.json(db.prepare("SELECT * FROM students ORDER BY created_at DESC").all());
  })
);

app.post(
  "/api/students",
  requireAuth,
  asyncRoute((req, res) => {
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ error: "name and email are required" });
    const info = db.prepare("INSERT INTO students (name, email, created_at) VALUES (?, ?, ?)").run(name, email, Date.now());
    res.status(201).json(db.prepare("SELECT * FROM students WHERE id = ?").get(info.lastInsertRowid));
  })
);

app.delete(
  "/api/students/:id",
  requireAuth,
  asyncRoute((req, res) => {
    db.prepare("DELETE FROM students WHERE id = ?").run(req.params.id);
    res.status(204).end();
  })
);

// ------------------------------------------------------------- recordings
app.get(
  "/api/recordings",
  requireAuth,
  asyncRoute((req, res) => {
    const { type } = req.query;
    const rows = type
      ? db.prepare("SELECT * FROM recordings WHERE type = ? ORDER BY created_at DESC").all(type)
      : db.prepare("SELECT * FROM recordings ORDER BY created_at DESC").all();
    res.json(rows.map(toRecordingDTO));
  })
);

app.get(
  "/api/recordings/:id",
  requireAuth,
  asyncRoute((req, res) => {
    const rec = db.prepare("SELECT * FROM recordings WHERE id = ?").get(req.params.id);
    if (!rec) return res.status(404).json({ error: "not found" });
    res.json(toRecordingDTO(rec));
  })
);

app.post(
  "/api/recordings",
  requireAuth,
  upload.single("video"),
  asyncRoute((req, res) => {
    if (!req.file) return res.status(400).json({ error: "no video uploaded" });
    const id = crypto.randomUUID();
    const { title = "Untitled recording", type = "lesson", durationSec = 0, mimeType = req.file.mimetype, edited = "0" } = req.body;
    db.prepare(
      "INSERT INTO recordings (id, title, type, duration_sec, mime_type, file_path, file_size, edited, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, title, type, Number(durationSec) || 0, mimeType, req.file.filename, req.file.size, edited === "1" || edited === "true" ? 1 : 0, Date.now());
    res.status(201).json(toRecordingDTO(db.prepare("SELECT * FROM recordings WHERE id = ?").get(id)));
  })
);

app.patch(
  "/api/recordings/:id",
  requireAuth,
  asyncRoute((req, res) => {
    const rec = db.prepare("SELECT * FROM recordings WHERE id = ?").get(req.params.id);
    if (!rec) return res.status(404).json({ error: "not found" });
    const title = req.body.title ?? rec.title;
    db.prepare("UPDATE recordings SET title = ? WHERE id = ?").run(title, rec.id);
    res.json(toRecordingDTO(db.prepare("SELECT * FROM recordings WHERE id = ?").get(rec.id)));
  })
);

app.delete(
  "/api/recordings/:id",
  requireAuth,
  asyncRoute((req, res) => {
    const rec = db.prepare("SELECT * FROM recordings WHERE id = ?").get(req.params.id);
    if (!rec) return res.status(404).json({ error: "not found" });
    const translations = db.prepare("SELECT * FROM translations WHERE recording_id = ?").all(rec.id);
    [rec, ...translations].forEach((r) => fs.rm(path.join(UPLOAD_DIR, r.file_path), { force: true }, () => {}));
    db.prepare("DELETE FROM recordings WHERE id = ?").run(rec.id); // cascades to translations/send_log via FK
    res.status(204).end();
  })
);

function toRecordingDTO(rec) {
  const translations = db.prepare("SELECT id, lang, file_path, created_at FROM translations WHERE recording_id = ?").all(rec.id);
  return {
    id: rec.id,
    title: rec.title,
    type: rec.type,
    durationSec: rec.duration_sec,
    mimeType: rec.mime_type,
    fileSize: rec.file_size,
    edited: Boolean(rec.edited),
    createdAt: rec.created_at,
    url: shareUrl(rec.file_path),
    translations: translations.map((t) => ({ id: t.id, lang: t.lang, createdAt: t.created_at, url: shareUrl(t.file_path) })),
  };
}

// -------------------------------------------------------------------- send
app.post(
  "/api/send",
  requireAuth,
  expensiveLimiter,
  upload.single("video"),
  asyncRoute(async (req, res) => {
    const { title, recordingId } = req.body;
    const students = JSON.parse(req.body.students || "[]");
    if (!students.length) return res.status(400).json({ error: "no students selected" });

    let filename;
    if (recordingId) {
      const rec = db.prepare("SELECT * FROM recordings WHERE id = ?").get(recordingId);
      if (!rec) return res.status(404).json({ error: "recording not found" });
      filename = rec.file_path;
    } else if (req.file) {
      filename = req.file.filename;
    } else {
      return res.status(400).json({ error: "no video uploaded and no recordingId given" });
    }

    const url = shareUrl(filename);
    const transporter = mailer();
    let emailed = false;

    if (transporter) {
      await Promise.all(
        students.map((s) =>
          transporter.sendMail({
            from: process.env.SMTP_FROM || "Chit & Chat <hello@example.com>",
            to: s.email,
            subject: `New lesson: ${title || "Your lesson is ready"}`,
            text: `Hi ${s.name},\n\nYour teacher just sent you a new lesson: "${title || "a new lesson"}".\n\nWatch/download it here:\n${url}\n\nSee you in class!`,
          })
        )
      );
      emailed = true;
    }

    const logInsert = db.prepare(
      "INSERT INTO send_log (recording_id, student_id, student_email, share_url, emailed, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const now = Date.now();
    students.forEach((s) => logInsert.run(recordingId || null, s.id || null, s.email, url, emailed ? 1 : 0, now));

    res.json(emailed ? { ok: true, emailed: true, shareUrl: url } : { ok: true, emailed: false, shareUrl: url, note: "SMTP not configured — share this link yourself." });
  })
);

// -------------------------------------------------------------- translate
app.post(
  "/api/translate",
  requireAuth,
  expensiveLimiter,
  upload.single("video"),
  asyncRoute(async (req, res) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(400).json({ error: "OPENAI_API_KEY is not configured on the server (server/.env)." });

    const targetLang = req.body.targetLang || "es";
    const recordingId = req.body.recordingId;
    let sourcePath, sourceRec;
    if (recordingId) {
      sourceRec = db.prepare("SELECT * FROM recordings WHERE id = ?").get(recordingId);
      if (!sourceRec) return res.status(404).json({ error: "recording not found" });
      sourcePath = path.join(UPLOAD_DIR, sourceRec.file_path);
    } else if (req.file) {
      sourcePath = req.file.path;
    } else {
      return res.status(400).json({ error: "no video uploaded and no recordingId given" });
    }

    const workDir = path.join(UPLOAD_DIR, `_work_${crypto.randomUUID()}`);
    fs.mkdirSync(workDir, { recursive: true });
    const audioPath = path.join(workDir, "audio.mp3");
    const ttsPath = path.join(workDir, "translated_audio.mp3");
    const outFilename = `${crypto.randomUUID()}.mp4`;
    const outPath = path.join(UPLOAD_DIR, outFilename);

    try {
      await new Promise((resolve, reject) => {
        ffmpeg(sourcePath).noVideo().audioCodec("libmp3lame").save(audioPath).on("end", resolve).on("error", reject);
      });

      const transcript = await transcribeAudio(audioPath, apiKey);
      const translatedText = await translateText(transcript, targetLang, apiKey);
      await synthesizeSpeech(translatedText, ttsPath, apiKey);

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(sourcePath)
          .input(ttsPath)
          .outputOptions(["-map 0:v:0", "-map 1:a:0", "-c:v copy", "-shortest"])
          .save(outPath)
          .on("end", resolve)
          .on("error", reject);
      });

      if (recordingId) {
        db.prepare("INSERT INTO translations (recording_id, lang, file_path, created_at) VALUES (?, ?, ?, ?)").run(
          recordingId,
          targetLang,
          outFilename,
          Date.now()
        );
      }

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("X-Share-Url", shareUrl(outFilename));
      fs.createReadStream(outPath).pipe(res);
    } finally {
      fs.rm(workDir, { recursive: true, force: true }, () => {});
      if (req.file) fs.rm(req.file.path, { force: true }, () => {});
    }
  })
);

async function transcribeAudio(audioPath, apiKey) {
  const form = new FormData();
  form.append("file", fs.createReadStream(audioPath));
  form.append("model", "whisper-1");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, ...form.getHeaders() },
    body: form,
  });
  if (!res.ok) throw new Error(`transcription failed: ${await res.text()}`);
  const json = await res.json();
  return json.text;
}

async function translateText(text, targetLang, apiKey) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Translate the user's lesson transcript into language code "${targetLang}". Keep the tone natural and spoken, suitable for a teacher addressing students. Return only the translated text.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  if (!res.ok) throw new Error(`translation failed: ${await res.text()}`);
  const json = await res.json();
  return json.choices[0].message.content;
}

async function synthesizeSpeech(text, outPath, apiKey) {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "tts-1", voice: "alloy", input: text }),
  });
  if (!res.ok) throw new Error(`speech synthesis failed: ${await res.text()}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buffer);
}

// ------------------------------------------------------------- error/404
app.use((req, res) => res.status(404).json({ error: "not found" }));
app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  res.status(500).json({ error: err.message || "internal server error" });
});

app.listen(PORT, () => console.log(`Chit & Chat studio server listening on http://localhost:${PORT}`));
