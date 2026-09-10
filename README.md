# Chit & Chat — Recording Station

A self-contained recording studio for teachers: draw on a whiteboard, record
lessons with a teleprompter script on the side, cut out mistakes, add music
or a voice-over, prepend your intro clip, translate for students abroad, and
send it all out — under your own brand.

## Running it

There's no build step for the front end. Open `index.html` in a browser
(or serve the folder with any static server, e.g. `npx serve .`), and you
have: the whiteboard, recording, local editing (cuts/voice-over/music/intro),
library, student roster, and brand kit — all working with **no backend at
all**, storing everything in the browser's IndexedDB/localStorage.

The **optional backend** (`server/`) adds everything that genuinely needs a
server: a recordings library and student roster that persist across
devices/browsers (SQLite, not a flat file), emailing/share-links when you
send a lesson, and translation (which needs a secret API key that must never
live in browser JavaScript). To run it:

```
cd server
cp .env.example .env   # fill in whichever keys you have — at minimum, set STUDIO_PASSCODE
npm install
npm start               # listens on http://localhost:8787
```

Then open **Brand Kit** (`settings.html`) in the front end, enter the server
address (default `http://localhost:8787`) and the same passcode, and save —
every page picks it up from there.

Every backend feature degrades gracefully without its key: student adds and
"send" still work locally / with a plain share link if SMTP isn't
configured; translate tells you exactly what's missing if `OPENAI_API_KEY`
isn't set.

### Backend security

The server protects every `/api/*` route with a shared passcode
(`STUDIO_PASSCODE` in `.env`, sent as `Authorization: Bearer <passcode>`) —
without it, **anyone who can reach the server can read/delete your library,
email your students, or spend your OpenAI credits**, so set it before this
server is reachable from anywhere but your own machine. `/api/health` stays
public (so the front end can show a connection status) and `/share/*` links
are intentionally public too — that's what makes them usable as links you
send students. Uploads are capped at 5GB/file (effectively unbounded — the
real ceiling is your disk), and `/api/send` + `/api/translate` are
rate-limited (20 requests/15 min per IP) since both cost real money or send
real email.

### Backend API

| Route | Auth | What |
|---|---|---|
| `GET /api/health` | — | Status + which features are configured |
| `GET/POST/DELETE /api/students` | ✓ | Roster CRUD |
| `GET/POST/PATCH/DELETE /api/recordings` | ✓ | Cloud library CRUD (`POST` accepts a multipart `video` file + title/type/durationSec/mimeType) |
| `GET /share/:file` | — (public link) | Streams a stored video/translation, with byte-range support for scrubbing |
| `POST /api/send` | ✓ | Emails (or returns a share link for) a lesson to selected students — pass either a `video` file or an existing `recordingId` to avoid re-uploading |
| `POST /api/translate` | ✓ | Transcribe → translate → synthesize narration; pass `recordingId` to also save the result into that recording's cloud translations |

## What's in here

| Page | What it does |
|---|---|
| `index.html` | Dashboard / quick links |
| `studio.html` | Whiteboard + camera recording + teleprompter |
| `editor.html` | Cut mistakes, voice-over, background music, intro clip, translate, export |
| `library.html` | All saved recordings (local + cloud) — download, rename, delete, backup, send |
| `students.html` | Roster + "send this lesson to selected students" |
| `settings.html` | Brand kit (colours + logo) + backend connection (server address + passcode) |

### Whiteboard
Fabric.js-based canvas: pencil with a colour palette and adjustable size, an
eraser, an editable/resizable text tool, image insertion (drag in a photo or
screenshot), undo/redo, and clear.

### Recording — no length limit
The whiteboard canvas and your webcam are composited onto an output canvas
every frame and captured with `MediaRecorder`. Chunks are flushed to
IndexedDB every 2 seconds as they're recorded, so recording length is bounded
only by your disk space, not by JavaScript memory. Pick a layout: camera as
picture-in-picture (either corner), side-by-side, whiteboard only, or camera
only.

### Teleprompter script
Paste text, or upload a `.txt`/`.pdf`. It sits in a sidebar (or move it to
the top) so you can read from it *while* the camera is rolling. **It's never
part of the recording** — only the whiteboard + camera composite gets
captured, and the script panel is a separate part of the page entirely. If
you also screen-share elsewhere and want it fully gone from your own screen
too during recording, tick "Hide from my screen too while recording."

### Editor
Mark cut-in/cut-out points on the video to remove filler or mistakes — the
kept segments are stitched back together. Add a saved intro/greeting clip to
prepend. Record a voice-over separately and mix it into the lesson's audio.
Upload your own background music track (Chit & Chat doesn't ship any —
bring your own royalty-free track) and set its mix volume. Export as MP4 or
WebM. All of this runs client-side via `ffmpeg.wasm` — no server needed, but
long videos will take a while to render since it's running in the browser.

### Translation
Sends the video to the backend, which: transcribes the audio (Whisper),
translates the transcript to your target language (GPT), synthesizes the
translated narration (TTS), and replaces the original audio track. **Known
limitation:** it doesn't attempt lip-sync or pacing — translated narration
plays start-to-finish with the shortest of the two tracks winning, which
works well for voiceover-style teaching but won't match your mouth movements
in the camera feed. This needs `OPENAI_API_KEY` set in `server/.env`; swap
in a different provider in `server/server.js` if you prefer one.

### Cloud library
`library.html` also shows a **Cloud library** — recordings you've backed up
to the server (SQLite + files on disk), reachable from any device once
you're pointed at the same backend. Hit "Backup to cloud" on any local
recording to push it up; cloud recordings can be downloaded, deleted, or
sent to students directly from there without re-uploading.

### Sending to students
Add students under **Students**. From the Library or Editor, hit **Send** to
pick recipients. With the backend + SMTP configured, they get an email with
a link. Without it, you get a share link to send yourself, or you can just
download and send the file directly.

### Brand kit
`settings.html` lets you set primary/secondary/accent/header colours and
upload a logo — applied everywhere via CSS custom properties (see
`:root` in `css/style.css` for the raw variables and current placeholder
values).

## Known limitations (v1)

- Recording and editing run entirely in the browser — very long sessions
  (multi-hour) will be slow to render in the Editor since `ffmpeg.wasm` is
  single-threaded WASM, not a real server-side encoder.
- Translation replaces narration rather than dubbing with lip-sync.
- Auth is a single shared passcode, not per-user accounts — intentionally
  simple for a single-teacher setup, not a multi-teacher SaaS.
- Background music must be supplied by you (licensing).
