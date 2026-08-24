/* ============================================================
 * Blinkie & Stamp Maker — v2
 * A layered frame compositor with a built-in pixel editor,
 * constrained to the blinkie/stamp aesthetic.
 *
 * v2: true layer stack + undo/redo + free transform.
 *
 * Layer stack (bottom → top, reorderable):
 *   · Background — one, pinned to the bottom (color/image/GIF + FX)
 *   · Draw       — unlimited pixel layers, per-frame raster data
 *   · Text       — unlimited, editable + movable + resizable anytime
 *   · Image      — unlimited uploaded decorations
 *   · Edge       — stamp perforation border; holes punch through
 *                  everything below it in the stack
 *
 * Every layer above the background can be grabbed with the Move
 * tool: drag the body to move, drag a corner handle to resize,
 * arrow keys to nudge, or type exact X / Y / Scale values.
 *
 * Undo/redo: snapshot history (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y).
 * ============================================================ */

'use strict';

// ===================== STATE =====================
const app = {
  w: 150, h: 20,
  zoom: 8,
  tool: 'brush',
  brushColor: '#ff2a6d',
  brushSize: 1,
  showGrid: true,
  onionSkin: true,
  fps: 12,
  isPlaying: false,
  playTimer: null,

  currentFrame: 0,
  frameCount: 3,

  layers: [],            // bottom → top; layers[0] is always the background
  selectedLayerId: null,

  bg: {
    type: 'color',      // color | image
    color: '#000000',
    image: null,        // static image (HTMLImageElement)
    frames: [],         // animated GIF frames (canvas[]), empty when static
    mapping: 'sync'     // sync | stretch | boomerang
  },

  filters: { pixelate: 0, blur: 0, noise: 0, brightness: 0, contrast: 0, saturation: 0, hue: 0 },

  // Draft used when placing a *new* text layer; once a text layer is
  // selected the Text tab edits that layer live instead.
  textDraft: {
    content: '',
    font: "'Press Start 2P', monospace",
    size: 10,
    color: '#ffffff',
    outline: false,
    outlineColor: '#000000'
  }
};

let nextLayerNum = 1;

const canvas = document.getElementById('mainCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const gridCanvas = document.getElementById('gridCanvas');
const gctx = gridCanvas.getContext('2d');
const $ = id => document.getElementById(id);

// Scratch canvas for compositing
const scratch = document.createElement('canvas');
const sctx = scratch.getContext('2d');

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

function hexToRGBA(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
    255
  ];
}

function blankImageData() {
  return ctx.createImageData(app.w, app.h); // all-zero = transparent
}

// ===================== LAYER FACTORY =====================
function makeLayerId() { return 'L' + (nextLayerNum++); }

function makeBackgroundLayer() {
  return { id: makeLayerId(), type: 'background', name: 'Background',
           visible: true, x: 0, y: 0, scale: 1 };
}

function makePixelLayer(name) {
  return { id: makeLayerId(), type: 'pixels',
           name: name || ('Draw ' + countLayersOfType('pixels')),
           visible: true, x: 0, y: 0, scale: 1,
           frames: Array.from({ length: app.frameCount }, blankImageData) };
}

function makeTextLayer(props, x, y) {
  return { id: makeLayerId(), type: 'text',
           name: (props.content || 'Text').slice(0, 14),
           visible: true, x: Math.round(x), y: Math.round(y), scale: 1,
           content: props.content, font: props.font, size: props.size,
           color: props.color, outline: props.outline,
           outlineColor: props.outlineColor };
}

function makeImageLayer(img) {
  const fit = Math.min(1, app.w / img.width, app.h / img.height);
  const w = Math.max(1, Math.round(img.width * fit));
  const h = Math.max(1, Math.round(img.height * fit));
  return { id: makeLayerId(), type: 'image',
           name: 'Image ' + countLayersOfType('image'),
           visible: true,
           x: Math.round((app.w - w) / 2), y: Math.round((app.h - h) / 2),
           scale: 1, image: img, w, h };
}

function makeBorderLayer() {
  return { id: makeLayerId(), type: 'border', name: 'Stamp edge',
           visible: true, x: 0, y: 0, scale: 1,
           style: 'circles',        // circles | squares | dashes | stars
           colorType: 'white',      // white | custom | rainbow | image
           color: '#ffffff', image: null,
           size: 3, spacing: 6 };
}

function countLayersOfType(type) {
  return app.layers.filter(l => l.type === type).length + 1;
}

function selectedLayer() {
  return app.layers.find(l => l.id === app.selectedLayerId) || null;
}

function borderLayer() {
  return app.layers.find(l => l.type === 'border') || null;
}

// Background is pinned and cannot be transformed
function movable(L) { return L && L.type !== 'background'; }

function layerById(id) { return app.layers.find(l => l.id === id) || null; }

// ===================== HISTORY (UNDO / REDO) =====================
// Snapshot-based: the full document is tiny (blinkie-sized pixel
// buffers), so deep-copying on every action is cheap and bulletproof.
const history = { undo: [], redo: [], limit: 40 };
let lastAction = { id: null, time: 0 };

function snapshot() {
  return {
    w: app.w, h: app.h,
    frameCount: app.frameCount,
    currentFrame: app.currentFrame,
    selectedLayerId: app.selectedLayerId,
    bg: {
      type: app.bg.type, color: app.bg.color, mapping: app.bg.mapping,
      image: app.bg.image, frames: app.bg.frames // refs: immutable after load
    },
    layers: app.layers.map(L => {
      const c = Object.assign({}, L);
      if (L.type === 'pixels') {
        c.frames = L.frames.map(f =>
          new ImageData(new Uint8ClampedArray(f.data), f.width, f.height));
      }
      return c;
    })
  };
}

function restore(s) {
  const sizeChanged = (s.w !== app.w || s.h !== app.h);
  app.w = s.w; app.h = s.h;
  app.frameCount = s.frameCount;
  app.currentFrame = Math.min(s.currentFrame, s.frameCount - 1);
  app.bg.type = s.bg.type;
  app.bg.color = s.bg.color;
  app.bg.mapping = s.bg.mapping;
  app.bg.image = s.bg.image;
  app.bg.frames = s.bg.frames;
  app.layers = s.layers;
  app.selectedLayerId = s.selectedLayerId;
  syncDocumentUI(sizeChanged);
}

// actionId enables coalescing: rapid repeats of the *same* action
// (arrow-key nudges, slider drags, typing) collapse into one undo step.
function pushHistory(actionId) {
  const now = Date.now();
  if (actionId && lastAction.id === actionId && now - lastAction.time < 1000) {
    lastAction.time = now;
    return;
  }
  lastAction = { id: actionId || null, time: now };
  history.undo.push(snapshot());
  if (history.undo.length > history.limit) history.undo.shift();
  history.redo = [];
  updateUndoButtons();
}

function undo() {
  if (!history.undo.length) return;
  if (app.isPlaying) stopPlayback();
  history.redo.push(snapshot());
  restore(history.undo.pop());
  lastAction = { id: null, time: 0 };
  updateUndoButtons();
}

function redo() {
  if (!history.redo.length) return;
  if (app.isPlaying) stopPlayback();
  history.undo.push(snapshot());
  restore(history.redo.pop());
  lastAction = { id: null, time: 0 };
  updateUndoButtons();
}

function updateUndoButtons() {
  $('undoBtn').disabled = !history.undo.length;
  $('redoBtn').disabled = !history.redo.length;
}

