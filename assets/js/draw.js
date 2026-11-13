/**
 * How a play is drawn: tokens, arrows, labels and the arrow geometry behind
 * them.
 *
 * Shared by the play builder, the printout and the Scouting page, so a play
 * looks the same everywhere it appears. Nothing here knows about the editor:
 * what is selected, and which player stands in which slot, are passed in by
 * whoever is drawing.
 */

import { SVG_NS } from './court.js';
import { pointAt } from './library.js';
import { shortName } from './model.js';
import { tokenGlyph } from './lineup.js';

export const TOKEN_R = 1.25;

/* ------------------------------------------------------------------ */
/* SVG helpers                                                         */
/* ------------------------------------------------------------------ */

export function node(name, attrs = {}) {
  const n = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

export function textNode(str, attrs = {}) {
  const t = node('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', ...attrs });
  t.textContent = str;
  return t;
}

/* ------------------------------------------------------------------ */
/* Arrow geometry                                                      */
/* ------------------------------------------------------------------ */

export function tangentAt(a, t) {
  if (!a.ctrl) return { x: a.to.x - a.from.x, y: a.to.y - a.from.y };
  const m = 1 - t;
  return {
    x: 2 * m * (a.ctrl.x - a.from.x) + 2 * t * (a.to.x - a.ctrl.x),
    y: 2 * m * (a.ctrl.y - a.from.y) + 2 * t * (a.to.y - a.ctrl.y),
  };
}

export function unitNormal(a, t) {
  const g = tangentAt(a, t);
  const m = Math.hypot(g.x, g.y) || 1;
  return { x: -g.y / m, y: g.x / m };
}

export function pathD(a) {
  if (a.ctrl) return `M ${a.from.x} ${a.from.y} Q ${a.ctrl.x} ${a.ctrl.y} ${a.to.x} ${a.to.y}`;
  return `M ${a.from.x} ${a.from.y} L ${a.to.x} ${a.to.y}`;
}

export function arrowLength(a) {
  let len = 0;
  let prev = pointAt(a, 0);
  for (let i = 1; i <= 24; i++) {
    const p = pointAt(a, i / 24);
    len += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return len;
}

/**
 * A dribble is drawn as a wave along the path. The amplitude tapers to zero at
 * both ends so it meets the player cleanly and the arrowhead points true.
 */
export function dribbleD(a) {
  const steps = 72;
  const waves = Math.max(2, Math.round(arrowLength(a) / 1.7));
  const amp = 0.42;
  const pts = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = pointAt(a, t);
    const n = unitNormal(a, t);
    const taper = Math.sin(Math.PI * t);
    const off = Math.sin(t * waves * Math.PI * 2) * amp * taper;
    pts.push(`${(p.x + n.x * off).toFixed(3)} ${(p.y + n.y * off).toFixed(3)}`);
  }
  return 'M ' + pts.join(' L ');
}

/** The bar at the end of a screen, perpendicular to the approach. */
export function screenBarD(a) {
  const n = unitNormal(a, 1);
  const L = 1.15;
  return `M ${a.to.x - n.x * L} ${a.to.y - n.y * L} L ${a.to.x + n.x * L} ${a.to.y + n.y * L}`;
}

export const midpoint = (a) => a.ctrl || pointAt(a, 0.5);

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Arrowhead markers. `id` must be unique in the document: `url(#ah)` resolves
 * to the first element with that id, wherever it is.
 */
