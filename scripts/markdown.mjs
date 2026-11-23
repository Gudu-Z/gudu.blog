import MarkdownIt from 'markdown-it';
import { isMap, parseDocument } from 'yaml';
import { normalizeGranularity, normalizeSpeedUnit, validPlaybackRate } from '../js/mc-playback-settings.mjs';

// Parsing happens only during the build. No Markdown/YAML runtime is shipped
// to the reader, and authored HTML stays visible text rather than executable UI.
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
const escape = markdown.utils.escapeHtml;
const defaultValidateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = url => {
  const normalized = url.trim().replace(/[\u0000-\u0020\u007f]/g, '');
  const scheme = normalized.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase();
  return defaultValidateLink(url) && (!scheme || ['http', 'https', 'mailto'].includes(scheme));
};

const renderImage = markdown.renderer.rules.image;
markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('loading', 'lazy');
  tokens[index].attrSet('decoding', 'async');
  return renderImage(tokens, index, options, env, renderer);
};

function renderCode(tokens, index) {
  const token = tokens[index];
  const language = markdown.utils.unescapeAll(token.info || '').trim().split(/\s+/)[0];
  return `<div class="code-block">${language ? `<span class="code-language">${escape(language)}</span>` : ''}<pre><code>${escape(token.content)}</code></pre></div>\n`;
}
markdown.renderer.rules.fence = renderCode;
markdown.renderer.rules.code_block = renderCode;
markdown.renderer.rules.mc_scene = (tokens, index) => {
  const { id, scene, bookmark, caption, poster, schematic, speed, speedUnit, granularity, loop, autoplay } = tokens[index].meta;
  const base = `../assets/minecraft/${scene}/`;
  const image = poster ? `<img data-mc-poster src="${escape(base + poster.split('/').map(encodeURIComponent).join('/'))}" alt="" loading="lazy" decoding="async" />` : '';
  const rate = speed === undefined ? '' : ` data-speed="${speed}"`;
  const unit = speedUnit === undefined ? '' : ` data-speed-unit="${speedUnit}"`;
  const repeat = loop ? ' data-loop="true"' : '';
  const auto = autoplay ? ' data-autoplay="true"' : '';
  return `<figure class="mc-scene" id="${escape(id)}" data-src="${base}scene.json" data-bookmark="${escape(bookmark)}"${rate}${unit}${granularity ? ` data-granularity="${granularity}"` : ''}${repeat}${auto}${schematic ? ' data-mc-kind="structure"' : ''}>
${image}<div data-mc-view></div>
<button type="button" data-mc-open hidden>${schematic ? '查看 3D 结构' : '打开红石回放'}</button>
<p data-mc-status role="status"></p>
<figcaption>${escape(caption)}</figcaption>
<noscript>启用 JavaScript 即可交互查看这个场景。</noscript>
</figure>\n`;
};
markdown.renderer.rules.table_open = () => '<div class="markdown-table" role="region" aria-label="文章表格，可横向滚动" tabindex="0"><table>\n';
markdown.renderer.rules.table_close = () => '</table></div>\n';

function inlineText(tokens = []) {
  return tokens.map(token => {
    if (token.children) return inlineText(token.children);
    if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
    if (token.type === 'text' || token.type === 'code_inline') return token.content;
    return '';
  }).join('');
}

const compact = text => text.replace(/\s+/g, ' ').trim();
function brief(text) {
  const characters = [...compact(text)];
  return characters.length > 160 ? `${characters.slice(0, 159).join('')}…` : characters.join('');
}

function headingId(text, used) {
  const base = text.normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/[\s_]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}

function yamlFields(source, name, fail) {
  const document = parseDocument(source, {
    version: '1.2', schema: 'core', uniqueKeys: true, stringKeys: true,
    prettyErrors: false,
  });
  const issue = document.errors[0] || document.warnings[0];
  if (issue) fail(`${name}无效：${issue.message}`);
  if (!isMap(document.contents)) fail(`${name}必须是字段对象。`);
  try {
    return document.toJS({ maxAliasCount: 20 });
  } catch (error) {
    fail(`${name}无效：${error.message}`);
  }
}