// Drag gestures (move/resize) only become a history entry if the
// pointer actually changed something — stash at dragstart, commit at
// dragend. Prevents "click without moving" from polluting undo.
let stashedSnapshot = null;
function stashForDrag() { stashedSnapshot = snapshot(); }
function commitDrag(changed) {
  if (stashedSnapshot && changed) {
    history.undo.push(stashedSnapshot);
    if (history.undo.length > history.limit) history.undo.shift();
    history.redo = [];
    lastAction = { id: null, time: 0 };
    updateUndoButtons();
  }
  stashedSnapshot = null;
}

// ===================== INIT =====================
function init() {
  buildPalette();
  app.layers.push(makeBackgroundLayer());
  const draw1 = makePixelLayer('Draw 1');
  app.layers.push(draw1);
  app.selectedLayerId = draw1.id;
  setupEvents();
  fitZoom();
  render();
  rebuildTimeline();
  refreshLayerList();
  refreshEdgeTab();
  updateUndoButtons();
}

function buildPalette() {
  const colors = ['#ff2a6d', '#00f5d4', '#fee800', '#9b5de5', '#ff6b35',
                  '#3a86ff', '#06ffa5', '#ff006e', '#ffffff', '#000000'];
  const p = $('palette');
  colors.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'swatch' + (i === 0 ? ' active' : '');
    d.style.background = c;
    d.onclick = () => {
      document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
      d.classList.add('active');
      setBrushColor(c);
      $('colorPicker').value = c;
    };
    p.appendChild(d);
  });
}

// ===================== FRAMES =====================
function addFrame() {
  pushHistory();
  app.frameCount++;
  app.layers.forEach(L => { if (L.type === 'pixels') L.frames.push(blankImageData()); });
  app.currentFrame = app.frameCount - 1;
  rebuildTimeline();
  render();
}

function dupFrame() {
  if (!app.frameCount) return;
  pushHistory();
  const i = app.currentFrame;
  app.layers.forEach(L => {
    if (L.type !== 'pixels') return;
    const src = L.frames[i];
    const copy = new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
    L.frames.splice(i + 1, 0, copy);
  });
  app.frameCount++;
  app.currentFrame++;
  rebuildTimeline();
  render();
}

function delFrame() {
  if (app.frameCount <= 1) return;
  pushHistory();
  const i = app.currentFrame;
  app.layers.forEach(L => { if (L.type === 'pixels') L.frames.splice(i, 1); });
  app.frameCount--;
  if (app.currentFrame >= app.frameCount) app.currentFrame = app.frameCount - 1;
  rebuildTimeline();
  render();
}

function selectFrame(idx) {
  app.currentFrame = idx;
  render();
}

// ===================== LAYOUT / SIZE =====================
function setLayout(name, btn) {
  document.querySelectorAll('.layout-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  if (name === 'blinkie')     { app.w = 150; app.h = 20; }
  else if (name === 'long')   { app.w = 300; app.h = 20; }
  else if (name === 'stamp')  { app.w = 100; app.h = 100; }
  $('cw').value = app.w;
  $('ch').value = app.h;
  applySize();
}

function applySize() {
  pushHistory();
  app.w = Math.max(20, Math.min(800, parseInt($('cw').value) || 150));
  app.h = Math.max(10, Math.min(600, parseInt($('ch').value) || 20));

  // Resize every draw-layer frame, preserving the top-left region
  app.layers.forEach(L => {
    if (L.type !== 'pixels') return;
    L.frames = L.frames.map(old => {
      const fresh = blankImageData();
      const cw = Math.min(old.width, app.w);
      const ch = Math.min(old.height, app.h);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const si = (y * old.width + x) * 4;
          const di = (y * app.w + x) * 4;
          fresh.data[di]     = old.data[si];
          fresh.data[di + 1] = old.data[si + 1];
          fresh.data[di + 2] = old.data[si + 2];
          fresh.data[di + 3] = old.data[si + 3];
        }
      }
      return fresh;
    });
  });

  fitZoom();
  rebuildTimeline();
  render();
}

function resizeCanvas() {
  canvas.width = app.w;
  canvas.height = app.h;
  canvas.style.width = (app.w * app.zoom) + 'px';
  canvas.style.height = (app.h * app.zoom) + 'px';
  gridCanvas.width = app.w * app.zoom;
  gridCanvas.height = app.h * app.zoom;
}

function setZoom(z) {
  app.zoom = Math.max(1, Math.min(32, z));
  $('zoomLabel').textContent = app.zoom + '×';
  resizeCanvas();
  render();
}

// Pick a zoom that fits the canvas inside the visible area,
// so nothing overflows or gets clipped on load / layout change.
function fitZoom() {
  const area = document.querySelector('.canvas-area');
  const zw = Math.floor((area.clientWidth - 64) / app.w);
  const zh = Math.floor((area.clientHeight - 64) / app.h);
  app.zoom = Math.max(1, Math.min(16, Math.min(zw || 1, zh || 1)));
  $('zoomLabel').textContent = app.zoom + '×';
  resizeCanvas();
}

// ===================== RENDER PIPELINE =====================
// opts.exporting = true skips editor-only overlays (onion skin)
function render(opts) {
  opts = opts || {};
  composeFrame(ctx, app.currentFrame, opts);
  drawOverlay();
  $('frameInfo').textContent = `Frame ${app.currentFrame + 1} of ${app.frameCount}`;
  refreshTimeline();
}

// Composite one timeline frame: walk the layer stack bottom → top.
function composeFrame(tctx, idx, opts) {
  opts = opts || {};
  tctx.clearRect(0, 0, app.w, app.h);
  for (const L of app.layers) {
    if (!L.visible) continue;
    drawLayerTo(tctx, L, idx, opts);
  }
}

function drawLayerTo(tctx, L, idx, opts) {
  switch (L.type) {
    case 'background': {
      tctx.drawImage(buildBackground(idx), 0, 0);
      break;
    }
    case 'pixels': {
      const f = L.frames[idx];
      if (!f) break;
      // Onion skin: ghost of this layer's previous frame (editor only)
      if (!opts.exporting && app.onionSkin && idx > 0 &&
          L.id === app.selectedLayerId && idx === app.currentFrame) {
        const pf = L.frames[idx - 1];
        if (pf) {
          scratch.width = pf.width; scratch.height = pf.height;
          sctx.putImageData(pf, 0, 0);
          tctx.save();
          tctx.globalAlpha = 0.3;
          tctx.imageSmoothingEnabled = false;
          tctx.drawImage(scratch, L.x, L.y, pf.width * L.scale, pf.height * L.scale);
          tctx.restore();
        }
      }
      scratch.width = f.width; scratch.height = f.height;
      sctx.putImageData(f, 0, 0);
      tctx.save();
      tctx.imageSmoothingEnabled = false;
      tctx.drawImage(scratch, L.x, L.y, f.width * L.scale, f.height * L.scale);
      tctx.restore();
      break;
    }
    case 'image': {
      if (!L.image) break;
      tctx.save();
      tctx.imageSmoothingEnabled = false;
      tctx.drawImage(L.image, L.x, L.y, L.w * L.scale, L.h * L.scale);
      tctx.restore();
      break;
    }
    case 'text': {
      drawTextObject(tctx, L);
      break;
    }
    case 'border': {
      drawPerforation(tctx, L);
      break;
    }
  }
}

