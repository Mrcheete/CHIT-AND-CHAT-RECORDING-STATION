let allRecordings = [];
let activeFilter = "all";
let combineMode = false;
let selectedIds = []; // in the order they were selected — that's the combine order

function fmtDuration(sec) {
  sec = Math.floor(sec || 0);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const LANG_NAMES = { es: "Spanish", fr: "French", pt: "Portuguese", zu: "Zulu", af: "Afrikaans", xh: "Xhosa", de: "German", zh: "Chinese" };
const TYPE_LABELS = { lesson: "Lesson", intro: "Intro clip", voiceover: "Voice-over" };

async function deleteRecording(rec) {
  if (!confirm(`Delete "${rec.title}"? This can't be undone.`)) return;
  try {
    await CCApi.fetch(`/api/recordings/${rec.id}`, { method: "DELETE" });
    load();
  } catch (err) {
    CCBrand.toast("Couldn't delete: " + err.message);
  }
}

function cardFor(rec) {
  const div = document.createElement("div");
  div.className = "card lib-card";
  const typeLabel = TYPE_LABELS[rec.type] || rec.type;
  const meta = `${typeLabel} · ${fmtDuration(rec.durationSec)} · ${new Date(rec.createdAt).toLocaleDateString()}${rec.edited ? " · edited" : ""}`;

  if (rec.status !== "finalized") {
    const uploading = rec.status === "uploading";
    div.innerHTML = `
      <div class="lib-card-placeholder">${uploading ? "Still uploading…" : "Upload failed"}</div>
      <h4>${rec.title}</h4>
      <div class="meta">${meta}</div>
      <p class="script-note">${
        uploading
          ? "This recording never finished saving — reopen Studio and record again, or delete it below."
          : "This upload never completed. Delete it and record again."
      }</p>
      <div class="actions">
        <button class="btn btn-sm btn-danger" data-action="delete">Delete</button>
      </div>
    `;
    div.querySelector('[data-action="delete"]').addEventListener("click", () => deleteRecording(rec));
    return div;
  }

  const selected = selectedIds.includes(rec.id);
  if (combineMode) div.classList.add("selectable");
  if (selected) div.classList.add("selected");

  div.innerHTML = `
    ${combineMode ? `<input type="checkbox" class="lib-card-select" ${selected ? "checked" : ""}>` : ""}
    <video src="${rec.url}" controls preload="metadata"></video>
    <h4>${rec.title}</h4>
    <div class="meta">${meta}</div>
    <div class="actions">
      <a class="btn btn-sm btn-outline" href="editor.html?id=${rec.id}">Edit</a>
      <button class="btn btn-sm btn-primary" data-action="copy-link">🔗 Copy link</button>
      <a class="btn btn-sm btn-secondary" href="${rec.url}" download>Download</a>
      <button class="btn btn-sm btn-outline" data-action="send">Send</button>
      <button class="btn btn-sm btn-outline" data-action="rename">Rename</button>
      <button class="btn btn-sm btn-danger" data-action="delete">Delete</button>
    </div>
    <div class="translations">
      ${(rec.translations || [])
        .map(
          (t) =>
            `<a class="badge" href="${t.url}" download>${LANG_NAMES[t.lang] || t.lang} ↓</a>` +
            (t.vttUrl ? `<a class="badge" href="${t.vttUrl}" download>${LANG_NAMES[t.lang] || t.lang} captions ↓</a>` : "")
        )
        .join("")}
    </div>
    ${
      (rec.chapters || []).length
        ? `<div class="chapters">
            ${rec.chapters
              .map((c) => `<button type="button" class="badge" data-jump="${c.timeSec}">📍 ${fmtDuration(c.timeSec)} ${c.label}</button>`)
              .join("")}
          </div>`
        : ""
    }
  `;

  if (combineMode) {
    const checkbox = div.querySelector(".lib-card-select");
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedIds.push(rec.id);
      else selectedIds = selectedIds.filter((id) => id !== rec.id);
      div.classList.toggle("selected", checkbox.checked);
      updateCombineBar();
    });
  }

  div.querySelector('[data-action="copy-link"]').addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(rec.url);
      CCBrand.toast("Link copied — paste it wherever you need it.");
    } catch (err) {
      window.prompt("Copy this link:", rec.url);
    }
  });
  div.querySelector('[data-action="send"]').addEventListener("click", () => {
    window.location.href = `students.html?send=${rec.id}`;
  });
  div.querySelector('[data-action="rename"]').addEventListener("click", async () => {
    const title = prompt("New title:", rec.title);
    if (!title) return;
    try {
      await CCApi.json(`/api/recordings/${rec.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      load();
    } catch (err) {
      CCBrand.toast("Couldn't rename: " + err.message);
    }
  });
  div.querySelector('[data-action="delete"]').addEventListener("click", () => deleteRecording(rec));

  div.querySelectorAll("[data-jump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const video = div.querySelector("video");
      video.currentTime = Number(btn.dataset.jump);
      video.play();
    });
  });

  return div;
}

function render() {
  const grid = document.getElementById("lib-grid");
  const items = activeFilter === "all" ? allRecordings : allRecordings.filter((r) => r.type === activeFilter);
  grid.innerHTML = "";
  if (!items.length) {
    grid.innerHTML = `<div class="empty-state">No recordings yet. <a href="studio.html">Go record one →</a></div>`;
    return;
  }
  items.forEach((rec) => grid.appendChild(cardFor(rec)));
}

async function load() {
  const grid = document.getElementById("lib-grid");
  try {
    allRecordings = await CCApi.json("/api/recordings");
    render();
  } catch (err) {
    grid.innerHTML = `<div class="empty-state">Couldn't reach the server (${err.message}) — check your connection and reload.</div>`;
  }
}

function updateCombineBar() {
  const bar = document.getElementById("combine-bar");
  const count = document.getElementById("combine-count");
  const goBtn = document.getElementById("btn-combine-go");
  bar.hidden = !combineMode;
  if (!combineMode) return;
  count.textContent =
    selectedIds.length === 0
      ? "Tap videos to select them"
      : `${selectedIds.length} selected${selectedIds.length === 1 ? " — pick at least one more" : ""}`;
  goBtn.disabled = selectedIds.length < 2;
}

function setCombineMode(on) {
  combineMode = on;
  if (!on) selectedIds = [];
  document.getElementById("btn-combine-mode").classList.toggle("active", on);
  updateCombineBar();
  render();
}

// Read straight off the file the browser just picked — no upload needed
// first just to find out how long it is.
function readDurationFromFile(file) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(video.src);
      resolve(Number.isFinite(video.duration) ? video.duration : 0);
    };
    video.onerror = () => resolve(0);
    video.src = URL.createObjectURL(file);
  });
}

