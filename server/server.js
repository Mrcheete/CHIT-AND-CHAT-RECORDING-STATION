// Optional backend for the Chit & Chat recording studio.
// The front end (studio.html / editor.html / library.html) works entirely
// standalone in the browser for whiteboard, recording, and local editing.
// This server only exists for the parts that genuinely need one:
//   - a student roster that persists across devices
//   - share links / emailing a lesson to students
//   - translation (needs a server-side API key, never expose it in the browser)
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const ffmpegPath = require("ffmpeg-static");
const ffmpeg = require("fluent-ffmpeg");
const FormData = require("form-data");
const fetch = require("node-fetch");

ffmpeg.setFfmpegPath(ffmpegPath);

const PORT = process.env.PORT || 8787;
const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const STUDENTS_FILE = path.join(DATA_DIR, "students.json");
[DATA_DIR, UPLOAD_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));
if (!fs.existsSync(STUDENTS_FILE)) fs.writeFileSync(STUDENTS_FILE, "[]");

const app = express();
app.use(cors()); // static front end is opened from file:// or a plain localhost port — allow any origin
app.use(express.json());
app.use("/share", express.static(UPLOAD_DIR));

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 5 * 1024 * 1024 * 1024 } }); // 5GB, i.e. effectively no cap

function readStudents() {
  return JSON.parse(fs.readFileSync(STUDENTS_FILE, "utf8"));
}
function writeStudents(list) {
  fs.writeFileSync(STUDENTS_FILE, JSON.stringify(list, null, 2));
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

// ---------------------------------------------------------------- students
app.get("/api/students", (req, res) => res.json(readStudents()));

app.post("/api/students", (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: "name and email are required" });
  const list = readStudents();
  const student = { id: Date.now(), name, email };
  list.push(student);
  writeStudents(list);
  res.json(list);
});

app.delete("/api/students/:id", (req, res) => {
  const list = readStudents().filter((s) => String(s.id) !== req.params.id);
  writeStudents(list);
  res.json(list);
});

// -------------------------------------------------------------------- send
app.post("/api/send", upload.single("video"), async (req, res) => {
  try {
    const { title } = req.body;
    const students = JSON.parse(req.body.students || "[]");
    if (!req.file) return res.status(400).json({ error: "no video uploaded" });
    if (!students.length) return res.status(400).json({ error: "no students selected" });

    const ext = path.extname(req.file.originalname) || ".mp4";
    const finalName = `${crypto.randomUUID()}${ext}`;
    fs.renameSync(req.file.path, path.join(UPLOAD_DIR, finalName));
    const shareUrl = `${process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`}/share/${finalName}`;

    const transporter = mailer();
    if (transporter) {
      await Promise.all(
        students.map((s) =>
          transporter.sendMail({
            from: process.env.SMTP_FROM || "Chit & Chat <hello@example.com>",
            to: s.email,
            subject: `New lesson: ${title}`,
            text: `Hi ${s.name},\n\nYour teacher just sent you a new lesson: "${title}".\n\nWatch/download it here:\n${shareUrl}\n\nSee you in class!`,
          })
        )
      );
      return res.json({ ok: true, emailed: true, shareUrl });
    }

    res.json({ ok: true, emailed: false, shareUrl, note: "SMTP not configured — share this link yourself." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------- translate
app.post("/api/translate", upload.single("video"), async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(400).send("OPENAI_API_KEY is not configured on the server (server/.env).");
  if (!req.file) return res.status(400).send("no video uploaded");

  const targetLang = req.body.targetLang || "es";
  const workDir = req.file.path + "_work";
  fs.mkdirSync(workDir, { recursive: true });
  const audioPath = path.join(workDir, "audio.mp3");
  const ttsPath = path.join(workDir, "translated_audio.mp3");
  const outPath = path.join(workDir, "output.mp4");

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(req.file.path).noVideo().audioCodec("libmp3lame").save(audioPath).on("end", resolve).on("error", reject);
    });

    const transcript = await transcribeAudio(audioPath, apiKey);
    const translatedText = await translateText(transcript, targetLang, apiKey);
    await synthesizeSpeech(translatedText, ttsPath, apiKey);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(req.file.path)
        .input(ttsPath)
        .outputOptions(["-map 0:v:0", "-map 1:a:0", "-c:v copy", "-shortest"])
        .save(outPath)
        .on("end", resolve)
        .on("error", reject);
    });

    res.setHeader("Content-Type", "video/mp4");
    fs.createReadStream(outPath).pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).send("Translation failed: " + err.message);
  } finally {
    setTimeout(() => fs.rm(workDir, { recursive: true, force: true }, () => {}), 5000);
    fs.rm(req.file.path, { force: true }, () => {});
  }
});

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

app.listen(PORT, () => console.log(`Chit & Chat studio server listening on http://localhost:${PORT}`));
