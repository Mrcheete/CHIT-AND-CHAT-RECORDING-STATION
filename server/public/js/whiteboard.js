// Digital whiteboard, built on Fabric.js (loaded from CDN in studio.html).
// Supports: freehand pencil with colour/size, an eraser, editable/resizable
// text boxes, image insertion, undo/redo, and a plain export canvas that
// recorder.js composites into the outgoing video.
function createWhiteboard(canvasEl) {
  const canvas = new fabric.Canvas(canvasEl, {
    isDrawingMode: true,
    backgroundColor: "#ffffff",
    selection: true,
  });

  canvas.freeDrawingBrush.color = "#1a1a2e";
  canvas.freeDrawingBrush.width = 4;

  const history = [];
  const redoStack = [];
  let suppressHistory = false;

  function snapshot() {
    if (suppressHistory) return;
    history.push(JSON.stringify(canvas.toDatalessJSON()));
    if (history.length > 60) history.shift();
    redoStack.length = 0;
  }
  canvas.on("object:added", snapshot);
  canvas.on("object:modified", snapshot);
  canvas.on("object:removed", snapshot);

  function undo() {
    if (history.length < 2) return;
    redoStack.push(history.pop());
    suppressHistory = true;
    canvas.loadFromJSON(history[history.length - 1], () => {
      canvas.renderAll();
      suppressHistory = false;
    });
  }
  function redo() {
    if (!redoStack.length) return;
    const state = redoStack.pop();
    history.push(state);
    suppressHistory = true;
    canvas.loadFromJSON(state, () => {
      canvas.renderAll();
      suppressHistory = false;
    });
  }

  const PALETTE = ["#1a1a2e", "#e63946", "#ff6b6b", "#ffd166", "#2a9d8f", "#4ecdc4", "#3a86ff", "#8338ec", "#ffffff"];

  function setTool(tool) {
    canvas.isDrawingMode = tool === "pencil" || tool === "eraser";
    if (tool === "eraser") {
      canvas.freeDrawingBrush.color = "#ffffff";
      canvas.freeDrawingBrush.width = 24;
    } else if (tool === "pencil") {
      canvas.freeDrawingBrush.width = canvas._lastPenWidth || 4;
      canvas.freeDrawingBrush.color = canvas._lastPenColor || "#1a1a2e";
    }
  }

  // A colour swatch click recolours whatever text box is currently selected
  // (so you can fix a text's colour after placing it, not just at creation),
  // and falls back to changing the pen colour otherwise.
  function setPenColor(hex) {
    const active = canvas.getActiveObject();
    if (active && active.type === "textbox") {
      active.set("fill", hex);
      canvas.requestRenderAll();
      return;
    }
    canvas._lastPenColor = hex;
    canvas.freeDrawingBrush.color = hex;
  }
  function setPenWidth(px) {
    canvas._lastPenWidth = px;
    canvas.freeDrawingBrush.width = px;
  }

  function addText(text = "Type here...") {
    canvas.isDrawingMode = false;
    const t = new fabric.Textbox(text, {
      left: 80,
      top: 80,
      width: 260,
      fontSize: 28,
      fill: canvas._lastPenColor || "#1a1a2e",
      fontFamily: "Inter, sans-serif",
      editable: true,
      selectable: true,
      hasControls: true,
    });
    canvas.add(t);
    canvas.setActiveObject(t);
    // While isEditing is true, Fabric treats clicks/drags on the text as
    // placing the cursor or selecting characters — not moving the object —
    // which is exactly why dragging right after typing does nothing. The
    // click that exits editing (anywhere outside the box) also clears the
    // selection entirely, so without this the very next click would just
    // select the box (still no drag) and only the one after that could
    // finally move it. Re-selecting it the instant editing exits collapses
    // that down to: click away once, then drag.
    t.on("editing:exited", () => {
      canvas.setActiveObject(t);
      canvas.requestRenderAll();
    });
    t.enterEditing();
  }

  function addImage(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        fabric.Image.fromURL(e.target.result, (img) => {
          const maxW = canvas.getWidth() * 0.6;
          if (img.width > maxW) img.scaleToWidth(maxW);
          img.set({ left: 100, top: 100 });
          canvas.add(img);
          canvas.setActiveObject(img);
          resolve(img);
        });
      };
      reader.readAsDataURL(file);
    });
  }

  function deleteSelected() {
    const objs = canvas.getActiveObjects();
    objs.forEach((o) => canvas.remove(o));
    canvas.discardActiveObject();
    canvas.requestRenderAll();
  }

  function clearBoard() {
    canvas.clear();
    canvas.backgroundColor = "#ffffff";
    canvas.renderAll();
  }

  function resize(width, height) {
    canvas.setWidth(width);
    canvas.setHeight(height);
    canvas.renderAll();
  }

  return {
    canvas,
    PALETTE,
    setTool,
    setPenColor,
    setPenWidth,
    addText,
    addImage,
    deleteSelected,
    clearBoard,
    undo,
    redo,
    resize,
  };
}

window.createWhiteboard = createWhiteboard;
