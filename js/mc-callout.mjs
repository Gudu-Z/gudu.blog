// The current event's card in the 3D view, held close to its target (the
// orange box round its block, or the white hitbox of an entity) the way a
// tooltip is: on the target's right when the card fits there, else its left,
// below or above, slid along that side to stay in the free part of the view
// (inside the margins, clear of the floating timeline and the view's buttons)
// and joined to the target by a short leader. While the view turns, the card
// keeps its side for as long as it still fits there. With no target in view
// it waits under the "3D VIEW" label. While the replay plays, the card steps
// aside and the event's name runs as one line after the label instead.
// Narrow figures keep the details in the timeline panel, under the list.
const svgNS = 'http://www.w3.org/2000/svg';
const wideFrom = 560;
const margin = 22;
const gap = 24;
const sides = ['right', 'left', 'bottom', 'top'];

const clamp = (value, low, high) => Math.max(low, Math.min(Math.max(low, high), value));
const overlap = (a, b) => b ? Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
  * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) : 0;

// A card of cw × ch on one side of the box: `gap` away from it, centred on it
// across, then slid along that side into `area`. `fits` tells whether it
// clears the area's edge on that side.
export function spotBeside(side, box, cw, ch, area) {
  const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
  let left, top, fits;
  if (side === 'right' || side === 'left') {
    left = side === 'right' ? box.right + gap : box.left - gap - cw;
    fits = side === 'right' ? left + cw <= area.right : left >= area.left;
    top = clamp(cy - ch / 2, area.top, area.bottom - ch);
  } else {
    top = side === 'bottom' ? box.bottom + gap : box.top - gap - ch;
    fits = side === 'bottom' ? top + ch <= area.bottom : top >= area.top;
    left = clamp(cx - cw / 2, area.left, area.right - cw);
  }
  return { side, fits, left, top, right: left + cw, bottom: top + ch };
}

// The first side that fits and leaves the controls clear, trying the side in
// use (`keep`) first. If none does (a target filling the view), the side with
// the most room, with the card pushed wholly inside the area.
export function chooseSpot(box, cw, ch, area, controls = [], keep = null) {
  const order = keep ? [keep, ...sides.filter(side => side !== keep)] : sides;
  for (const side of order) {
    const spot = spotBeside(side, box, cw, ch, area);
    if (spot.fits && !controls.some(control => overlap(spot, control))) return spot;
  }
  const room = { right: area.right - box.right, left: box.left - area.left,
    bottom: area.bottom - box.bottom, top: box.top - area.top };
  const side = sides.reduce((best, next) => room[next] > room[best] ? next : best);
  const spot = spotBeside(side, box, cw, ch, area);
  const left = clamp(spot.left, area.left, area.right - cw), top = clamp(spot.top, area.top, area.bottom - ch);
  return { side, fits: false, left, top, right: left + cw, bottom: top + ch };
}

// The parked card and the last-resort spot for a large target can reach
// the axes even though the normal beside-the-target spots clear them.
export function clearAxes(spot, axes, area) {
  if (!overlap(spot, axes)) return spot;
  const width = spot.right - spot.left, height = spot.bottom - spot.top;
  const left = axes.left - width - 4, top = axes.bottom + 4;
  if (left >= area.left && (spot.left - left < top - spot.top || top + height > area.bottom)) {
    return { ...spot, left, right: left + width };
  }
  return { ...spot, top, bottom: top + height };
}

