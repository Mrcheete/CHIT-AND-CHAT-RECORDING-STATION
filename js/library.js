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

document.addEventListener("DOMContentLoaded", async () => {
  CCBrand.renderHeader("library.html");
  allRecordings = await CCDB.getAllRecordings();
  render();

  document.querySelectorAll(".filter-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-tabs button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeFilter = btn.dataset.filter;
      render();
    });
  });
});
