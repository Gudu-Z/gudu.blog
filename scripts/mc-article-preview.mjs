import { createSceneResolver } from './mc-article-assets.mjs';
import { parseMarkdown } from './markdown.mjs';

// This route only exists in the local dev server. Build the same figure used in a post.
export function previewScene(root, scene, bookmark) {
  const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  if (!slug.test(scene) || (bookmark !== null && !slug.test(bookmark))) throw new Error('场景或书签名称无效。');
  const source = ['---', 'draft: false', '---', '```mc-scene', `scene: ${scene}`,
    ...(bookmark ? [`bookmark: ${bookmark}`] : []), `caption: ${scene}`, '```'].join('\n');
  const { html } = parseMarkdown(source, scene, createSceneResolver(root));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <base href="/posts/"><title>${scene} · 本地回放预览</title>
    <script src="../js/site-theme.js"></script><link rel="stylesheet" href="../css/style.css">
    <link rel="stylesheet" href="../css/blog.css"><link rel="stylesheet" href="../css/mc-article.css">
    <script type="module" src="../js/mc-article.mjs"></script></head>
    <body class="article-page"><main class="article-shell" data-mc-author><header class="article-header">
    <h1 class="article-title">红石场景预览</h1></header><article class="article-body">${html}</article></main></body></html>`;
}
