# Blinkie & Stamp Maker

A layered frame compositor with a built-in pixel editor, constrained to the
classic blinkie/stamp aesthetic — palette-locked colors, chunky pixels,
frame-cycled animation, and postage-stamp perforation with **real transparency**.

No build step, no dependencies, no server. Open `index.html` and make blinkies.

## Phone-first interface

The editor is fully usable on iPhone-sized screens. The live canvas is placed
first, followed by the frame timeline, large touch tools, and tabbed settings.
It respects the iPhone safe areas, uses dynamic viewport units so Safari's
address bar cannot swallow the workspace, auto-fits after rotation, and uses
Pointer Events so finger and Apple Pencil strokes remain continuous.

## Run it

```bash
# just open the file
open index.html            # macOS
xdg-open index.html        # Linux

# or serve the folder (nicer for font loading)
python3 -m http.server 8000
# → http://localhost:8000
```

Also works straight from **GitHub Pages**: Settings → Pages → deploy from
branch → `main` / root.

## Layer stack

A real, reorderable stack — top of the list renders on top:

- **Background** — one, pinned to the bottom. Solid color, uploaded image,
  or **animated GIF** (split into frames by a hand-rolled decoder: LZW
  decompression, disposal methods, transparency, interlacing), with an FX
  chain (pixelate, blur, noise, brightness, contrast, saturation, hue
  shift) baked into the export
- **Draw layers** — as many as you want. Each holds its own per-frame
  pixel raster; brush / eraser / cell fill / picker paint on the selected
  one (picking a tool auto-selects the topmost draw layer if needed)
- **Text layers** — as many as you want. Pixel-font rendering (Press
  Start 2P, VT323, Silkscreen, Pixelify Sans, system mono) with optional
  outline. Editable **live** any time: select a text layer and the Text
  tab edits it in place — content, font, size, color
- **Image layers** — uploaded decorations, one per layer, centered on drop
- **Edge layer** — the stamp perforation border. Not an overlay: holes are
  punched as actual alpha (`destination-out`) through every layer *below
  it in the stack*, so layers above it draw right over the border and the
  exported GIF still lets the page behind show through

Every layer above the background can be grabbed and transformed
**non-destructively**:

- **Move tool** — drag the layer body to move it (clicking also selects
  the layer in the stack), drag a corner handle to resize, arrow keys
  nudge 1 px (Shift = 4 px)
- **Transform panel** — exact X / Y / Scale fields when precision matters
- Draw layers scale nearest-neighbor, so pixel art stays crunchy; text
  scales by re-rendering at the new size, so it stays sharp
- Per-layer visibility eye, double-click rename, up/down reorder buttons,
  delete — the background can't be deleted or moved

## Undo / redo

Full snapshot history (40 steps) with buttons in the top bar and
**Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y**. Covers strokes, fills, layer
add/delete/reorder/visibility/rename, transforms, text edits, frame
add/duplicate/delete, background and edge changes, and canvas resizes.
Rapid repeats of one gesture (nudges, slider drags, typing) coalesce into
a single undo step, and click-without-moving never creates phantom steps.

## Features

- **3 layout presets** — Blinkie 150×20, Long 300×20, Stamp 100×100 —
  plus custom dimensions (20–800 × 10–600), with auto-fit zoom
- **Animated GIF backgrounds** — upload a GIF and it's split into
  frames; a pristine timeline auto-extends to match and adopts the
  GIF's frame rate. Three mapping modes: sync to timeline, stretch,
  boomerang (ping-pong)
- **Visible pixel grid** — every cell outlined on a crisp overlay that
  inverts against any background (never exported)
- **Cell fill tool** — click a square, that square fills. Shift+click
  for classic flood fill. Brush still doodles freehand
- **Frame timeline** — add, duplicate, delete, select; live thumbnails
  (including animated backgrounds); onion skinning on the active draw
  layer; playback with adjustable FPS; drawing auto-pauses playback
- **4 perforation styles** — postage circles, pixel squares, DeviantArt
  dashes, stars — with adjustable hole size and spacing
- **Edge fill** — white paper, custom color, rainbow gradient, or an
  uploaded image tiled around the border
- **GIF89a export** — hand-rolled LZW encoder, 216-color web-safe palette
  + one transparent index, frame delays synced to your FPS setting.
  The palette quantization is deliberate: it's what makes exports look
  like authentic 2003-era blinkies instead of smooth modern GIFs.

## Project layout

```
index.html          app shell
css/style.css       dark editor UI
js/app.js           editor state, layer stack, render pipeline, tools,
                    undo/redo history, timeline, export
js/gif-encoder.js   GIF89a writer (LZW + web-safe palette + transparency)
js/gif-decoder.js   GIF89a reader (LZW + disposal + interlacing) for uploads
```

## Roadmap (v3)

- Video upload → frame extraction
- Sparse keyframe system: draw frame 1, edit frame 5, hold in between
- Frame copy-paste between arbitrary frames
- Custom TTF/OTF font upload via `@font-face` injection
- Animated perforation borders (uploaded GIF in the edge, frame-synced)
- Independent background loop (bg plays at its own rate, not per-frame)
- Drag-to-reorder in the layer list, layer groups

## License

Fonts are loaded from Google Fonts under their respective open licenses
(OFL). Everything else: do what you want, make blinkies.
