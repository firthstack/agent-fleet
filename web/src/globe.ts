/**
 * An ASCII earth: a sphere ray-cast into character cells, lit from one side
 * and spun about its axis.
 *
 * A drawn globe has to choose between looking real and looking deliberate,
 * and half-real is the one option that just looks wrong. Characters put it
 * firmly on the deliberate side — and they are the page's own vocabulary,
 * which a shaded circle never was.
 *
 * Everything here is pure: given a spin it returns the same frame, so the
 * projection can be tested without a canvas, and the agents on the surface
 * can be placed with the very same maths that drew the ground under them.
 */

/**
 * The character grid, in one place because two things have to agree about it:
 * the renderer that draws the sphere and the projection that puts agents on
 * it. At 43 columns the disc was a third of a column wider than the grid, so
 * a marker at the limb landed just outside the box the characters occupied.
 * 44 leaves the sphere a hair of margin instead of an overhang.
 */
export const GRID = { cols: 44, rows: 26 } as const;

/** Monospace advance width, as a fraction of the font size. */
const CHAR_ASPECT = 0.6;

/** Brightness ramp, darkest first. Classic ASCII shading. */
/*
 * Density separates land from water before shading does anything: the two
 * ramps share no character, so a continent reads as a continent even before
 * the two layers are given their colours. Shading then works within each.
 */
const LAND_RAMP = "+*#%@";
const SEA_RAMP = "·:";

/**
 * Landmasses as ellipses in (longitude, latitude) degrees.
 *
 * A coarse bitmap would be more faithful and far less legible; at the size
 * this renders — a few dozen characters across — what has to survive is the
 * silhouette: a mass on the left, one down the middle, a bigger one to the
 * right, and a small one under it.
 */
const LAND: Array<{ lon: number; lat: number; rlon: number; rlat: number }> = [
  { lon: -100, lat: 46, rlon: 40, rlat: 25 }, // North America
  { lon: -86, lat: 20, rlon: 16, rlat: 13 }, // Central America
  { lon: -42, lat: 72, rlon: 15, rlat: 9 }, // Greenland
  { lon: -62, lat: -18, rlon: 19, rlat: 25 }, // South America
  { lon: -73, lat: 4, rlon: 10, rlat: 9 },
  { lon: 17, lat: 2, rlon: 24, rlat: 31 }, // Africa
  { lon: 24, lat: 52, rlon: 28, rlat: 11 }, // Europe
  { lon: 95, lat: 47, rlon: 48, rlat: 26 }, // Asia
  { lon: 79, lat: 22, rlon: 14, rlat: 13 }, // India
  { lon: 112, lat: 8, rlon: 14, rlat: 11 }, // South-east Asia
  { lon: 134, lat: -25, rlon: 20, rlat: 13 }, // Australia
];

/** Antarctica is a cap, not a blob. */
const ICE_CAP_LAT = -62;

export function isLand(lonDeg: number, latDeg: number): boolean {
  if (latDeg < ICE_CAP_LAT) return true;
  const lon = wrapLon(lonDeg);
  for (const m of LAND) {
    // Longitude wraps, so measure the short way round.
    let dLon = lon - m.lon;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    const a = dLon / m.rlon;
    const b = (latDeg - m.lat) / m.rlat;
    if (a * a + b * b <= 1) return true;
  }
  return false;
}

export interface GlobeFrame {
  /** Rows of land characters, oceans blanked out. */
  land: string;
  /** Rows of ocean characters, land blanked out. */
  sea: string;
}

/**
 * One frame, as two layers.
 *
 * Two strings rather than one because land and water want different colours
 * and a `<pre>` carries exactly one. Stacked, each blanking what the other
 * draws, they compose back into a single globe.
 */
export function renderGlobe(cols: number, rows: number, spinDeg: number): GlobeFrame {
  const land: string[] = [];
  const sea: string[] = [];
  // Character cells are about 0.6 as wide as they are tall, so the disc has
  // to be squashed horizontally or the globe comes out an egg.
  const aspect = (cols * CHAR_ASPECT) / rows;

  for (let r = 0; r < rows; r += 1) {
    let landRow = "";
    let seaRow = "";
    const y = ((r + 0.5) / rows) * 2 - 1;
    for (let c = 0; c < cols; c += 1) {
      const x = (((c + 0.5) / cols) * 2 - 1) * aspect;
      const d2 = x * x + y * y;
      if (d2 > 1) {
        landRow += " ";
        seaRow += " ";
        continue;
      }
      const z = Math.sqrt(1 - d2);
      const { lon, lat } = unproject(x, y, z, spinDeg);
      const shade = lightAt(x, y, z);
      if (isLand(lon, lat)) {
        landRow += LAND_RAMP[clampIndex(shade, LAND_RAMP.length)];
        seaRow += " ";
      } else {
        landRow += " ";
        seaRow += SEA_RAMP[clampIndex(shade, SEA_RAMP.length)];
      }
    }
    land.push(landRow);
    sea.push(seaRow);
  }
  return { land: land.join("\n"), sea: sea.join("\n") };
}

export interface Placed {
  /** Position within the globe's box, 0…1. */
  x: number;
  y: number;
  /** False while the point is round the back. */
  visible: boolean;
}

/**
 * Where a point on the surface lands on screen — the same projection the
 * characters were drawn with, so an agent marked at Berlin sits on Europe
 * and goes round the back with it.
 */
export function placeOnGlobe(
  lonDeg: number,
  latDeg: number,
  spinDeg: number,
  cols: number,
  rows: number,
): Placed {
  const aspect = (cols * CHAR_ASPECT) / rows;
  const lat = (latDeg * Math.PI) / 180;
  const lon = ((wrapLon(lonDeg - spinDeg)) * Math.PI) / 180;
  const x = Math.cos(lat) * Math.sin(lon);
  const y = -Math.sin(lat);
  const z = Math.cos(lat) * Math.cos(lon);
  return {
    x: (x / aspect + 1) / 2,
    y: (y + 1) / 2,
    visible: z > 0.08,
  };
}

function unproject(x: number, y: number, z: number, spinDeg: number) {
  const lat = (Math.asin(-y) * 180) / Math.PI;
  const lon = wrapLon((Math.atan2(x, z) * 180) / Math.PI + spinDeg);
  return { lon, lat };
}

/** Lit from up and to the right, matching the rim light the rest of the
 *  scene is drawn with. */
function lightAt(x: number, y: number, z: number): number {
  // Mostly from the side: a light from straight above flattens the sphere
  // into a lit cap, where a terminator running down it reads as a turning
  // ball. The ambient floor keeps the night side drawn rather than absent.
  const lx = 0.66;
  const ly = -0.28;
  const lz = 0.7;
  const lambert = x * lx + y * ly + z * lz;
  return Math.max(0, 0.22 + 0.78 * lambert);
}

function clampIndex(brightness: number, length: number): number {
  const i = Math.floor(brightness * length);
  return Math.min(length - 1, Math.max(0, i));
}

function wrapLon(lon: number): number {
  let v = ((lon + 180) % 360 + 360) % 360 - 180;
  if (v === -180) v = 180;
  return v;
}
