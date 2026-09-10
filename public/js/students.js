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

  let roster = [];
  try {
    roster = await CCApi.json("/api/students");
  } catch (err) {
    document.getElementById("roster-list").innerHTML = `<div class="empty-state">Can't reach the server (${err.message}) — check your connection and reload.</div>`;
  }

  const params = new URLSearchParams(location.search);
  const sendId = params.get("send");
  if (sendId) {
    document.getElementById("send-panel").style.display = "block";
    const rec = await CCApi.json(`/api/recordings/${sendId}`).catch(() => null);
    document.getElementById("send-title").textContent = `Sending "${rec ? rec.title : "video"}"`;

    document.getElementById("btn-do-send").addEventListener("click", async () => {
      const checked = [...document.querySelectorAll(".student-check:checked")].map((c) => Number(c.value));
      if (!checked.length) return CCBrand.toast("Select at least one student.");
      const chosen = roster.filter((s) => checked.includes(s.id));

      try {
        const result = await CCApi.json("/api/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: rec ? rec.title : "Your lesson", recordingId: sendId, students: chosen }),
        });
        CCBrand.toast(
          result.emailed
            ? `Sent "${rec.title}" to ${chosen.length} student(s).`
            : `Saved a share link (email isn't configured on the server yet): ${result.shareUrl}`
        );
      } catch (err) {
        CCBrand.toast("Couldn't send: " + err.message);
      }
    });
  }

  renderRoster(roster);

  document.getElementById("btn-add-student").addEventListener("click", async () => {
    const name = document.getElementById("new-name").value.trim();
    const email = document.getElementById("new-email").value.trim();
    if (!name || !email) return CCBrand.toast("Name and email are required.");
    try {
      await CCApi.json("/api/students", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email }),
      });
      roster = await CCApi.json("/api/students");
      document.getElementById("new-name").value = "";
      document.getElementById("new-email").value = "";
      renderRoster(roster);
    } catch (err) {
      CCBrand.toast("Couldn't add student: " + err.message);
    }
  });
});