// Grid + selection chrome live on a separate overlay canvas at display
// resolution, so lines land crisply *between* pixel cells (1 CSS px
// each) and never get baked into the export. mix-blend-mode: difference
// keeps them visible over any background color.
function drawOverlay() {
  const gw = gridCanvas.width, gh = gridCanvas.height;
  gctx.clearRect(0, 0, gw, gh);
  const z = app.zoom;

  if (app.showGrid) {
    gctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (let x = 1; x < app.w; x++) gctx.fillRect(x * z, 0, 1, gh);
    for (let y = 1; y < app.h; y++) gctx.fillRect(0, y * z, gw, 1);
  }

  // Selection box + resize handles for the Move tool
  const L = selectedLayer();
  if (app.tool === 'move' && L && movable(L) && L.visible) {
    const b = layerBounds(L);
    const bx = b.x * z, by = b.y * z, bw = b.w * z, bh = b.h * z;
    gctx.save();
    gctx.strokeStyle = 'rgba(255,255,255,0.9)';
    gctx.lineWidth = 1;
    gctx.setLineDash([4, 3]);
    gctx.strokeRect(bx + 0.5, by + 0.5, bw, bh);
    gctx.setLineDash([]);
    gctx.fillStyle = '#ffffff';
    handleCorners(b).forEach(c => gctx.fillRect(c.dx - 3.5, c.dy - 3.5, 7, 7));
    gctx.restore();
  }
}

// The 4 resize-handle positions of a bounds rect, in both canvas
// pixels (x/y) and display pixels (dx/dy).
function handleCorners(b) {
  const z = app.zoom;
  return [
    { corner: 'nw', x: b.x,         y: b.y,          dx: b.x * z,         dy: b.y * z },
    { corner: 'ne', x: b.x + b.w,   y: b.y,          dx: (b.x + b.w) * z, dy: b.y * z },
    { corner: 'sw', x: b.x,         y: b.y + b.h,    dx: b.x * z,         dy: (b.y + b.h) * z },
    { corner: 'se', x: b.x + b.w,   y: b.y + b.h,    dx: (b.x + b.w) * z, dy: (b.y + b.h) * z }
  ];
}

// Outer bounds of a layer in canvas pixels (for hit-testing + chrome)
function layerBounds(L) {
  switch (L.type) {
    case 'text': {
      const m = measureTextObject(L);
      return { x: L.x, y: L.y, w: m.w, h: m.h };
    }
    case 'image':
      return { x: L.x, y: L.y, w: L.w * L.scale, h: L.h * L.scale };
    default: // pixels | border | background
      return { x: L.x, y: L.y, w: app.w * L.scale, h: app.h * L.scale };
  }
}

// Which animated-background frame should show on timeline frame i
function bgFrameForIndex(i) {
  const frames = app.bg.frames;
  const n = frames.length;
  if (!n) return null;
  if (app.bg.mapping === 'stretch') {
    const total = Math.max(1, app.frameCount);
    return frames[Math.min(n - 1, Math.floor(i / total * n))];
  }
  if (app.bg.mapping === 'boomerang') {
    if (n === 1) return frames[0];
    const cycle = 2 * n - 2;
    const k = i % cycle;
    return frames[k < n ? k : cycle - k];
  }
  return frames[i % n]; // sync
}

// Background + FX chain: css filters → pixelate → noise
function buildBackground(idx) {
  const f = app.filters;
  let c = makeCanvas(app.w, app.h);
  let x = c.getContext('2d');

  if (app.bg.type === 'color') {
    x.fillStyle = app.bg.color;
    x.fillRect(0, 0, app.w, app.h);
  } else {
    const src = app.bg.frames.length ? bgFrameForIndex(idx) : app.bg.image;
    if (!src) return c; // transparent
    x.drawImage(src, 0, 0, app.w, app.h);
  }

  // CSS filter pass (blur / brightness / contrast / saturation / hue)
  const parts = [];
  if (f.blur)       parts.push(`blur(${(f.blur * 0.15).toFixed(2)}px)`);
  if (f.brightness) parts.push(`brightness(${1 + f.brightness / 100})`);
  if (f.contrast)   parts.push(`contrast(${1 + f.contrast / 100})`);
  if (f.saturation) parts.push(`saturate(${Math.max(0, 1 + f.saturation / 100)})`);
  if (f.hue)        parts.push(`hue-rotate(${f.hue}deg)`);
  if (parts.length) {
    const c2 = makeCanvas(app.w, app.h);
    const x2 = c2.getContext('2d');
    x2.filter = parts.join(' ');
    x2.drawImage(c, 0, 0);
    c = c2; x = x2;
  }

  // Pixelate pass (downscale, then upscale with smoothing off)
  if (f.pixelate > 0) {
    const s = f.pixelate + 1;
    const dw = Math.max(1, Math.round(app.w / s));
    const dh = Math.max(1, Math.round(app.h / s));
    const small = makeCanvas(dw, dh);
    small.getContext('2d').drawImage(c, 0, 0, dw, dh);
    const c3 = makeCanvas(app.w, app.h);
    const x3 = c3.getContext('2d');
    x3.imageSmoothingEnabled = false;
    x3.drawImage(small, 0, 0, app.w, app.h);
    c = c3; x = x3;
  }

  // Noise pass (per-pixel random offset)
  if (f.noise > 0) {
    const id = x.getImageData(0, 0, app.w, app.h);
    const d = id.data;
    const amt = f.noise * 0.6;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const n = (Math.random() * 2 - 1) * amt;
      d[i]     = clamp(d[i] + n);
      d[i + 1] = clamp(d[i + 1] + n);
      d[i + 2] = clamp(d[i + 2] + n);
    }
    x.putImageData(id, 0, 0);
  }

  return c;
}

function drawTextObject(tctx, t) {
  const size = Math.max(1, Math.round(t.size * (t.scale || 1)));
  tctx.save();
  tctx.font = `${size}px ${t.font}`;
  tctx.textBaseline = 'top';
  if (t.outline) {
    tctx.lineWidth = 2;
    tctx.strokeStyle = t.outlineColor;
    tctx.strokeText(t.content, t.x, t.y);
  }
  tctx.fillStyle = t.color;
  tctx.fillText(t.content, t.x, t.y);
  tctx.restore();
}

function measureTextObject(t) {
  const size = Math.max(1, Math.round(t.size * (t.scale || 1)));
  sctx.font = `${size}px ${t.font}`;
  const m = sctx.measureText(t.content || '');
  return { w: Math.ceil(m.width), h: size + (t.outline ? 2 : 0) };
}

