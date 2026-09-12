const params = new URLSearchParams(location.search);
const RECORDING_ID = params.get("id");

let currentRecording = null;
let cuts = []; // [{start, end}]
let markIn = null;
let speedChanges = []; // [{start, end, speed}] — speed > 1 speeds up, < 1 slows down
let speedMarkIn = null;
let voiceovers = []; // [{id, blob, ext, startAt, trimStart, trimEnd, durationSec, previewUrl}]
let voIdSeq = 0;
let voRecorder = null;
let musicFile = null;
let ffmpeg = null;
let timelineDragStart = null; // seconds, while dragging a new cut on the timeline
let timelineDragCurrent = null;
let chapters = []; // [{id, timeSec, label}]

const $ = (id) => document.getElementById(id);

// Some recorded WebM files never got a proper duration written into their
// header (a known MediaRecorder quirk) — the video element then reports
// Infinity until manually seeked near the end, which silently poisons any
// cut/segment math built on it (Infinity survives arithmetic fine, but
// becomes `null` the moment it's JSON.stringify'd for the server, which is
// exactly what "segments must be ... pairs with end > start" was seeing).
// The duration recorded at upload time is reliable, so fall back to it.
function getVideoDuration() {
  const d = $("preview").duration;
  if (Number.isFinite(d) && d > 0) return d;
  return currentRecording?.durationSec || 0;
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

let fetchFile; // resolved lazily below, once the CDN's FFmpeg global is confirmed present

async function ensureFFmpeg(onProgress) {
  if (ffmpeg && ffmpeg.isLoaded()) return ffmpeg;
  // The FFmpeg global comes from a CDN <script> tag — reading it only here
  // (not at page load) means a CDN hiccup only breaks this one feature
  // (voice-over/music mixing, intro clips, format export) instead of
  // crashing the whole editor page before anything else can run.
  if (typeof FFmpeg === "undefined") {
    throw new Error("The video editor couldn't load (check your internet connection and reload) — cuts-only trims still work fine without it.");
  }
  fetchFile = FFmpeg.fetchFile;
  const instance = FFmpeg.createFFmpeg({
    log: true,
    corePath: "https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js",
    progress: ({ ratio }) => onProgress && onProgress(Math.min(1, Math.max(0, ratio))),
  });
  const logEl = $("ffmpeg-log");
  logEl.style.display = "block";
  instance.setLogger(({ message }) => {
    logEl.textContent += message + "\n";
    logEl.scrollTop = logEl.scrollHeight;
  });
  // Only assign the shared `ffmpeg` variable once load() actually succeeds —
  // if it's assigned beforehand and load() then fails partway (a slow/blocked
  // CDN, a dropped connection), every render attempt afterward sees a
  // non-null `ffmpeg` above and skips loading entirely, straight into
  // "ffmpeg.wasm is not ready" on the very first command — permanently, for
  // the rest of the page's life, since nothing here ever went back to null.
  await instance.load();
  ffmpeg = instance;
  return ffmpeg;
}

// ffmpeg.wasm's run() does NOT reject when the real ffmpeg process fails
// internally (a bad filtergraph, an unsupported stream, anything) — it just
// logs the error and resolves normally, as if nothing went wrong. Left
// unchecked, a failed step would either surface as a confusing error several
// steps later, or — since the same ffmpeg instance's virtual filesystem now
// persists across repeated Apply & Render attempts — silently read back a
// STALE file of the same name left over from an earlier, actually-successful
// attempt, shipping old content (or none) as if the latest render worked.
// clearOutput() removes any leftover file before a step runs, so a failure
// can't hide behind old data; readOutput() then confirms the step actually
// produced something real, or throws a clear, specific error instead of
// silently continuing with whatever happens to exist.
function clearOutput(ff, filename) {
  try {
    ff.FS("unlink", filename);
  } catch {
    // wasn't there — nothing to clear
  }
}

function readOutput(ff, filename, stepLabel) {
  let data;
  try {
    data = ff.FS("readFile", filename);
  } catch {
    throw new Error(`${stepLabel} didn't produce any output — check the render log above for the actual ffmpeg error.`);
  }
  if (!data || data.length === 0) {
    throw new Error(`${stepLabel} produced an empty file — check the render log above for the actual ffmpeg error.`);
  }
  return data;
}

function setProgress(ratio) {
  $("progress-fill").style.width = `${Math.round(ratio * 100)}%`;
}

function renderCutList() {
  const list = $("cut-list");
  if (!cuts.length) {
    list.innerHTML = `<p class="script-note">No cuts marked yet — drag on the bar above (or play the video, mark a start and end), then "Add cut".</p>`;
  } else {
    list.innerHTML = "";
    cuts
      .sort((a, b) => a.start - b.start)
      .forEach((c, i) => {
        const row = document.createElement("div");
        row.className = "clip-row";
        row.innerHTML = `<span>✂️ ${fmtTime(c.start)} → ${fmtTime(c.end)}</span><span class="spacer"></span>`;
        const rm = document.createElement("button");
        rm.className = "btn btn-sm btn-ghost";
        rm.textContent = "Remove";
        rm.onclick = () => {
          cuts.splice(i, 1);
          renderCutList();
        };
        row.appendChild(rm);
        list.appendChild(row);
      });
  }
  renderTimeline();
}

function renderSpeedList() {
  const list = $("speed-list");
  if (!speedChanges.length) {
    list.innerHTML = `<p class="script-note">No speed changes yet — mark a start and end above, pick a speed, then "Add speed change".</p>`;
  } else {
    list.innerHTML = "";
    speedChanges
      .sort((a, b) => a.start - b.start)
      .forEach((sc, i) => {
        const row = document.createElement("div");
        row.className = "clip-row";
        row.innerHTML = `<span>⏩ ${fmtTime(sc.start)} → ${fmtTime(sc.end)} at ${sc.speed}×</span><span class="spacer"></span>`;
        const rm = document.createElement("button");
        rm.className = "btn btn-sm btn-ghost";
        rm.textContent = "Remove";
        rm.onclick = () => {
          speedChanges.splice(i, 1);
          renderSpeedList();
        };
        row.appendChild(rm);
        list.appendChild(row);
      });
  }
  renderTimeline();
}

function renderTimeline() {
  const track = $("cut-timeline");
  const duration = getVideoDuration();
  track.querySelectorAll(".timeline-cut, .timeline-speed, .timeline-vo").forEach((el) => el.remove());
  if (!duration) return;

  cuts.forEach((c, i) => {
    const rect = document.createElement("div");
    rect.className = "timeline-cut";
    rect.style.left = `${(c.start / duration) * 100}%`;
    rect.style.width = `${Math.max(0.3, ((c.end - c.start) / duration) * 100)}%`;
    rect.title = `${fmtTime(c.start)} → ${fmtTime(c.end)} — click to remove`;
    rect.addEventListener("click", (e) => {
      e.stopPropagation();
      cuts.splice(i, 1);
      renderCutList();
    });
    track.appendChild(rect);
  });

  speedChanges.forEach((sc, i) => {
    const rect = document.createElement("div");
    rect.className = "timeline-speed";
    rect.style.left = `${(sc.start / duration) * 100}%`;
    rect.style.width = `${Math.max(0.3, ((sc.end - sc.start) / duration) * 100)}%`;
    rect.textContent = `${sc.speed}×`;
    rect.title = `${fmtTime(sc.start)} → ${fmtTime(sc.end)} at ${sc.speed}× — click to remove`;
    rect.addEventListener("click", (e) => {
      e.stopPropagation();
      speedChanges.splice(i, 1);
      renderSpeedList();
    });
    track.appendChild(rect);
  });

  // Voice-overs get a draggable marker rather than a click-to-remove one —
  // grabbing it anywhere and moving the pointer sets its start to wherever
  // the pointer lands, which is the actual "drag the audio onto the video
  // where I want it" interaction, no typed-in second required.
  voiceovers.forEach((vo) => {
    const rect = document.createElement("div");
    rect.className = "timeline-vo";
    const voDur = Math.max((vo.trimEnd ?? vo.durationSec ?? 2) - vo.trimStart, 0.3);
    rect.style.left = `${(vo.startAt / duration) * 100}%`;
    rect.style.width = `${Math.max(0.6, (voDur / duration) * 100)}%`;
    rect.title = `Voice-over starting at ${fmtTime(vo.startAt)} — drag to reposition`;
    rect.textContent = "🎙️";
    rect.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      const onMove = (ev) => {
        vo.startAt = Math.round(timelineTimeFromEvent(ev) * 10) / 10;
        renderTimeline();
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        renderVoiceoverList(); // syncs the "Starts at" field to the dropped position
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    track.appendChild(rect);
  });

  if (timelineDragStart !== null && timelineDragCurrent !== null) {
    const s = Math.min(timelineDragStart, timelineDragCurrent);
    const e = Math.max(timelineDragStart, timelineDragCurrent);
    const preview = document.createElement("div");
    preview.className = "timeline-cut timeline-cut-preview";
    preview.style.left = `${(s / duration) * 100}%`;
    preview.style.width = `${((e - s) / duration) * 100}%`;
    track.appendChild(preview);
  }
}

function timelineTimeFromEvent(e) {
  const track = $("cut-timeline");
  const rect = track.getBoundingClientRect();
  const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
  const duration = getVideoDuration();
  return rect.width ? (x / rect.width) * duration : 0;
}

function setupTimeline() {
  const track = $("cut-timeline");
  track.addEventListener("pointerdown", (e) => {
    if (!getVideoDuration()) return;
    timelineDragStart = timelineTimeFromEvent(e);
    timelineDragCurrent = timelineDragStart;
    renderTimeline();
  });
  window.addEventListener("pointermove", (e) => {
    if (timelineDragStart === null) return;
    timelineDragCurrent = timelineTimeFromEvent(e);
    renderTimeline();
  });
  window.addEventListener("pointerup", () => {
    if (timelineDragStart === null) return;
    const s = Math.min(timelineDragStart, timelineDragCurrent);
    const e = Math.max(timelineDragStart, timelineDragCurrent);
    timelineDragStart = null;
    timelineDragCurrent = null;
    if (e - s > 0.15) {
      cuts.push({ start: s, end: e });
      renderCutList();
    } else {
      renderTimeline();
    }
  });
}

function keepSegments(duration, cutRanges) {
  const sorted = [...cutRanges].sort((a, b) => a.start - b.start);
  const segs = [];
  let cursor = 0;
  for (const c of sorted) {
    if (c.start > cursor) segs.push([cursor, Math.min(c.start, duration)]);
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < duration) segs.push([cursor, duration]);
  return segs.filter(([s, e]) => e - s > 0.05);
}

// ffmpeg's atempo filter only accepts 0.5–2.0 in one step; anything outside
// that (a 4x speed-up, an 0.25x slow-down) needs to be chained as several
// steps that multiply out to the target — e.g. 4x becomes atempo=2,atempo=2.
function buildAtempoChain(factor) {
  const chain = [];
  let remaining = factor;
  while (remaining > 2) {
    chain.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5) {
    chain.push(0.5);
    remaining /= 0.5;
  }
  chain.push(remaining);
  return chain;
}

// Turns the kept (post-cut) stretches of the video into an ordered list of
// pieces to actually render — most at normal speed, any that overlap a
// marked speed change split out on their own with that speed attached. A
// speed change that straddles a cut is simply clipped to whichever kept
// segment it falls in; it can't speed up footage that was removed.
function buildRenderPieces(duration, cutRanges, speedRanges) {
  const kept = keepSegments(duration, cutRanges);
  const pieces = [];
  for (const [s, e] of kept) {
    const ranges = speedRanges
      .map((sc) => ({ start: Math.max(sc.start, s), end: Math.min(sc.end, e), speed: sc.speed }))
      .filter((r) => r.end - r.start > 0.05)
      .sort((a, b) => a.start - b.start);
    let cursor = s;
    for (const r of ranges) {
      if (r.start > cursor) pieces.push({ start: cursor, end: r.start, speed: 1 });
      pieces.push({ start: r.start, end: r.end, speed: r.speed });
      cursor = r.end;
    }
    if (cursor < e) pieces.push({ start: cursor, end: e, speed: 1 });
  }
  return pieces;
}

async function loadRecordingIntoEditor() {
  try {
    currentRecording = await CCApi.json(`/api/recordings/${RECORDING_ID}`);
  } catch {
    currentRecording = null;
  }
  if (!currentRecording) {
    CCBrand.toast("Recording not found — pick one from the Library.");
    return;
  }
  if (currentRecording.status !== "finalized") {
    CCBrand.toast("This recording hasn't finished uploading yet — check the Library.");
    return;
  }
  $("editor-subtitle").textContent = `Editing "${currentRecording.title}"`;
  $("preview").muted = false;
  $("preview").src = currentRecording.url;
  $("preview").addEventListener("timeupdate", () => {
    const preview = $("preview");
    const duration = getVideoDuration();
    $("time-readout").textContent = `${fmtTime(preview.currentTime)} / ${fmtTime(duration)}`;
    if (duration) $("timeline-playhead").style.left = `${(preview.currentTime / duration) * 100}%`;

    // Only while actually playing — paused, a scrub into a cut is someone
    // deliberately checking or adjusting exactly that cut, not something to
    // jump them out of. Playing, it previews the edited result: landing
    // inside a cut (including right at the start, from the first frame)
    // hops straight to what comes after it, same as the real render would.
    if (!preview.paused && duration && cuts.length) {
      const kept = keepSegments(duration, cuts);
      const t = preview.currentTime;
      if (!kept.some(([s, e]) => t >= s && t < e)) {
        const next = kept.find(([s]) => s > t);
        if (next) preview.currentTime = next[0];
        else preview.pause();
      }
    }
  });
  $("preview").addEventListener("loadedmetadata", () => renderTimeline());
  chapters = currentRecording.chapters || [];
  renderChapterList();
}

function renderChapterList() {
  const list = $("chapter-list");
  if (!chapters.length) {
    list.innerHTML = `<p class="script-note">No chapters yet — play to the moment a new topic starts, type a label, and add it.</p>`;
    return;
  }
  list.innerHTML = "";
  chapters
    .slice()
    .sort((a, b) => a.timeSec - b.timeSec)
    .forEach((c) => {
      const row = document.createElement("div");
      row.className = "clip-row";
      row.innerHTML = `<span>📍 ${fmtTime(c.timeSec)} — ${c.label}</span><span class="spacer"></span>`;
      const jump = document.createElement("button");
      jump.className = "btn btn-sm btn-outline";
      jump.textContent = "Jump";
      jump.onclick = () => {
        $("preview").currentTime = c.timeSec;
      };
      const rm = document.createElement("button");
      rm.className = "btn btn-sm btn-ghost";
      rm.textContent = "Remove";
      rm.onclick = async () => {
        chapters = chapters.filter((x) => x !== c);
        await saveChapters();
        renderChapterList();
      };
      row.appendChild(jump);
      row.appendChild(rm);
      list.appendChild(row);
    });
}

async function saveChapters() {
  try {
    const saved = await CCApi.json(`/api/recordings/${currentRecording.id}/chapters`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapters: chapters.map((c) => ({ timeSec: c.timeSec, label: c.label })) }),
    });
    chapters = saved.chapters;
  } catch (err) {
    CCBrand.toast("Couldn't save chapters: " + err.message);
  }
}

