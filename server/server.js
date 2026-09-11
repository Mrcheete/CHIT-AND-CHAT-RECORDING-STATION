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
const cookieSession = require("cookie-session");
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
const { requireAuth, verifyLogin } = require("./auth");

ffmpeg.setFfmpegPath(ffmpegPath);

const PORT = process.env.PORT || 8787;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString("hex");
  console.warn(
    "⚠️  SESSION_SECRET is not set — using a random secret generated for this run, which logs everyone out " +
      "every time the server restarts. Set SESSION_SECRET in server/.env before deploying."
  );
}

const app = express();
app.disable("x-powered-by");
// Railway (and most PaaS hosts) terminate HTTPS at their edge and forward to
// the app over plain HTTP — without this, Express sees every request as
// insecure, and the secure session cookie below silently fails to persist.
app.set("trust proxy", 1);
app.use(express.json());
app.use(
  cookieSession({
    name: "cc_session",
    keys: [sessionSecret],
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  })
);
// Same-origin now — the front end is served straight from this server, not
// opened separately from file:// or a different localhost port.
app.use(express.static(PUBLIC_DIR));
// Range requests (video scrubbing) are handled automatically by express.static.
// Public and unauthenticated on purpose — this is what makes share links usable.
app.use("/share", express.static(UPLOAD_DIR, { maxAge: "1d" }));

// Chunk/finalize uploads happen every ~2s for as long as a lesson records,
// which would blow through the general API limit on any recording longer
// than ~10 minutes — so they get their own, much roomier limiter instead.
const CHUNK_ROUTE_RE = /^\/api\/recordings\/[^/]+\/(chunk|finalize)$/;
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  // req.path here is relative to the "/api" mount point (Express strips the
  // prefix inside app.use("/api", ...)), so match against req.originalUrl —
  // which keeps the full path — instead of building the regex around a path
  // that would never actually appear in req.path.
  skip: (req) => CHUNK_ROUTE_RE.test(req.originalUrl.split("?")[0]),
});
const expensiveLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const chunkLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 3000, standardHeaders: true, legacyHeaders: false });
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

function uploadPartsDir(id) {
  return path.join(UPLOAD_DIR, `_upload_${id}`);
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
  res.json({ ok: true, time: Date.now(), translateConfigured: Boolean(process.env.OPENAI_API_KEY), emailConfigured: Boolean(process.env.SMTP_HOST) })
);

// -------------------------------------------------------------------- auth
app.post(
  "/api/login",
  asyncRoute((req, res) => {
    const { email, password } = req.body;
    const teacher = verifyLogin(email, password);
    if (!teacher) return res.status(401).json({ error: "invalid email or password" });
    req.session.teacherId = teacher.id;
    res.json({ ok: true, email: teacher.email });
  })
);

app.post("/api/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  if (!req.session || !req.session.teacherId) return res.status(401).json({ error: "not logged in" });
  const teacher = db.prepare("SELECT id, email FROM teachers WHERE id = ?").get(req.session.teacherId);
  if (!teacher) return res.status(401).json({ error: "not logged in" });
  res.json(teacher);
});

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
    [rec, ...translations].forEach((r) => {
      // An in-progress (never-finalized) upload has no final file yet — an
      // empty file_path here would resolve to UPLOAD_DIR itself, so skip it.
      if (r.file_path) fs.rm(path.join(UPLOAD_DIR, r.file_path), { force: true }, () => {});
      if (r.vtt_path) fs.rm(path.join(UPLOAD_DIR, r.vtt_path), { force: true }, () => {});
    });
    fs.rm(uploadPartsDir(rec.id), { recursive: true, force: true }, () => {});
    db.prepare("DELETE FROM recordings WHERE id = ?").run(rec.id); // cascades to translations/send_log via FK
    res.status(204).end();
  })
);