// ---------- Stamp edge (perforation border) ----------
// Renders a border band, then punches real alpha holes through
// everything *below this layer* in the stack.
function drawPerforation(tctx, L) {
  const { style, size, spacing, colorType, color } = L;
  const maxBand = Math.max(2, Math.floor(Math.min(app.w, app.h) / 2) - 1);
  const band = Math.min(size + 3, maxBand);
  const mid = band / 2;
  const dw = app.w * L.scale, dh = app.h * L.scale;

  // 1 — Border band fill (a ring around the perimeter)
  const bandC = makeCanvas(app.w, app.h);
  const bx = bandC.getContext('2d');
  if (colorType === 'rainbow') {
    const grad = bx.createLinearGradient(0, 0, app.w, app.h);
    grad.addColorStop(0, '#ff006e');
    grad.addColorStop(0.5, '#fee800');
    grad.addColorStop(1, '#00f5d4');
    bx.fillStyle = grad;
  } else if (colorType === 'image' && L.image) {
    bx.fillStyle = bx.createPattern(L.image, 'repeat');
  } else if (colorType === 'custom') {
    bx.fillStyle = color;
  } else {
    bx.fillStyle = '#ffffff';
  }
  bx.fillRect(0, 0, app.w, app.h);
  // Cut out the interior, leaving only the ring
  bx.globalCompositeOperation = 'destination-out';
  bx.fillRect(band, band, Math.max(0, app.w - band * 2), Math.max(0, app.h - band * 2));
  tctx.save();
  tctx.imageSmoothingEnabled = false;
  tctx.drawImage(bandC, L.x, L.y, dw, dh);
  tctx.restore();

  // 2 — Hole pattern on a separate canvas
  const holeC = makeCanvas(app.w, app.h);
  const hx = holeC.getContext('2d');
  hx.fillStyle = '#000';

  const drawHole = (x, y, horizontal) => {
    if (style === 'circles') {
      hx.beginPath(); hx.arc(x, y, size / 2, 0, Math.PI * 2); hx.fill();
    } else if (style === 'squares') {
      hx.fillRect(x - size / 2, y - size / 2, size, size);
    } else if (style === 'dashes') {
      if (horizontal) hx.fillRect(x - size / 2, y - 1, size, 2);
      else            hx.fillRect(x - 1, y - size / 2, 2, size);
    } else if (style === 'stars') {
      hx.save();
      hx.translate(x, y);
      hx.beginPath();
      for (let i = 0; i < 5; i++) {
        hx.lineTo(Math.cos((18 + i * 72) / 180 * Math.PI) * size / 2,
                  -Math.sin((18 + i * 72) / 180 * Math.PI) * size / 2);
        hx.lineTo(Math.cos((54 + i * 72) / 180 * Math.PI) * size / 4,
                  -Math.sin((54 + i * 72) / 180 * Math.PI) * size / 4);
      }
      hx.closePath(); hx.fill();
      hx.restore();
    }
  };

  for (let x = spacing / 2; x < app.w; x += spacing) {
    drawHole(x, mid, true);              // top edge
    drawHole(x, app.h - mid, true);      // bottom edge
  }
  for (let y = spacing / 2; y < app.h; y += spacing) {
    drawHole(mid, y, false);             // left edge
    drawHole(app.w - mid, y, false);     // right edge
  }

  // 3 — Punch real alpha holes through every layer below this one
  tctx.save();
  tctx.globalCompositeOperation = 'destination-out';
  tctx.imageSmoothingEnabled = false;
  tctx.drawImage(holeC, L.x, L.y, dw, dh);
  tctx.restore();
}

// ===================== LAYER MANAGEMENT =====================
function selectLayer(id) {
  app.selectedLayerId = id;
  refreshLayerList();
  syncTransformPanel();
  syncTextControlsFromSelection();
  render();
}

function addDrawLayer(skipHistory) {
  if (!skipHistory) pushHistory();
  const L = makePixelLayer();
  // Insert above the topmost draw layer so stacks stay tidy
  let idx = app.layers.length;
  for (let i = app.layers.length - 1; i >= 0; i--) {
    if (app.layers[i].type === 'pixels') { idx = i + 1; break; }
  }
  app.layers.splice(idx, 0, L);
  app.selectedLayerId = L.id;
  refreshLayerList();
  syncTransformPanel();
  render();
  return L;
}

function addTextLayerFromDraft(x, y) {
  syncTextDraft();
  if (!app.textDraft.content) return null;
  pushHistory();
  const L = makeTextLayer(app.textDraft, x, y);
  app.layers.push(L);
  app.selectedLayerId = L.id;
  ensureFontLoaded(L);
  refreshLayerList();
  syncTransformPanel();
  syncTextControlsFromSelection();
  render();
  return L;
}

function addImageLayer(img) {
  pushHistory();
  const L = makeImageLayer(img);
  app.layers.push(L);
  app.selectedLayerId = L.id;
  refreshLayerList();
  syncTransformPanel();
  render();
}

function addEdgeLayer() {
  if (borderLayer()) return;
  pushHistory();
  const L = makeBorderLayer();
  app.layers.push(L);
  app.selectedLayerId = L.id;
  refreshLayerList();
  refreshEdgeTab();
  syncTransformPanel();
  render();
}

function deleteLayer(id) {
  const L = layerById(id);
  if (!L || L.type === 'background') return;
  pushHistory();
  app.layers = app.layers.filter(l => l.id !== id);
  if (app.selectedLayerId === id) {
    const px = app.layers.filter(l => l.type === 'pixels');
    app.selectedLayerId = px.length ? px[px.length - 1].id : app.layers[0].id;
  }
  refreshLayerList();
  refreshEdgeTab();
  syncTransformPanel();
  render();
}

function moveLayerOrder(id, dir) { // dir: +1 = up (toward top), -1 = down
  const i = app.layers.findIndex(l => l.id === id);
  const j = i + dir;
  if (i < 0 || j < 1 || j >= app.layers.length) return; // background stays pinned at 0
  pushHistory();
  const [L] = app.layers.splice(i, 1);
  app.layers.splice(j, 0, L);
  refreshLayerList();
  render();
}

function toggleLayerVisible(id) {
  const L = layerById(id);
  if (!L) return;
  pushHistory();
  L.visible = !L.visible;
  refreshLayerList();
  render();
}

function renameLayer(id, name) {
  const L = layerById(id);
  if (!L) return;
  name = name.trim();
  if (!name || name === L.name) return;
  pushHistory();
  L.name = name;
  refreshLayerList();
}

// The layer drawing tools operate on: the selected layer if it's a
// draw layer, else the topmost visible draw layer, else a fresh one.
function activePixelLayer() {
  const sel = selectedLayer();
  if (sel && sel.type === 'pixels') return sel;
  for (let i = app.layers.length - 1; i >= 0; i--) {
    if (app.layers[i].type === 'pixels' && app.layers[i].visible) {
      selectLayer(app.layers[i].id);
      return app.layers[i];
    }
  }
  return addDrawLayer(true); // implicit: no separate undo step
}

const LAYER_ICONS = {
  background: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 15l5-5 4 4 3-3 6 6"/></svg>',
  pixels:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13.5c0 2.5-2 4.5-4.5 4.5S9 16 9 13.5s2-4.5 4.5-4.5 4.5 2 4.5 4.5z"/><path d="M9 13.5L4.5 9 3 3l6 1.5L13.5 9"/></svg>',
  text:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>',
  image:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5-9 9"/></svg>',
  border:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 3"/><rect x="8" y="8" width="8" height="8" rx="1"/></svg>'
};

const TYPE_LABEL = { background: 'BG', pixels: 'Draw', text: 'Text', image: 'Image', border: 'Edge' };