async function populateIntroOptions() {
  let intros = [];
  try {
    intros = (await CCApi.json("/api/recordings?type=intro")).filter((r) => r.status === "finalized");
  } catch {
    intros = [];
  }
  const sel = $("intro-select");
  intros.forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = r.title;
    sel.appendChild(opt);
  });
}

function extFor(mimeType) {
  if (!mimeType) return "webm";
  if (mimeType.includes("mp4")) return "mp4";
  return "webm";
}

async function applyEditsAndRender() {
  const applyBtn = $("btn-apply");
  const introId = $("intro-select").value;
  // No intro/voice-over/music to mix in — with or without cuts, this is
  // just "trim (or don't) and maybe change format," which the server
  // already does with real ffmpeg. Reusing that here instead of always
  // reaching for the much slower, less reliable in-browser ffmpeg.wasm
  // pipeline (built for the cases that genuinely do need it: mixing in an
  // intro clip, a voice-over, or background music) is both faster and, for
  // a file whose container has trouble reporting its own duration, doesn't
  // depend on the browser correctly reading that duration at all.
  const noExtras = !introId && !voiceovers.length && !musicFile;

  if (noExtras) {
    applyBtn.disabled = true;
    try {
      const duration = getVideoDuration();
      const pieces = buildRenderPieces(duration, cuts, speedChanges);
      if (!pieces.length) throw new Error("those cuts remove the entire video");
      CCBrand.toast("Rendering on the server…");
      const saved = await CCApi.json(`/api/recordings/${currentRecording.id}/trim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pieces,
          format: $("export-format").value,
          title: `${currentRecording.title} (edited)`,
        }),
      });
      CCBrand.toast("Saved the trimmed video to your library.");
      setTimeout(() => (window.location.href = `editor.html?id=${saved.id}`), 900);
    } catch (err) {
      console.error(err);
      CCBrand.toast("Trim failed: " + err.message);
    } finally {
      applyBtn.disabled = false;
    }
    return;
  }

  applyBtn.disabled = true;
  setProgress(0);
  try {
    const ff = await ensureFFmpeg(setProgress);
    const duration = getVideoDuration();
    const inputExt = extFor(currentRecording.mimeType);
    ff.FS("writeFile", `input.${inputExt}`, await fetchFile(currentRecording.url));

    const pieces = buildRenderPieces(duration, cuts, speedChanges);
    const segFiles = [];
    for (let i = 0; i < pieces.length; i++) {
      const { start: s, end: e, speed } = pieces[i];
      const out = `seg${i}.mp4`;
      const args = ["-i", `input.${inputExt}`, "-ss", String(s), "-to", String(e)];
      if (speed !== 1) {
        args.push("-vf", `setpts=PTS/${speed}`, "-af", buildAtempoChain(speed).map((f) => `atempo=${f}`).join(","));
      }
      args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-c:a", "aac", out);
      clearOutput(ff, out);
      await ff.run(...args);
      readOutput(ff, out, `Trimming piece ${i + 1}`);
      segFiles.push(out);
    }

    // Intro clip, prepended
    if (introId) {
      const introRec = await CCApi.json(`/api/recordings/${introId}`);
      const iExt = extFor(introRec.mimeType);
      ff.FS("writeFile", `intro.${iExt}`, await fetchFile(introRec.url));
      clearOutput(ff, "intro_seg.mp4");
      await ff.run("-i", `intro.${iExt}`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-c:a", "aac", "intro_seg.mp4");
      readOutput(ff, "intro_seg.mp4", "Encoding the intro clip");
      segFiles.unshift("intro_seg.mp4");
    }

    const listTxt = segFiles.map((f) => `file '${f}'`).join("\n");
    ff.FS("writeFile", "list.txt", new TextEncoder().encode(listTxt));
    clearOutput(ff, "merged.mp4");
    await ff.run("-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "merged.mp4");
    readOutput(ff, "merged.mp4", "Joining the trimmed pieces");
    let current = "merged.mp4";

    if (voiceovers.length) {
      // Each voice-over is its own ffmpeg input, trimmed/delayed to its own
      // spot, then all of them plus the video's own audio go through one
      // amix — N voice-overs mix together in a single pass rather than one
      // sequential merge per track.
      const args = ["-i", current];
      const filterParts = [];
      const voLabels = [];
      for (let i = 0; i < voiceovers.length; i++) {
        const vo = voiceovers[i];
        const filename = `voiceover${i}.${vo.ext}`;
        ff.FS("writeFile", filename, await fetchFile(vo.blob));
        args.push("-i", filename);

        const trimStart = Number(vo.trimStart) || 0;
        const trimEnd = vo.trimEnd ? Number(vo.trimEnd) : null;
        const delayMs = Math.round((Number(vo.startAt) || 0) * 1000);
        const trimFilter =
          trimEnd && trimEnd > trimStart
            ? `atrim=start=${trimStart}:end=${trimEnd},asetpts=PTS-STARTPTS`
            : trimStart > 0
              ? `atrim=start=${trimStart},asetpts=PTS-STARTPTS`
              : `anull`;
        const label = `vo${i}`;
        const delayFilter = delayMs > 0 ? `,adelay=${delayMs}:all=1` : "";
        filterParts.push(`[${i + 1}:a]${trimFilter}${delayFilter}[${label}]`);
        voLabels.push(`[${label}]`);
      }
      filterParts.push(`[0:a]${voLabels.join("")}amix=inputs=${voiceovers.length + 1}:duration=first:dropout_transition=2[aout]`);
      args.push(
        "-filter_complex", filterParts.join(";"),
        "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "merged_vo.mp4"
      );
      clearOutput(ff, "merged_vo.mp4");
      await ff.run(...args);
      readOutput(ff, "merged_vo.mp4", "Mixing in the voice-over(s)");
      current = "merged_vo.mp4";
    }

    if (musicFile) {
      const mExt = musicFile.name.split(".").pop();
      ff.FS("writeFile", `music.${mExt}`, await fetchFile(musicFile));
      const vol = Number($("music-volume").value) / 100;
      clearOutput(ff, "merged_music.mp4");
      await ff.run(
        "-i", current, "-i", `music.${mExt}`,
        "-filter_complex", `[1:a]volume=${vol}[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
        "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "merged_music.mp4"
      );
      readOutput(ff, "merged_music.mp4", "Mixing in the background music");
      current = "merged_music.mp4";
    }

    const format = $("export-format").value;
    let finalFile = current;
    if (format === "webm") {
      clearOutput(ff, "output.webm");
      await ff.run("-i", current, "-c:v", "libvpx-vp9", "-c:a", "libopus", "output.webm");
      finalFile = "output.webm";
    } else {
      clearOutput(ff, "output.mp4");
      await ff.run("-i", current, "-c", "copy", "output.mp4");
      finalFile = "output.mp4";
    }

    const data = readOutput(ff, finalFile, "The final export step");
    const mimeType = format === "webm" ? "video/webm" : "video/mp4";
    const outBlob = new Blob([data.buffer], { type: mimeType });

    $("preview").src = URL.createObjectURL(outBlob);
    // Defensive, regardless of whether a voice-over was recorded this
    // session — the rendered result must always be audible, never silently
    // inheriting a stuck mute from an interrupted recording attempt.
    $("preview").muted = false;
    CCBrand.toast("Render complete — saving to your library…");

    // Edits produce a new library entry (same pattern as a translation),
    // rather than overwriting the original recording.
    const form = new FormData();
    form.append("video", outBlob, `edited.${format}`);
    form.append("title", `${currentRecording.title} (edited)`);
    form.append("type", currentRecording.type);
    form.append("durationSec", currentRecording.durationSec || 0);
    form.append("mimeType", mimeType);
    form.append("edited", "1");
    const saved = await CCApi.json("/api/recordings", { method: "POST", body: form });
    CCBrand.toast("Saved as a new recording in your library.");
    setTimeout(() => (window.location.href = `editor.html?id=${saved.id}`), 900);
  } catch (err) {
    console.error(err);
    CCBrand.toast("Render failed: " + err.message);
  } finally {
    applyBtn.disabled = false;
    setProgress(0);
  }
}

// Real duration for a recorded/uploaded audio clip — used both to size its
// timeline marker and to default its trim-end field.
function readAudioDuration(blob) {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      resolve(Number.isFinite(audio.duration) ? audio.duration : 0);
    };
    audio.onerror = () => resolve(0);
    audio.src = URL.createObjectURL(blob);
  });
}

