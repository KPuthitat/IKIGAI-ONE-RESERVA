// Code 128-B barcode encoder → bar geometry for an inline SVG
// (owner 2026-06-08). Dependency-free on purpose: the R2 incident taught
// us not to load code generators from a CDN/runtime lib. This is a pure
// function bundled with the app, and an SVG prints crisply at any label
// size (vector, not raster).
//
// Set B covers printable ASCII (32–126), which is everything our item
// codes use (uppercase, digits, "/", "-"). Returns null if the input has
// nothing encodable.

// Bar/space width patterns for code values 0..106. Each pattern is a run
// of element widths starting with a BAR (even index = bar, odd = space).
// Index 104 = Start B, 106 = Stop. This is the canonical Code 128 table.
const PATTERNS = [
  "212222","222122","222221","121223","121322","131222","122213","122312","132212","221213",
  "221312","231212","112232","122132","122231","113222","123122","123221","223211","221132",
  "221231","213212","223112","312131","311222","321122","321221","312212","322112","322211",
  "212123","212321","232121","111323","131123","131321","112313","132113","132311","211313",
  "231113","231311","112133","112331","132131","113123","113321","133121","313121","211331",
  "231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
  "314111","221411","431111","111224","111422","121124","121421","141122","141221","112214",
  "112412","122114","122411","142112","142211","241211","221114","413111","241112","134111",
  "111242","121142","121241","114212","124112","124211","411212","421112","421211","212141",
  "214121","412121","111143","111341","131141","114113","114311","411113","411311","113141",
  "114131","311141","411131","211412","211214","211232","2331112"
];
const START_B = 104;
const STOP = 106;
const QUIET = 10; // quiet-zone modules each side (required for scanning)

export type Barcode = { bars: Array<{ x: number; w: number }>; width: number };

/** Encode `input` as Code 128-B. Returns bar rectangles (in module units)
 *  plus the total module width, for rendering into an SVG with a viewBox
 *  of `0 0 width H`. Returns null when there's nothing encodable. */
export function code128B(input: string): Barcode | null {
  const codes: number[] = [];
  for (const ch of input) {
    const n = ch.charCodeAt(0);
    if (n >= 32 && n <= 126) codes.push(n - 32);
  }
  if (codes.length === 0) return null;

  const values: number[] = [START_B, ...codes];
  // Checksum = (start + Σ value_i * position_i) mod 103, position from 1.
  let sum = START_B;
  for (let i = 1; i < values.length; i++) sum += values[i] * i;
  values.push(sum % 103);
  values.push(STOP);

  const bars: Array<{ x: number; w: number }> = [];
  let x = QUIET;
  for (const v of values) {
    const pat = PATTERNS[v];
    for (let i = 0; i < pat.length; i++) {
      const w = pat.charCodeAt(i) - 48; // ASCII digit → width
      if (i % 2 === 0) bars.push({ x, w });
      x += w;
    }
  }
  return { bars, width: x + QUIET };
}
