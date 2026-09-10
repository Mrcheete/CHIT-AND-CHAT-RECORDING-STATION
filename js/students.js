const STUDENTS_KEY = "cc_students_v1";
const API_BASE = "http://localhost:8787";

function loadLocalRoster() {
  try {
    return JSON.parse(localStorage.getItem(STUDENTS_KEY)) || [];
  } catch {
    return [];
  }
}
function saveLocalRoster(list) {
  localStorage.setItem(STUDENTS_KEY, JSON.stringify(list));
}

async function fetchRoster() {
  try {
    const res = await fetch(`${API_BASE}/api/students`);
    if (!res.ok) throw new Error();
    return await res.json();
  } catch {
    return loadLocalRoster();
  }
}

async function addStudent(student) {
  try {
    const res = await fetch(`${API_BASE}/api/students`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(student),
    });
    if (!res.ok) throw new Error();
    return await res.json();
  } catch {
    const list = loadLocalRoster();
    const withId = { ...student, id: Date.now() };
    list.push(withId);
    saveLocalRoster(list);
    return list;
  }
}

function renderRoster(list) {
  const el = document.getElementById("roster-list");
  const sendPanelOpen = document.getElementById("send-panel").style.display === "block";
  if (!list.length) {
    el.innerHTML = `<p class="empty-state">No students yet — add one above.</p>`;
    return;
  }
  el.innerHTML = list
    .map(
      (s) => `
    <div class="roster-row">
      ${sendPanelOpen ? `<input type="checkbox" class="student-check" value="${s.id}">` : ""}
      <strong>${s.name}</strong>
      <span class="spacer"></span>
      <span class="script-note">${s.email}</span>
    </div>`
    )
    .join("");
}

document.addEventListener("DOMContentLoaded", async () => {
  CCBrand.renderHeader("students.html");
  let roster = await fetchRoster();

  const params = new URLSearchParams(location.search);
  const sendId = params.get("send");
  if (sendId) {
    document.getElementById("send-panel").style.display = "block";
    const rec = await CCDB.getRecording(Number(sendId));
    document.getElementById("send-title").textContent = `Sending "${rec ? rec.title : "video"}"`;

    document.getElementById("btn-do-send").addEventListener("click", async () => {
      const checked = [...document.querySelectorAll(".student-check:checked")].map((c) => Number(c.value));
      if (!checked.length) return CCBrand.toast("Select at least one student.");
      const chosen = roster.filter((s) => checked.includes(s.id));

      try {
        const form = new FormData();
        form.append("video", rec.blob, `${rec.title}.${rec.mimeType.includes("mp4") ? "mp4" : "webm"}`);
        form.append("title", rec.title);
        form.append("students", JSON.stringify(chosen));
        const res = await fetch(`${API_BASE}/api/send`, { method: "POST", body: form });
        if (!res.ok) throw new Error(await res.text());
        CCBrand.toast(`Sent "${rec.title}" to ${chosen.length} student(s).`);
      } catch (err) {
        CCBrand.toast("Backend not running — download the video from the Library and share it manually. (" + err.message + ")");
      }
    });
  }

  renderRoster(roster);

  document.getElementById("btn-add-student").addEventListener("click", async () => {
    const name = document.getElementById("new-name").value.trim();
    const email = document.getElementById("new-email").value.trim();
    if (!name || !email) return CCBrand.toast("Name and email are required.");
    roster = await addStudent({ name, email });
    if (!Array.isArray(roster)) roster = await fetchRoster();
    document.getElementById("new-name").value = "";
    document.getElementById("new-email").value = "";
    renderRoster(roster);
  });
});
