# Chit & Chat — Recording Station

A self-contained recording studio for teachers: draw on a whiteboard, record
lessons with a teleprompter script on the side, cut out mistakes, add music
or a voice-over, prepend your intro clip, translate for students abroad, and
send it all out — under your own brand.

## Running it

This app is a static front end (`public/`) plus a small Node/Express server
(`server/`) — the server is no longer optional. It serves the front end
itself, stores every recording and the student roster (SQLite, not a flat
file), handles the login you use to get in, and does anything that needs a
secret key (translation, emailing) so that key never has to live in browser
JavaScript.

```
cd server
cp .env.example .env   # fill in DATA_DIR, TEACHER_EMAIL, TEACHER_PASSWORD, SESSION_SECRET at minimum
npm install
npm start               # listens on http://localhost:8787
```

Open `http://localhost:8787` and log in with the `TEACHER_EMAIL` /
`TEACHER_PASSWORD` you set — that account is created automatically the
first time the server starts with both of those set. Translation and email
sending stay optional and degrade gracefully: pages tell you exactly what's
missing (`OPENAI_API_KEY`, `SMTP_HOST`, etc.) if you haven't set them yet.

### Deploying (Railway)

The server + SQLite database + uploaded video files are designed to run as
one small always-on service:

1. Create a Railway service from this repo (Nixpacks builds it automatically
   — no Dockerfile needed) and add one **Volume**, mounted at a path of your
   choice (e.g. `/data`).
2. Set `DATA_DIR` to that mount path, plus `TEACHER_EMAIL`,
   `TEACHER_PASSWORD`, `SESSION_SECRET`, and `PUBLIC_BASE_URL` (your
   Railway-assigned URL). Add `OPENAI_API_KEY` / `SMTP_*` if you want
   translation and email sending.
3. Deploy. The teacher account is seeded on first boot; log in at your
   Railway URL from then on.

Since the Volume holds both the database and every uploaded/rendered video,
a redeploy or restart doesn't lose anything — only deleting the Volume
itself would.

### Backend security

Every `/api/*` route (aside from `/api/health`, `/api/login`, and
`/share/*`) requires being logged in as the one teacher account — a signed
session cookie set by `/api/login`, checked on every request. `/share/*`
links stay intentionally public, since that's what makes them usable as
links you send students. Uploads are capped at 5GB/file (effectively
unbounded — the real ceiling is your disk), and `/api/send` +
`/api/translate` are rate-limited (20 requests/15 min per IP) since both
cost real money or send real email; the chunk-upload routes used while
recording get their own, much roomier limit so a long lesson never trips
the general one.

### Backend API

| Route | Auth | What |
|---|---|---|
| `GET /api/health` | — | Status + which features are configured |
| `POST /api/login` / `POST /api/logout` / `GET /api/me` | — / ✓ / ✓ | Session login for the one teacher account |
| `GET/POST/DELETE /api/students` | ✓ | Roster CRUD |
| `GET/POST/PATCH/DELETE /api/recordings` | ✓ | Library CRUD (`POST` accepts a multipart `video` file + title/type/durationSec/mimeType) |
| `PUT /api/recordings/:id/chunk` | ✓ | One indexed part of an in-progress recording upload (`?seq=`, raw body) |
| `POST /api/recordings/:id/finalize` | ✓ | Assembles all uploaded parts into the finished recording |
| `POST /api/recordings/:id/trim` | ✓ | Cuts-only edit: extracts and concats `{segments: [[start,end],...]}` server-side, saved as a new recording |
| `GET /share/:file` | — (public link) | Streams a stored video/translation/captions file, with byte-range support for scrubbing |
| `POST /api/send` | ✓ | Emails (or returns a share link for) a lesson to selected students — pass `recordingId` to reference an existing recording |
| `POST /api/translate` | ✓ | Transcribe → translate → synthesize narration for an existing `recordingId`; saves the dubbed video and a `.vtt` captions file into that recording's translations |

## What's in here