export function mountCallout(stage, details) {
  const home = details.parentNode, homeNext = details.nextSibling;
  const card = document.createElement('div');
  card.className = 'mc-callout';
  const leader = document.createElementNS(svgNS, 'svg');
  leader.classList.add('mc-callout-leader');
  leader.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(svgNS, 'polyline');
  const dot = document.createElementNS(svgNS, 'circle');
  dot.setAttribute('r', '2.5');
  leader.append(line, dot);
  // The event's name after the "3D VIEW" label, while the replay plays.
  const readout = document.createElement('span');
  readout.className = 'mc-stage-readout';
  readout.setAttribute('aria-hidden', 'true');
  readout.hidden = true;
  const title = () => details.querySelector('.mc-event')?.textContent ?? '';
  const watch = new MutationObserver(() => { if (playing) readout.textContent = title(); });
  watch.observe(details, { childList: true, subtree: true, characterData: true });
  let box = null, playing = false, wide = false, side = null, lastLeft = 0, lastTop = 0;

  // The free part of the view: inside the margins, under the label, and left
  // of the timeline where it floats over the view (wide figures).
  function freeArea() {
    let right = stage.clientWidth - margin;
    const panel = stage.parentElement?.querySelector(':scope > .mc-timeline');
    if (panel && getComputedStyle(panel).position === 'absolute') {
      right = Math.min(right, panel.getBoundingClientRect().left - stage.getBoundingClientRect().left - margin);
    }
    return { left: margin, top: margin + 18, right, bottom: stage.clientHeight - margin };
  }
  function controls() {
    return Array.from(stage.querySelectorAll('.mc-view-reset, .mc-controls, .mc-axes'), element => ({
      axes: element.classList.contains('mc-axes'),
      left: element.offsetLeft, top: element.offsetTop, right: element.offsetLeft + element.offsetWidth,
      bottom: element.offsetTop + element.offsetHeight,
    }));
  }

  // The leader leaves the box from its edge nearest the card, steps out a
  // little straight, then runs to the card's nearest edge.
  function leaderPoints(spot) {
    const ccx = (spot.left + spot.right) / 2, ccy = (spot.top + spot.bottom) / 2;
    const bcx = (box.left + box.right) / 2, bcy = (box.top + box.bottom) / 2;
    const horizontal = spot.side === 'right' || spot.side === 'left';
    const anchor = horizontal ? [ccx > bcx ? box.right + 3 : box.left - 3, bcy]
      : [bcx, ccy > bcy ? box.bottom + 3 : box.top - 3];
    const elbow = horizontal ? [anchor[0] + (ccx > bcx ? 10 : -10), anchor[1]]
      : [anchor[0], anchor[1] + (ccy > bcy ? 10 : -10)];
    const reach = [clamp(elbow[0], spot.left, spot.right), clamp(elbow[1], spot.top, spot.bottom)];
    return [anchor, elbow, reach];
  }

  function place() {
    if (!wide) return;
    card.hidden = playing;
    readout.hidden = !playing;
    if (playing) {
      leader.style.display = 'none';
      return;
    }
    const cw = card.offsetWidth, ch = card.offsetHeight, area = freeArea();
    const obstacles = controls(), axes = obstacles.find(rect => rect.axes);
    const preferred = box ? chooseSpot(box, cw, ch, area, obstacles, side)
      : { side: null, left: area.left, top: area.top, right: area.left + cw, bottom: area.top + ch };
    const spot = clearAxes(preferred, axes, area);
    side = spot.side;
    const left = Math.round(spot.left), top = Math.round(spot.top);
    // Turning the view, the card keeps up with its target at once; a jump to
    // another side or another target eases, so the eye can follow it.
    let ease = Math.hypot(left - lastLeft, top - lastTop) > 48;
    if (ease && axes) {
      // Even two clear spots can take the card across the axes as it slides.
      const start = card.getBoundingClientRect(), origin = stage.getBoundingClientRect();
      ease = Math.min(start.top - origin.top, top) >= axes.bottom
        || Math.max(start.right - origin.left, left + cw) <= axes.left;
    }
    card.classList.toggle('is-moving', ease);
    lastLeft = left;
    lastTop = top;
    card.style.transform = `translate(${left}px, ${top}px)`;
    leader.style.display = side ? '' : 'none';
    if (side) {
      const points = leaderPoints(spot);
      line.setAttribute('points', points.map(point => point.map(Math.round).join(',')).join(' '));
      dot.setAttribute('cx', String(Math.round(points[0][0])));
      dot.setAttribute('cy', String(Math.round(points[0][1])));
    }
  }

  function setMode() {
    const next = (stage.parentElement?.clientWidth ?? 0) >= wideFrom;
    if (next === wide) return place();
    wide = next;
    if (wide) {
      card.append(details);
      stage.append(leader, card, readout);
    } else {
      home.insertBefore(details, homeNext?.parentNode === home ? homeNext : null);
      card.remove();
      leader.remove();
      readout.remove();
    }
    place();
  }

  const resize = new ResizeObserver(setMode);
  resize.observe(stage);
  resize.observe(card);
  setMode();

  return {
    // The viewer reports the target's box on every draw, rotation included.
    place(nextBox) {
      box = nextBox;
      place();
    },
    setPlaying(value) {
      if (playing === value) return;
      playing = value;
      if (playing) {
        readout.textContent = title();
        stage.querySelector('.mc-stage-hint')?.classList.remove('is-shown');
      }
      place();
    },
    destroy() {
      resize.disconnect();
      watch.disconnect();
      card.remove();
      leader.remove();
      readout.remove();
    },
  };
}
