// Script / teleprompter panel. Loads a script from pasted text, a .txt
// upload, or a .pdf (via pdf.js). Lives in the sidebar or a top bar, and is
// a separate DOM panel that is never part of the composited output canvas
// recorder.js records — so it never appears in the saved video no matter
// what. "Hide from my screen too while recording" is offered as an extra
// option for anyone who also screen-shares elsewhere and wants it fully gone.
function createTeleprompter({ panelEl, textEl }) {
  let autoScrollTimer = null;
  let hideWhileRecording = false;
  let currentSpeed = 30;
  let running = false;

  function setScript(text) {
    textEl.textContent = text;
    textEl.scrollTop = 0;
  }

  function loadTxtFile(file) {
    return file.text().then(setScript);
  }

  async function loadPdfFile(file) {
    if (!window.pdfjsLib) throw new Error("pdf.js not loaded");
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    let fullText = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      fullText += content.items.map((it) => it.str).join(" ") + "\n\n";
    }
    setScript(fullText.trim());
  }

  function setPosition(pos) {
    // 'side' | 'top'
    panelEl.dataset.position = pos;
  }

  function setFontSize(px) {
    textEl.style.fontSize = `${px}px`;
  }

  // Turning it off (rather than reloading the script) never resets the
  // scroll position — that's what makes it double as pause/resume, wherever
  // in the script it's stopped.
  function setAutoScroll(on, speed) {
    if (typeof speed === "number") currentSpeed = speed;
    running = on;
    clearInterval(autoScrollTimer);
    if (!on) return;
    autoScrollTimer = setInterval(() => {
      textEl.scrollTop += 1;
    }, 1000 / currentSpeed);
  }

  // Changes the rate live, without pausing or losing the current position —
  // for dragging the speed slider mid-scroll instead of only before starting.
  function setSpeed(speed) {
    currentSpeed = speed;
    if (running) setAutoScroll(true, speed);
  }

  function isRunning() {
    return running;
  }

  function setHideWhileRecording(on) {
    hideWhileRecording = on;
  }

  function onRecordingStateChange(state) {
    if (!hideWhileRecording) return; // panel stays visible to the presenter by design
    panelEl.style.visibility = state === "recording" ? "hidden" : "visible";
  }

  return {
    setScript,
    loadTxtFile,
    loadPdfFile,
    setPosition,
    setFontSize,
    setAutoScroll,
    setSpeed,
    isRunning,
    setHideWhileRecording,
    onRecordingStateChange,
  };
}

window.createTeleprompter = createTeleprompter;
