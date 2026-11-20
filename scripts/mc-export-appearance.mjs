// Only publish NBT that determines the visible model. Item inventories, account IDs,
// commands, book contents and interactive text actions do not belong in a blog replay.
import { hitboxNbt } from './mc-export-hitbox.mjs';
import { profileSkin } from './mc-player-skins.mjs';

const resource = value => typeof value === 'string' && value.length <= 256
  && /^(?:[a-z0-9_.-]+:)?[a-z0-9_/.-]+$/.test(value) && !value.split('/').includes('..');
const vector = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
const object = v => v != null && typeof v === 'object' && !Array.isArray(v);
const numericFields = `Health OnGround AngerTime HasNectar HasStung has_stung Sheared sheared Shivering shivering
  powered Powered Invul active Active HasLeftHorn HasRightHorn Pumpkin ChestedHorse Sleeping
  DeathTime HasEgg BatFlags LeftHanded ShowArms NoBasePlate Saddle ItemRotation item_rotation
  Fuse fuse DisplayOffset display_offset CustomDisplayTile background text_opacity line_width see_through
  shadow default_background width height Color color CollarColor collar_color Glowing glowing
  Radius radius value Value ShowBottom show_bottom ShotFromCrossbow ShotAtAngle dangerous Dangerous`.split(/\s+/);
const variants = `Motive Potion potion Type type Variant variant minecraft:variant MainGene HiddenGene CatType RabbitType Color color
  state weather_state oxidation_level item_display billboard alignment facing attach_face`.split(/\s+/);

function blockState(value) {
  if (!resource(value?.Name)) return;
  const state = { Name: value.Name };
  if (object(value.Properties)) {
    const properties = Object.entries(value.Properties).filter(([k, v]) => /^[\w-]+$/.test(k) && resource(v));
    if (properties.length) state.Properties = Object.fromEntries(properties);
  }
  return state;
}

function stack(value) {
  if (!resource(value?.id)) return;
  const item = { id: value.id };
  if (Number.isFinite(value.count ?? value.Count)) item.count = value.count ?? value.Count;
  const c = value.components ?? {};
  const component = key => c['minecraft:' + key] ?? c[key];
  const clean = {};
  const color = component('dyed_color');
  if (Number.isFinite(color?.rgb ?? color ?? value.tag?.display?.color)) clean.dyed_color = color?.rgb ?? color ?? value.tag.display.color;
  if (resource(component('item_model'))) clean.item_model = component('item_model');
  if (Number.isFinite(component('damage'))) clean.damage = component('damage');
  const enchantments = component('enchantments');
  if (component('enchantment_glint_override') != null) clean.enchantment_glint_override = Boolean(component('enchantment_glint_override'));
  else if (Object.keys(enchantments?.levels ?? enchantments ?? {}).length || value.tag?.Enchantments?.length) clean.enchantment_glint_override = true;
  const trim = component('trim') ?? value.tag?.Trim;
  if (resource(trim?.pattern) && resource(trim?.material)) clean.trim = { pattern: trim.pattern, material: trim.material };
  const potion = component('potion_contents');
  if (object(potion)) {
    const info = {};
    if (resource(potion.potion)) info.potion = potion.potion;
    if (Number.isFinite(potion.custom_color)) info.custom_color = potion.custom_color;
    if (Object.keys(info).length) clean['minecraft:potion_contents'] = info;
  }
  const equip = component('equippable');
  if (resource(equip?.slot) && resource(equip.asset_id)) clean.equippable = { slot: equip.slot, asset_id: equip.asset_id };
  if (Object.keys(clean).length) item.components = clean;
  return item;
}

// Flatten display components to their recorded literal text. Never forward commands,
// selectors, NBT lookups or click/hover actions as part of the published display.
function plainText(value, depth = 0) {
  if (depth > 16) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(v => plainText(v, depth + 1)).join('');
  if (!object(value)) return '';
  return (typeof value.text === 'string' ? value.text : '') + plainText(value.extra, depth + 1);
}

