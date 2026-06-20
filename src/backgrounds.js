// Table background options for the canvas.
//
// The default is the dotted grid (scales + pans with the world). Solid colours
// are flat. The woodgrain textures are generated procedurally with an SVG
// feTurbulence filter (no binary assets) and tile seamlessly via stitchTiles.

const GRID_SIZE = 48; // world px between grid dots at scale 1
const GRID_IMAGE =
  "radial-gradient(circle, var(--bg-grid) 1.5px, transparent 1.5px)," +
  "radial-gradient(circle, var(--bg-grid-strong) 1.5px, transparent 1.5px)";

// Build a tiling woodgrain texture as a data-URI background-image.
function wood({ base, r, g, b, fx, fy, seed, tile = 480 }) {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${tile}' height='${tile}'>` +
    `<rect width='100%' height='100%' fill='${base}'/>` +
    `<filter id='w' x='0' y='0' width='100%' height='100%'>` +
    `<feTurbulence type='fractalNoise' baseFrequency='${fx} ${fy}' numOctaves='5' seed='${seed}' stitchTiles='stitch' result='n'/>` +
    `<feColorMatrix in='n' type='saturate' values='0' result='m'/>` +
    `<feComponentTransfer in='m'>` +
    `<feFuncR type='table' tableValues='${r}'/>` +
    `<feFuncG type='table' tableValues='${g}'/>` +
    `<feFuncB type='table' tableValues='${b}'/>` +
    `<feFuncA type='table' tableValues='1'/>` +
    `</feComponentTransfer>` +
    `</filter>` +
    `<rect width='100%' height='100%' filter='url(#w)'/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const DARK_WOOD = wood({
  base: "#241710",
  r: "0.16 0.33 0.20 0.37 0.18",
  g: "0.09 0.19 0.11 0.21 0.10",
  b: "0.04 0.10 0.05 0.11 0.04",
  fx: 0.0017,
  fy: 0.03,
  seed: 11,
});
const PINE_WOOD = wood({
  base: "#c8a578",
  r: "0.68 0.86 0.72 0.88 0.70",
  g: "0.52 0.69 0.55 0.71 0.53",
  b: "0.33 0.47 0.36 0.49 0.34",
  fx: 0.0016,
  fy: 0.028,
  seed: 4,
});
const WOOD_TILE = 480;

export const BACKGROUNDS = [
  { id: "default", label: "Default grid" },
  { id: "black", label: "Flat black" },
  { id: "white", label: "White" },
  { id: "darkwood", label: "Dark woodgrain" },
  { id: "pinewood", label: "Pine woodgrain" },
];

/**
 * Set the static parts of a background (colour + image). Call only when the
 * mode changes — re-assigning the woodgrain data-URI every frame is wasteful.
 */
export function paintBackground(canvas, mode) {
  const s = canvas.style;
  if (mode === "black") {
    s.backgroundColor = "#000";
    s.backgroundImage = "none";
  } else if (mode === "white") {
    s.backgroundColor = "#ffffff";
    s.backgroundImage = "none";
  } else if (mode === "darkwood" || mode === "pinewood") {
    s.backgroundColor = mode === "darkwood" ? "#241710" : "#c8a578";
    s.backgroundImage = mode === "darkwood" ? DARK_WOOD : PINE_WOOD;
    s.backgroundRepeat = "repeat";
  } else {
    s.backgroundColor = "var(--bg)";
    s.backgroundImage = GRID_IMAGE;
    s.backgroundRepeat = "repeat, repeat";
  }
}

/**
 * Update the per-frame parts (size + position) so the surface tracks pan/zoom.
 * Cheap enough to call on every viewport change.
 */
export function positionBackground(canvas, mode, vp) {
  const s = canvas.style;
  if (mode === "darkwood" || mode === "pinewood") {
    // Fixed tile size (keeps the turbulence raster cached); pans with the world.
    s.backgroundSize = `${WOOD_TILE}px ${WOOD_TILE}px`;
    s.backgroundPosition = `${vp.panX}px ${vp.panY}px`;
  } else if (mode === "black" || mode === "white") {
    s.backgroundSize = "";
    s.backgroundPosition = "";
  } else {
    // default dotted grid: scales + pans with the world
    const g = GRID_SIZE * vp.scale;
    s.backgroundSize = `${g}px ${g}px, ${g * 4}px ${g * 4}px`;
    s.backgroundPosition = `${vp.panX}px ${vp.panY}px, ${vp.panX}px ${vp.panY}px`;
  }
}