| Page | What it does |
|---|---|
| `index.html` | Dashboard / quick links |
| `login.html` | Sign in as the one teacher account |
| `studio.html` | Whiteboard + camera recording + teleprompter |
| `editor.html` | Cut mistakes, voice-over, background music, intro clip, translate, export |
| `library.html` | Every recording — download, rename, delete, send |
| `students.html` | Roster + "send this lesson to selected students" |
| `settings.html` | Brand kit (colours + logo) |

### Whiteboard
Fabric.js-based canvas: pencil with a colour palette and adjustable size, an
eraser, an editable/resizable text tool, image insertion (drag in a photo or
screenshot), undo/redo, and clear.

### Recording — no length limit
The whiteboard canvas and your webcam are composited onto an output canvas
every frame and captured with `MediaRecorder`. Every ~2-second chunk is
written to IndexedDB (a local safety net) **and** streamed straight to the
server as its own indexed part file, so a long lesson is never held
entirely in browser memory or IndexedDB — the server assembles the parts
into the finished recording the moment you hit Stop. Pick a layout: camera
as picture-in-picture (either corner), side-by-side, whiteboard only, or
camera only.

### Teleprompter script
Paste text, or upload a `.txt`/`.pdf`. It sits in a sidebar (or move it to
the top) so you can read from it *while* the camera is rolling. **It's never
part of the recording** — only the whiteboard + camera composite gets
captured, and the script panel is a separate part of the page entirely. If
you also screen-share elsewhere and want it fully gone from your own screen
too during recording, tick "Hide from my screen too while recording."

### Editor
Mark cut-in/cut-out points on the video to remove filler or mistakes. If
cuts are the *only* edit you're making, they're extracted and stitched back
together on the server directly from the stored recording — fast, and no
need to pull a long video back into the browser first. Add a saved
intro/greeting clip to prepend, record a voice-over separately to mix in,
or bring your own background music track (Chit & Chat doesn't ship any) —
combining any of those with cuts runs client-side via `ffmpeg.wasm` instead,
so it can take a while on a long recording. Either way, the edited result is
saved to your library as a new recording (the original stays untouched).

### Translation
Sends an existing recording to the backend, which: transcribes the audio
with per-sentence timing (Whisper), translates it sentence-by-sentence
(GPT), synthesizes the translated narration (TTS), and replaces the
original audio track — saving both the dubbed video and a `.vtt` captions
file into that recording's translations. **Known limitation:** the dubbed
narration is one continuous pass rather than timed per sentence, so it
doesn't attempt lip-sync or pacing — it plays start-to-finish with the
shortest of the two tracks winning, and the captions (timed to the
*original* speech) can drift from the new narration's pace over a long
video. This needs `OPENAI_API_KEY` set in `server/.env`; swap in a
different provider in `server/server.js` if you prefer one.

### Sending to students
Add students under **Students**. From the Library or Editor, hit **Send** to
pick recipients. With SMTP configured, they get an email with a link.
Without it, you get a share link to send yourself, or you can just
download and send the file directly.

### Brand kit
`settings.html` lets you set primary/secondary/accent/header colours and
upload a logo — applied everywhere via CSS custom properties (see `:root`
in `css/style.css` for the raw variables). Defaults to the same
purple/mint palette used across the other Chit & Chat apps.

## Known limitations (v2 MVP)

- Voice-over mixing, background music mixing, and format export still run
  entirely in the browser via `ffmpeg.wasm` — a multi-hour recording using
  any of those will be slow to render, since `ffmpeg.wasm` is
  single-threaded WASM, not a real server-side encoder. Cuts alone don't
  have this limitation (see Editor, above).
- Translation replaces narration rather than dubbing with lip-synced,
  per-sentence timing.
- Single teacher account by design — intentionally simple for a
  one-teacher setup, not a multi-teacher SaaS (the database schema leaves
  room for that later, but there's no UI for it yet).
- A chunk that fails to upload live is retried once when you hit Stop, and
  a recording whose upload never fully completes shows up in the Library as
  "still uploading" rather than silently vanishing — but there's no
  automatic resume if you close the tab mid-recording with the server
  unreachable the whole time (the data stays in that browser's IndexedDB,
  just not yet reachable from the UI).
- Background music must be supplied by you (licensing).
