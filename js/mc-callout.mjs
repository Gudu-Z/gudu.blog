// The current event's card in the 3D view, standing beside the orange box
// round its block and joined to it by a leader line. Of the places beside the
// box and in the view's corners, it takes the one that hides least of the
// recording, then the nearest. With no block in view, and while the replay
// plays (the focus then moves faster than a card can follow), it rests in the
// view's lower-left corner. Narrow figures keep the details in the timeline
// panel, under the list.
const svgNS = 'http://www.w3.org/2000/svg';
const wideFrom = 560;
const margin = 22;
const gap = 36;

const clamp = (value, low, high) => Math.max(low, Math.min(Math.max(low, high), value));
const overlap = (a, b) => b ? Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
  * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) : 0;

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
  let box = null, model = null, playing = false, wide = false;

  function candidates(width, height, cw, ch) {
    const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
    const midTop = clamp(cy - ch / 2, margin, height - ch - margin);
    const midLeft = clamp(cx - cw / 2, margin, width - cw - margin);
    return [
      [box.right + gap, midTop], [box.left - gap - cw, midTop],
      [midLeft, box.top - gap - ch], [midLeft, box.bottom + gap],
      // The top corners sit under the view's "3D VIEW" label.
      [margin, margin + 18], [width - cw - margin, margin + 18],
      [margin, height - ch - margin], [width - cw - margin, height - ch - margin],
    ].filter(([left, top]) => left >= margin - 0.5 && top >= margin - 0.5
      && left + cw <= width - margin + 0.5 && top + ch <= height - margin + 0.5)
      .map(([left, top]) => ({ left, top, right: left + cw, bottom: top + ch }));
  }

  function choose(width, height, cw, ch) {
    const reset = stage.querySelector('.mc-view-reset');
    const button = reset && !reset.hidden ? { left: reset.offsetLeft, top: reset.offsetTop,
      right: reset.offsetLeft + reset.offsetWidth, bottom: reset.offsetTop + reset.offsetHeight } : null;
    const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
    let best = null, bestScore = Infinity;
    for (const spot of candidates(width, height, cw, ch)) {
      const distance = Math.hypot((spot.left + spot.right) / 2 - cx, (spot.top + spot.bottom) / 2 - cy);
      const score = overlap(spot, box) * 50 + overlap(spot, button) * 50 + overlap(spot, model) * 2 + distance;
      if (score < bestScore) { best = spot; bestScore = score; }
    }
    return best;
  }

  // The leader leaves the box from its edge nearest the card, steps out a
  // little straight, then runs to the card's nearest edge.
  function leaderPoints(spot) {
    const ccx = (spot.left + spot.right) / 2, ccy = (spot.top + spot.bottom) / 2;
    const bcx = (box.left + box.right) / 2, bcy = (box.top + box.bottom) / 2;
    const horizontal = Math.abs(ccx - bcx) / (spot.right - spot.left + box.right - box.left)
      >= Math.abs(ccy - bcy) / (spot.bottom - spot.top + box.bottom - box.top);
    const anchor = horizontal ? [ccx > bcx ? box.right + 3 : box.left - 3, bcy]
      : [bcx, ccy > bcy ? box.bottom + 3 : box.top - 3];
    const elbow = horizontal ? [anchor[0] + (ccx > bcx ? 12 : -12), anchor[1]]
      : [anchor[0], anchor[1] + (ccy > bcy ? 12 : -12)];
    const reach = [clamp(elbow[0], spot.left, spot.right), clamp(elbow[1], spot.top, spot.bottom)];
    return [anchor, elbow, reach];
  }

  function place() {
    if (!wide) return;
    const width = stage.clientWidth, height = stage.clientHeight;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const spot = !playing && box ? choose(width, height, cw, ch) : null;
    const left = spot ? spot.left : margin, top = spot ? spot.top : height - ch - margin;
    // Docked, the card follows its own height at once: easing the move would
    // leave a taller event's card hanging below the view for a moment.
    card.classList.toggle('is-docked', !spot);
    card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    leader.style.display = spot ? '' : 'none';
    if (spot) {
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
      stage.append(leader, card);
    } else {
      home.insertBefore(details, homeNext?.parentNode === home ? homeNext : null);
      card.remove();
      leader.remove();
    }
    place();
  }

  const resize = new ResizeObserver(setMode);
  resize.observe(stage);
  resize.observe(card);
  setMode();

  return {
    // The viewer reports the focus box (and the recording's box) on every
    // draw, rotation included.
    place(nextBox, nextModel) {
      box = nextBox;
      model = nextModel ?? null;
      place();
    },
    setPlaying(value) {
      if (playing === value) return;
      playing = value;
      place();
    },
    destroy() {
      resize.disconnect();
      card.remove();
      leader.remove();
    },
  };
}
