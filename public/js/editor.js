const { createFFmpeg, fetchFile } = FFmpeg;
const params = new URLSearchParams(location.search);
const RECORDING_ID = Number(params.get("id"));

let currentRecording = null;
let currentBlob = null;
let cuts = []; // [{start, end}]
let markIn = null;
let voiceoverBlob = null;
let voRecorder = null;
let musicFile = null;
let ffmpeg = null;

const $ = (id) => document.getElementById(id);

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function ensureFFmpeg(onProgress) {
  if (ffmpeg) return ffmpeg;
  ffmpeg = createFFmpeg({
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
    list.innerHTML = `<p class="script-note">No cuts marked yet — play the video, mark a start and end around a mistake, then "Add cut".</p>`;
    return;
  }
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
  currentRecording = await CCDB.getRecording(RECORDING_ID);
  if (!currentRecording) {
    CCBrand.toast("Recording not found — pick one from the Library.");
    return;
  }
  currentBlob = currentRecording.blob;
  $("editor-subtitle").textContent = `Editing "${currentRecording.title}"`;
  $("preview").src = URL.createObjectURL(currentBlob);
  $("preview").addEventListener("timeupdate", () => {
    $("time-readout").textContent = `${fmtTime($("preview").currentTime)} / ${fmtTime($("preview").duration)}`;
  });
}

async function populateIntroOptions() {
  const all = await CCDB.getAllRecordings();
  const intros = all.filter((r) => r.type === "intro");
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
  applyBtn.disabled = true;
  setProgress(0);
  try {
    const ff = await ensureFFmpeg(setProgress);
    const duration = $("preview").duration;
    const inputExt = extFor(currentRecording.mimeType);
    ff.FS("writeFile", `input.${inputExt}`, await fetchFile(currentBlob));

    const segs = cuts.length ? keepSegments(duration, cuts) : [[0, duration]];
    const segFiles = [];
    for (let i = 0; i < segs.length; i++) {
      const [s, e] = segs[i];
      const out = `seg${i}.mp4`;
      await ff.run("-i", `input.${inputExt}`, "-ss", String(s), "-to", String(e), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-c:a", "aac", out);
      segFiles.push(out);
    }

    // Intro clip, prepended
    const introId = Number($("intro-select").value);
    if (introId) {
      const introRec = await CCDB.getRecording(introId);
      const iExt = extFor(introRec.mimeType);
      ff.FS("writeFile", `intro.${iExt}`, await fetchFile(introRec.blob));
      await ff.run("-i", `intro.${iExt}`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-c:a", "aac", "intro_seg.mp4");
      segFiles.unshift("intro_seg.mp4");
    }

    const listTxt = segFiles.map((f) => `file '${f}'`).join("\n");
    ff.FS("writeFile", "list.txt", new TextEncoder().encode(listTxt));
    await ff.run("-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "merged.mp4");
    let current = "merged.mp4";

    if (voiceoverBlob) {
      ff.FS("writeFile", "voiceover.webm", await fetchFile(voiceoverBlob));
      await ff.run(
        "-i", current, "-i", "voiceover.webm",
        "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[aout]",
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

    currentBlob = outBlob;
    $("preview").src = URL.createObjectURL(outBlob);
    await CCDB.updateRecording(RECORDING_ID, { blob: outBlob, mimeType, edited: true });
    CCBrand.toast("Edits applied — preview updated.");
  } catch (err) {
    console.error(err);
    CCBrand.toast("Render failed: " + err.message);
  } finally {
    applyBtn.disabled = false;
    setProgress(0);
  }
}

async function toggleVoiceoverRecording() {
  const btn = $("btn-vo-record");
  if (voRecorder && voRecorder.state === "recording") {
    voRecorder.stop();
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const chunks = [];
  voRecorder = new MediaRecorder(stream);
  voRecorder.ondataavailable = (e) => chunks.push(e.data);
  voRecorder.onstop = () => {
    voiceoverBlob = new Blob(chunks, { type: "audio/webm" });
    stream.getTracks().forEach((t) => t.stop());
    btn.textContent = "● Record voice-over";
    btn.classList.remove("btn-danger");
    $("vo-status").style.display = "inline-block";
  };
  voRecorder.start();
  btn.textContent = "■ Stop recording";
  btn.classList.add("btn-danger");
}

async function translateVideo() {
  const status = $("translate-status");
  status.textContent = "Translating… this can take a while for longer videos.";
  try {
    const form = new FormData();
    form.append("video", currentBlob, "video." + extFor(currentRecording.mimeType));
    form.append("targetLang", $("translate-lang").value);
    const res = await CCApi.fetch("/api/translate", { method: "POST", body: form });
    if (!res.ok) throw new Error(await res.text());
    const translatedBlob = await res.blob();
    const translations = currentRecording.translations || [];
    translations.push({ lang: $("translate-lang").value, blob: translatedBlob });
    await CCDB.updateRecording(RECORDING_ID, { translations });
    status.textContent = "Translated copy saved — find it in the Library.";
    CCBrand.toast("Translation complete.");
  } catch (err) {
    status.textContent = "Translation needs the backend running (see README → Translation setup). " + err.message;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  CCBrand.renderHeader("editor.html");
  renderCutList();
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
  $("btn-vo-record").addEventListener("click", toggleVoiceoverRecording);
  $("btn-apply").addEventListener("click", applyEditsAndRender);
  $("btn-translate").addEventListener("click", translateVideo);

  $("btn-download").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(currentBlob);
    a.download = `${(currentRecording.title || "video").replace(/[^\w-]+/g, "_")}.${extFor(currentRecording.mimeType)}`;
    a.click();
  });
  $("btn-send").addEventListener("click", () => {
    window.location.href = `students.html?send=${RECORDING_ID}`;
  });
});