function addVoiceover({ blob, ext, startAt, durationSec }) {
  voiceovers.push({
    id: ++voIdSeq,
    blob,
    ext,
    startAt: Math.round((startAt || 0) * 10) / 10,
    trimStart: 0,
    trimEnd: durationSec ? Math.round(durationSec * 10) / 10 : null,
    durationSec: durationSec || 0,
    previewUrl: URL.createObjectURL(blob),
  });
  renderVoiceoverList();
  renderTimeline();
}

function removeVoiceoverById(id) {
  const vo = voiceovers.find((v) => v.id === id);
  if (vo) URL.revokeObjectURL(vo.previewUrl);
  voiceovers = voiceovers.filter((v) => v.id !== id);
  renderVoiceoverList();
  renderTimeline();
}

function renderVoiceoverList() {
  const list = $("vo-list");
  if (!voiceovers.length) {
    list.innerHTML = `<p class="script-note">No voice-overs yet — record one or upload an audio file, then drag its 🎙️ marker on the timeline above.</p>`;
    return;
  }
  list.innerHTML = "";
  voiceovers.forEach((vo, i) => {
    const row = document.createElement("div");
    row.className = "vo-item";
    row.innerHTML = `
      <div class="vo-item-row">
        <strong>🎙️ Voice-over ${i + 1}</strong>
        <span class="spacer"></span>
        <button class="btn btn-sm btn-ghost" data-action="remove">Remove</button>
      </div>
      <audio controls src="${vo.previewUrl}"></audio>
      <div class="vo-trim-fields">
        <div class="field">
          <label>Starts at (video, sec)</label>
          <input type="number" class="vo-start-at" min="0" step="0.5" value="${vo.startAt}">
        </div>
        <div class="field">
          <label>Trim start (sec)</label>
          <input type="number" class="vo-trim-start" min="0" step="0.5" value="${vo.trimStart}">
        </div>
        <div class="field">
          <label>Trim end (sec)</label>
          <input type="number" class="vo-trim-end" min="0" step="0.5" value="${vo.trimEnd ?? ""}">
        </div>
      </div>
    `;
    row.querySelector('[data-action="remove"]').addEventListener("click", () => removeVoiceoverById(vo.id));
    row.querySelector(".vo-start-at").addEventListener("change", (e) => {
      vo.startAt = Number(e.target.value) || 0;
      renderTimeline();
    });
    row.querySelector(".vo-trim-start").addEventListener("change", (e) => {
      vo.trimStart = Number(e.target.value) || 0;
    });
    row.querySelector(".vo-trim-end").addEventListener("change", (e) => {
      vo.trimEnd = e.target.value ? Number(e.target.value) : null;
      renderTimeline();
    });
    list.appendChild(row);
  });
}

