import { entityVisualNbt } from './mc-export-appearance.mjs';
import { profileSkin } from './mc-player-skins.mjs';
import { createHash } from 'node:crypto';

function uuid(value) {
  if (typeof value === 'string') {
    return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;
  }
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isInteger)) return null;
  const hex = value.map(n => (n >>> 0).toString(16).padStart(8, '0')).join('');
  return formatUuid(hex);
}

function formatUuid(hex) {
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function isPlayerSnapshot(nbt, key, recordedPlayers) {
  if (nbt.id === 'minecraft:player') return true;
  if (nbt.id !== 'minecraft:mannequin') return false;
  if (recordedPlayers.has(key)) return true;
  const account = uuid(nbt.profile?.id);
  if (!account) return false;
  // PlayerProxy.replayUuid uses UUID.nameUUIDFromBytes. This distinguishes a
  // recorded player from a real, skinned mannequin even in an idle recording.
  const bytes = createHash('md5').update('mtr:player:' + account, 'utf8').digest();
  bytes[6] = (bytes[6] & 15) | 0x30;
  bytes[8] = (bytes[8] & 63) | 0x80;
  return formatUuid(bytes.toString('hex')) === key;
}

function finitePos(pos) {
  return Array.isArray(pos) && pos.length === 3 && pos.every(Number.isFinite);
}

const validType = type => typeof type === 'string' && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(type);
const motion = new Set(['entityTick', 'entityMove', 'entityCollideAxis']);

export function actorTracks(areas, frames, local) {
  const recorded = new Set();
  function collect(tag) {
    if (tag.entityType === 'minecraft:player') {
      const key = uuid(tag.entityUuid);
      if (key) recorded.add(key);
    }
    for (const child of tag.children ?? []) collect(child);
  }
  for (const frame of frames) for (const event of frame.events) collect(event);

  const ids = new Map(), active = new Map();
  const counters = { player: 0, entity: 0 };
  function idFor(key, kind) {
    if (!ids.has(key)) ids.set(key, kind + '-' + (++counters[kind]));
    return ids.get(key);
  }
  const separateIds = new Set(areas.flatMap(area => (area.entities ?? []).map(nbt => uuid(nbt.UUID))).filter(Boolean));
  const separateActor = nbt => separateIds.has(uuid(nbt.UUID));
  function visualNbt(nbt, player) {
    // The player skin is already stored once in the scene skin table.
    return entityVisualNbt(player && nbt ? { ...nbt, profile: undefined } : nbt, separateActor);
  }
  const players = [], entities = [], playerAccounts = new Map();
  function appearance(nbt, actorId) {
    // MTR stores the real account in profile.id. A proxy entity UUID is only a replay key.
    const account = uuid(nbt?.profile?.id) ?? (nbt?.id === 'minecraft:player' ? uuid(nbt.UUID) : null);
    if (account) playerAccounts.set(actorId, account);
    return profileSkin(nbt?.profile);
  }
  let omittedEntities = 0;
  for (const area of areas) {
    for (const nbt of area.entities ?? []) {
      const key = uuid(nbt.UUID);
      if (!key || !validType(nbt.id)) { omittedEntities++; continue; }
      if (active.has(key)) continue;
      if (!finitePos(nbt.Pos)) throw Error('实体快照的初始坐标无效。');
      const [yaw = 0, pitch = 0] = nbt.Rotation ?? [];
      if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) throw Error('实体快照的朝向无效。');
      const player = isPlayerSnapshot(nbt, key, recorded);
      const state = { id: idFor(key, player ? 'player' : 'entity'), pos: local(nbt.Pos), yaw, pitch };
      if (player) {
        Object.assign(state, appearance(nbt, state.id), visualNbt(nbt, true));
        players.push(state);
      } else {
        Object.assign(state, { type: nbt.id }, visualNbt(nbt, false));
        entities.push(state);
      }
      active.set(key, state);
    }
  }

  function apply(tag, event) {
    const key = uuid(tag.entityUuid);
    if (!key) return;
    const previous = active.get(key);
    const spawn = tag.type === 'entitySpawn';
    // Identity is useful even at an unchanged tick or a non-positional event
    // such as entitySetHealth. Never instantiate an actor from these markers.
    if (ids.has(key)) event.actorId = ids.get(key);
    if (spawn && tag.despawn) {
      if (!previous) return;
      active.delete(key);
      event[previous.type ? 'entity' : 'player'] = { id: previous.id, removed: true };
      return;
    }
    if (previous?.type && tag.type === 'entitySetHealth' && Number.isFinite(tag.newHealth)) {
      const state = { ...previous, nbt: { ...previous.nbt, Health: tag.newHealth } };
      active.set(key, state);
      event.entity = state;
      return;
    }
    if (!spawn && (!previous || !motion.has(tag.type))) return;
    const entityType = validType(tag.entityType) ? tag.entityType : tag.entityNbt?.id;
    if (spawn && !validType(entityType)) return;
    const world = [tag.x, tag.y, tag.z];
    if (!finitePos(world)) throw Error('实体事件的坐标无效。');
    const pos = local(world);
    const yaw = tag.yaw ?? previous?.yaw ?? tag.entityNbt?.Rotation?.[0] ?? 0;
    const pitch = tag.pitch ?? previous?.pitch ?? tag.entityNbt?.Rotation?.[1] ?? 0;
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) throw Error('实体事件的朝向无效。');
    if (!spawn && yaw === previous.yaw && pitch === previous.pitch && pos.every((n, i) => n === previous.pos[i])) return;

    let state;
    if (spawn) {
      const kind = entityType === 'minecraft:player' || (tag.entityNbt && isPlayerSnapshot(tag.entityNbt, key, recorded))
        ? 'player' : 'entity';
      const id = idFor(key, kind);
      const metadata = kind === 'player' ? appearance(tag.entityNbt, id) : { type: entityType };
      state = { id, ...metadata, ...visualNbt(tag.entityNbt, kind === 'player'), pos, yaw, pitch };
    } else {
      state = { ...previous, pos, yaw, pitch };
    }
    active.set(key, state);
    event.actorId = state.id;
    event[state.type ? 'entity' : 'player'] = state;
  }

  // MTR writes an area exit at the first position outside the box.
  const isActive = tag => active.has(uuid(tag.entityUuid));
  return { players, entities, apply, isActive, omittedEntities, playerAccounts };
}
