// Each article page loads its own cuts of Noto Sans SC (Source Han Sans): the
// title in Black, and the prose in Regular and SemiBold. The build keeps only
// the characters a face draws on that page, so a page loads tens of kilobytes
// instead of a full CJK font. A cut is named by its characters, so unchanged
// words never need the source font again and --check needs no font tools.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const articleFontDirectory = 'assets/fonts/articles';

// Bump when the way cuts are made changes, so every cut is made again.
const recipe = 1;
const cutName = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z]+-[0-9a-f]{10}\.woff2$/;
const byCodePoint = (a, b) => a.codePointAt(0) - b.codePointAt(0);

// Every character, plus the space, once each in code point order.
export const fontCharacters = text => [...new Set([...text, ' '])].sort(byCodePoint).join('');
// Han and CJK punctuation only: Latin in the prose stays in the UI face.
export const hanCharacters = text => [...new Set([...text].filter(char => char.codePointAt(0) >= 0x2e80))].sort(byCodePoint).join('');

const decode = text => text.replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => String.fromCodePoint(code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code)));
// The prose of the body markup: code keeps its mono face, and a replay keeps
// the UI face except for the author's caption.
const prose = html => html
  .replace(/<(script|style|pre|code)\b[\s\S]*?<\/\1>/gi, '')
  .replace(/<figure class="mc-scene"[\s\S]*?<\/figure>/gi, figure => figure.match(/<figcaption>[\s\S]*?<\/figcaption>/i)?.[0] ?? '');
const plain = html => decode(html.replace(/<[^>]*>/g, ''));
const boldParts = html => [...html.matchAll(/<(h[2-6]|strong|b|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(match => match[2]).join('');

const faces = [
  { name: 'title', family: 'Gudu Title', weight: 900, range: '900', display: 'block', characters: ({ title }) => fontCharacters(title) },
  { name: 'body', family: 'Gudu Body', weight: 400, range: '400', display: 'swap', characters: ({ text }) => hanCharacters(text) },
  { name: 'bold', family: 'Gudu Body', weight: 600, range: '600 700', display: 'swap', characters: ({ bold }) => hanCharacters(bold) },
];

// The cuts one article asks for. `bodyHTML` is the article's body markup and
// `extraHTML` any other markup set in the body face: the deck, the closing
// line and the page's own chrome (facts, contents, neighbours, foot bar).
export function articleFonts(post, bodyHTML = '', extraHTML = '') {
  const html = prose(bodyHTML);
  const words = { title: post.title, text: `${plain(html)}\n${plain(extraHTML)}`, bold: plain(boldParts(html) + boldParts(extraHTML)) };
  return faces.flatMap(({ name, characters: pick, ...face }) => {
    const characters = pick(words);
    if (!characters) return [];
    const hash = createHash('sha256').update(`${recipe}\n${face.weight}\n${characters}`).digest('hex').slice(0, 10);
    return [{ ...face, characters, path: `${articleFontDirectory}/${post.slug}-${name}-${hash}.woff2` }];
  });
}

// The article index lists every article on every page, so its words share one
// cut across all pages instead of joining each page's own: a new or renamed
// article then remakes this one cut, not every page's prose cut.
export function indexFont(indexHTML = '') {
  const characters = hanCharacters(plain(indexHTML));
  if (!characters) return [];
  const face = { family: 'Gudu Index', weight: 400, range: '400', display: 'swap' };
  const hash = createHash('sha256').update(`${recipe}\n${face.weight}\n${characters}`).digest('hex').slice(0, 10);
  return [{ ...face, characters, path: `${articleFontDirectory}/site-index-${hash}.woff2` }];
}

// Every cut is preloaded. The title blocks briefly rather than swapping, so it
// appears once in its own face; the prose shows at once in the system face and
// swaps when its cut arrives, which keeps every line where it was.
export function articleFontHead(fonts, prefix) {
  const preload = fonts.map(({ path }) => `<link rel="preload" href="${prefix}${path}" as="font" type="font/woff2" crossorigin />`);
  const rules = fonts.map(({ family, range, display, path }) => `@font-face { font-family: "${family}"; src: url("${prefix}${path}") format("woff2"); font-weight: ${range}; font-display: ${display}; }`);
  return [...preload, `<style>\n      ${rules.join('\n      ')}\n    </style>`].join('\n    ');
}

const sourceNames = ['NotoSansSC-VF.ttf', 'NotoSansSC-VariableFont_wght.ttf', 'NotoSansSC[wght].ttf'];
const sourceFolders = () => [
  'C:/Windows/Fonts',
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft/Windows/Fonts'),
  join(homedir(), 'Library/Fonts'),
  '/Library/Fonts',
  join(homedir(), '.local/share/fonts'),
  '/usr/share/fonts/truetype/noto',
].filter(Boolean);

async function readSource() {
  const candidates = [process.env.GUDU_ARTICLE_FONT, ...sourceFolders().flatMap(folder => sourceNames.map(name => join(folder, name)))].filter(Boolean);
  for (const path of candidates) {
    try { return await readFile(path); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new Error('生成文章字体需要 Noto Sans SC 可变字体（NotoSansSC-VF.ttf）。请从 Google Fonts 安装 Noto Sans SC，或用环境变量 GUDU_ARTICLE_FONT 指向字体文件。');
}

let source;
async function cutFromSource(characters, weight) {
  source ??= readSource();
  const { default: subsetFont } = await import('subset-font');
  return subsetFont(await source, characters, { targetFormat: 'woff2', variationAxes: { wght: weight } });
}

// Writes the cuts the pages ask for and removes the ones no page asks for any
// more. Files that do not look like cuts are left alone.
export async function syncArticleFonts({ root, fonts, checkOnly = false, cut = cutFromSource }) {
  const directory = resolve(root, articleFontDirectory);
  const wanted = new Map(fonts.map(font => [font.path.slice(articleFontDirectory.length + 1), font]));
  const existing = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const missing = [...wanted.keys()].filter(name => !existing.includes(name));
  const stale = existing.filter(name => cutName.test(name) && !wanted.has(name));
  if (checkOnly) {
    if (missing.length || stale.length) throw new Error(`文章字体需要更新，请运行 npm run build：${[...missing, ...stale].map(name => `${articleFontDirectory}/${name}`).join(', ')}`);
    console.log(`Article fonts checked: ${wanted.size} cut(s) are current.`);
    return;
  }
  if (missing.length) await mkdir(directory, { recursive: true });
  for (const name of missing) {
    const { characters, weight } = wanted.get(name);
    await writeFile(join(directory, name), await cut(characters, weight));
  }
  for (const name of stale) await unlink(join(directory, name));
  console.log(`Article fonts: ${wanted.size} cut(s), ${missing.length} written, ${stale.length} removed.`);
}