function displayText(value) {
  if (typeof value === 'string' && /^\s*[{"\[]/.test(value)) {
    try { value = JSON.parse(value); } catch { /* Older saves can use plain text. */ }
  }
  return plainText(value).slice(0, 32767);
}

// A mannequin may store the resolved Java skin in a GameProfile. Only the art
// and arm type are part of the scene. Strip profile IDs, signatures and names.
function mannequinSkin(profile) {
  const appearance = profileSkin(profile);
  if (!appearance) return;
  const skin = { url: 'https://textures.minecraft.net/texture/' + appearance.skin };
  if (appearance.model === 'slim') skin.metadata = { model: 'slim' };
  const value = Buffer.from(JSON.stringify({ textures: { SKIN: skin } })).toString('base64');
  return { properties: [{ name: 'textures', value }] };
}

export function entityVisualNbt(nbt, separateActors, depth = 0) {
  if (!object(nbt)) return {};
  const out = hitboxNbt(nbt).nbt ?? {};
  for (const key of numericFields) if (Number.isFinite(nbt[key]) || typeof nbt[key] === 'boolean') out[key] = nbt[key];
  for (const key of variants) if (resource(nbt[key]) || Number.isFinite(nbt[key])) out[key] = nbt[key];
  if (['Owner', 'OwnerUUID', 'owner'].some(key => Object.hasOwn(nbt, key))) out.Owner = true;
  if (nbt.id === 'minecraft:mannequin') {
    const profile = mannequinSkin(nbt.profile);
    if (profile) out.profile = profile;
  }
  const special = displayText(nbt.CustomName ?? nbt.custom_name).replace(/§[0-9a-fk-or]/gi, '');
  if (['Toast', 'jeb_', 'Dinnerbone', 'Grumm'].includes(special)) out.CustomName = special;
  for (const key of ['BlockState', 'block_state', 'DisplayState', 'display_block_state', 'carriedBlockState']) {
    const state = blockState(nbt[key]);
    if (state) out[key] = state;
  }
  for (const key of ['Item', 'item', 'ArmorItem', 'DecorItem', 'SaddleItem', 'body_armor_item', 'FireworksItem']) {
    const item = stack(nbt[key]);
    if (item) out[key] = item;
  }
  // The renderer accepts the old and new names for dropped items and item frames.
  if (out.item && !out.Item && nbt.id?.endsWith('item_frame')) out.Item = out.item;
  for (const [key, length] of [['ArmorItems', 4], ['HandItems', 2]]) {
    if (Array.isArray(nbt[key])) out[key] = nbt[key].slice(0, length).map(v => stack(v) ?? {});
  }
  if (object(nbt.equipment)) {
    const slots = {};
    for (const key of ['head', 'chest', 'legs', 'feet', 'mainhand', 'offhand', 'body', 'saddle']) {
      const item = stack(nbt.equipment[key]);
      if (item) slots[key] = item;
    }
    if (Object.keys(slots).length) out.equipment = slots;
  }
  if (object(nbt.Pose)) {
    const pose = {};
    for (const key of ['Head', 'Body', 'LeftArm', 'RightArm', 'LeftLeg', 'RightLeg']) {
      if (vector(nbt.Pose[key], 3)) pose[key] = nbt.Pose[key];
    }
    if (Object.keys(pose).length) out.Pose = pose;
  }
  if (nbt.id === 'minecraft:painting' && object(nbt.variant)) {
    const { asset_id, width, height } = nbt.variant;
    if (resource(asset_id) && Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0) {
      out.variant = { asset_id, width, height };
    }
  }
  if (nbt.text != null) out.text = displayText(nbt.text);
  const transform = nbt.transformation;
  if (vector(transform, 16)) out.transformation = transform;
  else if (object(transform)) {
    const fields = {};
    for (const [key, length] of [['translation', 3], ['scale', 3], ['left_rotation', 4], ['right_rotation', 4]]) {
      if (vector(transform[key], length)) fields[key] = transform[key];
      else if (key.endsWith('rotation') && vector(transform[key]?.axis, 3) && Number.isFinite(transform[key].angle)) {
        const {axis, angle} = transform[key];
        const length = Math.hypot(...axis);
        if (length) fields[key] = [...axis.map(n => n / length * Math.sin(angle / 2)), Math.cos(angle / 2)];
      }
    }
    if (Object.keys(fields).length) out.transformation = fields;
  }
  const villager = nbt.VillagerData;
  if (object(villager)) {
    out.VillagerData = Object.fromEntries(Object.entries(villager).filter(([k, v]) =>
      (['type', 'profession'].includes(k) && resource(v)) || (k === 'level' && Number.isFinite(v))));
  }
  if (depth < 32 && Array.isArray(nbt.Passengers)) {
    // A passenger also saved as its own actor has an independent movement track.
    const nested = nbt.Passengers.filter(p => resource(p?.id) && !separateActors?.(p)).map(p => {
      const visual = { id: p.id, ...entityVisualNbt(p, separateActors, depth + 1).nbt };
      if (vector(p.Pos, 3)) visual.Pos = p.Pos;
      if (vector(p.Rotation, 2)) visual.Rotation = p.Rotation;
      return visual;
    });
    if (nested.length) {
      out.Passengers = nested;
      if (vector(nbt.Pos, 3)) out.Pos = nbt.Pos;
    }
  }
  return Object.keys(out).length ? { nbt: out } : {};
}
