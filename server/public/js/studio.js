document.addEventListener("DOMContentLoaded", () => {
  CCBrand.renderHeader("studio.html");

  const stageEl = document.getElementById("stage");
  const whiteboardCanvasEl = document.getElementById("whiteboard-canvas");
  const outputCanvasEl = document.getElementById("output-canvas");
  const camPreviewEl = document.getElementById("cam-preview");

  // size the fabric canvas to the stage's rendered box
  whiteboardCanvasEl.width = stageEl.clientWidth;
  whiteboardCanvasEl.height = stageEl.clientHeight;

  const wb = createWhiteboard(whiteboardCanvasEl);
  // Fabric renders across two stacked <canvas> elements: the "lower-canvas"
  // holds the actual persisted content (finished strokes, text, images) —
  // that's what the recorder should read frames from. The "upper-canvas" is
  // only used transiently for selection handles and the in-progress stroke
  // while the mouse is down, and is empty the rest of the time.
  const rec = createRecorder({
    whiteboardCanvasEl: wb.canvas.lowerCanvasEl,
    outputCanvasEl,
    videoPreviewEl: camPreviewEl,
  });

  window.addEventListener("resize", () => {
    wb.resize(stageEl.clientWidth, stageEl.clientHeight);
  });

  // ---- Tool rail ----
  document.querySelectorAll(".tool-btn[data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tool-btn[data-tool]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      wb.setTool(btn.dataset.tool);
    });
  });
  document.getElementById("btn-add-text").addEventListener("click", () => {
    wb.addText();
    CCBrand.toast("Type your text, then click elsewhere on the board — you can then drag it into place.");
  });
  document.getElementById("btn-add-image").addEventListener("click", () => document.getElementById("image-input").click());
  document.getElementById("image-input").addEventListener("change", (e) => {
    if (e.target.files[0]) wb.addImage(e.target.files[0]);
    e.target.value = "";
  });
  document.getElementById("btn-undo").addEventListener("click", () => wb.undo());
  document.getElementById("btn-redo").addEventListener("click", () => wb.redo());
  document.getElementById("btn-delete").addEventListener("click", () => wb.deleteSelected());
  document.getElementById("btn-clear").addEventListener("click", () => {
    if (confirm("Clear the whole whiteboard?")) wb.clearBoard();
  });
  document.getElementById("pen-size").addEventListener("input", (e) => wb.setPenWidth(Number(e.target.value)));
  document.getElementById("text-size").addEventListener("input", (e) => wb.setTextSize(Number(e.target.value)));

  // The board scrolls rather than running out of room: the buttons move a
  // fixed step, the mouse wheel pans by however much was scrolled — both go
  // through the same clamped panBy, so neither can scroll above the top.
  const SCROLL_STEP = 120;
  document.getElementById("btn-scroll-up").addEventListener("click", () => wb.panBy(SCROLL_STEP));
  document.getElementById("btn-scroll-down").addEventListener("click", () => wb.panBy(-SCROLL_STEP));
  // Bound to the stage wrapper, not the whiteboard canvas element itself —
  // Fabric stacks its own interactive "upper canvas" on top of the one we
  // passed in, which is what actually receives pointer/wheel events.
  stageEl.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      wb.panBy(-e.deltaY);
    },
    { passive: false }
  );

  const swatchesEl = document.getElementById("swatches");
  wb.PALETTE.forEach((hex, i) => {
    const s = document.createElement("div");
    s.className = "swatch" + (i === 0 ? " active" : "");
    s.style.background = hex;
    s.title = hex;
    s.addEventListener("click", () => {
      wb.setPenColor(hex);
      document.querySelectorAll(".swatch").forEach((el) => el.classList.remove("active"));
      s.classList.add("active");
    });
    swatchesEl.appendChild(s);
  });

  document.getElementById("custom-color").addEventListener("input", (e) => {
    wb.setPenColor(e.target.value);
    document.querySelectorAll(".swatch").forEach((el) => el.classList.remove("active"));
  });

  // ---- Teleprompter ----
  const tp = createTeleprompter({ panelEl: document.getElementById("script-panel"), textEl: document.getElementById("script-text") });
  document.getElementById("btn-script-top").addEventListener("click", () => {
    tp.setPosition("top");
    document.getElementById("studio-layout").dataset.scriptTop = "1";
  });
  document.getElementById("btn-script-side").addEventListener("click", () => {
    tp.setPosition("side");
    document.getElementById("studio-layout").dataset.scriptTop = "0";
  });
  document.getElementById("script-paste").addEventListener("input", (e) => tp.setScript(e.target.value));
  document.getElementById("script-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.name.endsWith(".pdf")) await tp.loadPdfFile(file);
    else await tp.loadTxtFile(file);
  });
  document.getElementById("script-font").addEventListener("input", (e) => tp.setFontSize(Number(e.target.value)));

  const btnAutoscroll = document.getElementById("btn-autoscroll");
  const speedSlider = document.getElementById("script-speed");
  let autoscrollOn = false;
  let scrollSpeed = Number(speedSlider.value);

  function toggleAutoscroll() {
    autoscrollOn = !autoscrollOn;
    tp.setAutoScroll(autoscrollOn, scrollSpeed);
    btnAutoscroll.textContent = autoscrollOn ? "⏸ Pause script" : "▶ Play script";
  }
  btnAutoscroll.addEventListener("click", toggleAutoscroll);

  // Dragged while already scrolling, this changes the rate immediately
  // without losing the current position or needing to pause first.
  speedSlider.addEventListener("input", (e) => {
    scrollSpeed = Number(e.target.value);
    tp.setSpeed(scrollSpeed);
  });

  // Space pauses/resumes the script from wherever it's stopped, so it can be
  // stopped the instant something needs re-reading without reaching for the
  // mouse — ignored while typing anywhere, so it never fights normal typing.
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "input" || tag === "select") return;
    e.preventDefault();
    toggleAutoscroll();
  });
  document.getElementById("chk-hide-recording").addEventListener("change", (e) => tp.setHideWhileRecording(e.target.checked));

  // ---- Camera / layout ----
  const camSelect = document.getElementById("camera-select");
  const micSelect = document.getElementById("mic-select");

  async function populateDeviceSelects() {
    const { cameras, mics } = await rec.listDevices();
    camSelect.innerHTML = cameras.map((d, i) => `<option value="${d.deviceId}">${d.label || `Camera ${i + 1}`}</option>`).join("");
    micSelect.innerHTML = mics.map((d, i) => `<option value="${d.deviceId}">${d.label || `Microphone ${i + 1}`}</option>`).join("");
    // Only worth showing a picker if there's actually a choice to make —
    // most laptops have exactly one of each, and an extra dropdown for
    // "the only camera you have" is just clutter.
    camSelect.style.display = cameras.length > 1 ? "inline-block" : "none";
    micSelect.style.display = mics.length > 1 ? "inline-block" : "none";
  }

  const btnToggleCamera = document.getElementById("btn-toggle-camera");
  function renderCameraToggle() {
    btnToggleCamera.textContent = rec.cameraEnabled ? "📷 Camera: On" : "📷 Camera: Off";
    camPreviewEl.classList.toggle("cam-preview-off", !rec.cameraEnabled);
  }

  document.getElementById("btn-enable-cam").addEventListener("click", async (e) => {
    try {
      await rec.requestCamera();
      e.target.textContent = "Camera ready ✓";
      e.target.disabled = true;
      document.getElementById("btn-record").disabled = false;
      btnToggleCamera.disabled = false;
      renderCameraToggle();
      await populateDeviceSelects();
    } catch (err) {
      CCBrand.toast("Couldn't access camera/mic: " + err.message);
    }
  });
  // Independent of the mic — this only disables the video track, so the
  // same underlying stream keeps the mic recording without interruption,
  // and it can be flipped anytime, including mid-recording.
  btnToggleCamera.addEventListener("click", () => {
    rec.setCameraEnabled(!rec.cameraEnabled);
    renderCameraToggle();
  });
  camSelect.addEventListener("change", async () => {
    try {
      await rec.requestCamera({ videoDeviceId: camSelect.value, audioDeviceId: micSelect.value || undefined });
    } catch (err) {
      CCBrand.toast("Couldn't switch camera: " + err.message);
    }
  });
  micSelect.addEventListener("change", async () => {
    try {
      await rec.requestCamera({ videoDeviceId: camSelect.value || undefined, audioDeviceId: micSelect.value });
    } catch (err) {
      CCBrand.toast("Couldn't switch microphone: " + err.message);
    }
  });
  document.getElementById("layout-select").addEventListener("change", (e) => {
    rec.setLayout(e.target.value);
    stageEl.className = "whiteboard-stage " + e.target.value;
  });

  // ---- Record controls ----
  const timerEl = document.getElementById("rec-timer");
  function fmt(sec) {
    const m = String(Math.floor(sec / 60)).padStart(2, "0");
    const s = String(sec % 60).padStart(2, "0");
    return `${m}:${s}`;
  }
  rec.on("tick", (sec) => (timerEl.innerHTML = `<span class="rec-dot"></span>${fmt(sec)}`));
  rec.on("statechange", (state) => {
    timerEl.classList.toggle("live", state === "recording");
    document.getElementById("btn-record").disabled = state !== "idle";
    document.getElementById("btn-pause").disabled = state === "idle";
    document.getElementById("btn-pause").textContent = state === "paused" ? "Resume" : "Pause";
    document.getElementById("btn-stop").disabled = state === "idle";
    document.getElementById("btn-discard").disabled = state === "idle";
    tp.onRecordingStateChange(state);
  });

  document.getElementById("btn-record").addEventListener("click", () => rec.start());
  document.getElementById("btn-pause").addEventListener("click", () => {
    if (rec.state === "recording") rec.pause();
    else rec.resume();
  });
  document.getElementById("btn-discard").addEventListener("click", () => {
    if (confirm("Discard this recording?")) rec.discard();
  });
  document.getElementById("btn-stop").addEventListener("click", async () => {
    const title = document.getElementById("rec-title").value.trim() || "Untitled lesson";
    CCBrand.toast("Saving…");
    const result = await rec.stop({ title, type: "lesson" });
    if (!result) return;
    if (!result.recording) {
      CCBrand.toast(
        `Couldn't finish saving "${title}" to the server (${result.finalizeError || "unknown error"}). ` +
          `The recording is still in this browser — check your connection, then record again once it's steady.`
      );
      return;
    }
    if (result.pendingFailures > 0) {
      CCBrand.toast(`Saved "${title}", but ${result.pendingFailures} chunk(s) never made it — the recording may have gaps.`);
    } else {
      CCBrand.toast(`Saved "${title}" (${fmt(result.durationSec)}) to your library.`);
    }
    setTimeout(() => (window.location.href = `editor.html?id=${result.recording.id}`), 900);
  });
});
