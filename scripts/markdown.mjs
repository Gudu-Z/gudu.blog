import MarkdownIt from 'markdown-it';
import { isMap, parseDocument } from 'yaml';

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

/** Return rendered body and plain metadata; metadata fields are validated by the builder. */
export function parseMarkdown(source, filename) {
  const fail = message => { throw new Error(`${filename}：${message}`); };
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  if (!/^---[\t ]*$/.test(lines[0])) fail('需要在文件开头使用 --- 包围 YAML 文章信息。');
  const end = lines.findIndex((line, index) => index > 0 && /^---[\t ]*$/.test(line));
  if (end < 0) fail('YAML 文章信息缺少结尾的 ---。');
  const document = parseDocument(lines.slice(1, end).join('\n'), {
    version: '1.2', schema: 'core', uniqueKeys: true, stringKeys: true,
    prettyErrors: false,
  });
  const issue = document.errors[0] || document.warnings[0];
  if (issue) fail(`YAML 文章信息无效：${issue.message}`);
  if (!isMap(document.contents)) fail('YAML 文章信息必须是字段对象。');
  let attributes;
  try {
    attributes = document.toJS({ maxAliasCount: 20 });
  } catch (error) {
    fail(`YAML 文章信息无效：${error.message}`);
  }
  const body = lines.slice(end + 1).join('\n');
  if (!body.trim()) fail('Markdown 正文不能为空。');
  const env = {};
  const tokens = markdown.parse(body, env);
  const headings = [];
  const used = new Set(['main-content']);
  const textParts = [];
  let paragraph = '';
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
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
  const plainText = compact(textParts.join(' '));
  if (!plainText) fail('Markdown 正文需要可读内容。');
  return {
    attributes,
    html: markdown.renderer.render(tokens, markdown.options, env),
    headings,
    plainText,
    excerpt: brief(paragraph || plainText),
  };
}