// Layers panel — top of the list = top of the stack (rendered last)
function refreshLayerList() {
  const list = $('layerList');
  list.innerHTML = '';
  const topFirst = app.layers.slice().reverse();

  topFirst.forEach((L, revIdx) => {
    const i = app.layers.length - 1 - revIdx; // real stack index
    const row = document.createElement('div');
    row.className = 'layer-row' + (L.id === app.selectedLayerId ? ' active' : '');
    row.dataset.id = L.id;

    // Visibility eye
    const vis = document.createElement('button');
    vis.className = 'l-btn' + (L.visible ? '' : ' off');
    vis.title = 'Toggle visibility';
    vis.innerHTML = L.visible
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    vis.onclick = e => { e.stopPropagation(); toggleLayerVisible(L.id); };

    const icon = document.createElement('span');
    icon.className = 'l-icon';
    icon.innerHTML = LAYER_ICONS[L.type];

    const name = document.createElement('span');
    name.className = 'l-name';
    name.textContent = L.name;
    name.title = L.name + ' — double-click to rename';
    name.ondblclick = e => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'text';
      input.value = L.name;
      name.textContent = '';
      name.appendChild(input);
      input.focus();
      input.select();
      const commit = () => renameLayer(L.id, input.value);
      input.onblur = commit;
      input.onkeydown = ev => {
        if (ev.key === 'Enter') input.blur();
        if (ev.key === 'Escape') { input.onblur = null; refreshLayerList(); }
        ev.stopPropagation();
      };
    };

    const typeTag = document.createElement('span');
    typeTag.className = 'l-type';
    typeTag.textContent = TYPE_LABEL[L.type];

    const mkBtn = (title, svg, fn, hidden) => {
      const b = document.createElement('button');
      b.className = 'l-btn';
      b.title = title;
      b.innerHTML = svg;
      b.style.visibility = hidden ? 'hidden' : 'visible';
      b.onclick = e => { e.stopPropagation(); fn(); };
      return b;
    };
    const up = mkBtn('Move up (toward top)',
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>',
      () => moveLayerOrder(L.id, +1), L.type === 'background' || i === app.layers.length - 1);
    const down = mkBtn('Move down',
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>',
      () => moveLayerOrder(L.id, -1), L.type === 'background' || i === 1);
    const del = mkBtn('Delete layer',
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
      () => deleteLayer(L.id), L.type === 'background');

    row.appendChild(vis);
    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(typeTag);
    row.appendChild(up);
    row.appendChild(down);
    row.appendChild(del);
    row.onclick = () => selectLayer(L.id);
    list.appendChild(row);
  });
}

// ===================== TRANSFORM PANEL =====================
function syncTransformPanel() {
  const L = selectedLayer();
  const show = L && movable(L);
  $('transformPanel').classList.toggle('hidden', !show);
  if (!show) return;
  $('tfName').textContent = L.name;
  $('tfX').value = Math.round(L.x);
  $('tfY').value = Math.round(L.y);
  $('tfScale').value = Math.round(L.scale * 100) / 100;
}

function applyTransformInputs() {
  const L = selectedLayer();
  if (!L || !movable(L)) return;
  pushHistory('transform:' + L.id);
  L.x = Math.round(parseFloat($('tfX').value) || 0);
  L.y = Math.round(parseFloat($('tfY').value) || 0);
  L.scale = Math.max(0.1, Math.min(10, parseFloat($('tfScale').value) || 1));
  render();
}

function resetTransform() {
  const L = selectedLayer();
  if (!L || !movable(L)) return;
  pushHistory();
  L.x = 0; L.y = 0; L.scale = 1;
  if (L.type === 'image') {
    L.x = Math.round((app.w - L.w) / 2);
    L.y = Math.round((app.h - L.h) / 2);
  }
  syncTransformPanel();
  render();
}

// ===================== POINTER / TOOLS =====================
let isDrawing = false;
let dragTarget = null; // { kind:'move'|'scale', ... } for the move tool
let dragChanged = false;
let lastPos = null;

function getPixelPos(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.floor((clientX - rect.left) * app.w / rect.width),
    y: Math.floor((clientY - rect.top) * app.h / rect.height)
  };
}

function getDisplayPos(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return { dx: clientX - rect.left, dy: clientY - rect.top };
}

// Is the pointer on one of the selected layer's resize handles?
function handleAt(clientX, clientY) {
  const L = selectedLayer();
  if (app.tool !== 'move' || !L || !movable(L) || !L.visible) return null;
  const p = getDisplayPos(clientX, clientY);
  const corners = handleCorners(layerBounds(L));
  for (const c of corners) {
    if (Math.abs(p.dx - c.dx) <= 6 && Math.abs(p.dy - c.dy) <= 6) return c;
  }
  return null;
}

// Topmost layer whose visible content is under the point (canvas px)
function hitTestLayers(x, y) {
  for (let i = app.layers.length - 1; i >= 0; i--) {
    const L = app.layers[i];
    if (!L.visible || L.type === 'background') continue;
    const b = layerBounds(L);
    if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue;

    if (L.type === 'pixels') {
      // Only grab actual painted pixels, so layers below stay reachable
      const f = L.frames[app.currentFrame];
      if (!f) continue;
      const lx = Math.floor((x - L.x) / L.scale);
      const ly = Math.floor((y - L.y) / L.scale);
      if (lx < 0 || lx >= f.width || ly < 0 || ly >= f.height) continue;
      if (f.data[(ly * f.width + lx) * 4 + 3] > 0) return L;
    } else if (L.type === 'border') {
      // Only the band ring is grabbable, not the hollow interior
      const lx = (x - L.x) / L.scale;
      const ly = (y - L.y) / L.scale;
      const maxBand = Math.max(2, Math.floor(Math.min(app.w, app.h) / 2) - 1);
      const band = Math.min(L.size + 3, maxBand);
      if (lx < band || lx >= app.w - band || ly < band || ly >= app.h - band) return L;
    } else {
      return L; // text | image: bounding-box hit
    }
  }
  return null;
}

function onPointerDown(clientX, clientY, shiftKey) {
  // Drawing while the preview plays is confusing — strokes would land
  // on whatever frame happens to be active. Pause first.
  if (app.isPlaying) stopPlayback();

  const pos = getPixelPos(clientX, clientY);
  lastPos = pos;

  if (app.tool === 'brush' || app.tool === 'eraser') {
    pushHistory();
    activePixelLayer();
    isDrawing = true;
    drawPixel(pos.x, pos.y);
  } else if (app.tool === 'fill') {
    pushHistory();
    activePixelLayer();
    if (shiftKey) floodFill(pos.x, pos.y);        // Shift+click: classic flood fill
    else { fillCell(pos.x, pos.y); render(); }    // default: fill one pixel cell
  } else if (app.tool === 'picker') {
    pickColor(pos.x, pos.y);
  } else if (app.tool === 'text') {
    addTextLayerFromDraft(pos.x, pos.y);
  } else if (app.tool === 'move') {
    // Corner handle? → resize. Body? → move (and select). Empty? → nothing.
    const h = handleAt(clientX, clientY);
    if (h) {
      const L = selectedLayer();
      const b = layerBounds(L);
      // Anchor = the corner opposite the one being dragged
      const anchor = {
        nw: { x: b.x + b.w, y: b.y + b.h },
        ne: { x: b.x,       y: b.y + b.h },
        sw: { x: b.x + b.w, y: b.y },
        se: { x: b.x,       y: b.y }
      }[h.corner];
      stashForDrag();
      dragTarget = {
        kind: 'scale', layer: L, anchor,
        ox: L.x, oy: L.y, os: L.scale,
        d0: Math.max(1, Math.hypot(pos.x - anchor.x, pos.y - anchor.y))
      };
      dragChanged = false;
      return;
    }
    const hit = hitTestLayers(pos.x, pos.y);
    if (hit) {
      if (hit.id !== app.selectedLayerId) selectLayer(hit.id);
      stashForDrag();
      dragTarget = { kind: 'move', layer: hit, dx: pos.x - hit.x, dy: pos.y - hit.y };
      dragChanged = false;
    }
  }
}

