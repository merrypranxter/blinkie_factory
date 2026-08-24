/* ============================================================
 * Blinkie & Stamp Maker — v1
 * A layered frame compositor with a built-in pixel editor,
 * constrained to the blinkie/stamp aesthetic.
 *
 * Layer stack (per frame):
 *   1. Background   — solid color or uploaded image (+ FX)
 *   2. Pixel art    — hand-drawn per-frame raster
 *   3. Decorations  — uploaded images, draggable
 *   4. Text         — bitmap-font rendering
 *   5. Perforation  — real alpha holes punched through everything
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
  frames: [], // { pixels: ImageData, texts: [], decorations: [] }

  bg: { type: 'color', color: '#000000', image: null },

  perforation: {
    style: 'none',        // none | circles | squares | dashes | stars
    colorType: 'white',   // white | custom | rainbow | image
    color: '#ffffff',
    image: null,
    size: 3,
    spacing: 6
  },

  filters: { pixelate: 0, blur: 0, noise: 0, brightness: 0, contrast: 0, saturation: 0, hue: 0 },

  textDraft: {
    content: '',
    font: "'Press Start 2P', monospace",
    size: 10,
    color: '#ffffff',
    outline: false,
    outlineColor: '#000000',
    x: 0, y: 0
  }
};

const canvas = document.getElementById('mainCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
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
  const d = ctx.createImageData(app.w, app.h); // already all-zero = transparent
  return d;
}

// ===================== INIT =====================
function init() {
  buildPalette();
  for (let i = 0; i < 3; i++) app.frames.push(newFrame());
  app.currentFrame = 0;
  resizeCanvas();
  setupEvents();
  render();
  rebuildTimeline();
}

function newFrame() {
  return { pixels: blankImageData(), texts: [], decorations: [] };
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
  app.frames.push(newFrame());
  app.currentFrame = app.frames.length - 1;
  rebuildTimeline();
  render();
}

function dupFrame() {
  if (!app.frames.length) return;
  const src = app.frames[app.currentFrame];
  const copy = {
    pixels: blankImageData(),
    texts: src.texts.map(t => ({ ...t })),
    decorations: src.decorations.map(d => ({ ...d }))
  };
  copy.pixels.data.set(src.pixels.data);
  app.frames.splice(app.currentFrame + 1, 0, copy);
  app.currentFrame++;
  rebuildTimeline();
  render();
}

function delFrame() {
  if (app.frames.length <= 1) return;
  app.frames.splice(app.currentFrame, 1);
  if (app.currentFrame >= app.frames.length) app.currentFrame = app.frames.length - 1;
  rebuildTimeline();
  render();
}

function selectFrame(idx) {
  app.currentFrame = idx;
  render();
  refreshTextList();
  refreshDecoList();
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
  app.w = Math.max(20, Math.min(800, parseInt($('cw').value) || 150));
  app.h = Math.max(10, Math.min(600, parseInt($('ch').value) || 20));

  // Resize per-frame pixel data, preserving the top-left region
  app.frames.forEach(f => {
    const old = f.pixels;
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
    f.pixels = fresh;
  });

  resizeCanvas();
  rebuildTimeline();
  render();
}

function resizeCanvas() {
  canvas.width = app.w;
  canvas.height = app.h;
  canvas.style.width = (app.w * app.zoom) + 'px';
  canvas.style.height = (app.h * app.zoom) + 'px';
}

function setZoom(z) {
  app.zoom = Math.max(1, Math.min(32, z));
  $('zoomLabel').textContent = app.zoom + '×';
  resizeCanvas();
}

// ===================== RENDER PIPELINE =====================
// opts.exporting = true skips editor-only overlays (grid, onion skin)
function render(opts) {
  opts = opts || {};
  const frame = app.frames[app.currentFrame];
  if (!frame) return;

  ctx.clearRect(0, 0, app.w, app.h);

  // 1 — Background (with FX baked in)
  ctx.drawImage(buildBackground(), 0, 0);

  // Onion skin (editor only)
  if (!opts.exporting && app.onionSkin && app.currentFrame > 0) {
    ctx.save();
    ctx.globalAlpha = 0.3;
    scratch.width = app.w; scratch.height = app.h;
    sctx.putImageData(app.frames[app.currentFrame - 1].pixels, 0, 0);
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }

  // 2 — Pixel art layer
  scratch.width = app.w; scratch.height = app.h;
  sctx.putImageData(frame.pixels, 0, 0);
  ctx.drawImage(scratch, 0, 0);

  // 3 — Decorations
  frame.decorations.forEach(d => {
    if (d.image) ctx.drawImage(d.image, d.x, d.y, d.w, d.h);
  });

  // 4 — Texts
  frame.texts.forEach(t => drawTextObject(ctx, t));

  // 5 — Perforation (border band, then holes punched through everything)
  if (app.perforation.style !== 'none') drawPerforation(ctx);

  // Grid overlay (editor only)
  if (!opts.exporting && app.showGrid && app.zoom >= 4) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= app.w; x++) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, app.h); ctx.stroke();
    }
    for (let y = 0; y <= app.h; y++) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(app.w, y); ctx.stroke();
    }
    ctx.restore();
  }

  $('frameInfo').textContent = `Frame ${app.currentFrame + 1} of ${app.frames.length}`;
  refreshTimeline();
}

// Background + FX chain: css filters → pixelate → noise
function buildBackground() {
  const f = app.filters;
  let c = makeCanvas(app.w, app.h);
  let x = c.getContext('2d');

  if (app.bg.type === 'color') {
    x.fillStyle = app.bg.color;
    x.fillRect(0, 0, app.w, app.h);
  } else if (app.bg.image) {
    x.drawImage(app.bg.image, 0, 0, app.w, app.h);
  } else {
    return c; // transparent
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
  tctx.save();
  tctx.font = `${t.size}px ${t.font}`;
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
  sctx.font = `${t.size}px ${t.font}`;
  const m = sctx.measureText(t.content);
  return { w: Math.ceil(m.width), h: t.size + (t.outline ? 2 : 0) };
}

// ---------- Perforation ----------
function drawPerforation(tctx) {
  const { style, size, spacing, colorType, color } = app.perforation;
  const maxBand = Math.max(2, Math.floor(Math.min(app.w, app.h) / 2) - 1);
  const band = Math.min(size + 3, maxBand);
  const mid = band / 2;

  // 1 — Border band fill (a ring around the perimeter)
  const bandC = makeCanvas(app.w, app.h);
  const bx = bandC.getContext('2d');
  if (colorType === 'rainbow') {
    const grad = bx.createLinearGradient(0, 0, app.w, app.h);
    grad.addColorStop(0, '#ff006e');
    grad.addColorStop(0.5, '#fee800');
    grad.addColorStop(1, '#00f5d4');
    bx.fillStyle = grad;
  } else if (colorType === 'image' && app.perforation.image) {
    bx.fillStyle = bx.createPattern(app.perforation.image, 'repeat');
  } else if (colorType === 'custom') {
    bx.fillStyle = color;
  } else {
    bx.fillStyle = '#ffffff';
  }
  bx.fillRect(0, 0, app.w, app.h);
  // Cut out the interior, leaving only the ring
  bx.globalCompositeOperation = 'destination-out';
  bx.fillRect(band, band, Math.max(0, app.w - band * 2), Math.max(0, app.h - band * 2));
  tctx.drawImage(bandC, 0, 0);

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

  // 3 — Punch real alpha holes through the entire layer stack
  tctx.save();
  tctx.globalCompositeOperation = 'destination-out';
  tctx.drawImage(holeC, 0, 0);
  tctx.restore();
}

// ===================== DRAWING / POINTER =====================
let isDrawing = false;
let dragTarget = null; // { obj, dx, dy } for move tool
let lastPos = null;

function getPixelPos(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.floor((clientX - rect.left) * app.w / rect.width),
    y: Math.floor((clientY - rect.top) * app.h / rect.height)
  };
}

function hitTest(x, y) {
  const frame = app.frames[app.currentFrame];
  // Decorations sit above texts; later entries render on top
  for (let i = frame.decorations.length - 1; i >= 0; i--) {
    const d = frame.decorations[i];
    if (x >= d.x && x <= d.x + d.w && y >= d.y && y <= d.y + d.h)
      return { type: 'deco', obj: d };
  }
  for (let i = frame.texts.length - 1; i >= 0; i--) {
    const t = frame.texts[i];
    const m = measureTextObject(t);
    if (x >= t.x && x <= t.x + m.w && y >= t.y && y <= t.y + m.h)
      return { type: 'text', obj: t };
  }
  return null;
}

function onPointerDown(clientX, clientY) {
  const pos = getPixelPos(clientX, clientY);
  lastPos = pos;

  if (app.tool === 'brush' || app.tool === 'eraser') {
    isDrawing = true;
    drawPixel(pos.x, pos.y);
  } else if (app.tool === 'fill') {
    floodFill(pos.x, pos.y);
  } else if (app.tool === 'picker') {
    pickColor(pos.x, pos.y);
  } else if (app.tool === 'text') {
    placeTextAt(pos.x, pos.y);
  } else if (app.tool === 'move') {
    const hit = hitTest(pos.x, pos.y);
    if (hit) {
      dragTarget = { obj: hit.obj, dx: pos.x - hit.obj.x, dy: pos.y - hit.obj.y };
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
  } else if (dragTarget) {
    dragTarget.obj.x = pos.x - dragTarget.dx;
    dragTarget.obj.y = pos.y - dragTarget.dy;
    render();
  }
  lastPos = pos;
}

function onPointerUp() {
  isDrawing = false;
  dragTarget = null;
  lastPos = null;
}

function drawPixel(x, y, defer) {
  const frame = app.frames[app.currentFrame];
  const data = frame.pixels.data;
  const c = app.tool === 'eraser' ? [0, 0, 0, 0] : hexToRGBA(app.brushColor);
  const r = Math.floor(app.brushSize / 2);

  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const px = x + dx, py = y + dy;
      if (px >= 0 && px < app.w && py >= 0 && py < app.h) {
        const idx = (py * app.w + px) * 4;
        data[idx] = c[0]; data[idx + 1] = c[1];
        data[idx + 2] = c[2]; data[idx + 3] = c[3];
      }
    }
  }
  if (!defer) render();
}

function floodFill(sx, sy) {
  const frame = app.frames[app.currentFrame];
  const data = frame.pixels.data;
  const w = app.w, h = app.h;
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
  if (x < 0 || x >= app.w || y < 0 || y >= app.h) return;
  const frame = app.frames[app.currentFrame];
  const idx = (y * app.w + x) * 4;
  const hex = '#' + [0, 1, 2]
    .map(o => frame.pixels.data[idx + o].toString(16).padStart(2, '0'))
    .join('');
  setBrushColor(hex);
  $('colorPicker').value = hex;
}

// ===================== TEXT =====================
function syncTextDraft() {
  app.textDraft.content = $('textContent').value;
  app.textDraft.font = $('textFont').value;
  app.textDraft.size = parseInt($('textSize').value);
  app.textDraft.color = $('textColor').value;
  app.textDraft.outline = $('textOutline').checked;
  app.textDraft.outlineColor = $('textOutlineColor').value;
  $('textSizeLabel').textContent = app.textDraft.size + 'px';
}

function ensureFontLoaded(t) {
  if (document.fonts && document.fonts.load) {
    document.fonts.load(`${t.size}px ${t.font}`).then(() => render());
  }
}

function placeTextAt(x, y) {
  syncTextDraft();
  if (!app.textDraft.content) return;
  const t = { ...app.textDraft, x, y };
  app.frames[app.currentFrame].texts.push(t);
  ensureFontLoaded(t);
  render();
  refreshTextList();
}

function placeTextCentered() {
  syncTextDraft();
  if (!app.textDraft.content) return;
  const t = { ...app.textDraft, x: 0, y: 0 };
  const m = measureTextObject(t);
  t.x = Math.round((app.w - m.w) / 2);
  t.y = Math.round((app.h - m.h) / 2);
  app.frames[app.currentFrame].texts.push(t);
  ensureFontLoaded(t);
  render();
  refreshTextList();
}

function refreshTextList() {
  const list = $('textList');
  list.innerHTML = '';
  app.frames[app.currentFrame].texts.forEach((t, i) => {
    const div = document.createElement('div');
    div.className = 'list-item';
    const label = document.createElement('span');
    label.className = 'li-label';
    label.textContent = t.content || ('Text ' + (i + 1));
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Remove';
    btn.onclick = () => {
      app.frames[app.currentFrame].texts.splice(i, 1);
      render();
      refreshTextList();
    };
    div.appendChild(label);
    div.appendChild(btn);
    list.appendChild(div);
  });
}

// ===================== UI WIRING =====================
function setTool(t) {
  app.tool = t;
  document.querySelectorAll('.tool-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === t));
  canvas.style.cursor = t === 'move' ? 'move' : 'crosshair';
}

function setBrushColor(c) { app.brushColor = c; }

function setupEvents() {
  // Canvas pointer + touch
  canvas.addEventListener('mousedown', e => onPointerDown(e.clientX, e.clientY));
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

  // Background
  $('bgType').addEventListener('change', e => {
    app.bg.type = e.target.value;
    $('bgColorField').classList.toggle('hidden', app.bg.type !== 'color');
    $('bgImageField').classList.toggle('hidden', app.bg.type !== 'image');
    render();
  });
  $('bgColor').addEventListener('input', e => { app.bg.color = e.target.value; render(); });
  $('bgUploadBox').addEventListener('click', () => $('bgUpload').click());
  $('bgUpload').addEventListener('change', e => {
    loadImageFile(e.target.files[0], img => { app.bg.image = img; render(); });
  });

  // Decorations
  $('decoUploadBox').addEventListener('click', () => $('decoUpload').click());
  $('decoUpload').addEventListener('change', e => {
    loadImageFile(e.target.files[0], img => {
      const scale = Math.min(1, app.w / img.width, app.h / img.height);
      app.frames[app.currentFrame].decorations.push({
        image: img, x: 0, y: 0,
        w: Math.max(1, Math.round(img.width * scale)),
        h: Math.max(1, Math.round(img.height * scale))
      });
      render();
      refreshDecoList();
    });
  });

  // Text
  ['textContent', 'textFont', 'textSize', 'textColor', 'textOutline', 'textOutlineColor']
    .forEach(id => $(id).addEventListener('input', syncTextDraft));
  $('addTextBtn').addEventListener('click', placeTextCentered);

  // Perforation
  $('perfStyle').addEventListener('change', e => { app.perforation.style = e.target.value; render(); });
  $('perfColorType').addEventListener('change', e => {
    app.perforation.colorType = e.target.value;
    $('perfCustomColorField').classList.toggle('hidden', app.perforation.colorType !== 'custom');
    $('perfImageField').classList.toggle('hidden', app.perforation.colorType !== 'image');
    render();
  });
  $('perfColor').addEventListener('input', e => { app.perforation.color = e.target.value; render(); });
  $('perfUploadBox').addEventListener('click', () => $('perfUpload').click());
  $('perfUpload').addEventListener('change', e => {
    loadImageFile(e.target.files[0], img => { app.perforation.image = img; render(); });
  });
  $('perfSize').addEventListener('input', e => {
    app.perforation.size = parseInt(e.target.value);
    $('perfSizeLabel').textContent = e.target.value;
    render();
  });
  $('perfSpacing').addEventListener('input', e => {
    app.perforation.spacing = parseInt(e.target.value);
    $('perfSpacingLabel').textContent = e.target.value;
    render();
  });

  // Filters
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

function refreshDecoList() {
  const list = $('decoList');
  list.innerHTML = '';
  app.frames[app.currentFrame].decorations.forEach((d, i) => {
    const div = document.createElement('div');
    div.className = 'list-item';
    const label = document.createElement('span');
    label.className = 'li-label';
    label.textContent = `Deco ${i + 1} (${d.w}×${d.h})`;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Remove';
    btn.onclick = () => {
      app.frames[app.currentFrame].decorations.splice(i, 1);
      render();
      refreshDecoList();
    };
    div.appendChild(label);
    div.appendChild(btn);
    list.appendChild(div);
  });
}

// ===================== TIMELINE =====================
function rebuildTimeline() {
  const container = $('timelineFrames');
  container.innerHTML = '';
  app.frames.forEach((f, i) => {
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
  });
  refreshTimeline();
}

function refreshTimeline() {
  const container = $('timelineFrames');
  // Canvases are tiny (blinkie-sized), so re-rendering every thumb is cheap
  // and guarantees nothing goes stale when bg/layers/filters change.
  Array.from(container.children).forEach((div, i) => {
    div.classList.toggle('active', i === app.currentFrame);
    renderThumb(div.querySelector('canvas'), app.frames[i]);
  });
}

function renderThumb(c, frame) {
  const tctx = c.getContext('2d');
  tctx.clearRect(0, 0, c.width, c.height);
  if (app.bg.type === 'color') {
    tctx.fillStyle = app.bg.color;
    tctx.fillRect(0, 0, c.width, c.height);
  } else if (app.bg.image) {
    tctx.drawImage(app.bg.image, 0, 0, c.width, c.height);
  }
  scratch.width = c.width; scratch.height = c.height;
  sctx.putImageData(frame.pixels, 0, 0);
  tctx.drawImage(scratch, 0, 0);
  frame.decorations.forEach(d => { if (d.image) tctx.drawImage(d.image, d.x, d.y, d.w, d.h); });
  frame.texts.forEach(t => drawTextObject(tctx, t));
}

// ===================== PLAYBACK =====================
function startPlayback() {
  app.isPlaying = true;
  $('playLabel').textContent = 'Stop';
  app.playTimer = setInterval(() => {
    app.currentFrame = (app.currentFrame + 1) % app.frames.length;
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

  for (let i = 0; i < app.frames.length; i++) {
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

// ===================== START =====================
init();