export function defs(id = 'ah') {
  const d = node('defs');
  for (const [mid, cls] of [[id, 'ah'], [`${id}-ghost`, 'ah ghost']]) {
    const m = node('marker', {
      id: mid,
      viewBox: '0 0 10 10',
      refX: 8.5,
      refY: 5,
      markerWidth: 5,
      markerHeight: 5,
      markerUnits: 'strokeWidth',
      orient: 'auto-start-reverse',
    });
    m.append(node('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: cls }));
    d.append(m);
  }
  return d;
}

/**
 * The renderers, bound to whoever is drawing.
 *
 * @param {Object} [opts]
 * @param {(type: string, id: string) => boolean} [opts.isSelected]
 *   which item the editor has selected; nothing, when only looking
 * @param {(label: string) => Object|null} [opts.playerFor]
 *   the roster player standing in an offensive slot, for the name under the
 *   token. Nothing, for a play that isn't ours — an opponent's 1 is not our 1.
 * @param {'full'|'jersey'|'initials'} [opts.nameDisplay]
 */
export function createDrawer({ isSelected = () => false, playerFor = () => null, nameDisplay = 'full' } = {}) {
  function renderToken(t, ghost = false, still = false) {
    const g = node('g', {
      class: `token ${t.kind}${ghost ? ' ghost' : ''}${!still && isSelected('token', t.id) ? ' selected' : ''}${still ? ' anim' : ''}`,
      transform: `translate(${t.x} ${t.y})`,
    });
    if (!ghost && !still) g.setAttribute('data-id', t.id);

    if (t.kind === 'offense') {
      const player = playerFor(t.label);
      g.append(node('circle', { r: TOKEN_R, class: 'tok-body' }));
      g.append(textNode(tokenGlyph(player, t.label), {
        class: 'tok-label',
        'font-size': player && tokenGlyph(player, t.label).length > 2 ? 1.15 : 1.55,
      }));
      // The name goes under the token, and only when names are what we're
      // showing — with jersey or initials mode the glyph already says it all.
      if (player && nameDisplay === 'full') {
        g.append(textNode(shortName(player, 'full'), {
          class: 'tok-name', y: TOKEN_R + 1.05, 'font-size': 1.0,
        }));
      }
    } else if (t.kind === 'defense') {
      g.append(node('circle', { r: TOKEN_R, class: 'tok-hit' }));
      g.append(node('path', { d: 'M -0.95 -0.95 L 0.95 0.95 M 0.95 -0.95 L -0.95 0.95', class: 'tok-x' }));
      if (t.label) g.append(textNode(t.label, { class: 'tok-sub', x: 1.5, y: -1.1, 'font-size': 1.1 }));
    } else if (t.kind === 'ball') {
      g.append(node('circle', { r: 0.62, class: 'tok-ball' }));
    } else if (t.kind === 'cone') {
      g.append(node('path', { d: 'M 0 -1.15 L 1.05 0.85 L -1.05 0.85 Z', class: 'tok-cone' }));
    } else if (t.kind === 'coach') {
      g.append(node('rect', { x: -1.15, y: -1.15, width: 2.3, height: 2.3, rx: 0.35, class: 'tok-body' }));
      g.append(textNode('C', { class: 'tok-label', 'font-size': 1.4 }));
    }

    if (t.hasBall && t.kind !== 'ball') {
      g.append(node('circle', { cx: 1.5, cy: -1.2, r: 0.52, class: 'tok-ball' }));
    }
    return g;
  }

  function renderArrow(a, ghost = false, markerId = 'ah') {
    const g = node('g', {
      class: `arrow ${a.kind}${ghost ? ' ghost' : ''}${isSelected('arrow', a.id) ? ' selected' : ''}`,
    });
    if (!ghost) g.setAttribute('data-id', a.id);

    const marker = `url(#${markerId}${ghost ? '-ghost' : ''})`;

    if (a.kind === 'dribble') {
      g.append(node('path', { d: dribbleD(a), class: 'stroke', 'marker-end': marker }));
    } else if (a.kind === 'screen') {
      g.append(node('path', { d: pathD(a), class: 'stroke' }));
      g.append(node('path', { d: screenBarD(a), class: 'stroke bar' }));
    } else {
      g.append(node('path', { d: pathD(a), class: 'stroke', 'marker-end': marker }));
    }

    // A wide invisible path makes a thin arrow easy to hit, on a mouse or a thumb.
    if (!ghost) g.append(node('path', { d: pathD(a), class: 'hit' }));
    return g;
  }

  function renderText(t, ghost = false) {
    const g = node('g', {
      class: `note${ghost ? ' ghost' : ''}${isSelected('text', t.id) ? ' selected' : ''}`,
      transform: `translate(${t.x} ${t.y})`,
    });
    if (!ghost) g.setAttribute('data-id', t.id);
    g.append(textNode(t.text, { class: 'note-text', 'font-size': 1.15 }));
    return g;
  }

  return { defs, renderToken, renderArrow, renderText };
}
