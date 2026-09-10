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

The **optional backend** (`server/`) adds three things that genuinely need a
server: a roster that persists across devices, emailing/share-links when you
send a lesson, and translation (which needs a secret API key that must never
live in browser JavaScript). To run it:

```
cd server
cp .env.example .env   # fill in whichever keys you have
npm install
npm start               # listens on http://localhost:8787
```

Every backend feature degrades gracefully without its key: student adds and
"send" still work locally / with a plain share link if SMTP isn't
configured; translate tells you exactly what's missing if `OPENAI_API_KEY`
isn't set.

## What's in here

| Page | What it does |
|---|---|
| `index.html` | Dashboard / quick links |
| `studio.html` | Whiteboard + camera recording + teleprompter |
| `editor.html` | Cut mistakes, voice-over, background music, intro clip, translate, export |
| `library.html` | All saved recordings — download, rename, delete, send |
| `students.html` | Roster + "send this lesson to selected students" |
| `settings.html` | Brand kit: colours + logo |

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
- No user accounts/auth yet — the student roster and share links are
  intentionally simple for a single-teacher setup.
- Background music must be supplied by you (licensing).
