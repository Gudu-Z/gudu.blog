import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { validateScene } from '../js/mc-replay.mjs';

function containedPath(directory, filename) {
  const path = realpathSync(resolve(directory, filename));
  const inside = relative(directory, path);
  if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) {
    throw new Error(`场景资源越过目录边界：${filename}`);
  }
  return path;
}

export function createSceneResolver(root) {
  const scenes = new Map();
  function readScene(id) {
    const base = containedPath(realpathSync(root), 'assets/minecraft');
    const directory = containedPath(base, id);
    const scene = JSON.parse(readFileSync(containedPath(directory, 'scene.json'), 'utf8'));
    validateScene(scene);
    const posters = new Map(Object.entries(scene.bookmarks ?? {}).map(([key, value]) => [key, value.poster]));
    for (const file of new Set([scene.schematic, scene.poster, ...posters.values()])) {
      if (file && !statSync(containedPath(directory, file)).isFile()) throw new Error(`需要资源文件：${file}`);
    }
    return { schematic: Boolean(scene.schematic), poster: scene.poster, posters };
  }
  return (id, bookmark) => {
    if (!scenes.has(id)) scenes.set(id, readScene(id));
    const scene = scenes.get(id);
    if (bookmark && !scene.posters.has(bookmark)) throw new Error(`找不到书签 ${bookmark}。`);
    return { schematic: scene.schematic, poster: scene.posters.get(bookmark) ?? scene.poster };
  };
}