function onPointerMove(clientX, clientY) {
  const pos = getPixelPos(clientX, clientY);

  if (isDrawing && (app.tool === 'brush' || app.tool === 'eraser')) {
    // Interpolate between samples so fast strokes don't leave gaps
    if (lastPos) {
      const dx = pos.x - lastPos.x, dy = pos.y - lastPos.y;
      const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
      for (let i = 1; i <= steps; i++) {
        drawPixel(lastPos.x + Math.round(dx * i / steps),
                  lastPos.y + Math.round(dy * i / steps), true);
      }
      render();
    }
  } else if (dragTarget && dragTarget.kind === 'move') {
    const L = dragTarget.layer;
    const nx = pos.x - dragTarget.dx;
    const ny = pos.y - dragTarget.dy;
    if (nx !== L.x || ny !== L.y) {
      L.x = nx; L.y = ny;
      dragChanged = true;
      render();
    }
  } else if (dragTarget && dragTarget.kind === 'scale') {
    const L = dragTarget.layer;
    const d1 = Math.hypot(pos.x - dragTarget.anchor.x, pos.y - dragTarget.anchor.y);
    const ns = Math.max(0.1, Math.min(10, dragTarget.os * d1 / dragTarget.d0));
    const k = ns / dragTarget.os;
    // Pin the anchor corner in place while scaling
    L.scale = ns;
    L.x = Math.round(dragTarget.anchor.x - (dragTarget.anchor.x - dragTarget.ox) * k);
    L.y = Math.round(dragTarget.anchor.y - (dragTarget.anchor.y - dragTarget.oy) * k);
    dragChanged = true;
    render();
  } else if (app.tool === 'move' && !dragTarget) {
    // Hover cursor feedback
    canvas.style.cursor = handleAt(clientX, clientY) ? 'nwse-resize'
      : hitTestLayers(pos.x, pos.y) ? 'move' : 'default';
  }
  lastPos = pos;
}

function onPointerUp() {
  if (dragTarget) {
    commitDrag(dragChanged);
    if (dragChanged) syncTransformPanel();
  }
  isDrawing = false;
  dragTarget = null;
  lastPos = null;
}

function drawPixel(x, y, defer) {
  const L = activePixelLayer();
  const f = L.frames[app.currentFrame];
  if (!f) return;
  const data = f.data;
  const c = app.tool === 'eraser' ? [0, 0, 0, 0] : hexToRGBA(app.brushColor);
  const r = Math.floor(app.brushSize / 2);

  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const px = x + dx, py = y + dy;
      if (px >= 0 && px < f.width && py >= 0 && py < f.height) {
        const idx = (py * f.width + px) * 4;
        data[idx] = c[0]; data[idx + 1] = c[1];
        data[idx + 2] = c[2]; data[idx + 3] = c[3];
      }
    }
  }
  if (!defer) render();
}

// Fill exactly one pixel cell — the "click a square, it fills" workflow.
function fillCell(x, y) {
  const L = activePixelLayer();
  const f = L.frames[app.currentFrame];
  if (!f || x < 0 || x >= f.width || y < 0 || y >= f.height) return;
  const idx = (y * f.width + x) * 4;
  const c = hexToRGBA(app.brushColor);
  f.data[idx]     = c[0];
  f.data[idx + 1] = c[1];
  f.data[idx + 2] = c[2];
  f.data[idx + 3] = c[3];
}

function floodFill(sx, sy) {
  const L = activePixelLayer();
  const f = L.frames[app.currentFrame];
  if (!f) return;
  const data = f.data;
  const w = f.width, h = f.height;
  if (sx < 0 || sx >= w || sy < 0 || sy >= h) return;

  const ti = (sy * w + sx) * 4;
  const tr = data[ti], tg = data[ti + 1], tb = data[ti + 2], ta = data[ti + 3];
  const fc = hexToRGBA(app.brushColor);
  if (tr === fc[0] && tg === fc[1] && tb === fc[2] && ta === fc[3]) return;

  const stack = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop();
    const idx = (y * w + x) * 4;
    if (data[idx] === tr && data[idx + 1] === tg && data[idx + 2] === tb && data[idx + 3] === ta) {
      data[idx] = fc[0]; data[idx + 1] = fc[1]; data[idx + 2] = fc[2]; data[idx + 3] = fc[3];
      if (x > 0) stack.push([x - 1, y]);
      if (x < w - 1) stack.push([x + 1, y]);
      if (y > 0) stack.push([x, y - 1]);
      if (y < h - 1) stack.push([x, y + 1]);
    }
  }
  render();
}

function pickColor(x, y) {
  const L = activePixelLayer();
  const f = L.frames[app.currentFrame];
  if (!f || x < 0 || x >= f.width || y < 0 || y >= f.height) return;
  const idx = (y * f.width + x) * 4;
  const hex = '#' + [0, 1, 2]
    .map(o => f.data[idx + o].toString(16).padStart(2, '0'))
    .join('');
  setBrushColor(hex);
  $('colorPicker').value = hex;
}

// ===================== TEXT =====================
// The Text tab is dual-mode: with a text layer selected it edits that
// layer live; otherwise it's the draft used to place the next one.
function textControlsTarget() {
  const L = selectedLayer();
  return (L && L.type === 'text') ? L : null;
}

function syncTextDraft() {
  app.textDraft.content = $('textContent').value;
  app.textDraft.font = $('textFont').value;
  app.textDraft.size = parseInt($('textSize').value);
  app.textDraft.color = $('textColor').value;
  app.textDraft.outline = $('textOutline').checked;
  app.textDraft.outlineColor = $('textOutlineColor').value;
  $('textSizeLabel').textContent = app.textDraft.size + 'px';
}

function syncTextControlsFromSelection() {
  const L = textControlsTarget();
  $('textTargetNote').textContent = L
    ? `Editing selected layer “${L.name}” — changes apply live.`
    : 'No text layer selected — these settings apply to the next text you place.';
  if (!L) return;
  $('textContent').value = L.content;
  $('textFont').value = L.font;
  $('textSize').value = L.size;
  $('textSizeLabel').textContent = L.size + 'px';
  $('textColor').value = L.color;
  $('textOutline').checked = L.outline;
  $('textOutlineColor').value = L.outlineColor;
}

function onTextControlInput(commit) {
  const L = textControlsTarget();
  if (!L) { syncTextDraft(); return; }
  if (commit) pushHistory('text:' + L.id);
  L.content = $('textContent').value;
  L.font = $('textFont').value;
  L.size = parseInt($('textSize').value);
  L.color = $('textColor').value;
  L.outline = $('textOutline').checked;
  L.outlineColor = $('textOutlineColor').value;
  L.name = (L.content || 'Text').slice(0, 14);
  $('textSizeLabel').textContent = L.size + 'px';
  ensureFontLoaded(L);
  refreshLayerList();
  render();
}

function ensureFontLoaded(t) {
  if (document.fonts && document.fonts.load) {
    document.fonts.load(`${t.size}px ${t.font}`).then(() => render());
  }
}