async function toggleVoiceoverRecording() {
  const btn = $("btn-vo-record");
  if (voRecorder && voRecorder.state === "recording") {
    voRecorder.stop();
    $("preview").pause();
    $("preview").muted = false;
    return;
  }
  // echoCancellation left on for the mic itself, but explicitly requested
  // rather than left to default — see the mute below for why it doesn't end
  // up cancelling the narration.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
  const chunks = [];
  // Wherever the video is currently paused is where the narration is meant
  // to land — playing it at the same time it's recorded is what makes that
  // automatic instead of a number to work out and type in afterwards.
  const startAt = getVideoDuration() ? $("preview").currentTime : 0;
  voRecorder = new MediaRecorder(stream);
  voRecorder.ondataavailable = (e) => chunks.push(e.data);
  voRecorder.onstop = async () => {
    // Unmuting here too (not just in the click handler above) guarantees it
    // actually happens whenever a recording really stops, no matter what
    // triggered .stop() — a click landing a beat before MediaRecorder's
    // internal state finished flipping to "recording" would otherwise skip
    // the click handler's branch entirely and leave every video permanently
    // silent for the rest of this page, voice-over or not.
    $("preview").pause();
    $("preview").muted = false;
    const blob = new Blob(chunks, { type: "audio/webm" });
    stream.getTracks().forEach((t) => t.stop());
    btn.textContent = "● Record voice-over (plays the video along with you)";
    btn.classList.remove("btn-danger");
    const durationSec = await readAudioDuration(blob);
    addVoiceover({ blob, ext: "webm", startAt, durationSec });
  };
  voRecorder.start();
  // Muted, not silent to the narrator by choice — playing the video's own
  // audio out loud while the mic is live is exactly what the browser's own
  // echo cancellation looks for to cancel out, and on a laptop's built-in
  // mic/speakers that can quietly cancel the narration right along with it.
  // The video is still visible to narrate along with; only its sound is off.
  $("preview").muted = true;
  $("preview").play();
  btn.textContent = "■ Stop recording";
  btn.classList.add("btn-danger");
}

