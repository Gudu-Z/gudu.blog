// Keep only values used for debug hitbox dimensions, eye height and visibility.
// In particular, item contents, owners, profiles and attribute modifier IDs are private.
export function hitboxNbt(nbt) {
  if (!nbt) return {};
  const out = {};
  const setNumber = (key, ...values) => {
    const value = values.find(Number.isFinite);
    if (value !== undefined) out[key] = value;
  };
  const setFlag = (key, ...values) => {
    if (values.some(value => value === true || value === 1)) out[key] = 1;
  };
  setNumber('Age', nbt.Age, nbt.age);
  setFlag('IsBaby', nbt.IsBaby, nbt.is_baby);
  setFlag('Small', nbt.Small, nbt.small);
  setFlag('Marker', nbt.Marker, nbt.marker);
  setFlag('Invisible', nbt.Invisible, nbt.invisible);
  setFlag('Sitting', nbt.Sitting, nbt.sitting);
  setNumber('LastPoseTick', nbt.LastPoseTick, nbt.last_pose_tick);
  setNumber('Size', nbt.Size, nbt.size);
  setNumber('PuffState', nbt.PuffState, nbt.puff_state);
  setNumber('DragonPhase', nbt.DragonPhase, nbt.dragon_phase);
  setNumber('Peek', nbt.Peek, nbt.peek);
  const directions = ['down', 'up', 'north', 'south', 'west', 'east'];
  for (const [key, field] of [['Facing', nbt.Facing ?? nbt.facing], ['AttachFace', nbt.AttachFace ?? nbt.attach_face]]) {
    const value = typeof field === 'string' ? directions.indexOf(field) : field;
    if (Number.isInteger(value) && value >= 0 && value <= 5) out[key] = value;
  }
  const rawPose = nbt.Pose ?? nbt.pose;
  if (typeof rawPose === 'string') {
    const pose = rawPose.toLowerCase().replace(/^minecraft:/, '');
    if (['standing', 'crouching', 'swimming', 'fall_flying', 'spin_attack', 'sleeping', 'dying',
      'sitting', 'digging', 'emerging'].includes(pose)) out.Pose = pose;
  }
  if (nbt.sleeping_pos != null || Number.isFinite(nbt.SleepingX)) out.Pose = 'sleeping';
  if (nbt.id === 'minecraft:salmon') {
    const size = String(nbt.type ?? nbt.Type ?? '').replace(/^minecraft:/, '');
    if (['small', 'medium', 'large'].includes(size)) out.type = size;
  }
  if (['minecraft:item_frame', 'minecraft:glow_item_frame'].includes(nbt.id) &&
      (nbt.Item ?? nbt.item)?.id === 'minecraft:filled_map') out.Item = { id: 'minecraft:filled_map' };

  const attributes = nbt.attributes ?? nbt.Attributes;
  const scale = Array.isArray(attributes) && attributes.find(a =>
    ['scale', 'generic.scale'].includes(String(a?.id ?? a?.Name).replace(/^minecraft:/, '')));
  if (scale) {
    const attr = { id: 'minecraft:scale', base: Number.isFinite(scale.base ?? scale.Base) ? (scale.base ?? scale.Base) : 1 };
    const modifiers = scale.modifiers ?? scale.Modifiers;
    if (Array.isArray(modifiers)) {
      const clean = [];
      for (const m of modifiers) {
        const op = m.operation ?? m.type ?? m.Operation;
        const kind = ['add_value', 'add_multiplied_base', 'add_multiplied_total'];
        const type = typeof op === 'number' ? kind[op] : op;
        const amount = m.amount ?? m.Amount;
        if (kind.includes(type) && Number.isFinite(amount)) clean.push({ type, amount });
      }
      if (clean.length) attr.modifiers = clean;
    }
    out.attributes = [attr];
  }
  return Object.keys(out).length ? { nbt: out } : {};
}
