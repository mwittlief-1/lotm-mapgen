import fs from "node:fs";
import zlib from "node:zlib";

// Minimal PNG writer (RGBA8) using only Node built-ins.

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & (-(c & 1)));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const d = data ? Buffer.from(data) : Buffer.alloc(0);
  const len = u32be(d.length);
  const crc = u32be(crc32(Buffer.concat([t, d])));
  return Buffer.concat([len, t, d, crc]);
}

export function writePngRGBA({ filepath, width, height, rgba }) {
  if (!Buffer.isBuffer(rgba)) throw new Error("rgba must be a Buffer");
  if (rgba.length !== width * height * 4) throw new Error("rgba length mismatch");

  // PNG scanlines: each row starts with filter byte 0.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * (stride + 1);
    raw[rowOff] = 0;
    rgba.copy(raw, rowOff + 1, y * stride, y * stride + stride);
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const png = Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND")
  ]);

  fs.writeFileSync(filepath, png);
}
