let allRecordings = [];
let activeFilter = "all";

function fmtDuration(sec) {
  sec = Math.floor(sec || 0);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const LANG_NAMES = { es: "Spanish", fr: "French", pt: "Portuguese", zu: "Zulu", af: "Afrikaans", xh: "Xhosa", de: "German", zh: "Chinese" };

function cardFor(rec) {
  const div = document.createElement("div");
  div.className = "card lib-card";
  const url = URL.createObjectURL(rec.blob);
  const typeLabel = { lesson: "Lesson", intro: "Intro clip", voiceover: "Voice-over" }[rec.type] || rec.type;

  div.innerHTML = `
    <video src="${url}" controls preload="metadata"></video>
    <h4>${rec.title}</h4>
    <div class="meta">${typeLabel} · ${fmtDuration(rec.durationSec)} · ${new Date(rec.createdAt).toLocaleDateString()}${rec.edited ? " · edited" : ""}</div>
    <div class="actions">
      <a class="btn btn-sm btn-outline" href="editor.html?id=${rec.id}">Edit</a>
      <button class="btn btn-sm btn-secondary" data-action="download">Download</button>
      <button class="btn btn-sm btn-outline" data-action="send">Send</button>
      <button class="btn btn-sm btn-outline" data-action="backup">Backup to cloud</button>
      <button class="btn btn-sm btn-outline" data-action="rename">Rename</button>
      <button class="btn btn-sm btn-danger" data-action="delete">Delete</button>
    </div>
    <div class="translations">
      ${(rec.translations || [])
        .map((t) => `<a class="badge" href="${URL.createObjectURL(t.blob)}" download="${rec.title}_${t.lang}.mp4">${LANG_NAMES[t.lang] || t.lang} ↓</a>`)
        .join("")}
    </div>
  `;

  div.querySelector('[data-action="download"]').addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = url;
    a.download = `${rec.title.replace(/[^\w-]+/g, "_")}.${rec.mimeType.includes("mp4") ? "mp4" : "webm"}`;
    a.click();
  });
  div.querySelector('[data-action="send"]').addEventListener("click", () => {
    window.location.href = `students.html?send=${rec.id}`;
  });
  div.querySelector('[data-action="backup"]').addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Uploading…";
    try {
      const form = new FormData();
      form.append("video", rec.blob, `${rec.title}.${rec.mimeType.includes("mp4") ? "mp4" : "webm"}`);
      form.append("title", rec.title);
      form.append("type", rec.type);
      form.append("durationSec", rec.durationSec || 0);
      form.append("mimeType", rec.mimeType);
      form.append("edited", rec.edited ? "1" : "0");
      await CCApi.json("/api/recordings", { method: "POST", body: form });
      CCBrand.toast(`Backed up "${rec.title}" to the cloud library.`);
      loadCloud();
    } catch (err) {
      CCBrand.toast("Backup failed — is the backend running? (" + err.message + ")");
    } finally {
      e.target.disabled = false;
      e.target.textContent = "Backup to cloud";
    }
  });
  div.querySelector('[data-action="rename"]').addEventListener("click", async () => {
    const title = prompt("New title:", rec.title);
    if (title) {
      await CCDB.updateRecording(rec.id, { title });
      render();
    }
  });
  div.querySelector('[data-action="delete"]').addEventListener("click", async () => {
    if (confirm(`Delete "${rec.title}"? This can't be undone.`)) {
      await CCDB.deleteRecording(rec.id);
      allRecordings = allRecordings.filter((r) => r.id !== rec.id);
      render();
    }
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

function cloudCardFor(rec) {
  const div = document.createElement("div");
  div.className = "card lib-card";
  const typeLabel = { lesson: "Lesson", intro: "Intro clip", voiceover: "Voice-over" }[rec.type] || rec.type;
  div.innerHTML = `
    <video src="${rec.url}" controls preload="metadata"></video>
    <h4>${rec.title}</h4>
    <div class="meta">${typeLabel} · ${fmtDuration(rec.durationSec)} · ${new Date(rec.createdAt).toLocaleDateString()}${rec.edited ? " · edited" : ""}</div>
    <div class="actions">
      <a class="btn btn-sm btn-secondary" href="${rec.url}" download>Download</a>
      <button class="btn btn-sm btn-outline" data-action="send">Send</button>
      <button class="btn btn-sm btn-danger" data-action="delete">Delete</button>
    </div>
    <div class="translations">
      ${(rec.translations || []).map((t) => `<a class="badge" href="${t.url}" download>${LANG_NAMES[t.lang] || t.lang} ↓</a>`).join("")}
    </div>
  `;
  div.querySelector('[data-action="send"]').addEventListener("click", () => {
    window.location.href = `students.html?send=cloud:${rec.id}`;
  });
  div.querySelector('[data-action="delete"]').addEventListener("click", async () => {
    if (!confirm(`Delete "${rec.title}" from the cloud library? This can't be undone.`)) return;
    await CCApi.fetch(`/api/recordings/${rec.id}`, { method: "DELETE" });
    loadCloud();
  });
  return div;
}

async function loadCloud() {
  const grid = document.getElementById("cloud-grid");
  try {
    const items = await CCApi.json("/api/recordings");
    grid.innerHTML = "";
    if (!items.length) {
      grid.innerHTML = `<div class="empty-state">Nothing backed up yet — use "Backup to cloud" on a recording above.</div>`;
      return;
    }
    items.forEach((rec) => grid.appendChild(cloudCardFor(rec)));
  } catch (err) {
    grid.innerHTML = `<div class="empty-state">Couldn't reach the backend — set it up in <a href="settings.html">Brand Kit</a>. (${err.message})</div>`;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  CCBrand.renderHeader("library.html");
  allRecordings = await CCDB.getAllRecordings();
  render();
  loadCloud();

  document.querySelectorAll(".filter-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-tabs button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeFilter = btn.dataset.filter;
      render();
    });
  });
});
