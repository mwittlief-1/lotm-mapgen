import React, { useEffect, useMemo, useRef, useState } from "react";
import type { MapV1, HexV1, CountyV1, SeatV1, SettlementV1 } from "./types";
import { axialRound, axialToPixel, hexPolygon, pixelToAxial } from "./hexMath";

type ViewState = {
  panX: number; // screen px
  panY: number; // screen px
  zoom: number;
};

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function hashToHue(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

function countyFill(countyId: string) {
  const hue = hashToHue(countyId);
  // muted wash
  return `hsl(${hue} 25% 78%)`;
}

function terrainFill(hex: HexV1) {
  // Minimal fallback palette (renderer is political-first)
  if (hex.tile_kind === "sea") return "#A8B7C4";
  if (hex.tile_kind === "void") return "#F3EFE6";
  switch (hex.terrain) {
    case "lake":
      return "#7FA8C7";
    case "coast":
      return "#D9D0C2";
    case "plains":
      return "#E3DCCB";
    case "forest":
      return "#D2D8C9";
    case "hills":
      return "#D7C7A2";
    case "marsh":
      return "#B7D4D0";
    case "mountains":
      return "#C8C5BE";
    default:
      return "#E3DCCB";
  }
}

const DIRS = [
  { name: "E", dq: 1, dr: 0 },
  { name: "NE", dq: 1, dr: -1 },
  { name: "NW", dq: 0, dr: -1 },
  { name: "W", dq: -1, dr: 0 },
  { name: "SW", dq: -1, dr: 1 },
  { name: "SE", dq: 0, dr: 1 }
] as const;

// edge corner pairs for pointy-top vertices from hexPolygon()
const EDGE_CORNERS: Array<[number, number]> = [
  [0, 1], // E
  [5, 0], // NE
  [4, 5], // NW
  [3, 4], // W
  [2, 3], // SW
  [1, 2] // SE
];

export function FealtyBoard(props: { onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [map, setMap] = useState<MapV1 | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<ViewState>({ panX: 80, panY: 80, zoom: 0.28 });
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const [showPolitical, setShowPolitical] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [showTerrain, setShowTerrain] = useState(false);

  // Load map (runtime fetch path)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/data/map/map_v1.json", { cache: "no-store" });
        if (!res.ok) throw new Error(`map fetch failed: ${res.status} ${res.statusText}`);
        const json = (await res.json()) as MapV1;
        if (cancelled) return;
        if (!json || json.schema_version !== "map_schema_v1") throw new Error("invalid map schema_version");
        setMap(json);
      } catch (e: any) {
        if (cancelled) return;
        setError(String(e?.message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const derived = useMemo(() => {
    if (!map) return null;

    const hexById = new Map<string, HexV1>();
    const indexById = new Map<string, number>();
    for (let i = 0; i < map.hexes.length; i++) {
      const h = map.hexes[i];
      hexById.set(h.hex_id, h);
      indexById.set(h.hex_id, i);
    }

    const countyById = new Map<string, CountyV1>();
    for (const c of map.counties) countyById.set(c.county_id, c);

    const seatByHex = new Map<string, SeatV1>();
    for (const s of map.seats) seatByHex.set(s.hex_id, s);

    const settlementsByHex = new Map<string, SettlementV1[]>();
    for (const s of map.settlements) {
      const arr = settlementsByHex.get(s.hex_id) ?? [];
      arr.push(s);
      settlementsByHex.set(s.hex_id, arr);
    }

    const size = 10; // world units
    const centers = map.hexes.map((h) => axialToPixel(h.q, h.r, size));

    // Precompute world bounds
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of centers) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    return {
      size,
      polygon: hexPolygon(size),
      centers,
      hexById,
      indexById,
      countyById,
      seatByHex,
      settlementsByHex,
      worldBounds: { minX, minY, maxX, maxY }
    };
  }, [map]);

  // Canvas resize
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !map || !derived) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.width;
      const h = canvas.height;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // parchment-ish background
      ctx.fillStyle = "#F3EFE6";
      ctx.fillRect(0, 0, w, h);

      // apply view transform
      ctx.setTransform(view.zoom * dpr, 0, 0, view.zoom * dpr, view.panX * dpr, view.panY * dpr);

      const invZoom = 1 / view.zoom;
      const worldLeft = (-view.panX) * invZoom;
      const worldTop = (-view.panY) * invZoom;
      const worldRight = (w / dpr - view.panX) * invZoom;
      const worldBottom = (h / dpr - view.panY) * invZoom;
      const margin = derived.size * 3;

      const visible: number[] = [];
      for (let i = 0; i < derived.centers.length; i++) {
        const p = derived.centers[i];
        if (p.x < worldLeft - margin || p.x > worldRight + margin || p.y < worldTop - margin || p.y > worldBottom + margin) continue;
        visible.push(i);
      }

      // Draw tiles
      ctx.lineWidth = 1 / view.zoom;

      for (const i of visible) {
        const hex = map.hexes[i];
        if (hex.tile_kind === "void") continue;

        const center = derived.centers[i];

        // fill
        if (showPolitical && hex.tile_kind === "land" && hex.county_id) {
          ctx.fillStyle = countyFill(hex.county_id);
        } else if (showTerrain) {
          ctx.fillStyle = terrainFill(hex);
        } else {
          ctx.fillStyle = hex.tile_kind === "sea" ? "#A8B7C4" : "#E3DCCB";
        }

        ctx.beginPath();
        const poly = derived.polygon;
        ctx.moveTo(center.x + poly[0].x, center.y + poly[0].y);
        for (let k = 1; k < poly.length; k++) {
          ctx.lineTo(center.x + poly[k].x, center.y + poly[k].y);
        }
        ctx.closePath();
        ctx.fill();

        // borders / grid
        const drawCountyBorders = showPolitical && view.zoom >= 0.22;

        if (showGrid && !drawCountyBorders) {
          ctx.strokeStyle = "rgba(0,0,0,0.07)";
          ctx.stroke();
        }

        if (drawCountyBorders && hex.tile_kind === "land") {
          // stroke only boundary edges
          ctx.strokeStyle = "rgba(0,0,0,0.18)";

          for (let di = 0; di < DIRS.length; di++) {
            const d = DIRS[di];
            const nq = hex.q + d.dq;
            const nr = hex.r + d.dr;

            let isBorder = false;
            if (nq < 0 || nr < 0 || nq >= map.width || nr >= map.height) {
              isBorder = true;
            } else {
              const ni = nr * map.width + nq;
              const nh = map.hexes[ni];
              if (nh.tile_kind !== "land") isBorder = true;
              else if (nh.county_id !== hex.county_id) isBorder = true;
            }

            if (!isBorder) continue;
            const [a, b] = EDGE_CORNERS[di];
            ctx.beginPath();
            ctx.moveTo(center.x + poly[a].x, center.y + poly[a].y);
            ctx.lineTo(center.x + poly[b].x, center.y + poly[b].y);
            ctx.stroke();
          }
        }
      }

      // Node markers
      const showNodes = view.zoom >= 0.18;
      if (showNodes) {
        // seats
        ctx.fillStyle = "rgba(30,30,30,0.9)";
        for (const s of map.seats) {
          const idx = derived.indexById.get(s.hex_id);
          if (idx == null) continue;
          if (!visible.includes(idx)) continue;
          const p = derived.centers[idx];
          const r = derived.size * 0.35;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fill();

          if (s.is_capital && view.zoom >= 0.3) {
            ctx.strokeStyle = "rgba(180,120,40,0.9)";
            ctx.lineWidth = 2 / view.zoom;
            ctx.beginPath();
            ctx.arc(p.x, p.y, r * 1.8, 0, Math.PI * 2);
            ctx.stroke();
            ctx.lineWidth = 1 / view.zoom;
          }
        }

        // settlements
        for (const stl of map.settlements) {
          const idx = derived.indexById.get(stl.hex_id);
          if (idx == null) continue;
          if (!visible.includes(idx)) continue;
          const p = derived.centers[idx];

          const isPrimaryPort = stl.settlement_kind === "port" && stl.is_primary_port;
          const isBishopric = stl.settlement_kind === "bishopric";

          if (view.zoom < 0.24 && !isPrimaryPort && !isBishopric) continue;

          ctx.fillStyle = isPrimaryPort ? "rgba(40,70,110,0.95)" : isBishopric ? "rgba(40,90,85,0.95)" : "rgba(80,60,30,0.8)";
          const rr = isPrimaryPort ? derived.size * 0.42 : derived.size * 0.28;
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Selection highlight
      if (selectedIndex != null && map.hexes[selectedIndex]) {
        const hex = map.hexes[selectedIndex];
        if (hex.tile_kind !== "void") {
          const center = derived.centers[selectedIndex];
          const poly = derived.polygon;
          ctx.strokeStyle = "rgba(210,150,50,0.95)";
          ctx.lineWidth = 3 / view.zoom;
          ctx.beginPath();
          ctx.moveTo(center.x + poly[0].x, center.y + poly[0].y);
          for (let k = 1; k < poly.length; k++) ctx.lineTo(center.x + poly[k].x, center.y + poly[k].y);
          ctx.closePath();
          ctx.stroke();
        }
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [map, derived, view, selectedIndex, showPolitical, showGrid, showTerrain]);

  // Pointer interactions: pan + select
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !map || !derived) return;

    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      setView((v) => ({ ...v, panX: v.panX + dx, panY: v.panY + dy }));
    };

    const onPointerUp = (e: PointerEvent) => {
      dragging = false;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
    };

    const onClick = (e: MouseEvent) => {
      // Ignore click if user just dragged significantly
      // (best-effort: if movement is small, treat as click)
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const worldX = (x - view.panX) / view.zoom;
      const worldY = (y - view.panY) / view.zoom;

      const frac = pixelToAxial(worldX, worldY, derived.size);
      const rounded = axialRound(frac.q, frac.r);

      if (rounded.q < 0 || rounded.r < 0 || rounded.q >= map.width || rounded.r >= map.height) {
        setSelectedIndex(null);
        return;
      }

      const idx = rounded.r * map.width + rounded.q;
      const hex = map.hexes[idx];
      if (!hex || hex.tile_kind === "void") {
        setSelectedIndex(null);
        return;
      }
      setSelectedIndex(idx);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = -e.deltaY;
      const factor = delta > 0 ? 1.08 : 0.92;

      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      setView((v) => {
        const newZoom = clamp(v.zoom * factor, 0.08, 1.6);

        // Zoom around mouse cursor
        const worldX = (mx - v.panX) / v.zoom;
        const worldY = (my - v.panY) / v.zoom;

        const newPanX = mx - worldX * newZoom;
        const newPanY = my - worldY * newZoom;

        return { panX: newPanX, panY: newPanY, zoom: newZoom };
      });
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [map, derived, view.panX, view.panY, view.zoom]);

  const selected = useMemo(() => {
    if (!map || !derived || selectedIndex == null) return null;
    const hex = map.hexes[selectedIndex];
    if (!hex) return null;
    const county = hex.county_id ? derived.countyById.get(hex.county_id) ?? null : null;
    const seat = derived.seatByHex.get(hex.hex_id) ?? null;
    const settlements = derived.settlementsByHex.get(hex.hex_id) ?? [];
    return { hex, county, seat, settlements };
  }, [map, derived, selectedIndex]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 12px",
          borderBottom: "1px solid rgba(0,0,0,0.12)",
          background: "#F3EFE6"
        }}
      >
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ fontWeight: 800, letterSpacing: 0.2 }}>Fealty Board</div>
          {map ? (
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              {map.width}×{map.height} • land {map.hexes.filter((h) => h.tile_kind === "land").length} • seed {map.mapgen_seed ?? "?"}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
            <input type="checkbox" checked={showPolitical} onChange={(e) => setShowPolitical(e.target.checked)} />
            Political
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
            <input type="checkbox" checked={showTerrain} onChange={(e) => setShowTerrain(e.target.checked)} />
            Terrain
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
            <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
            Grid
          </label>
          <button
            onClick={props.onClose}
            style={{
              padding: "6px 10px",
              border: "1px solid rgba(0,0,0,0.2)",
              borderRadius: 8,
              background: "#fff",
              cursor: "pointer"
            }}
          >
            Back
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div ref={containerRef} style={{ position: "relative", flex: 1, minHeight: 0 }}>
          <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%" }} />

          {!map && !error ? (
            <div style={{ position: "absolute", top: 20, left: 20, padding: 10, background: "rgba(255,255,255,0.8)", borderRadius: 10 }}>
              Loading map…
            </div>
          ) : null}

          {error ? (
            <div style={{ position: "absolute", top: 20, left: 20, padding: 10, background: "rgba(255,240,240,0.9)", borderRadius: 10, maxWidth: 520 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Map load error</div>
              <div style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{error}</div>
              <div style={{ fontSize: 12, marginTop: 8, opacity: 0.8 }}>
                Expected runtime path: <code>/data/map/map_v1.json</code>
              </div>
            </div>
          ) : null}

          <div style={{ position: "absolute", left: 14, bottom: 14, padding: 10, borderRadius: 12, background: "rgba(255,255,255,0.82)", fontSize: 12, maxWidth: 280 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Controls</div>
            <div>Drag: pan</div>
            <div>Wheel/trackpad: zoom</div>
            <div>Click: select hex</div>
          </div>
        </div>

        <div
          style={{
            width: 360,
            borderLeft: "1px solid rgba(0,0,0,0.12)",
            background: "#FAF7F0",
            padding: 12,
            overflow: "auto"
          }}
        >
          <div style={{ fontWeight: 800, marginBottom: 10 }}>Inspector</div>

          {!selected ? (
            <div style={{ fontSize: 12, opacity: 0.7 }}>Select a hex to see details.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 12 }}>
              <div style={{ padding: 10, borderRadius: 12, background: "rgba(255,255,255,0.9)", border: "1px solid rgba(0,0,0,0.08)" }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Hex</div>
                <div>
                  <b>{selected.hex.hex_id}</b> • ({selected.hex.q},{selected.hex.r})
                </div>
                <div>tile_kind: {selected.hex.tile_kind}</div>
                <div>terrain: {selected.hex.terrain}</div>
                {selected.hex.hydrology?.river_class ? <div>river: {selected.hex.hydrology.river_class}</div> : null}
                {selected.hex.hydrology?.water_kind ? <div>water_kind: {selected.hex.hydrology.water_kind}</div> : null}
              </div>

              <div style={{ padding: 10, borderRadius: 12, background: "rgba(255,255,255,0.9)", border: "1px solid rgba(0,0,0,0.08)" }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>County</div>
                {selected.county ? (
                  <>
                    <div>
                      <b>{selected.county.name}</b> ({selected.county.county_id})
                    </div>
                    <div>hexes: {selected.county.hex_ids.length}</div>
                  </>
                ) : (
                  <div style={{ opacity: 0.7 }}>None</div>
                )}
              </div>

              <div style={{ padding: 10, borderRadius: 12, background: "rgba(255,255,255,0.9)", border: "1px solid rgba(0,0,0,0.08)" }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Seat</div>
                {selected.seat ? (
                  <>
                    <div>
                      {selected.seat.seat_id} • {selected.seat.county_id}
                    </div>
                    {selected.seat.is_capital ? <div style={{ color: "#8a5b1c", fontWeight: 700 }}>Capital</div> : null}
                  </>
                ) : (
                  <div style={{ opacity: 0.7 }}>None</div>
                )}
              </div>

              <div style={{ padding: 10, borderRadius: 12, background: "rgba(255,255,255,0.9)", border: "1px solid rgba(0,0,0,0.08)" }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Settlements</div>
                {selected.settlements.length ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {selected.settlements.map((s) => (
                      <div key={s.settlement_id} style={{ padding: 8, borderRadius: 10, border: "1px solid rgba(0,0,0,0.08)", background: "rgba(250,247,240,0.95)" }}>
                        <div>
                          <b>{s.settlement_kind}</b> — {s.name ?? s.settlement_id}
                        </div>
                        {s.is_primary_port ? <div style={{ fontWeight: 700 }}>Primary port</div> : null}
                        {s.is_metropolitan ? <div style={{ fontWeight: 700 }}>Metropolitan</div> : null}
                        {s.is_cathedral ? <div style={{ fontWeight: 700 }}>Cathedral</div> : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ opacity: 0.7 }}>None</div>
                )}
              </div>
            </div>
          )}

          <div style={{ marginTop: 16, fontSize: 11, opacity: 0.7 }}>
            Note: This is a presentation-only map shell. Simulation never imports map data/assets.
          </div>
        </div>
      </div>
    </div>
  );
}