async function addVoiceoverFromFile(file) {
  const startAt = getVideoDuration() ? $("preview").currentTime : 0;
  const durationSec = await readAudioDuration(file);
  const ext = (file.name.split(".").pop() || "mp3").toLowerCase();
  addVoiceover({ blob: file, ext, startAt, durationSec });
}

// Lets the script be read while narrating a voice-over, same as the
// Studio's recording teleprompter — paste/upload a script, play/pause it
// (button, or Space while not typing), and adjust its scroll speed live.
function setupVoiceoverTeleprompter() {
  const tp = createTeleprompter({ panelEl: $("vo-script-panel"), textEl: $("vo-script-text") });
  $("vo-script-paste").addEventListener("input", (e) => tp.setScript(e.target.value));
  $("vo-script-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.name.endsWith(".pdf")) await tp.loadPdfFile(file);
    else await tp.loadTxtFile(file);
  });
  $("vo-script-font").addEventListener("input", (e) => tp.setFontSize(Number(e.target.value)));

  const btn = $("btn-vo-autoscroll");
  const speedSlider = $("vo-script-speed");
  let on = false;
  let speed = Number(speedSlider.value);

  function toggle() {
    on = !on;
    tp.setAutoScroll(on, speed);
    btn.textContent = on ? "⏸ Pause script" : "▶ Play script";
  }
  btn.addEventListener("click", toggle);
  speedSlider.addEventListener("input", (e) => {
    speed = Number(e.target.value);
    tp.setSpeed(speed);
  });
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "input" || tag === "select") return;
    e.preventDefault();
    toggle();
  });
}

