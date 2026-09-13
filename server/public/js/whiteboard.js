// Digital whiteboard, built on Fabric.js (loaded from CDN in studio.html).
// Supports: freehand pencil with colour/size, an eraser, editable/resizable
// text boxes, image insertion, undo/redo, and a plain export canvas that
// recorder.js composites into the outgoing video.
// A small "✕" that appears on any selected object (text, shape, or image)
// and deletes it on click — a safer, more obvious way to remove a specific
// thing than drawing over it with the eraser, which only paints white pixels
// on top and never actually removes the object underneath. Set once on the
// shared prototype (Fabric convention), so it applies to every object type.
if (typeof fabric !== "undefined" && !fabric.Object.prototype.controls.deleteControl) {
  const DELETE_SIZE = 20;
  fabric.Object.prototype.controls.deleteControl = new fabric.Control({
    x: 0.5,
    y: -0.5,
    offsetX: 18,
    offsetY: -30,
    cursorStyle: "pointer",
    mouseUpHandler: (_eventData, transform) => {
      const target = transform.target;
      const canvas = target.canvas;
      canvas.remove(target);
      canvas.requestRenderAll();
      return true;
    },
    render: (ctx, left, top, _styleOverride, fabricObject) => {
      ctx.save();
      ctx.translate(left, top);
      ctx.rotate(fabric.util.degreesToRadians(fabricObject.angle));
      ctx.fillStyle = "#e63946";
      ctx.beginPath();
      ctx.arc(0, 0, DELETE_SIZE / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-4, -4);
      ctx.lineTo(4, 4);
      ctx.moveTo(4, -4);
      ctx.lineTo(-4, 4);
      ctx.stroke();
      ctx.restore();
    },
  });
}

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

  let currentTool = "pencil";

  function setTool(tool) {
    currentTool = tool;
    canvas.isDrawingMode = tool === "pencil" || tool === "eraser";
    if (tool === "eraser") {
      canvas.freeDrawingBrush.color = "#ffffff";
      canvas.freeDrawingBrush.width = 24;
    } else if (tool === "pencil") {
      canvas.freeDrawingBrush.width = canvas._lastPenWidth || 4;
      canvas.freeDrawingBrush.color = canvas._lastPenColor || "#1a1a2e";
    }
  }

  // Builds a shape spanning two drag points, fresh each call — simplest way
  // to keep an arrow's line+head geometry correct while dragging without
  // hand-rolling Fabric Path point mutation, at the cost of a remove+recreate
  // per mouse-move (cheap; bounded by pointer-move frequency, not a render
  // loop).
  function buildShape(tool, x1, y1, x2, y2) {
    const stroke = canvas._lastPenColor || "#1a1a2e";
    const strokeWidth = Math.max(2, Math.min(canvas._lastPenWidth || 4, 10));
    const common = { stroke, strokeWidth, fill: "transparent", selectable: true, hasControls: true };
    if (tool === "circle") {
      const r = Math.hypot(x2 - x1, y2 - y1);
      return new fabric.Circle({ ...common, left: x1 - r, top: y1 - r, radius: r });
    }
    if (tool === "square") {
      return new fabric.Rect({
        ...common,
        left: Math.min(x1, x2),
        top: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      });
    }
    if (tool === "triangle") {
      return new fabric.Triangle({
        ...common,
        left: Math.min(x1, x2),
        top: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      });
    }
    if (tool === "arrow") {
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const headLen = 18;
      const headAngle = Math.PI / 7;
      const hx1 = x2 - headLen * Math.cos(angle - headAngle);
      const hy1 = y2 - headLen * Math.sin(angle - headAngle);
      const hx2 = x2 - headLen * Math.cos(angle + headAngle);
      const hy2 = y2 - headLen * Math.sin(angle + headAngle);
      const d = `M ${x1} ${y1} L ${x2} ${y2} M ${hx1} ${hy1} L ${x2} ${y2} L ${hx2} ${hy2}`;
      return new fabric.Path(d, { stroke, strokeWidth, fill: "", selectable: true, hasControls: true });
    }
    return null;
  }

  const SHAPE_TOOLS = ["circle", "square", "triangle", "arrow"];
  let shapeStart = null;
  let shapeObj = null;

  canvas.on("mouse:down", (opt) => {
    // Clicking an existing object is always left to Fabric's own
    // select/edit/drag handling, whatever tool happens to be selected.
    if (opt.target) return;
    const pointer = canvas.getPointer(opt.e);
    // With "text" selected, clicking empty board space drops a new text box
    // right where you clicked (like Connect's whiteboard) instead of always
    // at a fixed spot, and the tool stays selected afterward — so typing one
    // line, clicking the next empty spot, and typing again never needs the
    // toolbar button re-clicked in between.
    if (currentTool === "text") {
      addText("Type here...", { left: pointer.x, top: pointer.y });
      return;
    }
    if (SHAPE_TOOLS.includes(currentTool)) {
      shapeStart = pointer;
      suppressHistory = true; // only the finished shape belongs in undo history, not every in-progress frame
      shapeObj = buildShape(currentTool, pointer.x, pointer.y, pointer.x, pointer.y);
      canvas.add(shapeObj);
    }
  });
  canvas.on("mouse:move", (opt) => {
    if (!shapeObj || !shapeStart) return;
    const pointer = canvas.getPointer(opt.e);
    canvas.remove(shapeObj);
    shapeObj = buildShape(currentTool, shapeStart.x, shapeStart.y, pointer.x, pointer.y);
    canvas.add(shapeObj);
  });
  canvas.on("mouse:up", () => {
    if (!shapeObj) return;
    suppressHistory = false;
    const w = shapeObj.width || shapeObj.radius * 2 || 0;
    const h = shapeObj.height || shapeObj.radius * 2 || 0;
    if (w < 5 && h < 5) {
      // A stray click/tiny drag rather than a real shape — drop it silently.
      canvas.remove(shapeObj);
    } else {
      canvas.setActiveObject(shapeObj);
      snapshot();
    }
    shapeObj = null;
    shapeStart = null;
  });

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

  // Same pattern as setPenColor: resizes whatever text box is selected right
  // now, so a size picked wrong at typing time can still be fixed afterwards.
  // Always remembers the size too (not just when nothing is selected), so
  // the next new text box carries over whatever size was last dialled in.
  function setTextSize(px) {
    canvas._lastTextSize = px;
    const active = canvas.getActiveObject();
    if (active && active.type === "textbox") {
      active.set("fontSize", px);
      canvas.requestRenderAll();
    }
  }

  function addText(text = "Type here...", { left = 80, top = 80 } = {}) {
    canvas.isDrawingMode = false;
    const t = new fabric.Textbox(text, {
      left,
      top,
      width: 260,
      fontSize: canvas._lastTextSize || 28,
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

  // The board itself is taller than what's ever visible at once — running
  // out of room means scrolling down to reveal fresh blank space below, not
  // running out of board. Scrolling back up is clamped at the board's
  // original top (dy > 0 here); there's no ceiling on scrolling down.
  function panBy(dy) {
    const vpt = canvas.viewportTransform;
    let nextY = vpt[5] + dy;
    if (nextY > 0) nextY = 0;
    const delta = nextY - vpt[5];
    if (delta === 0) return;
    canvas.relativePan(new fabric.Point(0, delta));
  }

  return {
    canvas,
    PALETTE,
    setTool,
    setPenColor,
    setPenWidth,
    setTextSize,
    addText,
    addImage,
    deleteSelected,
    clearBoard,
    undo,
    redo,
    resize,
    panBy,
  };
}

window.createWhiteboard = createWhiteboard;
