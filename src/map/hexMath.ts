// Pointy-top axial hex math (q,r) <-> pixel

export interface Point {
  x: number;
  y: number;
}

export function axialToPixel(q: number, r: number, size: number): Point {
  const x = size * Math.sqrt(3) * (q + r / 2);
  const y = size * (3 / 2) * r;
  return { x, y };
}

// Convert pixel -> axial (fractional)
export function pixelToAxial(x: number, y: number, size: number): { q: number; r: number } {
  const q = (Math.sqrt(3) / 3 * x - 1 / 3 * y) / size;
  const r = (2 / 3 * y) / size;
  return { q, r };
}

// Cube rounding
export function axialRound(q: number, r: number): { q: number; r: number } {
  let x = q;
  let z = r;
  let y = -x - z;

  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);

  const xDiff = Math.abs(rx - x);
  const yDiff = Math.abs(ry - y);
  const zDiff = Math.abs(rz - z);

  if (xDiff > yDiff && xDiff > zDiff) {
    rx = -ry - rz;
  } else if (yDiff > zDiff) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }

  return { q: rx, r: rz };
}

export function hexPolygon(size: number): Point[] {
  // 6 corners around origin
  const pts: Point[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    pts.push({ x: size * Math.cos(angle), y: size * Math.sin(angle) });
  }
  return pts;
}