async function cleanUpAudio() {
  const btn = $("btn-audio-cleanup");
  const status = $("audio-cleanup-status");
  btn.disabled = true;
  status.textContent = "Cleaning up audio on the server…";
  try {
    const saved = await CCApi.json(`/api/recordings/${currentRecording.id}/audio-cleanup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `${currentRecording.title} (audio cleaned up)` }),
    });
    status.textContent = "Saved as a new recording in your library.";
    CCBrand.toast("Audio cleanup complete.");
    setTimeout(() => (window.location.href = `editor.html?id=${saved.id}`), 900);
  } catch (err) {
    status.textContent = "Audio cleanup failed: " + err.message;
    btn.disabled = false;
  }
}

async function translateVideo() {
  const status = $("translate-status");
  status.textContent = "Translating… this can take a while for longer videos.";
  try {
    const res = await CCApi.fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordingId: currentRecording.id, targetLang: $("translate-lang").value }),
    });
    if (!res.ok) throw new Error(await res.text());
    await res.blob(); // drain the streamed response — the saved copy is in this recording's translations list
    currentRecording = await CCApi.json(`/api/recordings/${currentRecording.id}`);
    status.textContent = "Translated copy saved — find it in the Library.";
    CCBrand.toast("Translation complete.");
  } catch (err) {
    status.textContent = "Translation needs OPENAI_API_KEY configured on the server (see README). " + err.message;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  CCBrand.renderHeader("editor.html");
  renderCutList();
  renderSpeedList();
  setupTimeline();
  await loadRecordingIntoEditor();
  await populateIntroOptions();

  $("btn-mark-in").addEventListener("click", () => {
    markIn = $("preview").currentTime;
    CCBrand.toast(`Cut start marked at ${fmtTime(markIn)}`);
    $("btn-add-cut").disabled = false;
  });
  $("btn-mark-out").addEventListener("click", () => {
    if (markIn === null) return CCBrand.toast("Mark a cut start first.");
    const out = $("preview").currentTime;
    if (out <= markIn) return CCBrand.toast("Cut end must be after cut start.");
    cuts.push({ start: markIn, end: out });
    markIn = null;
    $("btn-add-cut").disabled = true;
    renderCutList();
  });
  $("btn-add-cut").addEventListener("click", () => $("btn-mark-out").click());

  $("btn-mark-speed-in").addEventListener("click", () => {
    speedMarkIn = $("preview").currentTime;
    CCBrand.toast(`Speed-up start marked at ${fmtTime(speedMarkIn)}`);
    $("btn-add-speed").disabled = false;
  });
  $("btn-mark-speed-out").addEventListener("click", () => {
    if (speedMarkIn === null) return CCBrand.toast("Mark a speed-up start first.");
    const out = $("preview").currentTime;
    if (out <= speedMarkIn) return CCBrand.toast("Speed-up end must be after its start.");
    speedChanges.push({ start: speedMarkIn, end: out, speed: Number($("speed-factor").value) });
    speedMarkIn = null;
    $("btn-add-speed").disabled = true;
    renderSpeedList();
  });
  $("btn-add-speed").addEventListener("click", () => $("btn-mark-speed-out").click());

  $("music-file").addEventListener("change", (e) => (musicFile = e.target.files[0] || null));
  setupVoiceoverTeleprompter();
  renderVoiceoverList();
  $("btn-vo-record").addEventListener("click", toggleVoiceoverRecording);
  $("btn-vo-upload").addEventListener("click", () => $("vo-upload-file").click());
  $("vo-upload-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) addVoiceoverFromFile(file);
  });
  $("btn-apply").addEventListener("click", applyEditsAndRender);
  $("btn-translate").addEventListener("click", translateVideo);
  $("btn-audio-cleanup").addEventListener("click", cleanUpAudio);
  $("btn-add-chapter").addEventListener("click", async () => {
    const label = $("chapter-label").value.trim();
    if (!label) return CCBrand.toast("Give the chapter a label first.");
    chapters.push({ timeSec: $("preview").currentTime, label });
    chapters.sort((a, b) => a.timeSec - b.timeSec);
    $("chapter-label").value = "";
    await saveChapters();
    renderChapterList();
  });

  $("btn-copy-link").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(currentRecording.url);
      CCBrand.toast("Link copied — paste it wherever you need it.");
    } catch (err) {
      // Clipboard access can be blocked (older browser, non-HTTPS, etc.) —
      // fall back to a selectable prompt so the link is still reachable.
      window.prompt("Copy this link:", currentRecording.url);
    }
  });
  $("btn-download").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = currentRecording.url;
    a.download = `${(currentRecording.title || "video").replace(/[^\w-]+/g, "_")}.${extFor(currentRecording.mimeType)}`;
    a.click();
  });
  $("btn-send").addEventListener("click", () => {
    window.location.href = `students.html?send=${currentRecording.id}`;
  });
});
