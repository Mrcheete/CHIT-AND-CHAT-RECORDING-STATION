let allRecordings = [];
let activeFilter = "all";

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

  div.innerHTML = `
    <video src="${rec.url}" controls preload="metadata"></video>
    <h4>${rec.title}</h4>
    <div class="meta">${meta}</div>
    <div class="actions">
      <a class="btn btn-sm btn-outline" href="editor.html?id=${rec.id}">Edit</a>
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
  `;

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

document.addEventListener("DOMContentLoaded", () => {
  CCBrand.renderHeader("library.html");
  load();

  document.querySelectorAll(".filter-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-tabs button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeFilter = btn.dataset.filter;
      render();
    });
  });
});
