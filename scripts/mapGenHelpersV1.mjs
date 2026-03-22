export function isProjectedRunInBand(value, min = 40, max = 80) {
  return value >= min && value <= max;
}

export function computeNearBoundaryRatio({ idxList, maxDist = 1, total, landMask, distToPoliticalBorder }) {
  const arr = Array.isArray(idxList) ? idxList : [];
  if (arr.length === 0) return 0;
  let eligible = 0;
  let hit = 0;
  for (const idx of arr) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= total) continue;
    if (landMask[idx] !== 1) continue;
    eligible++;
    const d = distToPoliticalBorder[idx];
    if (d >= 0 && d <= maxDist) hit++;
  }
  return eligible > 0 ? (hit / eligible) : 0;
}

export function collectRoughenCandidates({ total, width, height, primaryMask, excludedMask, inWorld, straightPairs }) {
  const out = [];
  const dirs = [
    { dq: 1, dr: 0 },
    { dq: 1, dr: -1 },
    { dq: 0, dr: -1 },
    { dq: -1, dr: 0 },
    { dq: -1, dr: 1 },
    { dq: 0, dr: 1 },
  ];
  for (let i = 0; i < total; i++) {
    if (primaryMask[i] !== 1 || excludedMask?.[i] === 1) continue;
    if (straightPairs(i) < 2) continue;
    const q0 = i % width;
    const r0 = Math.floor(i / width);
    let touchesOutside = false;
    for (const d of dirs) {
      const nq = q0 + d.dq;
      const nr = r0 + d.dr;
      if (nq < 0 || nr < 0 || nq >= width || nr >= height) { touchesOutside = true; break; }
      const ni = (nr * width) + nq;
      if (!inWorld[ni] || primaryMask[ni] !== 1) { touchesOutside = true; break; }
    }
    if (touchesOutside) out.push(i);
  }
  out.sort((a, b) => a - b);
  return out;
}

export function computeInlandBoundaryFeatureAdjacency({ hexes, selected, width, trunkIdxSet, mountainIdxSet }) {
  const dirs = [
    { dq: 1, dr: 0 },
    { dq: 1, dr: -1 },
    { dq: 0, dr: -1 },
    { dq: -1, dr: 0 },
    { dq: -1, dr: 1 },
    { dq: 0, dr: 1 },
  ];
  let riverAdjTiles = 0;
  let ridgeAdjTiles = 0;
  for (let i = 0; i < hexes.length; i++) {
    if (selected[i] !== 1) continue;
    const h = hexes[i];
    const q0 = h.q;
    const r0 = h.r;
    let touchesNonPrimary = false;
    let touchesSea = false;
    let trunkNear = trunkIdxSet.has(i);
    let ridgeNear = mountainIdxSet.has(i);
    for (const d of dirs) {
      const nq = q0 + d.dq;
      const nr = r0 + d.dr;
      if (nq < 0 || nr < 0 || nq >= width || nr >= Math.ceil(hexes.length / width)) continue;
      const ni = (nr * width) + nq;
      const nh = hexes[ni];
      if (!nh) continue;
      if (nh.tile_kind === "sea") touchesSea = true;
      if (selected[ni] === 0 && nh.tile_kind !== "void") touchesNonPrimary = true;
      if (trunkIdxSet.has(ni)) trunkNear = true;
      if (mountainIdxSet.has(ni)) ridgeNear = true;
    }
    if (!touchesNonPrimary || touchesSea) continue;
    if (trunkNear) riverAdjTiles++;
    if (ridgeNear) ridgeAdjTiles++;
  }
  return { riverAdjTiles, ridgeAdjTiles };
}
