// Derives the day palette from the night palette. Each color keeps its hue
// and chroma while its OKLab lightness is mirrored between the night sky and
// the day paper, so every contrast step of the night design carries over.
// Usage: node scripts/day-palette.mjs "#a0a0aa" "rgb(0 0 0 / 24%)"
import { pathToFileURL } from 'node:url';

export const nightSky = '#080b10';
export const dayPaper = '#eef0f2';

// The brand orange and its tints stay as they are. Orange text needs more
// contrast on paper, and the logo amber matches the dark logo artwork.
const fixed = new Map([
  ['#080b10', '#eef0f2'],
  ['#f06446', '#f06446'],
  ['#f69b85', '#c0401f'],
  ['#fa967e', '#c0401f'],
  ['#e7907a', '#b5432a'],
  ['#d4aa71', '#8c6528'],
  ['#fbb03b', '#fbb03b'],
  ['#f04f46', '#f04f46'],
]);

const toLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function toOklab([r, g, b]) {
  [r, g, b] = [r, g, b].map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(toGamma);
}

const inGamut = rgb => rgb.every(c => c >= -1e-4 && c <= 1 + 1e-4);

function parseHex(hex) {
  let digits = hex.slice(1);
  if (digits.length <= 4) digits = [...digits].map(d => d + d).join('');
  const channel = i => parseInt(digits.slice(i, i + 2), 16) / 255;
  return { rgb: [channel(0), channel(2), channel(4)], alpha: digits.length === 8 ? digits.slice(6) : null };
}

const toHex = rgb => '#' + rgb.map(c => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('');

const pivot = toOklab(parseHex(nightSky).rgb)[0] + toOklab(parseHex(dayPaper).rgb)[0];

function mirror(rgb) {
  const [L, a, b] = toOklab(rgb);
  const target = Math.min(1, Math.max(0, pivot - L));
  // A tint reads far stronger on a light surface than on a dark one: the
  // faint blue of a night panel would turn visibly blue next to the paper.
  const tint = 1 - 0.55 * Math.min(1, Math.max(0, (target - 0.7) / 0.2));
  // Keep hue; give up chroma only where the mirrored color leaves sRGB.
  for (let scale = tint; scale >= 0; scale -= 0.02) {
    const candidate = fromOklab([target, a * scale, b * scale]);
    if (inGamut(candidate)) return candidate;
  }
  return fromOklab([target, 0, 0]);
}

// Shadows stay dark on paper; lighter surfaces need less of them.
const shadowAlpha = alpha => Math.round(alpha * 0.45 * 1000) / 1000;

export function dayColor(literal) {
  const value = literal.trim();
  if (value.startsWith('#')) {
    const { rgb, alpha } = parseHex(value.toLowerCase());
    const base = toHex(rgb);
    if (fixed.has(base)) return fixed.get(base) + (alpha ?? '');
    if (base === '#000000' && alpha) {
      const scaled = Math.round(parseInt(alpha, 16) * 0.45).toString(16).padStart(2, '0');
      return `#000000${scaled}`;
    }
    return toHex(mirror(rgb)) + (alpha ?? '');
  }
  const match = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*(.+))?\)$/s);
  if (!match) throw new Error(`Unsupported color: ${literal}`);
  const rgb = match.slice(1, 4).map(Number);
  const alpha = match[4]?.trim();
  const base = toHex(rgb.map(c => c / 255));
  const format = (color, alphaText = alpha) => {
    const channels = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16)).join(' ');
    return alphaText ? `rgb(${channels} / ${alphaText})` : `rgb(${channels})`;
  };
  if (fixed.has(base)) return format(fixed.get(base));
  if (base === '#000000' && alpha && /^[\d.]+%?$/.test(alpha)) {
    const fraction = alpha.endsWith('%') ? parseFloat(alpha) / 100 : parseFloat(alpha);
    return format('#000000', `${Math.round(shadowAlpha(fraction) * 1000) / 10}%`);
  }
  return format(toHex(mirror(rgb.map(c => c / 255))));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  for (const literal of process.argv.slice(2)) console.log(`light-dark(${dayColor(literal)}, ${literal})`);
}