function placeTextCentered() {
  syncTextDraft();
  if (!app.textDraft.content) return;
  const probe = { ...app.textDraft, scale: 1 };
  const m = measureTextObject(probe);
  addTextLayerFromDraft(Math.round((app.w - m.w) / 2), Math.round((app.h - m.h) / 2));
}

// ===================== UI WIRING =====================
function setTool(t) {
  app.tool = t;
  document.querySelectorAll('.tool-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === t));
  canvas.style.cursor = t === 'move' ? 'default' : 'crosshair';
  render(); // selection chrome only shows for the move tool
}

function setBrushColor(c) { app.brushColor = c; }

function setupEvents() {
  // Canvas pointer + touch
  canvas.addEventListener('mousedown', e => onPointerDown(e.clientX, e.clientY, e.shiftKey));
  canvas.addEventListener('mousemove', e => onPointerMove(e.clientX, e.clientY));
  canvas.addEventListener('mouseup', onPointerUp);
  canvas.addEventListener('mouseleave', onPointerUp);
  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.touches[0];
    onPointerDown(t.clientX, t.clientY);
  }, { passive: false });
  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    const t = e.touches[0];
    onPointerMove(t.clientX, t.clientY);
  }, { passive: false });
  canvas.addEventListener('touchend', onPointerUp);

  // Keyboard: undo/redo + arrow-key nudge for the selected layer
  document.addEventListener('keydown', e => {
    const tag = (document.activeElement || {}).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
    } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      const L = selectedLayer();
      if (!L || !movable(L)) return;
      e.preventDefault();
      pushHistory('nudge:' + L.id);
      const s = e.shiftKey ? 4 : 1;
      if (e.key === 'ArrowLeft')  L.x -= s;
      if (e.key === 'ArrowRight') L.x += s;
      if (e.key === 'ArrowUp')    L.y -= s;
      if (e.key === 'ArrowDown')  L.y += s;
      syncTransformPanel();
      render();
    }
  });

  // Undo / redo buttons
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);

  // Tools
  document.querySelectorAll('.tool-btn').forEach(b =>
    b.addEventListener('click', () => setTool(b.dataset.tool)));

  // Layout buttons + custom size
  document.querySelectorAll('.layout-btn').forEach(b =>
    b.addEventListener('click', () => setLayout(b.dataset.layout, b)));
  $('applySize').addEventListener('click', applySize);

  // Color / brush
  $('colorPicker').addEventListener('input', e => setBrushColor(e.target.value));
  $('brushSize').addEventListener('input', e => {
    app.brushSize = parseInt(e.target.value);
    $('brushSizeLabel').textContent = e.target.value + ' px';
  });
  $('gridToggle').addEventListener('change', e => { app.showGrid = e.target.checked; render(); });
  $('onionToggle').addEventListener('change', e => { app.onionSkin = e.target.checked; render(); });

  // Zoom
  $('zoomOut').addEventListener('click', () => setZoom(app.zoom - 1));
  $('zoomIn').addEventListener('click', () => setZoom(app.zoom + 1));

  // Tabs
  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
      document.querySelectorAll('.tab-content').forEach(x =>
        x.classList.toggle('active', x.id === 'tab-' + t.dataset.tab));
    }));

  // Layers panel
  $('addDrawLayerBtn').addEventListener('click', () => addDrawLayer(false));
  $('addTextLayerBtn').addEventListener('click', () => {
    syncTextDraft();
    if (app.textDraft.content) placeTextCentered();
    else { $('textContent').focus(); switchToTab('text'); }
  });
  $('addImageLayerBtn').addEventListener('click', () => $('imageLayerUpload').click());
  $('imageLayerUpload').addEventListener('change', e => {
    loadImageFile(e.target.files[0], addImageLayer);
    e.target.value = '';
  });
  $('addEdgeLayerBtn').addEventListener('click', addEdgeLayer);
  ['tfX', 'tfY', 'tfScale'].forEach(id =>
    $(id).addEventListener('change', applyTransformInputs));
  $('tfReset').addEventListener('click', resetTransform);

  // Background
  $('bgType').addEventListener('change', e => {
    pushHistory();
    app.bg.type = e.target.value;
    $('bgColorField').classList.toggle('hidden', app.bg.type !== 'color');
    $('bgImageField').classList.toggle('hidden', app.bg.type !== 'image');
    render();
  });
  $('bgColor').addEventListener('input', e => { app.bg.color = e.target.value; render(); });
  $('bgColor').addEventListener('change', () => pushHistory('bg:color'));
  $('bgUploadBox').addEventListener('click', () => $('bgUpload').click());
  $('bgUpload').addEventListener('change', e => handleBgUpload(e.target.files[0]));
  $('bgMapping').addEventListener('change', e => {
    pushHistory();
    app.bg.mapping = e.target.value;
    render();
  });

  // Text — live edit on 'input', one undo step per burst on 'change'
  ['textContent', 'textFont', 'textSize', 'textColor', 'textOutline', 'textOutlineColor']
    .forEach(id => {
      $(id).addEventListener('input', () => onTextControlInput(false));
      $(id).addEventListener('change', () => onTextControlInput(true));
    });
  $('addTextBtn').addEventListener('click', placeTextCentered);

  // Edge (border layer) — controls edit the border layer when one exists
  $('edgeAddBtn').addEventListener('click', addEdgeLayer);
  $('edgeRemoveBtn').addEventListener('click', () => {
    const L = borderLayer();
    if (L) deleteLayer(L.id);
  });
  $('perfStyle').addEventListener('change', e => {
    const L = borderLayer(); if (!L) return;
    pushHistory(); L.style = e.target.value; render();
  });
  $('perfColorType').addEventListener('change', e => {
    const L = borderLayer(); if (!L) return;
    pushHistory();
    L.colorType = e.target.value;
    $('perfCustomColorField').classList.toggle('hidden', L.colorType !== 'custom');
    $('perfImageField').classList.toggle('hidden', L.colorType !== 'image');
    render();
  });
  $('perfColor').addEventListener('input', e => {
    const L = borderLayer(); if (!L) return;
    L.color = e.target.value; render();
  });
  $('perfColor').addEventListener('change', () => pushHistory('edge:color'));
  $('perfUploadBox').addEventListener('click', () => $('perfUpload').click());
  $('perfUpload').addEventListener('change', e => {
    loadImageFile(e.target.files[0], img => {
      const L = borderLayer(); if (!L) return;
      pushHistory(); L.image = img; render();
    });
  });
  $('perfSize').addEventListener('input', e => {
    const L = borderLayer(); if (!L) return;
    L.size = parseInt(e.target.value);
    $('perfSizeLabel').textContent = e.target.value;
    render();
  });
  $('perfSize').addEventListener('change', () => pushHistory('edge:size'));
  $('perfSpacing').addEventListener('input', e => {
    const L = borderLayer(); if (!L) return;
    L.spacing = parseInt(e.target.value);
    $('perfSpacingLabel').textContent = e.target.value;
    render();
  });
  $('perfSpacing').addEventListener('change', () => pushHistory('edge:spacing'));

  // Filters (live preview; intentionally outside undo history)
  document.querySelectorAll('[data-filter]').forEach(el =>
    el.addEventListener('input', () => {
      app.filters[el.dataset.filter] = parseInt(el.value);
      const label = $(el.id + 'Label');
      if (label) label.textContent = el.dataset.filter === 'hue' ? el.value + '°' : el.value;
      render();
    }));

  // Timeline
  $('addFrameBtn').addEventListener('click', addFrame);
  $('dupFrameBtn').addEventListener('click', dupFrame);
  $('delFrameBtn').addEventListener('click', delFrame);
  $('fpsInput').addEventListener('change', e => {
    app.fps = Math.max(1, Math.min(60, parseInt(e.target.value) || 12));
    if (app.isPlaying) { stopPlayback(); startPlayback(); }
  });

  // Playback + export
  $('playBtn').addEventListener('click', togglePlay);
  $('exportBtn').addEventListener('click', exportGIF);
}