async function uploadVideoFile(file) {
  CCBrand.toast(`Uploading "${file.name}"…`);
  const durationSec = await readDurationFromFile(file);
  const form = new FormData();
  form.append("video", file);
  form.append("title", file.name.replace(/\.[^./]+$/, "") || "Uploaded video");
  form.append("type", "lesson");
  form.append("durationSec", durationSec);
  form.append("mimeType", file.type || "video/mp4");
  try {
    await CCApi.json("/api/recordings", { method: "POST", body: form });
    CCBrand.toast("Uploaded — added to your library.");
    load();
  } catch (err) {
    CCBrand.toast("Upload failed: " + err.message);
  }
}

async function combineSelected() {
  const goBtn = document.getElementById("btn-combine-go");
  const title = prompt("Title for the combined video:", "Combined video");
  if (!title) return;
  goBtn.disabled = true;
  CCBrand.toast("Combining on the server — this can take a minute for longer videos…");
  try {
    const saved = await CCApi.json("/api/recordings/combine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordingIds: selectedIds, title }),
    });
    CCBrand.toast("Combined — added to your library.");
    setCombineMode(false);
    window.location.href = `editor.html?id=${saved.id}`;
  } catch (err) {
    CCBrand.toast("Couldn't combine those: " + err.message);
    goBtn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  CCBrand.renderHeader("library.html");
  load();

  document.getElementById("btn-upload").addEventListener("click", () => document.getElementById("upload-file").click());
  document.getElementById("upload-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) uploadVideoFile(file);
    e.target.value = "";
  });

  document.getElementById("btn-combine-mode").addEventListener("click", () => setCombineMode(!combineMode));
  document.getElementById("btn-combine-cancel").addEventListener("click", () => setCombineMode(false));
  document.getElementById("btn-combine-go").addEventListener("click", combineSelected);

  document.querySelectorAll(".filter-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-tabs button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeFilter = btn.dataset.filter;
      render();
    });
  });
});