// ---------------------------------------------------- chunked upload (long recordings)
// A recording is created incrementally: each ~2s chunk from MediaRecorder is
// PUT to its own indexed part file (never appended blindly), so a retried
// chunk just overwrites the same file instead of risking a doubled-up or
// corrupted stream. The first chunk creates a placeholder row with
// status='uploading' so an abandoned recording is visible (and cleanable)
// in the library instead of silently vanishing; finalize checks every
// sequence number is present, concatenates them in order, and marks it
// 'finalized'.
app.put(
  "/api/recordings/:id/chunk",
  requireAuth,
  chunkLimiter,
  express.raw({ type: "*/*", limit: "50mb" }),
  asyncRoute((req, res) => {
    const { id } = req.params;
    const seq = Number(req.query.seq);
    if (!Number.isInteger(seq) || seq < 0) return res.status(400).json({ error: "seq must be a non-negative integer" });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "empty chunk body" });

    const rec = db.prepare("SELECT id FROM recordings WHERE id = ?").get(id);
    if (!rec) {
      const mimeType = req.query.mimeType || "video/webm";
      db.prepare(
        "INSERT INTO recordings (id, title, type, duration_sec, mime_type, file_path, file_size, edited, status, created_at) VALUES (?, 'Recording in progress', 'lesson', 0, ?, '', 0, 0, 'uploading', ?)"
      ).run(id, mimeType, Date.now());
    }

    const dir = uploadPartsDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${seq}.part`), req.body);
    res.json({ ok: true, seq });
  })
);

app.post(
  "/api/recordings/:id/finalize",
  requireAuth,
  chunkLimiter,
  asyncRoute(async (req, res) => {
    const { id } = req.params;
    const rec = db.prepare("SELECT * FROM recordings WHERE id = ?").get(id);
    if (!rec) return res.status(404).json({ error: "no upload found for this id — send at least one chunk first" });

    const dir = uploadPartsDir(id);
    let seqs;
    try {
      seqs = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".part"))
        .map((f) => Number(f.slice(0, -5)))
        .sort((a, b) => a - b);
    } catch {
      seqs = [];
    }
    if (seqs.length === 0) {
      db.prepare("UPDATE recordings SET status = 'failed' WHERE id = ?").run(id);
      return res.status(400).json({ error: "no chunks were received for this upload" });
    }
    for (let i = 0; i < seqs.length; i++) {
      if (seqs[i] !== i) {
        return res.status(409).json({
          error: `missing chunk ${i} — the upload is incomplete. Retry the missing chunk(s), then finalize again.`,
          receivedSeqs: seqs,
        });
      }
    }

    const { title, type, durationSec, mimeType, edited } = req.body;
    const finalMimeType = mimeType || rec.mime_type;
    const finalFilename = `${id}${extFor("", finalMimeType)}`;
    const finalPath = path.join(UPLOAD_DIR, finalFilename);

    const out = fs.createWriteStream(finalPath);
    try {
      for (const s of seqs) {
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(path.join(dir, `${s}.part`));
          rs.on("error", reject);
          rs.on("end", resolve);
          rs.pipe(out, { end: false });
        });
      }
    } finally {
      out.end();
    }
    await new Promise((resolve, reject) => {
      out.on("finish", resolve);
      out.on("error", reject);
    });

    const fileSize = fs.statSync(finalPath).size;
    db.prepare(
      "UPDATE recordings SET title = ?, type = ?, duration_sec = ?, mime_type = ?, file_path = ?, file_size = ?, edited = ?, status = 'finalized' WHERE id = ?"
    ).run(
      title || rec.title || "Untitled recording",
      type || rec.type || "lesson",
      Number(durationSec) || 0,
      finalMimeType,
      finalFilename,
      fileSize,
      edited === "1" || edited === "true" ? 1 : 0,
      id
    );

    fs.rm(dir, { recursive: true, force: true }, () => {});
    res.status(201).json(toRecordingDTO(db.prepare("SELECT * FROM recordings WHERE id = ?").get(id)));
  })
);

function toRecordingDTO(rec) {
  const translations = db.prepare("SELECT id, lang, file_path, vtt_path, created_at FROM translations WHERE recording_id = ?").all(rec.id);
  return {
    id: rec.id,
    title: rec.title,
    type: rec.type,
    durationSec: rec.duration_sec,
    mimeType: rec.mime_type,
    fileSize: rec.file_size,
    edited: Boolean(rec.edited),
    status: rec.status,
    createdAt: rec.created_at,
    url: rec.file_path ? shareUrl(rec.file_path) : null,
    translations: translations.map((t) => ({
      id: t.id,
      lang: t.lang,
      createdAt: t.created_at,
      url: shareUrl(t.file_path),
      vttUrl: t.vtt_path ? shareUrl(t.vtt_path) : null,
    })),
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
    // A multipart request (re-uploading a raw file) sends students as a JSON
    // string field; a plain JSON request (the common case now that every
    // recording already lives server-side) sends it as a real array.
    const students = Array.isArray(req.body.students) ? req.body.students : JSON.parse(req.body.students || "[]");
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

// --------------------------------------------------------------------- trim
// Cuts-only editing (the common "remove a mistake from a long lesson" case)
// runs here instead of in the browser: the client already knows which
// ranges to *keep* (it computes that from its own cut markers — see
// keepSegments() in editor.js), so this just extracts and concats those
// ranges with the same real ffmpeg already used for translation, instead of
// pulling the whole recording back into the browser for ffmpeg.wasm.
app.post(
  "/api/recordings/:id/trim",
  requireAuth,
  expensiveLimiter,
  asyncRoute(async (req, res) => {
    const rec = db.prepare("SELECT * FROM recordings WHERE id = ?").get(req.params.id);
    if (!rec) return res.status(404).json({ error: "not found" });
    if (rec.status !== "finalized") return res.status(400).json({ error: "recording isn't finalized yet" });

    const segments = Array.isArray(req.body.segments) ? req.body.segments : [];
    const valid = segments.every(
      (s) => Array.isArray(s) && s.length === 2 && typeof s[0] === "number" && typeof s[1] === "number" && s[1] > s[0]
    );
    if (!segments.length || !valid) {
      return res.status(400).json({ error: "segments must be a non-empty array of [start, end] pairs with end > start" });
    }

    const sourcePath = path.join(UPLOAD_DIR, rec.file_path);
    const workDir = path.join(UPLOAD_DIR, `_work_${crypto.randomUUID()}`);
    fs.mkdirSync(workDir, { recursive: true });
    try {
      const segFiles = [];
      for (let i = 0; i < segments.length; i++) {
        const [s, e] = segments[i];
        const segPath = path.join(workDir, `seg${i}.mp4`);
        await new Promise((resolve, reject) => {
          ffmpeg(sourcePath)
            .setStartTime(s)
            .duration(e - s)
            .outputOptions(["-c:v libx264", "-preset ultrafast", "-crf 23", "-c:a aac"])
            .save(segPath)
            .on("end", resolve)
            .on("error", reject);
        });
        segFiles.push(segPath);
      }

      const listPath = path.join(workDir, "list.txt");
      fs.writeFileSync(listPath, segFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));

      const outFilename = `${crypto.randomUUID()}.mp4`;
      const outPath = path.join(UPLOAD_DIR, outFilename);
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(listPath)
          .inputOptions(["-f concat", "-safe 0"])
          .outputOptions(["-c copy"])
          .save(outPath)
          .on("end", resolve)
          .on("error", reject);
      });

      const fileSize = fs.statSync(outPath).size;
      const newDurationSec = Math.round(segments.reduce((sum, [s, e]) => sum + (e - s), 0));
      const id = crypto.randomUUID();
      const title = req.body.title || `${rec.title} (trimmed)`;
      db.prepare(
        "INSERT INTO recordings (id, title, type, duration_sec, mime_type, file_path, file_size, edited, status, created_at) VALUES (?, ?, ?, ?, 'video/mp4', ?, ?, 1, 'finalized', ?)"
      ).run(id, title, rec.type, newDurationSec, outFilename, fileSize, Date.now());

      res.status(201).json(toRecordingDTO(db.prepare("SELECT * FROM recordings WHERE id = ?").get(id)));
    } finally {
      fs.rm(workDir, { recursive: true, force: true }, () => {});
    }
  })
);

// -------------------------------------------------------------- audio cleanup
// One-click noise reduction (afftdn — a general spectral denoiser, no manual
// noise-sample step needed) + loudness normalization (loudnorm), leaving the
// video stream untouched. The audio codec has to match the container the
// video stream is being copied into unchanged (WebM can't hold AAC, MP4
// doesn't take Opus), so it's picked from the source's own mime type rather
// than hardcoded.
app.post(
  "/api/recordings/:id/audio-cleanup",
  requireAuth,
  expensiveLimiter,
  asyncRoute(async (req, res) => {
    const rec = db.prepare("SELECT * FROM recordings WHERE id = ?").get(req.params.id);
    if (!rec) return res.status(404).json({ error: "not found" });
    if (rec.status !== "finalized") return res.status(400).json({ error: "recording isn't finalized yet" });

    const sourcePath = path.join(UPLOAD_DIR, rec.file_path);
    const outExt = extFor("", rec.mime_type);
    const audioCodec = outExt === ".webm" ? "libopus" : "aac";
    const outFilename = `${crypto.randomUUID()}${outExt}`;
    const outPath = path.join(UPLOAD_DIR, outFilename);

    await new Promise((resolve, reject) => {
      ffmpeg(sourcePath)
        .audioFilters(["afftdn", "loudnorm"])
        .outputOptions(["-c:v copy", `-c:a ${audioCodec}`])
        .save(outPath)
        .on("end", resolve)
        .on("error", reject);
    });

    const fileSize = fs.statSync(outPath).size;
    const id = crypto.randomUUID();
    const title = req.body.title || `${rec.title} (audio cleaned up)`;
    db.prepare(
      "INSERT INTO recordings (id, title, type, duration_sec, mime_type, file_path, file_size, edited, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'finalized', ?)"
    ).run(id, title, rec.type, rec.duration_sec, rec.mime_type, outFilename, fileSize, Date.now());

    res.status(201).json(toRecordingDTO(db.prepare("SELECT * FROM recordings WHERE id = ?").get(id)));
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

      const segments = await transcribeAudio(audioPath, apiKey);
      const translatedSegments = await translateSegments(segments, targetLang, apiKey);
      const fullTranslatedText = translatedSegments.map((s) => s.translatedText).join(" ");
      await synthesizeSpeech(fullTranslatedText, ttsPath, apiKey);

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(sourcePath)
          .input(ttsPath)
          .outputOptions(["-map 0:v:0", "-map 1:a:0", "-c:v copy", "-shortest"])
          .save(outPath)
          .on("end", resolve)
          .on("error", reject);
      });

      // The dubbed narration is one continuous TTS pass (see synthesizeSpeech
      // below) rather than timed per segment, so these captions track the
      // ORIGINAL spoken timing — close for the first stretch of a video but
      // free to drift from the new narration's pace over a long one.
      // Per-segment timed dubbing (Phase 2) is what actually fixes that.
      const vttFilename = `${crypto.randomUUID()}.vtt`;
      const vttPath = path.join(UPLOAD_DIR, vttFilename);
      fs.writeFileSync(vttPath, buildVtt(translatedSegments));

      if (recordingId) {
        db.prepare("INSERT INTO translations (recording_id, lang, file_path, vtt_path, created_at) VALUES (?, ?, ?, ?, ?)").run(
          recordingId,
          targetLang,
          outFilename,
          vttFilename,
          Date.now()
        );
      }

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("X-Share-Url", shareUrl(outFilename));
      res.setHeader("X-Captions-Url", shareUrl(vttFilename));
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
  form.append("response_format", "verbose_json"); // gets per-segment timestamps, not just one blob of text
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, ...form.getHeaders() },
    body: form,
  });
  if (!res.ok) throw new Error(`transcription failed: ${await res.text()}`);
  const json = await res.json();
  return json.segments || [];
}

// Translated sentence-by-sentence (rather than one whole-transcript call) so
// each segment keeps its own original timing for captions, and a mistake in
// one sentence's translation doesn't risk the model losing its place across
// a whole lesson's worth of text.
async function translateSegments(segments, targetLang, apiKey) {
  const translated = [];
  for (const seg of segments) {
    const text = (seg.text || "").trim();
    if (!text) {
      translated.push({ start: seg.start, end: seg.end, translatedText: "" });
      continue;
    }
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `Translate the user's lesson transcript sentence into language code "${targetLang}". Keep the tone natural and spoken, suitable for a teacher addressing students. Return only the translated text, nothing else.`,
          },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) throw new Error(`translation failed: ${await res.text()}`);
    const json = await res.json();
    translated.push({ start: seg.start, end: seg.end, translatedText: json.choices[0].message.content.trim() });
  }
  return translated;
}

function formatVttTime(seconds) {
  const clamped = Math.max(0, seconds || 0);
  const ms = Math.round((clamped % 1) * 1000);
  const totalSec = Math.floor(clamped);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function buildVtt(translatedSegments) {
  const lines = ["WEBVTT", ""];
  translatedSegments.forEach((seg, i) => {
    if (!seg.translatedText) return;
    lines.push(String(i + 1));
    lines.push(`${formatVttTime(seg.start)} --> ${formatVttTime(seg.end)}`);
    lines.push(seg.translatedText);
    lines.push("");
  });
  return lines.join("\n");
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
app.use("/api", (req, res) => res.status(404).json({ error: "not found" }));
app.use((req, res) => res.status(404).send("Not found"));
app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  res.status(500).json({ error: err.message || "internal server error" });
});

app.listen(PORT, () => console.log(`Chit & Chat studio server listening on http://localhost:${PORT}`));
