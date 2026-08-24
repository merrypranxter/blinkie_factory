/* ============================================================
 * GIFWriter — minimal GIF89a encoder with LZW compression.
 *
 * Uses the 216-color web-safe palette plus palette index 216
 * reserved for full transparency (perforation holes, erased
 * pixels, empty background). Pixels with alpha < 128 quantize
 * to the transparent index; everything else snaps to the
 * nearest web-safe color — which is exactly the crunchy,
 * palette-locked look classic blinkies had.
 * ============================================================ */

class GIFWriter {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.frames = [];   // ImageData[]
    this.delays = [];   // hundredths of a second
  }

  addFrame(imageData, delay) {
    this.frames.push(imageData);
    this.delays.push(delay || 10);
  }

  static TRANSPARENT_INDEX = 216;

  getPalIndex(r, g, b, a) {
    if (a < 128) return GIFWriter.TRANSPARENT_INDEX;
    const ri = Math.min(5, Math.round(r / 51));
    const gi = Math.min(5, Math.round(g / 51));
    const bi = Math.min(5, Math.round(b / 51));
    return ri * 36 + gi * 6 + bi;
  }

  write() {
    const w = this.w, h = this.h;
    const n = w * h;
    const frameIdx = [];

    for (let f = 0; f < this.frames.length; f++) {
      const d = this.frames[f].data;
      const idx = new Uint8Array(n);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        idx[p] = this.getPalIndex(d[i], d[i + 1], d[i + 2], d[i + 3]);
      }
      frameIdx.push(idx);
    }

    // 216 web-safe colors + 1 transparent slot, padded to 256
    const pal = [];
    for (let r = 0; r < 6; r++)
      for (let g = 0; g < 6; g++)
        for (let b = 0; b < 6; b++)
          pal.push(r * 51, g * 51, b * 51);
    pal.push(0, 0, 0); // transparent slot (index 216)
    while (pal.length < 256 * 3) pal.push(0, 0, 0);

    const out = [];
    const wb = b => out.push(b & 0xff);
    const ws = s => { wb(s & 0xff); wb((s >> 8) & 0xff); };

    // Header + Logical Screen Descriptor
    out.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // "GIF89a"
    ws(w); ws(h);
    wb(0xf7); // global color table, 256 entries, 8-bit color depth
    wb(0);    // background color index
    wb(0);    // pixel aspect ratio
    for (let i = 0; i < 768; i++) wb(pal[i]);

    // Netscape looping extension (loop forever)
    out.push(0x21, 0xff, 0x0b);
    for (let i = 0; i < 11; i++) wb('NETSCAPE2.0'.charCodeAt(i));
    out.push(0x03, 0x01, 0x00, 0x00, 0x00);

    for (let f = 0; f < frameIdx.length; f++) {
      const idx = frameIdx[f];

      // Graphics Control Extension: disposal 1 (do not dispose) + transparency
      out.push(0x21, 0xf9, 0x04);
      wb(0x05);
      ws(this.delays[f]);
      wb(GIFWriter.TRANSPARENT_INDEX);
      wb(0);

      // Image Descriptor
      out.push(0x2c);
      ws(0); ws(0); ws(w); ws(h);
      wb(0x00); // no local color table

      // LZW-compressed image data in <=255-byte sub-blocks
      const minCodeSize = 8;
      wb(minCodeSize);
      const lzw = this.lzwCompress(idx, minCodeSize);
      let pos = 0;
      while (pos < lzw.length) {
        const block = Math.min(255, lzw.length - pos);
        wb(block);
        for (let i = 0; i < block; i++) wb(lzw[pos + i]);
        pos += block;
      }
      wb(0); // block terminator
    }

    out.push(0x3b); // trailer
    return new Uint8Array(out);
  }

  lzwCompress(indices, minCodeSize) {
    const clearCode = 1 << minCodeSize;
    const endCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let nextCode = endCode + 1;

    const dict = new Map();
    const init = () => {
      dict.clear();
      for (let i = 0; i < clearCode; i++) dict.set(String.fromCharCode(i), i);
      nextCode = endCode + 1;
      codeSize = minCodeSize + 1;
    };
    init();

    const bytes = [];
    let curByte = 0, bitPos = 0;

    const writeCode = code => {
      for (let i = 0; i < codeSize; i++) {
        if ((code >> i) & 1) curByte |= (1 << bitPos);
        bitPos++;
        if (bitPos === 8) { bytes.push(curByte); curByte = 0; bitPos = 0; }
      }
    };

    writeCode(clearCode);
    let current = String.fromCharCode(indices[0]);

    for (let i = 1; i < indices.length; i++) {
      const c = String.fromCharCode(indices[i]);
      const combined = current + c;
      if (dict.has(combined)) {
        current = combined;
      } else {
        writeCode(dict.get(current));
        if (nextCode < 4096) dict.set(combined, nextCode++);
        if (nextCode >= (1 << codeSize) && codeSize < 12) codeSize++;
        if (nextCode >= 4096) { writeCode(clearCode); init(); }
        current = c;
      }
    }
    writeCode(dict.get(current));
    writeCode(endCode);
    if (bitPos > 0) bytes.push(curByte);
    return bytes;
  }
}

// Export for both browser and Node (used by tests)
if (typeof module !== 'undefined' && module.exports) module.exports = GIFWriter;
