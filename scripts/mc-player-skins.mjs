import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const pngHeader = Buffer.from('89504e470d0a1a0a', 'hex');
const maxSkinBytes = 1024 * 1024;
const textureOrigin = 'https://textures.minecraft.net';
const sessionOrigin = 'https://sessionserver.mojang.com';
const hashPattern = /^[a-f0-9]{64}$/;
const onlineAccount = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

export function profileSkin(profile) {
  const properties = profile?.properties;
  if (!Array.isArray(properties)) return;
  const value = properties.find(p => p?.name === 'textures')?.value;
  if (typeof value !== 'string' || value.length > 65536) return;
  try {
    const skin = JSON.parse(Buffer.from(value, 'base64').toString('utf8')).textures?.SKIN;
    const hash = /^https?:\/\/textures\.minecraft\.net\/texture\/([a-f0-9]{64})$/i.exec(skin?.url)?.[1];
    if (hash) return { skin: hash.toLowerCase(), model: skin.metadata?.model === 'slim' ? 'slim' : 'wide' };
  } catch { /* An unresolved profile uses the default player appearance. */ }
}

async function findSkinCache(source) {
  let dir = resolve(source);
  while (true) {
    const candidate = join(dir, 'assets', 'skins');
    const info = await stat(candidate).catch(() => null);
    if (info?.isDirectory()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function checkedSkin(png, hash) {
  if (!png || png.length < 45 || png.length > maxSkinBytes || !png.subarray(0, 8).equals(pngHeader)
    || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR'
    || png.readUInt32BE(16) !== 64 || ![32, 64].includes(png.readUInt32BE(20))) return;
  if (createHash('sha256').update(png).digest('hex') !== hash) return;
  let hasImage = false;
  for (let cursor = 33; cursor + 12 <= png.length;) {
    const size = png.readUInt32BE(cursor);
    const type = png.toString('ascii', cursor + 4, cursor + 8);
    cursor += size + 12;
    if (cursor > png.length) return;
    if (type === 'IDAT' && size) hasImage = true;
    if (type === 'IEND') return !size && cursor === png.length && hasImage ? png.toString('base64') : undefined;
  }
}

async function readCachedSkin(cache, hash) {
  // Java's SkinManager hashes the UTF-16LE texture hash. Some launchers use it directly.
  const javaKey = createHash('sha1').update(hash, 'utf16le').digest('hex');
  for (const key of [javaKey, hash]) {
    const file = await open(join(cache, key.slice(0, 2), key), 'r').catch(() => null);
    if (!file) continue;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maxSkinBytes) continue;
      const png = checkedSkin(await file.readFile(), hash);
      if (png) return png;
    } catch { /* A cache entry may be removed or unreadable during export. */ }
    finally { await file.close(); }
  }
}

async function readRemote(url, limit, fetchImpl, limitedOrigins) {
  const { origin } = new URL(url);
  if (limitedOrigins.has(origin)) return;
  try {
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (response.status === 429) limitedOrigins.add(origin);
    if (!response.ok || Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) return;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } catch { /* Offline, timeout and unavailable services keep exports usable. */ }
}

async function lookupProfile(account, fetchImpl, limitedOrigins) {
  if (!onlineAccount.test(account)) return;
  const id = account.replaceAll('-', '').toLowerCase();
  const bytes = await readRemote(sessionOrigin + '/session/minecraft/profile/' + id, 65536, fetchImpl, limitedOrigins);
  if (!bytes) return;
  try {
    const profile = JSON.parse(bytes.toString('utf8'));
    if (profile.id?.toLowerCase() === id) return profileSkin(profile);
  } catch { /* Mojang can return an empty or unavailable profile. */ }
}

export async function attachPlayerSkins(scene, source, cachePath, { accounts = new Map(), fetchImpl = fetch } = {}) {
  const hashes = new Set(), recorded = new Map(), unresolved = new Map();
  const seenNbt = new WeakSet();
  function collectNbt(nbt) {
    if (!nbt || seenNbt.has(nbt)) return;
    seenNbt.add(nbt);
    const skin = profileSkin(nbt.profile);
    if (skin) hashes.add(skin.skin);
    for (const passenger of nbt.Passengers ?? []) collectNbt(passenger);
  }
  function collect(actor, player) {
    if (!actor || actor.removed) return;
    collectNbt(actor.nbt);
    if (!player) return;
    if (typeof actor.skin === 'string' && hashPattern.test(actor.skin)) {
      hashes.add(actor.skin);
      recorded.set(actor.id, { skin: actor.skin, model: actor.model ?? 'wide' });
    } else if (accounts.has(actor.id)) {
      if (!unresolved.has(actor.id)) unresolved.set(actor.id, []);
      unresolved.get(actor.id).push(actor);
    }
  }
  for (const player of scene.players ?? []) collect(player, true);
  for (const entity of scene.entities ?? []) collect(entity, false);
  for (const event of scene.events) {
    collect(event.player, true);
    collect(event.entity, false);
  }
  const limitedOrigins = new Set(), profiles = new Map();
  let unavailable = 0;
  for (const [id, states] of unresolved) {
    const account = accounts.get(id);
    let skin = recorded.get(id);
    if (!skin) {
      if (!profiles.has(account)) profiles.set(account, await lookupProfile(account, fetchImpl, limitedOrigins));
      skin = profiles.get(account);
    }
    if (skin) {
      for (const state of states) Object.assign(state, skin);
      hashes.add(skin.skin);
    } else unavailable++;
  }
  const cache = hashes.size && (cachePath ? resolve(cachePath) : await findSkinCache(source));
  for (const hash of hashes) {
    if (Object.hasOwn(scene.skins ?? {}, hash)) continue;
    let png = cache && await readCachedSkin(cache, hash);
    if (!png) png = checkedSkin(await readRemote(textureOrigin + '/texture/' + hash, maxSkinBytes, fetchImpl, limitedOrigins), hash);
    if (png) (scene.skins ??= {})[hash] = png;
    else unavailable++;
  }
  if (unavailable) console.warn('部分玩家或假人皮肤无法取得，将使用默认皮肤。');
}
