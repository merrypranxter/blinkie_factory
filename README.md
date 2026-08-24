# Blinkie & Stamp Maker

A layered frame compositor with a built-in pixel editor, constrained to the
classic blinkie/stamp aesthetic — palette-locked colors, chunky pixels,
frame-cycled animation, and postage-stamp perforation with **real transparency**.

No build step, no dependencies, no server. Open `index.html` and make blinkies.

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

## Layer stack (per frame)

1. **Background** — solid color or uploaded image, with an FX chain
   (pixelate, blur, noise, brightness, contrast, saturation, hue shift)
   baked into the export
2. **Pixel art** — hand-drawn per-frame raster with brush, eraser, fill,
   and color picker
3. **Decorations** — uploaded images, draggable with the Move tool
4. **Text** — pixel-font rendering (Press Start 2P, VT323, Silkscreen,
   Pixelify Sans, system mono) with optional outline; click the canvas
   with the Text tool to place, drag with the Move tool to adjust
5. **Perforation** — not an overlay: holes are punched as actual alpha
   (`destination-out` compositing), so the exported GIF lets the page
   behind it show through

## Features

- **3 layout presets** — Blinkie 150×20, Long 300×20, Stamp 100×100 —
  plus custom dimensions (20–800 × 10–600)
- **Frame timeline** — add, duplicate, delete, select; thumbnails;
  onion skinning; grid overlay; live playback with adjustable FPS
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
js/app.js           editor state, render pipeline, tools, timeline, export
js/gif-encoder.js   GIF89a writer (LZW + web-safe palette + transparency)
```

## Roadmap (v2)

- Video upload → frame extraction / GIF upload → frame splitting
  (uploaded GIFs currently render as static first frames)
- Sparse keyframe system: draw frame 1, edit frame 5, hold in between
- Frame copy-paste between arbitrary frames
- Undo/redo
- Custom TTF/OTF font upload via `@font-face` injection
- Animated perforation borders (uploaded GIF in the edge, frame-synced)
- Background mapping modes: sample / hold / boomerang / independent loop

## License

Fonts are loaded from Google Fonts under their respective open licenses
(OFL). Everything else: do what you want, make blinkies.
