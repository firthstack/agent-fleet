import { describe, expect, it } from "vitest";
import { CHAR_ASPECT, GRID, isLand, placeOnGlobe, renderGlobe } from "../../web/src/globe";

const { cols: COLS, rows: ROWS } = GRID;

/**
 * The ASCII earth. Everything here is pure, so the thing that actually shows
 * on the page can be checked without a browser — which is the only reason a
 * hole in the night side was findable at all.
 */

describe("renderGlobe", () => {
  const frame = renderGlobe(COLS, ROWS, 0);
  const land = frame.land.split("\n");
  const sea = frame.sea.split("\n");

  it("returns a grid of the size asked for", () => {
    expect(land).toHaveLength(ROWS);
    expect(sea).toHaveLength(ROWS);
    for (const row of [...land, ...sea]) expect(row).toHaveLength(COLS);
  });

  it("draws a solid disc, with no holes punched through it", () => {
    // The first version shaded the ocean with a ramp whose darkest character
    // was a space, so the whole night side came out as a bite taken out of
    // the planet. Every cell inside the silhouette must carry a glyph.
    for (let r = 0; r < ROWS; r += 1) {
      const filled: number[] = [];
      for (let c = 0; c < COLS; c += 1) {
        if (land[r][c] !== " " || sea[r][c] !== " ") filled.push(c);
      }
      if (filled.length === 0) continue;
      const first = filled[0];
      const last = filled[filled.length - 1];
      expect(
        last - first + 1,
        `row ${r} has a gap between columns ${first} and ${last}`,
      ).toBe(filled.length);
    }
  });

  it("never draws land and sea in the same cell", () => {
    // The two layers stack; both drawing would double-strike the glyph.
    for (let r = 0; r < ROWS; r += 1) {
      for (let c = 0; c < COLS; c += 1) {
        expect(land[r][c] === " " || sea[r][c] === " ").toBe(true);
      }
    }
  });

  it("tells land from water by density, before colour does anything", () => {
    // Land and sea share no character, so continents read even in one colour.
    const landChars = new Set(frame.land.replace(/[\s\n]/g, ""));
    const seaChars = new Set(frame.sea.replace(/[\s\n]/g, ""));
    for (const ch of landChars) expect(seaChars.has(ch)).toBe(false);
    expect(landChars.size).toBeGreaterThan(1);
  });

  it("turns: the same cell is not the same place a quarter turn later", () => {
    const a = renderGlobe(COLS, ROWS, 0).land;
    const b = renderGlobe(COLS, ROWS, 90).land;
    expect(a).not.toBe(b);
  });

  it("comes back round", () => {
    expect(renderGlobe(COLS, ROWS, 0).land).toBe(renderGlobe(COLS, ROWS, 360).land);
  });
});

describe("isLand", () => {
  it("puts the continents where they belong", () => {
    expect(isLand(13, 52)).toBe(true); // Berlin
    expect(isLand(-100, 40)).toBe(true); // Kansas
    expect(isLand(20, 0)).toBe(true); // Congo basin
    expect(isLand(134, -25)).toBe(true); // central Australia
    expect(isLand(0, -80)).toBe(true); // Antarctica
  });

  it("leaves the oceans open", () => {
    expect(isLand(-150, 0)).toBe(false); // mid Pacific
    expect(isLand(-30, -30)).toBe(false); // south Atlantic
    expect(isLand(75, -40)).toBe(false); // southern Indian
  });

  it("does not tear at the date line", () => {
    // Longitude wraps; a naive distance check makes a seam down ±180.
    expect(isLand(179, 0)).toBe(isLand(-181, 0));
    expect(isLand(-179, 0)).toBe(isLand(181, 0));
  });
});

describe("placeOnGlobe", () => {
  it("agrees with the characters underneath it", () => {
    // A marker is only honest if it lands on the same pixel the renderer
    // decided was land.
    const spin = 20;
    const frame = renderGlobe(COLS, ROWS, spin).land.split("\n");
    for (const city of [
      { lon: 13, lat: 52 },
      { lon: 20, lat: 0 },
    ]) {
      const p = placeOnGlobe(city.lon, city.lat, spin, COLS, ROWS);
      expect(p.visible).toBe(true);
      const c = Math.round(p.x * (COLS - 1));
      const r = Math.round(p.y * (ROWS - 1));
      expect(frame[r][c], `${city.lon},${city.lat} should sit on land`).not.toBe(" ");
    }
  });

  it("hides what has turned away", () => {
    // Tokyo is face-on at 140° and behind the planet half a turn later.
    expect(placeOnGlobe(140, 36, 140, COLS, ROWS).visible).toBe(true);
    expect(placeOnGlobe(140, 36, -40, COLS, ROWS).visible).toBe(false);
  });

  it("keeps east on the right, as a globe seen from outside", () => {
    const east = placeOnGlobe(60, 0, 0, COLS, ROWS);
    const west = placeOnGlobe(-60, 0, 0, COLS, ROWS);
    expect(east.x).toBeGreaterThan(0.5);
    expect(west.x).toBeLessThan(0.5);
  });

  it("keeps north above the equator", () => {
    expect(placeOnGlobe(0, 60, 0, COLS, ROWS).y).toBeLessThan(0.5);
    expect(placeOnGlobe(0, -60, 0, COLS, ROWS).y).toBeGreaterThan(0.5);
  });

  it("stays inside the box", () => {
    for (let lon = -180; lon <= 180; lon += 15) {
      for (let lat = -90; lat <= 90; lat += 15) {
        const p = placeOnGlobe(lon, lat, 33, COLS, ROWS);
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(1);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(1);
      }
    }
  });
});

/**
 * The grid has to be shaped so the sphere comes out round. Characters are
 * about 0.6 as wide as they are tall, so COLS × 0.6 has to land on ROWS —
 * and the two `<pre>` layers have to be laid out at line-height 1 for ROWS
 * lines to occupy exactly the box's height. Both have been wrong: a grid a
 * third of a column too narrow, and a stylesheet that stretched the line
 * height to 1.6 and stood the globe up like a rugby ball.
 */
describe("the grid is shaped for a round globe", () => {
  it("puts as many character widths across as there are rows down", () => {
    const across = GRID.cols * CHAR_ASPECT;
    const ratio = across / GRID.rows;
    expect(ratio).toBeGreaterThan(0.97);
    expect(ratio).toBeLessThan(1.03);
  });

  it("draws a disc as tall as it is wide", () => {
    // Measured off the rendered frame rather than the constants, so this
    // fails if the projection stops agreeing with the grid.
    // Both layers: land blanks the sea and vice versa, so either alone
    // undercounts the silhouette.
    const f = renderGlobe(GRID.cols, GRID.rows, 0);
    const land = f.land.split("\n");
    const sea = f.sea.split("\n");
    const perRow = land.map(
      (row, r) => [...row].filter((c, i) => c !== " " || sea[r][i] !== " ").length,
    );
    const height = perRow.filter((n) => n > 0).length;
    const width = Math.max(...perRow);
    // Widest row is the equator; it spans the same fraction of the grid that
    // the filled rows do, once the cell aspect is taken out.
    expect((width * CHAR_ASPECT) / height).toBeGreaterThan(0.9);
    expect((width * CHAR_ASPECT) / height).toBeLessThan(1.1);
  });
});