function switchToTab(name) {
  document.querySelectorAll('.tab').forEach(x =>
    x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(x =>
    x.classList.toggle('active', x.id === 'tab-' + name));
}

function loadImageFile(file, cb) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const img = new Image();
    img.onload = () => cb(img);
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

// ---------- Background upload (static image or animated GIF) ----------
function handleBgUpload(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const buf = ev.target.result;
    const sig = String.fromCharCode(...new Uint8Array(buf.slice(0, 6)));
    if (sig === 'GIF89a' || sig === 'GIF87a') {
      try {
        const gif = GIFReader.parse(buf);
        if (gif.frames.length > 1) {
          pushHistory();
          setAnimatedBackground(gif);
          return;
        }
      } catch (err) {
        console.warn('GIF parse failed, treating as static image:', err);
      }
    }
    // Static image path
    const img = new Image();
    img.onload = () => {
      pushHistory();
      app.bg.image = img;
      app.bg.frames = [];
      updateBgAnimUI();
      render();
    };
    img.src = URL.createObjectURL(file);
  };
  reader.readAsArrayBuffer(file);
}

function setAnimatedBackground(gif) {
  // Convert composited RGBA frames to canvases
  app.bg.frames = gif.frames.map(f => {
    const c = makeCanvas(gif.width, gif.height);
    c.getContext('2d').putImageData(new ImageData(f.rgba, gif.width, gif.height), 0, 0);
    return c;
  });
  app.bg.image = null;

  // If the document is still pristine (nothing drawn, no extra layers),
  // grow the timeline to match the GIF and adopt its average frame rate.
  if (timelineIsEmpty()) {
    const n = Math.min(60, gif.frames.length);
    app.frameCount = n;
    app.layers.forEach(L => {
      if (L.type === 'pixels') L.frames = Array.from({ length: n }, blankImageData);
    });
    app.currentFrame = 0;
    const avgDelay = gif.frames.reduce((s, f) => s + f.delay, 0) / gif.frames.length;
    app.fps = Math.max(1, Math.min(60, Math.round(100 / avgDelay)));
    $('fpsInput').value = app.fps;
    rebuildTimeline();
  }

  updateBgAnimUI(gif.frames.length);
  render();
}

function timelineIsEmpty() {
  return app.layers.every(L => {
    if (L.type === 'pixels') {
      return L.frames.every(f => f.data.every((v, i) => i % 4 !== 3 || v === 0));
    }
    return L.type === 'background' || L.type === 'border';
  });
}

function updateBgAnimUI(n) {
  const animated = app.bg.frames.length > 1;
  $('bgAnimField').classList.toggle('hidden', !animated);
  if (animated) $('bgAnimInfo').textContent = `· ${n || app.bg.frames.length} frames`;
}

// Edge tab mirrors the border layer's state (or offers to create one)
function refreshEdgeTab() {
  const L = borderLayer();
  $('edgeEmpty').classList.toggle('hidden', !!L);
  $('edgeControls').classList.toggle('hidden', !L);
  if (!L) return;
  $('perfStyle').value = L.style;
  $('perfColorType').value = L.colorType;
  $('perfCustomColorField').classList.toggle('hidden', L.colorType !== 'custom');
  $('perfImageField').classList.toggle('hidden', L.colorType !== 'image');
  $('perfColor').value = L.color;
  $('perfSize').value = L.size;
  $('perfSizeLabel').textContent = L.size;
  $('perfSpacing').value = L.spacing;
  $('perfSpacingLabel').textContent = L.spacing;
}

// ===================== TIMELINE =====================
function rebuildTimeline() {
  const container = $('timelineFrames');
  container.innerHTML = '';
  for (let i = 0; i < app.frameCount; i++) {
    const div = document.createElement('div');
    div.className = 'frame-thumb';
    div.onclick = () => selectFrame(i);
    const c = makeCanvas(app.w, app.h);
    div.appendChild(c);
    const num = document.createElement('div');
    num.className = 'num';
    num.textContent = i + 1;
    div.appendChild(num);
    container.appendChild(div);
  }
  refreshTimeline();
}

function refreshTimeline() {
  const container = $('timelineFrames');
  // Canvases are tiny (blinkie-sized), so re-rendering every thumb is cheap
  // and guarantees nothing goes stale when bg/layers/filters change.
  Array.from(container.children).forEach((div, i) => {
    div.classList.toggle('active', i === app.currentFrame);
    renderThumb(div.querySelector('canvas'), i);
  });
}

function renderThumb(c, idx) {
  const tctx = c.getContext('2d');
  tctx.clearRect(0, 0, c.width, c.height);
  composeFrame(tctx, idx, { exporting: true });
}

// ===================== PLAYBACK =====================
function startPlayback() {
  app.isPlaying = true;
  $('playLabel').textContent = 'Stop';
  app.playTimer = setInterval(() => {
    app.currentFrame = (app.currentFrame + 1) % app.frameCount;
    render();
  }, 1000 / app.fps);
}

function stopPlayback() {
  clearInterval(app.playTimer);
  app.isPlaying = false;
  $('playLabel').textContent = 'Play';
}

function togglePlay() {
  if (app.isPlaying) stopPlayback();
  else startPlayback();
}

// ===================== GIF EXPORT =====================
async function exportGIF() {
  const wasPlaying = app.isPlaying;
  if (wasPlaying) stopPlayback();
  const restoreFrame = app.currentFrame;

  // Make sure web fonts are ready so text renders in the export
  if (document.fonts && document.fonts.ready) await document.fonts.ready;

  const encoder = new GIFWriter(app.w, app.h);
  const delay = Math.max(2, Math.round(100 / app.fps)); // hundredths of a second

  for (let i = 0; i < app.frameCount; i++) {
    app.currentFrame = i;
    render({ exporting: true });
    encoder.addFrame(ctx.getImageData(0, 0, app.w, app.h), delay);
  }

  app.currentFrame = restoreFrame;
  render();

  const blob = new Blob([encoder.write()], { type: 'image/gif' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'blinkie.gif';
  a.click();
  URL.revokeObjectURL(url);

  if (wasPlaying) startPlayback();
}

// ===================== DOCUMENT SYNC =====================
// Bring every control in line with app state (used by undo/redo restore)
function syncDocumentUI(sizeChanged) {
  $('cw').value = app.w;
  $('ch').value = app.h;
  $('bgType').value = app.bg.type;
  $('bgColor').value = app.bg.color;
  $('bgColorField').classList.toggle('hidden', app.bg.type !== 'color');
  $('bgImageField').classList.toggle('hidden', app.bg.type !== 'image');
  $('bgMapping').value = app.bg.mapping;
  updateBgAnimUI();
  if (sizeChanged) fitZoom(); else resizeCanvas();
  rebuildTimeline();
  refreshLayerList();
  refreshEdgeTab();
  syncTransformPanel();
  syncTextControlsFromSelection();
  render();
}

// ===================== START =====================
init();
