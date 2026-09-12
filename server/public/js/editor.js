const params = new URLSearchParams(location.search);
const RECORDING_ID = params.get("id");

let currentRecording = null;
let cuts = []; // [{start, end}]
let markIn = null;
let voiceoverBlob = null;
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
  if (ffmpeg) return ffmpeg;
  // The FFmpeg global comes from a CDN <script> tag — reading it only here
  // (not at page load) means a CDN hiccup only breaks this one feature
  // (voice-over/music mixing, intro clips, format export) instead of
  // crashing the whole editor page before anything else can run.
  if (typeof FFmpeg === "undefined") {
    throw new Error("The video editor couldn't load (check your internet connection and reload) — cuts-only trims still work fine without it.");
  }
  fetchFile = FFmpeg.fetchFile;
  ffmpeg = FFmpeg.createFFmpeg({
    log: true,
    corePath: "https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js",
    progress: ({ ratio }) => onProgress && onProgress(Math.min(1, Math.max(0, ratio))),
  });
  const logEl = $("ffmpeg-log");
  logEl.style.display = "block";
  ffmpeg.setLogger(({ message }) => {
    logEl.textContent += message + "\n";
    logEl.scrollTop = logEl.scrollHeight;
  });
  await ffmpeg.load();
  return ffmpeg;
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

function renderTimeline() {
  const track = $("cut-timeline");
  const duration = getVideoDuration();
  track.querySelectorAll(".timeline-cut").forEach((el) => el.remove());
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
  const noExtras = !introId && !voiceoverBlob && !musicFile;

  if (noExtras) {
    applyBtn.disabled = true;
    try {
      const duration = getVideoDuration();
      const segments = cuts.length ? keepSegments(duration, cuts) : [[0, duration]];
      if (!segments.length) throw new Error("those cuts remove the entire video");
      CCBrand.toast("Rendering on the server…");
      const saved = await CCApi.json(`/api/recordings/${currentRecording.id}/trim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          segments,
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

    const segs = cuts.length ? keepSegments(duration, cuts) : [[0, duration]];
    const segFiles = [];
    for (let i = 0; i < segs.length; i++) {
      const [s, e] = segs[i];
      const out = `seg${i}.mp4`;
      await ff.run("-i", `input.${inputExt}`, "-ss", String(s), "-to", String(e), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-c:a", "aac", out);
      segFiles.push(out);
    }

    // Intro clip, prepended
    if (introId) {
      const introRec = await CCApi.json(`/api/recordings/${introId}`);
      const iExt = extFor(introRec.mimeType);
      ff.FS("writeFile", `intro.${iExt}`, await fetchFile(introRec.url));
      await ff.run("-i", `intro.${iExt}`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-c:a", "aac", "intro_seg.mp4");
      segFiles.unshift("intro_seg.mp4");
    }

    const listTxt = segFiles.map((f) => `file '${f}'`).join("\n");
    ff.FS("writeFile", "list.txt", new TextEncoder().encode(listTxt));
    await ff.run("-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "merged.mp4");
    let current = "merged.mp4";

    if (voiceoverBlob) {
      ff.FS("writeFile", "voiceover.webm", await fetchFile(voiceoverBlob));
      const trimStart = Number($("vo-trim-start").value) || 0;
      const trimEndRaw = $("vo-trim-end").value;
      const trimEnd = trimEndRaw ? Number(trimEndRaw) : null;
      const voFilter =
        trimEnd && trimEnd > trimStart
          ? `[1:a]atrim=start=${trimStart}:end=${trimEnd},asetpts=PTS-STARTPTS[vo]`
          : trimStart > 0
            ? `[1:a]atrim=start=${trimStart},asetpts=PTS-STARTPTS[vo]`
            : `[1:a]anull[vo]`;
      await ff.run(
        "-i", current, "-i", "voiceover.webm",
        "-filter_complex", `${voFilter};[0:a][vo]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
        "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "merged_vo.mp4"
      );
      current = "merged_vo.mp4";
    }

    if (musicFile) {
      const mExt = musicFile.name.split(".").pop();
      ff.FS("writeFile", `music.${mExt}`, await fetchFile(musicFile));
      const vol = Number($("music-volume").value) / 100;
      await ff.run(
        "-i", current, "-i", `music.${mExt}`,
        "-filter_complex", `[1:a]volume=${vol}[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
        "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "merged_music.mp4"
      );
      current = "merged_music.mp4";
    }

    const format = $("export-format").value;
    let finalFile = current;
    if (format === "webm") {
      await ff.run("-i", current, "-c:v", "libvpx-vp9", "-c:a", "libopus", "output.webm");
      finalFile = "output.webm";
    } else {
      await ff.run("-i", current, "-c", "copy", "output.mp4");
      finalFile = "output.mp4";
    }

    const data = ff.FS("readFile", finalFile);
    const mimeType = format === "webm" ? "video/webm" : "video/mp4";
    const outBlob = new Blob([data.buffer], { type: mimeType });

    $("preview").src = URL.createObjectURL(outBlob);
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

function showVoiceoverPreview() {
  const url = URL.createObjectURL(voiceoverBlob);
  const audio = $("vo-preview");
  audio.src = url;
  audio.style.display = "block";
  $("vo-actions").style.display = "flex";
  $("vo-trim-fields").style.display = "flex";
  $("vo-trim-start").value = "0";
  audio.addEventListener(
    "loadedmetadata",
    () => {
      $("vo-trim-end").value = Math.round(audio.duration * 10) / 10;
    },
    { once: true }
  );
}

function removeVoiceover() {
  voiceoverBlob = null;
  const audio = $("vo-preview");
  audio.pause();
  audio.removeAttribute("src");
  audio.style.display = "none";
  $("vo-actions").style.display = "none";
  $("vo-trim-fields").style.display = "none";
}

async function toggleVoiceoverRecording() {
  const btn = $("btn-vo-record");
  if (voRecorder && voRecorder.state === "recording") {
    voRecorder.stop();
    return;
  }
  if (voiceoverBlob) removeVoiceover();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const chunks = [];
  voRecorder = new MediaRecorder(stream);
  voRecorder.ondataavailable = (e) => chunks.push(e.data);
  voRecorder.onstop = () => {
    voiceoverBlob = new Blob(chunks, { type: "audio/webm" });
    stream.getTracks().forEach((t) => t.stop());
    btn.textContent = "● Record voice-over";
    btn.classList.remove("btn-danger");
    showVoiceoverPreview();
  };
  voRecorder.start();
  btn.textContent = "■ Stop recording";
  btn.classList.add("btn-danger");
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

  $("music-file").addEventListener("change", (e) => (musicFile = e.target.files[0] || null));
  setupVoiceoverTeleprompter();
  $("btn-vo-record").addEventListener("click", toggleVoiceoverRecording);
  $("btn-vo-rerecord").addEventListener("click", toggleVoiceoverRecording);
  $("btn-vo-remove").addEventListener("click", removeVoiceover);
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
