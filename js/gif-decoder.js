/* ============================================================
 * GIFReader — minimal GIF89a/87a decoder with LZW decompression.
 *
 * Parses an uploaded GIF into fully-composited RGBA frames so
 * animated backgrounds can play inside the editor and bake into
 * the exported GIF. Handles: global/local color tables, per-frame
 * delays, transparency, all three disposal methods, interlacing.
 *
 * Environment-agnostic: works on raw bytes, no DOM/canvas needed.
 *   const gif = GIFReader.parse(arrayBuffer);
 *   // → { width, height, frames: [{ rgba: Uint8ClampedArray, delay }] }
 * ============================================================ */

const GIFReader = (() => {

  function parse(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let p = 0;

    const readByte = () => bytes[p++];
    const readShort = () => bytes[p++] | (bytes[p++] << 8);
    const readBytes = n => { const s = bytes.subarray(p, p + n); p += n; return s; };
    const readSubBlocks = () => {
      const chunks = [];
      let size;
      while (p < bytes.length && (size = readByte()) !== 0) chunks.push(readBytes(size));
      let total = 0;
      chunks.forEach(c => total += c.length);
      const out = new Uint8Array(total);
      let o = 0;
      chunks.forEach(c => { out.set(c, o); o += c.length; });
      return out;
    };

    // ---- Header ----
    const sig = String.fromCharCode(...readBytes(6));
    if (sig !== 'GIF89a' && sig !== 'GIF87a') throw new Error('Not a GIF file');

    // ---- Logical Screen Descriptor ----
    const width = readShort();
    const height = readShort();
    const packed = readByte();
    const bgIndex = readByte(); // background color index (for disposal method 2)
    readByte(); // pixel aspect ratio

    let gctColors = null;
    if (packed & 0x80) { // global color table present
      const n = 1 << ((packed & 0x07) + 1);
      gctColors = readBytes(n * 3);
    }

    // ---- Frame state ----
    const canvas = new Uint8ClampedArray(width * height * 4); // composited output
    const frames = [];
    let gce = { disposal: 0, transparentIndex: -1, delay: 10 };
    let prevDisposal = 0;
    let prevRect = null;
    let savedBuffer = null;
    let hasTransparency = false;

    // ---- Block loop ----
    while (p < bytes.length) {
      const marker = readByte();

      if (marker === 0x3b) break; // trailer

      if (marker === 0x21) { // extension
        const label = readByte();
        if (label === 0xf9) { // Graphics Control Extension
          readByte(); // block size (4)
          const gPacked = readByte();
          const delay = readShort();
          const tIndex = readByte();
          readByte(); // terminator
          gce = {
            disposal: (gPacked >> 2) & 0x07,
            transparentIndex: (gPacked & 0x01) ? tIndex : -1,
            delay: delay || 10
          };
          if (gce.transparentIndex !== -1) hasTransparency = true;
        } else {
          // Application (0xff) and Plain Text (0x01) have a sized header
          // block before their sub-blocks; Comment (0xfe) is sub-blocks only.
          if (label === 0x01 || label === 0xff) {
            const headerSize = readByte();
            readBytes(headerSize);
          }
          readSubBlocks();
        }
        continue;
      }

      if (marker !== 0x2c) continue; // unknown block — skip defensively

      // ---- Image Descriptor ----
      const left = readShort();
      const top = readShort();
      const w = readShort();
      const h = readShort();
      const iPacked = readByte();

      let colorTable = gctColors;
      if (iPacked & 0x80) { // local color table
        const n = 1 << ((iPacked & 0x07) + 1);
        colorTable = readBytes(n * 3);
      }
      const interlaced = !!(iPacked & 0x40);

      // ---- Image data ----
      const minCodeSize = readByte();
      const compressed = readSubBlocks();
      const indices = lzwDecode(minCodeSize, compressed, w * h);

      // Apply the PREVIOUS frame's disposal before drawing this one
      if (prevDisposal === 2 && prevRect) {
        // Restore-to-background: transparent when the GIF uses transparency,
        // otherwise the logical screen's background color.
        let bg = null;
        if (!hasTransparency && gctColors) {
          bg = [gctColors[bgIndex * 3], gctColors[bgIndex * 3 + 1], gctColors[bgIndex * 3 + 2]];
        }
        clearRect(canvas, width, prevRect, bg);
      } else if (prevDisposal === 3 && savedBuffer) {
        canvas.set(savedBuffer);
      }
      if (gce.disposal === 3) savedBuffer = canvas.slice();

      // Deinterlace row order if needed
      const rowOrder = interlaced ? interlaceOrder(h) : null;

      // Draw this frame onto the persistent canvas
      for (let y = 0; y < h; y++) {
        const dy = rowOrder ? rowOrder[y] : y;
        for (let x = 0; x < w; x++) {
          const idx = indices[y * w + x];
          if (idx === gce.transparentIndex) continue;
          const ci = idx * 3;
          const di = ((top + dy) * width + (left + x)) * 4;
          canvas[di]     = colorTable[ci];
          canvas[di + 1] = colorTable[ci + 1];
          canvas[di + 2] = colorTable[ci + 2];
          canvas[di + 3] = 255;
        }
      }

      frames.push({ rgba: canvas.slice(), delay: gce.delay });
      prevDisposal = gce.disposal;
      prevRect = { left, top, w, h };
      gce = { disposal: 0, transparentIndex: -1, delay: 10 };
    }

    return { width, height, frames };
  }

  function clearRect(canvas, canvasWidth, r, bg) {
    for (let y = r.top; y < r.top + r.h; y++) {
      for (let x = r.left; x < r.left + r.w; x++) {
        const i = (y * canvasWidth + x) * 4;
        if (bg) {
          canvas[i] = bg[0]; canvas[i + 1] = bg[1]; canvas[i + 2] = bg[2]; canvas[i + 3] = 255;
        } else {
          canvas[i] = canvas[i + 1] = canvas[i + 2] = canvas[i + 3] = 0;
        }
      }
    }
  }

  // GIF interlacing: 4 passes with starts 0/4/2/1 and steps 8/8/4/2
  function interlaceOrder(h) {
    const order = new Array(h);
    let i = 0;
    [[0, 8], [4, 8], [2, 4], [1, 2]].forEach(([start, step]) => {
      for (let y = start; y < h; y += step) order[i++] = y;
    });
    return order;
  }

  // GIF LZW decompression (variable-length codes, LSB-first bit packing)
  function lzwDecode(minCodeSize, data, pixelCount) {
    const clear = 1 << minCodeSize;
    const eoi = clear + 1;
    let table, next, codeSize;

    const reset = () => {
      table = new Array(4096);
      for (let i = 0; i < clear; i++) table[i] = [i];
      next = eoi + 1;
      codeSize = minCodeSize + 1;
    };
    reset();

    const out = [];
    let p = 0, cur = 0, bits = 0, prev = -1;

    const readCode = () => {
      while (bits < codeSize) {
        if (p >= data.length) return -1;
        cur |= data[p++] << bits;
        bits += 8;
      }
      const code = cur & ((1 << codeSize) - 1);
      cur >>= codeSize;
      bits -= codeSize;
      return code;
    };

    while (out.length < pixelCount) {
      const code = readCode();
      if (code === -1 || code === eoi) break;
      if (code === clear) { reset(); prev = -1; continue; }

      if (prev === -1) {
        for (const b of table[code]) out.push(b);
        prev = code;
        continue;
      }

      let entry;
      if (code < next && table[code]) {
        entry = table[code];
      } else if (code === next) {
        entry = table[prev].concat(table[prev][0]); // KwKwK case
      } else {
        break; // corrupt stream — bail with what we have
      }

      for (const b of entry) out.push(b);
      if (next < 4096) {
        table[next++] = table[prev].concat(entry[0]);
        if (next === (1 << codeSize) && codeSize < 12) codeSize++;
      }
      prev = code;
    }

    // Pad short frames (tolerate slightly truncated streams)
    while (out.length < pixelCount) out.push(0);
    return out;
  }

  return { parse };
})();

// Export for both browser and Node (used by tests)
if (typeof module !== 'undefined' && module.exports) module.exports = GIFReader;