const sceneKey = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function parseSceneBlock(source, fail) {
  const fields = yamlFields(source, '场景配置', fail);
  for (const key of Object.keys(fields)) {
    if (!['scene', 'bookmark', 'caption', 'speed', 'speed-unit', 'granularity', 'loop', 'autoplay'].includes(key)) fail(`未知的场景字段 ${key}。`);
  }
  const { scene, bookmark, caption, speed, loop = false, autoplay = false } = fields;
  if (typeof scene !== 'string' || !sceneKey.test(scene)) fail('scene 需要有效的场景 ID。');
  if (bookmark !== undefined && (typeof bookmark !== 'string' || !sceneKey.test(bookmark))) fail('bookmark 需要有效的书签 ID。');
  if (caption !== undefined && (typeof caption !== 'string' || !caption.trim())) fail('caption 需要非空文字。');
  if (typeof loop !== 'boolean') fail('loop 需要填写布尔值 true 或 false。');
  if (typeof autoplay !== 'boolean') fail('autoplay 需要填写布尔值 true 或 false。');
  const speedUnit = fields['speed-unit'] === undefined ? undefined : normalizeSpeedUnit(fields['speed-unit']);
  if (fields['speed-unit'] !== undefined && !speedUnit) fail('speed-unit 需要填写 gt/s、s/gt、x、event/s 或 phase/s。');
  if (speed !== undefined && !validPlaybackRate(speed, speedUnit ?? 'gt/s')) {
    fail('speed 需要填写所选单位下有效的正数。');
  }
  const granularity = normalizeGranularity(fields.granularity);
  if (fields.granularity !== undefined && !granularity) fail('granularity 需要填写 tick（游戏刻）、phase（阶段）或 event（事件）。');
  return { scene, bookmark: bookmark ?? '', speed, speedUnit, granularity, loop, autoplay, caption: caption?.trim() ?? `Minecraft 结构 · ${scene}` };
}

/** Return rendered body and plain metadata; metadata fields are validated by the builder. */
export function parseMarkdown(source, filename, resolveScene) {
  const fail = message => { throw new Error(`${filename}：${message}`); };
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  if (!/^---[\t ]*$/.test(lines[0])) fail('需要在文件开头使用 --- 包围 YAML 文章信息。');
  const end = lines.findIndex((line, index) => index > 0 && /^---[\t ]*$/.test(line));
  if (end < 0) fail('YAML 文章信息缺少结尾的 ---。');
  const attributes = yamlFields(lines.slice(1, end).join('\n'), 'YAML 文章信息', fail);
  const body = lines.slice(end + 1).join('\n');
  if (!body.trim()) fail('Markdown 正文不能为空。');
  const env = {};
  const tokens = markdown.parse(body, env);
  const headings = [];
  const used = new Set(['main-content', 'comments', 'comments-title', 'waline']);
  const textParts = [];
  const sceneTokens = [];
  let paragraph = '';
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === 'fence' && token.info.trim() === 'mc-scene') {
      const sceneFail = message => fail(`第 ${end + 2 + token.map[0]} 行 mc-scene：${message}`);
      const fields = parseSceneBlock(token.content, sceneFail);
      let assets;
      if (attributes.draft !== true && resolveScene) {
        try { assets = resolveScene(fields.scene, fields.bookmark); }
        catch (error) { sceneFail(`${fields.scene}：${error.message}`); }
      }
      token.type = 'mc_scene';
      token.meta = { ...fields, ...assets };
      sceneTokens.push(token);
      textParts.push(fields.caption);
      continue;
    }
    if (token.type === 'inline') textParts.push(inlineText(token.children));
    if (token.type === 'fence' || token.type === 'code_block') textParts.push(token.content);
    if (!paragraph && token.type === 'paragraph_open' && token.level === 0 && tokens[index + 1]?.type === 'inline') {
      paragraph = compact(inlineText(tokens[index + 1].children));
    }
    if (token.type !== 'heading_open') continue;
    const title = compact(inlineText(tokens[index + 1]?.children));
    const level = Math.max(2, Number(token.tag.slice(1)));
    token.tag = `h${level}`;
    if (tokens[index + 2]?.type === 'heading_close') tokens[index + 2].tag = token.tag;
    const id = headingId(title, used);
    token.attrSet('id', id);
    if (level <= 3) headings.push({ id, text: title, level });
  }
  for (const token of sceneTokens) token.meta.id = headingId(`mc-${token.meta.scene}`, used);
  const plainText = compact(textParts.join(' '));
  if (!plainText) fail('Markdown 正文需要可读内容。');
  return {
    attributes,
    html: markdown.renderer.render(tokens, markdown.options, env),
    headings,
    hasScenes: sceneTokens.length > 0,
    plainText,
    excerpt: brief(paragraph || plainText),
  };
}
