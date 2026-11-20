import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const pngHeader = Buffer.from('89504e470d0a1a0a', 'hex');

async function findSkinCache(source) {
  let dir = resolve(source);
  while (true) {
    const candidate = join(dir, 'assets', 'skins');
    const info = await stat(candidate).catch(error => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    });
    if (info?.isDirectory()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

async function readCachedSkin(cache, hash) {
  // Java's SkinManager caches SHA-1 of the texture hash as UTF-16LE.
  // Some launchers keep the original texture hash as the filename.
  const javaKey = createHash('sha1').update(hash, 'utf16le').digest('hex');
  for (const key of [javaKey, hash]) {
    const path = join(cache, key.slice(0, 2), key);
    const file = await open(path, 'r').catch(error => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    });
    if (!file) continue;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 33 || info.size > 1024 * 1024) continue;
      const png = await file.readFile();
      if (!png.subarray(0, 8).equals(pngHeader) || png.toString('ascii', 12, 16) !== 'IHDR') continue;
      if (png.readUInt32BE(16) !== 64 || ![32, 64].includes(png.readUInt32BE(20))) continue;
      const digest = createHash('sha256').update(png).digest('hex');
      if (digest === hash) return png.toString('base64');
    } finally { await file.close(); }
  }
}

export async function attachPlayerSkins(scene, source, cachePath) {
  const hashes = new Set();
  const collect = player => {
    if (typeof player?.skin === 'string' && /^[a-f0-9]{64}$/.test(player.skin)) hashes.add(player.skin);
  };
  scene.players?.forEach(collect);
  for (const event of scene.events) collect(event.player);
  if (!hashes.size) return;
  const cache = cachePath ? resolve(cachePath) : await findSkinCache(source);
  for (const hash of hashes) {
    const png = cache && await readCachedSkin(cache, hash);
    if (png) (scene.skins ??= {})[hash] = png;
  }
  const missing = hashes.size - Object.keys(scene.skins ?? {}).length;
  if (missing) console.warn(`有 ${missing} 张玩家皮肤未在缓存中找到，将显示默认皮肤。可用 --skin-cache 指定 Minecraft 的 assets/skins 目录。`);
}
