// Compositing recorder: draws the whiteboard canvas + webcam feed onto one
// output canvas every frame, captures that as a MediaStream, mixes in mic
// audio, and records with MediaRecorder. Each chunk is written to IndexedDB
// (a local safety net for retrying a failed upload) AND streamed to the
// server as its own indexed part file (see server/server.js's /chunk route)
// as it arrives — so recording length is bounded by disk space, not by
// holding the whole video in JS memory or IndexedDB alone.
async function uploadChunk(uploadId, seq, blob, mimeType) {
  const res = await fetch(`/api/recordings/${uploadId}/chunk?seq=${seq}&mimeType=${encodeURIComponent(mimeType)}`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/octet-stream" },
    body: await blob.arrayBuffer(),
  });
  if (!res.ok) throw new Error(`chunk ${seq} upload failed: ${res.status}`);
}

async function finalizeUpload(uploadId, { title, type, durationSec, mimeType, edited }) {
  const res = await fetch(`/api/recordings/${uploadId}/finalize`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, type, durationSec, mimeType, edited: edited ? "1" : "0" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`finalize failed (${res.status}): ${body}`);
  }
  return res.json();
}

function createRecorder({ whiteboardCanvasEl, outputCanvasEl, videoPreviewEl }) {
  const outputCtx = outputCanvasEl.getContext("2d");
  let camStream = null;
  let mixedStream = null;
  let mediaRecorder = null;
  let rafId = null;
  let sessionId = null;
  let seq = 0;
  let pendingRetrySeqs = new Set();
  let startedAt = 0;
  let elapsedBeforePause = 0;
  let layout = "pip-bottom-right"; // pip-bottom-right | pip-bottom-left | whiteboard-only | camera-only | side-by-side
  let state = "idle"; // idle | recording | paused
  let cameraEnabled = true;

  const listeners = { tick: [], statechange: [] };
  function on(evt, fn) { listeners[evt].push(fn); }
  function emit(evt, payload) { listeners[evt].forEach((fn) => fn(payload)); }

  async function requestCamera({ video = true, audio = true, videoDeviceId, audioDeviceId } = {}) {
    // Stop whatever's currently open first — switching devices without this
    // leaves the old camera/mic silently still held open in the background.
    if (camStream) camStream.getTracks().forEach((t) => t.stop());
    camStream = await navigator.mediaDevices.getUserMedia({
      video: video ? { width: 640, height: 480, ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : {}) } : false,
      audio: audio ? (audioDeviceId ? { deviceId: { exact: audioDeviceId } } : true) : false,
    });
    // A fresh getUserMedia call always comes back with video on — reapply
    // whatever the camera toggle was last set to (e.g. switching cameras
    // while the camera was off shouldn't silently turn it back on).
    camStream.getVideoTracks().forEach((t) => (t.enabled = cameraEnabled));
    videoPreviewEl.srcObject = camStream;
    await videoPreviewEl.play();
    return camStream;
  }

  // Toggles the camera on/off independently of the mic: disabling a track
  // (rather than stopping it or re-requesting the stream) mutes just that
  // track while the underlying stream — and the other track on it, i.e. the
  // mic — keeps running completely uninterrupted, even mid-recording.
  function setCameraEnabled(on) {
    cameraEnabled = on;
    if (camStream) camStream.getVideoTracks().forEach((t) => (t.enabled = on));
  }

  // Device labels only populate after permission has been granted at least
  // once, so this is only useful to call after requestCamera() has succeeded.
  async function listDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      cameras: devices.filter((d) => d.kind === "videoinput"),
      mics: devices.filter((d) => d.kind === "audioinput"),
    };
  }

  function stopCamera() {
    if (camStream) camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
  }

  function setLayout(newLayout) {
    layout = newLayout;
  }

  function drawFrame() {
    const w = outputCanvasEl.width;
    const h = outputCanvasEl.height;
    outputCtx.fillStyle = "#ffffff";
    outputCtx.fillRect(0, 0, w, h);

    if (layout !== "camera-only") {
      outputCtx.drawImage(whiteboardCanvasEl, 0, 0, w, h);
    }

    const hasVideo = cameraEnabled && videoPreviewEl.readyState >= 2 && camStream;
    if (hasVideo && layout === "camera-only") {
      outputCtx.drawImage(videoPreviewEl, 0, 0, w, h);
    } else if (hasVideo && layout === "side-by-side") {
      outputCtx.drawImage(whiteboardCanvasEl, 0, 0, w / 2, h);
      outputCtx.drawImage(videoPreviewEl, w / 2, 0, w / 2, h);
    } else if (hasVideo && layout.startsWith("pip")) {
      const pw = w * 0.24;
      const ph = pw * (videoPreviewEl.videoHeight / videoPreviewEl.videoWidth || 0.75);
      const x = layout === "pip-bottom-left" ? 16 : w - pw - 16;
      const y = h - ph - 16;
      outputCtx.save();
      outputCtx.strokeStyle = "#ffffff";
      outputCtx.lineWidth = 4;
      outputCtx.drawImage(videoPreviewEl, x, y, pw, ph);
      outputCtx.strokeRect(x, y, pw, ph);
      outputCtx.restore();
    }

    drawWatermark(w, h);
    rafId = requestAnimationFrame(drawFrame);
  }

  // A faint ownership mark baked into every recorded frame — subtle enough
  // not to distract a student watching, but there in the pixels themselves
  // (not an overlay a re-upload could just crop away) as proof this lesson
  // is yours if it ever turns up somewhere it shouldn't.
  function drawWatermark(w, h) {
    const name = (window.CCBrand && window.CCBrand.loadBrand().name) || "Chit & Chat";
    outputCtx.save();
    outputCtx.globalAlpha = 0.07;
    outputCtx.fillStyle = "#1a1433";
    outputCtx.font = `${Math.max(12, Math.round(w * 0.022))}px Inter, sans-serif`;
    outputCtx.textAlign = "right";
    outputCtx.textBaseline = "bottom";
    outputCtx.fillText(name, w - 14, h - 10);
    outputCtx.restore();
  }

  async function start() {
    if (state === "recording") return;
    sessionId = crypto.randomUUID();
    seq = 0;
    pendingRetrySeqs = new Set();
    startedAt = Date.now();
    elapsedBeforePause = 0;

    drawFrame();

    const canvasStream = outputCanvasEl.captureStream(30);
    const audioTracks = camStream ? camStream.getAudioTracks() : [];
    mixedStream = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);

    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((t) =>
      MediaRecorder.isTypeSupported(t)
    );
    mediaRecorder = new MediaRecorder(mixedStream, { mimeType });
    mediaRecorder.ondataavailable = async (e) => {
      if (!(e.data && e.data.size > 0)) return;
      const thisSeq = seq++;
      await CCDB.addChunk(sessionId, e.data); // local safety net for retrying a failed upload
      try {
        await uploadChunk(sessionId, thisSeq, e.data, mimeType);
      } catch (err) {
        console.warn(`Chunk ${thisSeq} didn't reach the server yet, will retry when recording stops:`, err.message);
        pendingRetrySeqs.add(thisSeq);
      }
    };
    mediaRecorder.start(2000); // flush + upload a chunk every 2s
    state = "recording";
    emit("statechange", state);
    tickLoop();
  }

  function tickLoop() {
    if (state !== "recording") return;
    emit("tick", elapsedSeconds());
    setTimeout(tickLoop, 500);
  }

  function elapsedSeconds() {
    if (state === "idle") return 0;
    const live = state === "recording" ? Date.now() - startedAt : 0;
    return Math.floor((elapsedBeforePause + live) / 1000);
  }

  function pause() {
    if (state !== "recording") return;
    mediaRecorder.pause();
    elapsedBeforePause += Date.now() - startedAt;
    state = "paused";
    emit("statechange", state);
  }

  function resume() {
    if (state !== "paused") return;
    startedAt = Date.now();
    mediaRecorder.resume();
    state = "recording";
    emit("statechange", state);
    tickLoop();
  }

  function stop({ title = "Untitled recording", type = "lesson", edited = false } = {}) {
    return new Promise((resolve) => {
      if (!mediaRecorder || state === "idle") return resolve(null);
      mediaRecorder.onstop = async () => {
        cancelAnimationFrame(rafId);
        const mimeType = mediaRecorder.mimeType || "video/webm";
        const duration = elapsedSeconds();
        const uploadId = sessionId;
        state = "idle";
        emit("statechange", state);

        // A chunk that failed live still has a local copy — resend it now
        // before asking the server to assemble the final file.
        if (pendingRetrySeqs.size > 0) {
          const chunks = await CCDB.getChunks(uploadId);
          for (const failedSeq of Array.from(pendingRetrySeqs)) {
            try {
              await uploadChunk(uploadId, failedSeq, chunks[failedSeq], mimeType);
              pendingRetrySeqs.delete(failedSeq);
            } catch (err) {
              console.warn(`Retry of chunk ${failedSeq} failed again:`, err.message);
            }
          }
        }

        let recording = null;
        let finalizeError = null;
        try {
          recording = await finalizeUpload(uploadId, { title, type, durationSec: duration, mimeType, edited });
          await CCDB.clearChunks(uploadId); // server has it now — safe to drop the local safety-net copy
        } catch (err) {
          finalizeError = err.message;
        }

        resolve({ uploadId, durationSec: duration, mimeType, recording, finalizeError, pendingFailures: pendingRetrySeqs.size });
      };
      if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
    });
  }

  function discard() {
    if (sessionId) {
      CCDB.clearChunks(sessionId);
      fetch(`/api/recordings/${sessionId}`, { method: "DELETE", credentials: "same-origin" }).catch(() => {});
    }
    cancelAnimationFrame(rafId);
    state = "idle";
    emit("statechange", state);
  }

  return {
    requestCamera,
    listDevices,
    stopCamera,
    setCameraEnabled,
    setLayout,
    start,
    pause,
    resume,
    stop,
    discard,
    on,
    get state() { return state; },
    get cameraEnabled() { return cameraEnabled; },
    elapsedSeconds,
  };
}

window.createRecorder = createRecorder;
