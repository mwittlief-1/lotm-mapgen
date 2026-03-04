// Hex raster helpers for PNG previews.
// Pointy-top axial hex math + a small scanline "stamp" for fast polygon fill.

export function axialToPixel(q, r, size) {
  const x = size * Math.sqrt(3) * (q + r / 2);
  const y = size * (3 / 2) * r;
  return { x, y };
}

export function hexPolygon(size) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    pts.push({ x: size * Math.cos(angle), y: size * Math.sin(angle) });
  }
  return pts;
}

// Build a scanline fill stamp for a unit hex centered at (0,0).
// The stamp is defined in integer pixel coordinates where each pixel is a unit square
// and membership is determined by sampling at pixel centers (x+0.5,y+0.5).
export function buildHexStamp(size) {
  const poly = hexPolygon(size);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  const minXi = Math.floor(minX);
  const maxXi = Math.ceil(maxX);
  const minYi = Math.floor(minY);
  const maxYi = Math.ceil(maxY);

  const width = maxXi - minXi + 1;
  const height = maxYi - minYi + 1;

  // For a convex polygon, each scanline intersects at most twice.
  const spans = new Array(height);

  for (let row = 0; row < height; row++) {
    const y = minYi + row + 0.5;
    const xs = [];

    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const y0 = a.y;
      const y1 = b.y;

      // Half-open edge rule prevents double-counting vertices.
      const crosses = (y0 <= y && y < y1) || (y1 <= y && y < y0);
      if (!crosses) continue;

      const t = (y - y0) / (y1 - y0);
      xs.push(a.x + t * (b.x - a.x));
    }

    if (xs.length < 2) {
      spans[row] = null;
      continue;
    }

    xs.sort((m, n) => m - n);
    const xL = xs[0];
    const xR = xs[1];

    // Fill integer pixels whose centers lie between xL and xR.
    const xStart = Math.ceil(xL - 0.5);
    const xEnd = Math.floor(xR - 0.5);

    if (xEnd < xStart) {
      spans[row] = null;
      continue;
    }

    spans[row] = [xStart - minXi, xEnd - minXi];
  }

  return {
    size,
    minX: minXi,
    maxX: maxXi,
    minY: minYi,
    maxY: maxYi,
    width,
    height,
    spans
  };
}

export function paintHexStamp(buf, imgW, imgH, x0, y0, stamp, rgba) {
  const { spans } = stamp;
  for (let row = 0; row < spans.length; row++) {
    const span = spans[row];
    if (!span) continue;

    const y = y0 + row;
    if (y < 0 || y >= imgH) continue;

    let xStart = x0 + span[0];
    let xEnd = x0 + span[1];
    if (xEnd < 0 || xStart >= imgW) continue;
    if (xStart < 0) xStart = 0;
    if (xEnd >= imgW) xEnd = imgW - 1;

    let off = (y * imgW + xStart) * 4;
    for (let x = xStart; x <= xEnd; x++) {
      buf[off + 0] = rgba[0];
      buf[off + 1] = rgba[1];
      buf[off + 2] = rgba[2];
      buf[off + 3] = rgba[3];
      off += 4;
    }
  }
}

export function paintDot(buf, imgW, imgH, cx, cy, rad, rgba) {
  const r2 = rad * rad;
  for (let dy = -rad; dy <= rad; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= imgH) continue;
    for (let dx = -rad; dx <= rad; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= imgW) continue;
      if ((dx * dx + dy * dy) > r2) continue;
      const off = (y * imgW + x) * 4;
      buf[off + 0] = rgba[0];
      buf[off + 1] = rgba[1];
      buf[off + 2] = rgba[2];
      buf[off + 3] = rgba[3];
    }
  }
}

// Simple deterministic line painter for overlays (rivers, borders, etc.).
// Draws a line by stepping along the dominant axis and stamping small dots.
export function paintLine(buf, imgW, imgH, x0, y0, x1, y1, thickness, rgba) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps <= 0) {
    paintDot(buf, imgW, imgH, x0, y0, Math.max(1, thickness), rgba);
    return;
  }
  const rad = Math.max(1, Math.floor(thickness));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(x0 + dx * t);
    const y = Math.round(y0 + dy * t);
    paintDot(buf, imgW, imgH, x, y, rad, rgba);
  }
}
