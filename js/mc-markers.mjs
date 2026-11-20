// Stand-ins for the blocks the game draws nothing for (js/mc-viewer.mjs).
// - Barrier, light and structure void show as the game shows its marker
//   blocks: the block's particle icon (item/barrier, item/light_00…15 by
//   level, item/structure_void) on a camera-facing quad one block wide at the
//   cell's centre, hidden behind opaque blocks, its clear pixels discarded
//   below alpha 0.1 (vanilla's BlockMarker particle). The game shows them only
//   to a creative player holding the item; the 3D view shows them always,
//   in replays and in static schematics alike.
// - A moving piston (b36) has no look of its own in the game, where its block
//   entity draws the moving block, as the engine does here from the replay's
//   piston data. Its cell gets the 3D view's corner marks in the piston
//   colour, so the reader sees which cell the moving block holds; at a step
//   with no piston data, when nothing moves into view, the marks close into
//   the cell's full outline.
import { BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Sprite, SpriteMaterial }
  from './vendor/mc-engine.mjs';

const icons = { barrier: 'item/barrier', structure_void: 'item/structure_void' };
const maxIcons = 2048;

// The marker blocks and moving pistons among `blocks`, pairs of an "x,y,z"
// key and a palette index: a replay's live block map, or the marker list a
// schematic's parser returns. `pistons` has the keys of moving pistons whose
// block entity is there.
export function markerCells(palette, blocks, pistons) {
  const cells = [];
  for (const [key, state] of blocks) {
    const entry = palette[state];
    const name = entry?.name.replace(/^minecraft:/, '');
    if (!name) continue;
    if (name === 'light') {
      const level = Math.max(0, Math.min(15, Number.parseInt(entry.properties.level ?? '15', 10) || 0));
      cells.push({ key, icon: 'item/light_' + String(level).padStart(2, '0') });
    } else if (Object.hasOwn(icons, name)) cells.push({ key, icon: icons[name] });
    else if (name === 'moving_piston') cells.push({ key, moving: true, carried: Boolean(pistons?.has(key)) });
  }
  return cells;
}

// Line segments for a cell's marks, a hair outside it so they do not fight
// its neighbours' faces: corner brackets a quarter of a block long, or all
// twelve edges.
export function cellLines([x, y, z], whole, arm = .25, pad = .01) {
  const lo = [x - pad, y - pad, z - pad], hi = [x + 1 + pad, y + 1 + pad, z + 1 + pad];
  const points = [];
  for (let corner = 0; corner < 8; corner++) {
    const at = [0, 1, 2].map(axis => corner >> axis & 1 ? hi[axis] : lo[axis]);
    for (let axis = 0; axis < 3; axis++) {
      // Each edge once when whole: from the corner whose bit on that axis is 0.
      if (whole && corner >> axis & 1) continue;
      const to = at.slice();
      const toward = corner >> axis & 1 ? -1 : 1;
      to[axis] += toward * (whole ? hi[axis] - lo[axis] : arm);
      points.push(...at, ...to);
    }
  }
  return points;
}

export function createMarkerLayer(renderer, assets, container) {
  const layer = new Group();
  layer.name = 'mc-markers';
  renderer.scene.add(layer);
  const materials = new Map(), sprites = new Map();
  // A b36 cell usually sits inside the machine. Its marks draw twice, as a
  // CAD view highlights a hidden part: full strength where they are in view,
  // and faint through the blocks in front of them.
  const lineMaterial = new LineBasicMaterial({ transparent: true, opacity: .95, depthWrite: false });
  const ghostMaterial = new LineBasicMaterial({ transparent: true, opacity: .3, depthWrite: false, depthTest: false });
  const lines = new LineSegments(new BufferGeometry(), lineMaterial);
  const ghost = new LineSegments(lines.geometry, ghostMaterial);
  lines.renderOrder = 3;
  ghost.renderOrder = 2;
  layer.add(ghost, lines);
  let wanted = [], destroyed = false;

  // The engine's textures keep flipY off for its own UVs; a sprite reads its
  // map the other way up, so each icon gets a flipped copy.
  function icon(key) {
    if (!materials.has(key)) {
      materials.set(key, Promise.resolve(assets.getTexture(key)).then(texture => {
        if (!texture || destroyed) return null;
        const copy = texture.clone();
        copy.offset.set(0, 1);
        copy.repeat.set(1, -1);
        copy.needsUpdate = true;
        return new SpriteMaterial({ map: copy, transparent: true, alphaTest: .1, depthWrite: true });
      }).catch(() => null));
    }
    return materials.get(key);
  }

  // The piston colour of the page's theme (css/mc-article.css).
  function readColour() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--mc-kind-piston)';
    container.append(probe);
    lineMaterial.color.setStyle(getComputedStyle(probe).color);
    ghostMaterial.color.copy(lineMaterial.color);
    probe.remove();
    renderer.requestRender();
  }
  // Read again a frame later too, in case the page applies its theme after
  // announcing it.
  function setTheme() {
    readColour();
    requestAnimationFrame(() => { if (!destroyed) readColour(); });
  }

  async function sync(cells) {
    wanted = cells;
    const points = [];
    const keep = new Set();
    let shown = 0;
    for (const cell of cells) {
      const pos = cell.key.split(',').map(Number);
      if (cell.moving) {
        points.push(...cellLines(pos, !cell.carried));
        continue;
      }
      // Each icon is a draw of its own; a wall of barriers in a large build
      // shows its first few thousand.
      if (shown++ < maxIcons) keep.add(cell.key + '|' + cell.icon);
    }
    lines.geometry.dispose();
    lines.geometry = ghost.geometry = new BufferGeometry();
    lines.geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
    for (const [id, sprite] of sprites) {
      if (keep.has(id)) continue;
      layer.remove(sprite);
      sprites.delete(id);
    }
    renderer.requestRender();
    await Promise.all(cells.filter(cell => keep.has(cell.key + '|' + cell.icon) && !sprites.has(cell.key + '|' + cell.icon)).map(async cell => {
      const material = await icon(cell.icon);
      const id = cell.key + '|' + cell.icon;
      // A later sync may have dropped the cell while its icon loaded.
      if (!material || destroyed || wanted !== cells || sprites.has(id)) return;
      const sprite = new Sprite(material);
      const [x, y, z] = cell.key.split(',').map(Number);
      sprite.position.set(x + .5, y + .5, z + .5);
      sprites.set(id, sprite);
      layer.add(sprite);
    }));
    renderer.requestRender();
  }

  function destroy() {
    destroyed = true;
    layer.removeFromParent();
    lines.geometry.dispose();
    lineMaterial.dispose();
    ghostMaterial.dispose();
    for (const request of materials.values()) {
      request.then(material => {
        material?.map.dispose();
        material?.dispose();
      });
    }
  }

  setTheme();
  return { sync, setTheme, destroy };
}
