// Compositing recorder: draws the whiteboard canvas + webcam feed onto one
// output canvas every frame, captures that as a MediaStream, mixes in mic
// audio, and records with MediaRecorder. Chunks are flushed to IndexedDB as
// they arrive (see db.js) so recording length isn't bounded by JS memory —
// only by however much disk space the browser/OS makes available.
function createRecorder({ whiteboardCanvasEl, outputCanvasEl, videoPreviewEl }) {
  const outputCtx = outputCanvasEl.getContext("2d");
  let camStream = null;
  let mixedStream = null;
  let mediaRecorder = null;
  let rafId = null;
  let sessionId = null;
  let startedAt = 0;
  let elapsedBeforePause = 0;
  let layout = "pip-bottom-right"; // pip-bottom-right | pip-bottom-left | whiteboard-only | camera-only | side-by-side
  let state = "idle"; // idle | recording | paused

  const listeners = { tick: [], statechange: [] };
  function on(evt, fn) { listeners[evt].push(fn); }
  function emit(evt, payload) { listeners[evt].forEach((fn) => fn(payload)); }

  async function requestCamera({ video = true, audio = true } = {}) {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: video ? { width: 640, height: 480 } : false,
      audio,
    });
    videoPreviewEl.srcObject = camStream;
    await videoPreviewEl.play();
    return camStream;
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

    const hasVideo = videoPreviewEl.readyState >= 2 && camStream;
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

    rafId = requestAnimationFrame(drawFrame);
  }

  async function start() {
    if (state === "recording") return;
    sessionId = `sess_${Date.now()}`;
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
      if (e.data && e.data.size > 0) await CCDB.addChunk(sessionId, e.data);
    };
    mediaRecorder.start(2000); // flush a chunk to IndexedDB every 2s
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

  function stop() {
    return new Promise((resolve) => {
      if (!mediaRecorder || state === "idle") return resolve(null);
      mediaRecorder.onstop = async () => {
        cancelAnimationFrame(rafId);
        const mimeType = mediaRecorder.mimeType || "video/webm";
        const chunks = await CCDB.getChunks(sessionId);
        const blob = new Blob(chunks, { type: mimeType });
        await CCDB.clearChunks(sessionId);
        const duration = elapsedSeconds();
        state = "idle";
        emit("statechange", state);
        resolve({ blob, mimeType, durationSec: duration, sessionId });
      };
      if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
    });
  }

  function discard() {
    if (sessionId) CCDB.clearChunks(sessionId);
    cancelAnimationFrame(rafId);
    state = "idle";
    emit("statechange", state);
  }

  return {
    requestCamera,
    stopCamera,
    setLayout,
    start,
    pause,
    resume,
    stop,
    discard,
    on,
    get state() { return state; },
    elapsedSeconds,
  };
}

window.createRecorder = createRecorder;
