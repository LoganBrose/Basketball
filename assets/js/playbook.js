/**
 * Play diagram editor.
 *
 * The court is an SVG whose user units are feet, so a token's x/y in the saved
 * JSON is a real position on a real floor — which is what keeps a play editable
 * years later instead of being a picture of a play.
 */

import {
  SVG_NS, COURT_PRESETS, courtSize, renderCourt,
} from './court.js';
import {
  newPlay, emptyFrame, uid, listPlays, savePlay, deletePlay, duplicatePlay,
  searchPlays, allCategories, allTags, parseImport, importPlays,
  exportPlay, exportLibrary, slugify, loadTeamPlaybook, normalizePlay,
} from './library.js';
import { CONFIG } from './config.js';
import { loadAll } from './data.js';
import { isEnabled, readSession, sessionValid, siteMaxAge } from './gate.js';
import {
  usingScript, canPublish, fetchTeamPlays, saveTeamPlay, deleteTeamPlay,
  playsToMigrate, readFilePlays, migrateFilePlays,
} from './teamplays.js';
import { shortName } from './model.js';
import { printPlay, printPlaybook } from './printout.js';
import {
  publishPlan, markPublished, fileUrl, minify, slugify as pubSlug,
} from './publish.js';
import {
  DEFAULT_PLAYBOOK, slugifyPlaybook, readLocalPlaybooks, addLocalPlaybook,
  mergePlaybooks, playbookOf, findSlugConflict, playbookExistsOnSite,
} from './playbooks.js';
import {
  SLOTS, readLineup, writeLineup, pruneLineup, availableFor, playerInSlot,
  assignSlot, tokenGlyph,
} from './lineup.js';

const $ = (s) => document.querySelector(s);
const svg = $('#court');

const SNAP = 0.5; // feet
const TOKEN_R = 1.25;

const S = {
  play: newPlay(),
  frame: 0,
  tool: 'select',
  selection: null, // { type, id }
  drag: null,
  draft: null, // arrow being drawn
  undo: [],
  redo: [],
  ghost: true,
  team: [],
  teamPlaybooks: [],
  teamError: null,
  playbooks: [],
  lib: { q: '', category: '', tag: '', playbook: '' },
  saveTimer: null,
  // Who is standing in each offensive slot. Display only — never saved into a
  // play, so any play can be opened with any lineup.
  lineup: {},
  roster: [],
  rosterError: null,
};

/** Where each player starts when you add them, so a set takes seconds to lay out. */
const SPOTS = {
  offense: { 1: [25, 27], 2: [42, 21], 3: [8, 21], 4: [34, 11], 5: [16, 11] },
  defense: { 1: [25, 23.5], 2: [39, 19], 3: [11, 19], 4: [32, 9.5], 5: [18, 9.5] },
  ball: [25, 30],
  cone: [25, 16],
  coach: [4, 43],
};

const HINTS = {
  select: 'Drag players to move them. Click an arrow to select it, then drag its ends — or its middle handle to curve it.',
  cut: 'Drag from where the player starts to where they finish. Solid arrow = a cut.',
  pass: 'Drag from the passer to the receiver. Dashed arrow = a pass.',
  dribble: 'Drag along the path the ball-handler takes. Squiggle = a dribble.',
  screen: 'Drag to where the screen is set. The bar shows which way the screener faces.',
  text: 'Click anywhere on the floor to drop a label.',
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function node(name, attrs = {}) {
  const n = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

function textNode(str, attrs = {}) {
  const t = node('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', ...attrs });
  t.textContent = str;
  return t;
}

const frame = () => S.play.frames[S.frame];
const snap = (v) => Math.round(v / SNAP) * SNAP;

function clampToCourt(p) {
  const { w, h } = courtSize(S.play.courtType);
  return { x: Math.min(Math.max(p.x, 0.6), w - 0.6), y: Math.min(Math.max(p.y, 0.6), h - 0.6) };
}

/** Screen coordinates -> court feet. */
function toCourt(evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

/* ------------------------------------------------------------------ */
/* Arrow geometry                                                      */
/* ------------------------------------------------------------------ */

function pointAt(a, t) {
  if (!a.ctrl) {
    return { x: a.from.x + (a.to.x - a.from.x) * t, y: a.from.y + (a.to.y - a.from.y) * t };
  }
  const m = 1 - t;
  return {
    x: m * m * a.from.x + 2 * m * t * a.ctrl.x + t * t * a.to.x,
    y: m * m * a.from.y + 2 * m * t * a.ctrl.y + t * t * a.to.y,
  };
}

function tangentAt(a, t) {
  if (!a.ctrl) return { x: a.to.x - a.from.x, y: a.to.y - a.from.y };
  const m = 1 - t;
  return {
    x: 2 * m * (a.ctrl.x - a.from.x) + 2 * t * (a.to.x - a.ctrl.x),
    y: 2 * m * (a.ctrl.y - a.from.y) + 2 * t * (a.to.y - a.ctrl.y),
  };
}

function unitNormal(a, t) {
  const g = tangentAt(a, t);
  const m = Math.hypot(g.x, g.y) || 1;
  return { x: -g.y / m, y: g.x / m };
}

function pathD(a) {
  if (a.ctrl) return `M ${a.from.x} ${a.from.y} Q ${a.ctrl.x} ${a.ctrl.y} ${a.to.x} ${a.to.y}`;
  return `M ${a.from.x} ${a.from.y} L ${a.to.x} ${a.to.y}`;
}

function arrowLength(a) {
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
function dribbleD(a) {
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
function screenBarD(a) {
  const n = unitNormal(a, 1);
  const L = 1.15;
  return `M ${a.to.x - n.x * L} ${a.to.y - n.y * L} L ${a.to.x + n.x * L} ${a.to.y + n.y * L}`;
}

const midpoint = (a) => a.ctrl || pointAt(a, 0.5);

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function defs() {
  const d = node('defs');
  for (const [id, cls] of [['ah', 'ah'], ['ah-ghost', 'ah ghost']]) {
    const m = node('marker', {
      id,
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

function renderToken(t, ghost = false) {
  const g = node('g', {
    class: `token ${t.kind}${ghost ? ' ghost' : ''}${isSelected('token', t.id) ? ' selected' : ''}`,
    transform: `translate(${t.x} ${t.y})`,
  });
  if (!ghost) g.setAttribute('data-id', t.id);

  if (t.kind === 'offense') {
    const player = playerInSlot(t.label, S.lineup, S.roster);
    g.append(node('circle', { r: TOKEN_R, class: 'tok-body' }));
    g.append(textNode(tokenGlyph(player, t.label), {
      class: 'tok-label',
      'font-size': player && tokenGlyph(player, t.label).length > 2 ? 1.15 : 1.55,
    }));
    // The name goes under the token, and only when names are what we're
    // showing — with jersey or initials mode the glyph already says it all.
    if (player && CONFIG.nameDisplay === 'full') {
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

function renderArrow(a, ghost = false) {
  const g = node('g', {
    class: `arrow ${a.kind}${ghost ? ' ghost' : ''}${isSelected('arrow', a.id) ? ' selected' : ''}`,
  });
  if (!ghost) g.setAttribute('data-id', a.id);

  const marker = ghost ? 'url(#ah-ghost)' : 'url(#ah)';

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

function renderHandles(layer) {
  if (!S.selection || S.selection.type !== 'arrow') return;
  const a = frame().arrows.find((x) => x.id === S.selection.id);
  if (!a) return;

  const mid = midpoint(a);
  for (const [role, p] of [['from', a.from], ['ctrl', mid], ['to', a.to]]) {
    const h = node('circle', {
      cx: p.x, cy: p.y, r: role === 'ctrl' ? 0.6 : 0.7,
      class: `handle ${role}`,
      'data-handle': role,
      'data-arrow': a.id,
    });
    layer.append(h);
  }
}

const isSelected = (type, id) => S.selection?.type === type && S.selection.id === id;

function render() {
  const { w, h } = courtSize(S.play.courtType);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.style.aspectRatio = `${w} / ${h}`;
  svg.replaceChildren();
  svg.append(defs());

  renderCourt(svg, { type: S.play.courtType, preset: S.play.preset });

  const content = node('g', { class: 'content' });

  // The previous step, faded, so you can see what moved.
  if (S.ghost && S.frame > 0) {
    const prev = S.play.frames[S.frame - 1];
    const gl = node('g', { class: 'ghost-layer' });
    for (const a of prev.arrows) gl.append(renderArrow(a, true));
    for (const t of prev.tokens) gl.append(renderToken(t, true));
    content.append(gl);
  }

  const f = frame();
  for (const a of f.arrows) content.append(renderArrow(a));
  if (S.draft) content.append(renderArrow(S.draft, false));
  for (const t of f.tokens) content.append(renderToken(t));
  for (const t of f.texts) content.append(renderText(t));

  renderHandles(content);
  svg.append(content);

  renderFrames();
  $('#pb-hint').textContent = HINTS[S.tool] || '';
  $('#pb-undo').disabled = S.undo.length === 0;
  $('#pb-redo').disabled = S.redo.length === 0;
  $('#pb-delete').disabled = !S.selection;
}

/* ------------------------------------------------------------------ */
/* Mutation + undo                                                     */
/* ------------------------------------------------------------------ */

function pushUndo() {
  S.undo.push(JSON.stringify(S.play.frames));
  if (S.undo.length > 60) S.undo.shift();
  S.redo.length = 0;
}

function restore(stack, other) {
  if (stack.length === 0) return;
  other.push(JSON.stringify(S.play.frames));
  S.play.frames = JSON.parse(stack.pop());
  if (S.frame >= S.play.frames.length) S.frame = S.play.frames.length - 1;
  S.selection = null;
  render();
  scheduleSave();
}

/** Autosave: work should survive a closed tab without anyone remembering to save. */
function scheduleSave() {
  setSaveState('saving');
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(() => {
    const saved = savePlay(S.play);
    setSaveState(saved ? 'saved' : 'error');
    renderLibrary();
    refreshPublish();
  }, 350);
}

function setSaveState(kind) {
  const pill = $('#save-state');
  pill.className = 'pill' + (kind === 'error' ? ' warn' : kind === 'saved' ? ' ok' : '');
  pill.textContent = kind === 'saved' ? 'Saved' : kind === 'saving' ? 'Saving…' : 'Not saved';
}

/* ------------------------------------------------------------------ */
/* Adding things                                                       */
/* ------------------------------------------------------------------ */

function freeSpot(base) {
  let [x, y] = base;
  const taken = () => frame().tokens.some((t) => Math.hypot(t.x - x, t.y - y) < 1.6);
  let guard = 0;
  while (taken() && guard++ < 40) {
    x += 1.8;
    y += 1.2;
  }
  return clampToCourt({ x, y });
}

function addToken(kind, label) {
  pushUndo();
  const base = kind === 'offense' || kind === 'defense'
    ? (SPOTS[kind][label] || [25, 24])
    : SPOTS[kind];
  const p = freeSpot(base);
  const token = {
    id: uid(),
    kind,
    label: kind === 'defense' ? String(label) : (label == null ? '' : String(label)),
    x: snap(p.x),
    y: snap(p.y),
    hasBall: false,
  };
  frame().tokens.push(token);
  S.selection = { type: 'token', id: token.id };
  render();
  scheduleSave();
}

function addText(p) {
  const value = prompt('Label text');
  if (!value) return;
  pushUndo();
  const t = { id: uid(), x: snap(p.x), y: snap(p.y), text: value };
  frame().texts.push(t);
  S.selection = { type: 'text', id: t.id };
  setTool('select');
  render();
  scheduleSave();
}

function deleteSelection() {
  if (!S.selection) return;
  pushUndo();
  const f = frame();
  const { type, id } = S.selection;
  if (type === 'token') f.tokens = f.tokens.filter((t) => t.id !== id);
  if (type === 'arrow') f.arrows = f.arrows.filter((a) => a.id !== id);
  if (type === 'text') f.texts = f.texts.filter((t) => t.id !== id);
  S.selection = null;
  render();
  scheduleSave();
}

/* ------------------------------------------------------------------ */
/* Pointer interaction                                                 */
/* ------------------------------------------------------------------ */

function findItem(id) {
  const f = frame();
  const token = f.tokens.find((t) => t.id === id);
  if (token) return { type: 'token', item: token };
  const arrow = f.arrows.find((a) => a.id === id);
  if (arrow) return { type: 'arrow', item: arrow };
  const text = f.texts.find((t) => t.id === id);
  if (text) return { type: 'text', item: text };
  return null;
}

function onPointerDown(e) {
  if (e.button != null && e.button !== 0) return;
  const p = toCourt(e);

  if (S.tool === 'text') {
    addText(p);
    return;
  }

  if (S.tool !== 'select') {
    pushUndo();
    S.draft = {
      id: uid(),
      kind: S.tool,
      from: { x: snap(p.x), y: snap(p.y) },
      to: { x: snap(p.x), y: snap(p.y) },
      ctrl: null,
    };
    S.drag = { mode: 'draw' };
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }

  const handle = e.target.closest('[data-handle]');
  if (handle) {
    const a = frame().arrows.find((x) => x.id === handle.dataset.arrow);
    if (a) {
      pushUndo();
      S.drag = { mode: 'handle', role: handle.dataset.handle, arrow: a };
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
    return;
  }

  const hit = e.target.closest('[data-id]');
  if (!hit) {
    S.selection = null;
    render();
    return;
  }

  const found = findItem(hit.dataset.id);
  if (!found) return;

  S.selection = { type: found.type, id: hit.dataset.id };
  pushUndo();
  S.drag = {
    mode: 'move',
    type: found.type,
    item: found.item,
    grab: p,
    origin: found.type === 'arrow'
      ? { from: { ...found.item.from }, to: { ...found.item.to }, ctrl: found.item.ctrl ? { ...found.item.ctrl } : null }
      : { x: found.item.x, y: found.item.y },
  };
  svg.setPointerCapture(e.pointerId);
  render();
  e.preventDefault();
}

function onPointerMove(e) {
  if (!S.drag) return;
  const p = toCourt(e);

  if (S.drag.mode === 'draw') {
    const q = clampToCourt(p);
    S.draft.to = { x: snap(q.x), y: snap(q.y) };
    render();
    return;
  }

  if (S.drag.mode === 'handle') {
    const q = clampToCourt(p);
    const a = S.drag.arrow;
    const v = { x: snap(q.x), y: snap(q.y) };
    if (S.drag.role === 'from') a.from = v;
    else if (S.drag.role === 'to') a.to = v;
    else a.ctrl = v;
    render();
    return;
  }

  if (S.drag.mode === 'move') {
    const dx = p.x - S.drag.grab.x;
    const dy = p.y - S.drag.grab.y;

    if (S.drag.type === 'arrow') {
      const o = S.drag.origin;
      const a = S.drag.item;
      a.from = { x: snap(o.from.x + dx), y: snap(o.from.y + dy) };
      a.to = { x: snap(o.to.x + dx), y: snap(o.to.y + dy) };
      if (o.ctrl) a.ctrl = { x: snap(o.ctrl.x + dx), y: snap(o.ctrl.y + dy) };
    } else {
      const q = clampToCourt({ x: S.drag.origin.x + dx, y: S.drag.origin.y + dy });
      S.drag.item.x = snap(q.x);
      S.drag.item.y = snap(q.y);
    }
    render();
  }
}

function onPointerUp(e) {
  if (!S.drag) return;
  try { svg.releasePointerCapture(e.pointerId); } catch { /* already released */ }

  if (S.drag.mode === 'draw') {
    const a = S.draft;
    S.draft = null;
    S.drag = null;
    // A tap without a drag isn't an arrow; drop it and undo the snapshot.
    if (Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y) < 1.2) {
      S.undo.pop();
      render();
      return;
    }
    frame().arrows.push(a);
    S.selection = { type: 'arrow', id: a.id };
    setTool('select');
    render();
    scheduleSave();
    return;
  }

  S.drag = null;
  render();
  scheduleSave();
}

function onDoubleClick(e) {
  const hit = e.target.closest('[data-id]');
  if (!hit) return;
  const found = findItem(hit.dataset.id);
  if (!found) return;

  if (found.type === 'token' && (found.item.kind === 'offense' || found.item.kind === 'defense')) {
    const value = prompt('Label', found.item.label);
    if (value == null) return;
    pushUndo();
    found.item.label = value;
  } else if (found.type === 'text') {
    const value = prompt('Label text', found.item.text);
    if (value == null) return;
    pushUndo();
    found.item.text = value;
  } else {
    return;
  }
  render();
  scheduleSave();
}

/* ------------------------------------------------------------------ */
/* Tools + frames                                                      */
/* ------------------------------------------------------------------ */

function setTool(tool) {
  S.tool = tool;
  for (const b of document.querySelectorAll('[data-tool]')) {
    b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  }
  svg.classList.toggle('drawing', tool !== 'select' && tool !== 'text');
  svg.classList.toggle('placing', tool === 'text');
  $('#pb-hint').textContent = HINTS[tool] || '';
}

function renderFrames() {
  const strip = $('#frame-chips');
  strip.replaceChildren();

  S.play.frames.forEach((f, i) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'frame-chip' + (i === S.frame ? ' active' : '');
    chip.textContent = f.label || `Step ${i + 1}`;
    chip.title = 'Double-click to rename';
    chip.addEventListener('click', () => {
      S.frame = i;
      S.selection = null;
      render();
    });
    chip.addEventListener('dblclick', () => {
      const value = prompt('Step name', f.label);
      if (value == null) return;
      pushUndo();
      f.label = value;
      render();
      scheduleSave();
    });
    strip.append(chip);
  });

  $('#fr-prev').disabled = S.frame === 0;
  $('#fr-next').disabled = S.frame >= S.play.frames.length - 1;
  $('#fr-del').disabled = S.play.frames.length <= 1;
}

function addFrame(carryOver) {
  pushUndo();
  const label = `Action ${S.play.frames.length}`;
  const next = emptyFrame(label);

  if (carryOver) {
    // Continue: players stay where they finished, arrows start clean.
    next.tokens = structuredClone(frame().tokens).map((t) => ({ ...t, id: uid() }));
  }

  S.play.frames.splice(S.frame + 1, 0, next);
  S.frame += 1;
  S.selection = null;
  render();
  scheduleSave();
}

function deleteFrame() {
  if (S.play.frames.length <= 1) return;
  pushUndo();
  S.play.frames.splice(S.frame, 1);
  if (S.frame >= S.play.frames.length) S.frame = S.play.frames.length - 1;
  S.selection = null;
  render();
  scheduleSave();
}

/* ------------------------------------------------------------------ */
/* Lineup                                                              */
/* ------------------------------------------------------------------ */

function renderLineup() {
  const wrap = $('#lineup-slots');
  const note = $('#lineup-note');
  wrap.replaceChildren();

  const disabled = S.roster.length === 0;

  for (const slot of SLOTS) {
    const field = document.createElement('label');
    field.className = 'lineup-slot';

    const tag = document.createElement('span');
    tag.className = 'lineup-num';
    tag.textContent = slot;
    field.append(tag);

    const select = document.createElement('select');
    select.setAttribute('aria-label', `Player in position ${slot}`);
    select.disabled = disabled;

    select.append(new Option('—', ''));
    // Only players who aren't already standing somewhere else, so the dropdown
    // can't build a lineup that couldn't exist.
    for (const p of availableFor(slot, S.lineup, S.roster)) {
      const label = p.jersey ? `${p.jersey} · ${p.fullName}` : p.fullName;
      select.append(new Option(label, p.playerId));
    }
    select.value = S.lineup[slot] || '';

    select.addEventListener('change', (e) => {
      S.lineup = assignSlot(S.lineup, slot, e.target.value);
      writeLineup(S.lineup);
      renderLineup();
      render();
    });

    field.append(select);
    wrap.append(field);
  }

  $('#lineup-clear').disabled = disabled || Object.keys(S.lineup).length === 0;

  if (S.rosterError) {
    note.textContent = `Roster unavailable — ${S.rosterError} Tokens show 1\u20135.`;
  } else if (disabled) {
    note.textContent = 'No players found in the sheet, so tokens show 1\u20135.';
  } else {
    note.textContent = 'Shown on the court only — never saved into the play.';
  }
}

/**
 * Pull the roster in the background. The editor is fully usable without it;
 * a coach drawing a play on a plane shouldn't be blocked by a sheet fetch.
 */
async function loadRoster() {
  try {
    // The roster only. Asking for StatsLog with a site token would be refused,
    // and would look like a broken sheet rather than a page asking for
    // something it has no business seeing.
    const data = await loadAll({ tabs: ['players'] });
    S.roster = data.players || [];
    S.rosterError = S.roster.length === 0 ? null : null;
  } catch (err) {
    S.roster = [];
    S.rosterError = err?.message ? `${err.message}.` : 'the sheet could not be read.';
  }

  // A stored ID that no longer exists on the roster clears its slot.
  S.lineup = pruneLineup(readLineup(), S.roster);
  writeLineup(S.lineup);

  renderLineup();
  render();
}

/* ------------------------------------------------------------------ */
/* Play form                                                           */
/* ------------------------------------------------------------------ */

function fillForm() {
  $('#p-name').value = S.play.name;
  $('#p-category').value = S.play.category;
  $('#p-tags').value = (S.play.tags || []).join(', ');
  $('#p-notes').value = S.play.notes;
  $('#p-court').value = S.play.courtType;
  $('#p-preset').value = S.play.preset;
}

function bindForm() {
  const presetSel = $('#p-preset');
  for (const [key, p] of Object.entries(COURT_PRESETS)) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = p.label;
    presetSel.append(o);
  }

  const text = (sel, apply) => $(sel).addEventListener('input', (e) => {
    apply(e.target.value);
    scheduleSave();
  });

  text('#p-name', (v) => { S.play.name = v; });
  text('#p-category', (v) => { S.play.category = v; });
  text('#p-notes', (v) => { S.play.notes = v; });
  text('#p-tags', (v) => {
    S.play.tags = v.split(',').map((t) => t.trim()).filter(Boolean);
  });

  $('#p-court').addEventListener('change', (e) => {
    S.play.courtType = e.target.value;
    render();
    scheduleSave();
  });
  $('#p-preset').addEventListener('change', (e) => {
    S.play.preset = e.target.value;
    render();
    scheduleSave();
  });
}

function loadPlay(play) {
  S.play = normalizePlay(structuredClone(play));
  S.frame = 0;
  S.selection = null;
  S.undo.length = 0;
  S.redo.length = 0;
  fillForm();
  render();
  setSaveState('saved');
  renderLibrary();
  refreshPublish();
}

/* ------------------------------------------------------------------ */
/* Library                                                             */
/* ------------------------------------------------------------------ */

function renderLibrary() {
  const plays = listPlays();
  $('#lib-count').textContent = String(plays.length);

  const fillSelect = (sel, values, current) => {
    const el = $(sel);
    el.replaceChildren(new Option('All', ''));
    for (const v of values) el.append(new Option(v, v));
    el.value = values.includes(current) ? current : '';
  };
  fillSelect('#lib-category', allCategories(plays), S.lib.category);
  fillSelect('#lib-tag', allTags(plays), S.lib.tag);

  const datalist = $('#category-list');
  datalist.replaceChildren();
  for (const c of allCategories(plays)) datalist.append(new Option(c));

  const matches = markPublished(scopedPlays(searchPlays(plays, S.lib.q, S.lib)), S.team);
  const list = $('#play-list');
  list.replaceChildren();

  if (matches.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty small';
    li.textContent = plays.length === 0
      ? 'No plays yet — draw one and it saves itself.'
      : 'No plays match that search.';
    list.append(li);
    return;
  }

  for (const play of matches) list.append(playRow(play, false));
}

function playRow(play, readOnly) {
  const li = document.createElement('li');
  li.className = 'play-row' + (!readOnly && play.id === S.play.id ? ' active' : '');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'play-open';

  const top = document.createElement('span');
  top.className = 'play-title';
  const name = document.createElement('span');
  name.className = 'play-name';
  name.textContent = play.name;
  top.append(name);

  // Every card says where it lives. This is the whole fix for "it's on my
  // computer but not my phone".
  const badge = document.createElement('span');
  if (readOnly) {
    badge.className = 'src-badge team';
    badge.textContent = 'Team';
  } else if (play.published) {
    badge.className = 'src-badge published';
    badge.textContent = play.newerThanTeam ? 'Edited since publishing' : 'Published';
  } else {
    badge.className = 'src-badge device';
    badge.textContent = 'This device';
  }
  top.append(badge);
  btn.append(top);

  const meta = document.createElement('span');
  meta.className = 'play-meta';
  const bits = [`${play.frames.length} step${play.frames.length === 1 ? '' : 's'}`];
  if (play.category) bits.unshift(play.category);
  if (play.courtType === 'full') bits.push('full court');
  meta.textContent = bits.join(' · ');
  btn.append(meta);

  if ((play.tags || []).length) {
    const tags = document.createElement('span');
    tags.className = 'play-tags';
    tags.textContent = play.tags.join(' · ');
    btn.append(tags);
  }

  btn.addEventListener('click', () => {
    if (readOnly) {
      // Keep the id: this is the same play, now editable here. Minting a new
      // one would make it look unrelated to the file it came from, and
      // re-publishing would fork it instead of updating it.
      const existing = listPlays().find((p) => p.id === play.id);
      if (existing) { loadPlay(existing); return; }
      const copy = structuredClone(play);
      // Not an edit: keep updatedAt so the card reads "Published" rather than
      // claiming work that hasn't happened yet.
      savePlay(copy, { touch: false });
      loadPlay(copy);
    } else {
      loadPlay(play);
    }
    renderLibrary();
  });

  li.append(btn);

  // Row actions, kept off the open-the-play button so a stray tap can't
  // destroy something.
  const actions = document.createElement('div');
  actions.className = 'play-actions';

  // Only meaningful while the team playbook is files in the repo. Once it lives
  // in the sheet there is no file behind this play, and a link to one would
  // point at something that is either absent or out of date.
  if (readOnly && !usingScript()) {
    const link = document.createElement('a');
    link.className = 'play-action';
    link.href = fileUrl(play.path || `plays/${pubSlug(play.name)}.json`);
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'On GitHub';
    link.title = 'To remove it from the team playbook, delete the file on GitHub.';
    actions.append(link);
  }

  if (!readOnly && play.published) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'play-action';
    remove.textContent = 'Remove local copy';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Remove the local copy of “${play.name}”? It stays in the team playbook.`)) return;
      deletePlay(play.id);
      if (S.play.id === play.id) {
        const team = S.team.find((t) => t.id === play.id);
        if (team) loadPlay(structuredClone(team));
      }
      renderLibrary();
    });
    actions.append(remove);
  }

  if (!readOnly) {
    for (const [label, copy] of [['Move', false], ['Copy', true]]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'play-action';
      b.textContent = `${label} to playbook`;
      b.addEventListener('click', (e) => { e.stopPropagation(); relocate(play, { copy }); });
      actions.append(b);
    }
  } else {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'play-action';
    b.textContent = 'Copy to this device';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const existing = listPlays().find((p) => p.id === play.id);
      if (existing) { loadPlay(existing); return; }
      savePlay(structuredClone(play), { touch: false });
      renderLibraryAll();
    });
    actions.append(b);

    // Removing from the team playbook is admin-only, and asks first: it changes
    // what the whole team sees.
    if (usingScript() && canPublish()) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'play-action danger';
      del.textContent = 'Remove from team playbook';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Remove “${play.name}” from the team playbook?\n\nEveryone loses it on their next refresh. Your copy on this device is kept.`)) return;

        del.disabled = true;
        del.textContent = 'Removing…';
        const result = await deleteTeamPlay(play.id);

        if (!result.ok) {
          del.disabled = false;
          del.textContent = 'Remove from team playbook';
          $('#team-status').className = 'small missing';
          $('#team-status').textContent = result.message;
          return;
        }
        renderTeam();
      });
      actions.append(del);
    }
  }

  if (actions.childElementCount) li.append(actions);
  return li;
}

async function renderTeam() {
  const { plays, playbooks, error } = await fetchTeamPlays();
  S.team = plays;
  S.teamPlaybooks = playbooks || [];
  S.teamError = error;

  renderLibraryAll();   // published badges depend on the team list
  refreshMigration();
}

/* ------------------------------------------------------------------ */
/* Migration from plays/ into the sheet                                */
/* ------------------------------------------------------------------ */

/**
 * Offer to move whatever is still in `plays/` into the sheet.
 *
 * Shown only to an admin, only while the files still hold plays the sheet
 * lacks, and it disappears the moment there is nothing left to move — so it
 * cannot linger as a button that does nothing.
 */
async function refreshMigration() {
  const host = $('#team-migrate');
  if (!host) return;

  host.hidden = true;
  host.replaceChildren();

  if (!usingScript() || !canPublish()) return;

  const filePlays = await readFilePlays();
  const pending = playsToMigrate(filePlays, S.team);
  if (pending.length === 0) return;

  const note = document.createElement('p');
  note.className = 'small';
  note.textContent = `${pending.length} play${pending.length === 1 ? '' : 's'} still only in the site's files.`;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-primary';
  btn.textContent = 'Move team plays into the sheet';

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Moving…';

    const { moved, failed } = await migrateFilePlays(pending);

    if (failed.length) {
      note.className = 'small missing';
      note.textContent = `Moved ${moved}. ${failed.length} failed: ${failed[0].message}`;
      btn.disabled = false;
      btn.textContent = 'Try again';
      return;
    }

    note.className = 'small';
    note.textContent = `Moved ${moved} play${moved === 1 ? '' : 's'}.`;
    btn.remove();
    renderTeam();
  });

  host.append(note, btn);
  host.hidden = false;
}

/** Render only — changing the playbook picker must not refetch the site. */
function renderTeamList() {
  const status = $('#team-status');
  const list = $('#team-list');
  const shown = scopedPlays(S.team);

  $('#team-count').textContent = String(shown.length);
  list.replaceChildren();

  // An empty list and a failed fetch are different problems. Saying which one
  // it is turns "where did my play go" into a fixable answer.
  if (S.teamError) {
    status.className = 'small missing';
    status.textContent = `Couldn't load the team playbook — ${S.teamError}`;
  } else if (S.team.length === 0) {
    status.className = 'small muted';
    status.textContent = 'No team plays published yet.';
  } else if (shown.length === 0) {
    status.className = 'small muted';
    status.textContent = 'Nothing published in this playbook yet.';
  } else {
    status.className = 'small muted';
    status.textContent = '';
  }

  const blurb = $('#team-blurb');
  if (blurb) {
    blurb.textContent = usingScript()
      ? 'Saved in the team sheet — the same on every device, and not readable without signing in. Opening one copies it here so you can edit it.'
      : 'Published to the site in plays/ — the same on every device. Opening one copies it here so you can edit it.';
  }

  for (const play of shown) list.append(playRow(play, true));
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ------------------------------------------------------------------ */
/* Playbooks                                                           */
/* ------------------------------------------------------------------ */

/** The selected playbook lives in the URL so a link opens straight to one. */
function readPlaybookParam() {
  S.lib.playbook = new URLSearchParams(location.search).get('playbook') || '';
}

function writePlaybookParam() {
  const q = new URLSearchParams(location.search);
  if (S.lib.playbook) q.set('playbook', S.lib.playbook);
  else q.delete('playbook');
  const qs = q.toString();
  history.replaceState(null, '', qs ? `${location.pathname}?${qs}` : location.pathname);
}

function refreshPlaybooks() {
  S.playbooks = mergePlaybooks(S.teamPlaybooks, readLocalPlaybooks(), listPlays());

  // Library picker: "All plays" plus every playbook with its count.
  const picker = $('#lib-playbook');
  const keep = S.lib.playbook;
  picker.replaceChildren(new Option(`All plays (${S.playbooks.reduce((n, p) => n + p.count, 0)})`, ''));
  for (const pb of S.playbooks) {
    picker.append(new Option(`${pb.name} (${pb.count})`, pb.slug));
  }
  picker.value = S.playbooks.some((p) => p.slug === keep) ? keep : '';
  S.lib.playbook = picker.value;

  // The current play's own playbook. Always offers the default, so a play can
  // never be stranded in a playbook that no longer exists.
  const own = $('#p-playbook');
  const slugs = new Set(S.playbooks.map((p) => p.slug));
  own.replaceChildren();
  if (!slugs.has(DEFAULT_PLAYBOOK)) own.append(new Option('General', DEFAULT_PLAYBOOK));
  for (const pb of S.playbooks) own.append(new Option(pb.name, pb.slug));
  own.value = playbookOf(S.play);
  if (own.value !== playbookOf(S.play)) {
    own.append(new Option(playbookOf(S.play), playbookOf(S.play)));
    own.value = playbookOf(S.play);
  }
}

/**
 * Re-render everything that depends on the playbook selection.
 *
 * Both lists and the publish target read the same selection, so refreshing
 * them separately is how one ends up showing a different playbook than the
 * other.
 */
function renderLibraryAll() {
  refreshPlaybooks();
  renderLibrary();
  renderTeamList();
  refreshPublish();
}

/** Plays shown in the library, scoped to the selected playbook. */
function scopedPlays(plays) {
  if (!S.lib.playbook) return plays;
  return plays.filter((p) => playbookOf(p) === S.lib.playbook);
}

function onNewPlaybook() {
  const name = prompt('Playbook name (e.g. Zone Offense)');
  if (!name || !name.trim()) return;
  const description = prompt('Short description (optional)') || '';

  const entry = addLocalPlaybook(name.trim(), description.trim());
  S.lib.playbook = entry.slug;
  // A new playbook is where you're about to work, so put the current play in it.
  S.play.playbook = entry.slug;
  scheduleSave();
  writePlaybookParam();
  renderLibraryAll();
}

/** Move or copy a play into another playbook. */
function relocate(play, { copy }) {
  const options = S.playbooks.map((p) => `${p.slug} — ${p.name}`).join('\n');
  const slug = prompt(`${copy ? 'Copy' : 'Move'} “${play.name}” to which playbook?\n\n${options}`,
    playbookOf(play));
  if (!slug) return;

  const target = slugifyPlaybook(slug.split(' — ')[0]);
  if (copy) {
    // A copy into a different playbook is a different play: it will publish to
    // a different path, so it needs its own id.
    savePlay({
      ...structuredClone(play),
      id: uid(),
      name: target === playbookOf(play) ? `${play.name} (copy)` : play.name,
      playbook: target,
      createdAt: new Date().toISOString(),
    });
  } else {
    savePlay({ ...play, playbook: target });
    if (S.play.id === play.id) S.play.playbook = target;
  }

  renderLibraryAll();
}

function currentPlaybook() {
  return S.playbooks.find((p) => p.slug === (S.lib.playbook || playbookOf(S.play)))
    || { slug: DEFAULT_PLAYBOOK, name: 'General', description: '' };
}

/** Every play in the selected playbook, team and device, one per id. */
function playbookPlays(pb) {
  const device = listPlays().filter((p) => playbookOf(p) === pb.slug);
  const team = S.team.filter((p) => playbookOf(p) === pb.slug);
  const seen = new Set(device.map((p) => p.id));
  return [...device, ...team.filter((p) => !seen.has(p.id))];
}

/* ------------------------------------------------------------------ */
/* Publish + PDF                                                       */
/* ------------------------------------------------------------------ */

/**
 * Keep the Publish link's href current.
 *
 * It has to be a real anchor with the href already set: Safari blocks
 * window.open() called after an await, so a click handler that fetches or
 * awaits before opening simply does nothing on a phone — which is the one
 * device this feature exists for.
 */
function currentPublishPlan() {
  const slug = playbookOf(S.play);
  const conflict = findSlugConflict(S.team, slug, pubSlug(S.play.name), S.play.id);
  if (conflict) {
    return {
      action: 'conflict',
      path: conflict.path,
      url: null,
      clipboard: null,
      clipboardOnly: false,
      message: `“${conflict.name}” already uses this filename in that playbook. Rename this play before publishing.`,
    };
  }
  return publishPlan(S.play, S.team, {
    playbook: slug,
    playbookExists: playbookExistsOnSite(S.teamPlaybooks, slug),
    playbookName: (S.playbooks.find((p) => p.slug === slug) || {}).name || slug,
  });
}

function refreshPublish() {
  const link = $('#p-publish');
  const note = $('#publish-note');
  if (!link) return;

  // With the sheet as the team playbook there is no file to commit and no
  // filename to collide with: a play is identified by its id, and publishing is
  // one request.
  if (usingScript()) {
    refreshPublishToSheet(link, note);
    return;
  }

  const plan = currentPublishPlan();
  link.dataset.action = plan.action;
  link.dataset.path = plan.path;

  if (plan.action === 'conflict') {
    link.removeAttribute('href');
    link.classList.add('disabled');
    link.textContent = 'Rename before publishing';
    note.className = 'small missing';
    note.textContent = plan.message;
    return;
  }

  // A playbook that doesn't exist on the site yet needs its own commit first.
  // Doing that as an explicit first step beats opening two tabs: a second
  // window.open is exactly what Safari blocks.
  if (plan.playbookUrl) {
    link.href = plan.playbookUrl;
    link.classList.remove('disabled');
    link.textContent = 'Create playbook on the site';
    note.className = 'small';
    note.textContent = 'Two commits: commit this playbook file, then press Publish again for the play.';
    return;
  }

  link.href = plan.url;
  link.classList.remove('disabled');
  link.textContent = plan.action === 'update' ? 'Update on team playbook' : 'Publish to team playbook';
  note.className = 'small muted';
  note.textContent = plan.clipboardOnly
    ? plan.message
    : 'Opens GitHub with the file filled in — just commit.';
}

/**
 * Publish straight into the sheet.
 *
 * A non-admin sees the button disabled and labelled "Admin only" rather than
 * hidden — knowing the team playbook exists and needs a second password is more
 * use than a feature that silently isn't there.
 */
function refreshPublishToSheet(link, note) {
  link.removeAttribute('href');
  link.dataset.action = 'sheet';

  const published = S.team.some((t) => t.id === S.play.id);

  if (!canPublish()) {
    link.classList.add('disabled');
    link.textContent = 'Admin only';
    note.className = 'small muted';
    note.textContent = 'Saving to the team playbook needs the admin password. This play is saved on this device.';
    return;
  }

  link.classList.remove('disabled');
  link.textContent = published ? 'Update on team playbook' : 'Publish to team playbook';
  note.className = 'small muted';
  note.textContent = 'Saves straight to the team playbook — everyone sees it on their next refresh.';
}

async function publishToSheet() {
  const link = $('#p-publish');
  const note = $('#publish-note');
  if (!canPublish()) return;

  const label = link.textContent;
  link.classList.add('disabled');
  link.textContent = 'Saving…';

  const result = await saveTeamPlay(S.play);

  link.classList.remove('disabled');
  link.textContent = label;

  if (!result.ok) {
    note.className = 'small missing';
    note.textContent = result.message;
    return;
  }

  note.className = 'small';
  note.textContent = 'Saved to the team playbook.';
  renderTeam();   // refetches, which is what re-badges the card as Published
}

async function onPublishClick(e) {
  const link = $('#p-publish');

  if (usingScript()) {
    e.preventDefault();
    await publishToSheet();
    return;
  }

  const plan = currentPublishPlan();

  if (plan.action === 'conflict') {
    e.preventDefault();
    alert(plan.message);
    return;
  }

  // Copy inside the click, before the anchor navigates: a later write loses
  // the user gesture that browsers require.
  if (plan.playbookUrl) {
    $('#publish-note').className = 'small';
    $('#publish-note').textContent = 'Commit the playbook file, then press Publish again for the play.';
    return;
  }

  if (plan.clipboard) {
    try {
      await navigator.clipboard.writeText(plan.clipboard);
      $('#publish-note').className = 'small';
      $('#publish-note').textContent = plan.message;
    } catch {
      // Blocked clipboard (insecure context, permissions): the download is the
      // way out, so say that rather than failing silently.
      $('#publish-note').className = 'small missing';
      $('#publish-note').textContent = 'Could not copy automatically — use Download backup (.json) and upload it.';
    }
  }

  if (plan.playbookUrl) {
    $('#publish-note').textContent = 'Two commits: the playbook file first, then the play.';
  }
  void link;
}

/** The renderers the print view borrows, so the page matches the screen. */
const printDraw = {
  defs,
  renderToken: (t) => renderToken(t),
  renderArrow: (a) => renderArrow(a),
  renderText: (t) => renderText(t),
};

/* ------------------------------------------------------------------ */
/* Collapsible cards                                                   */
/* ------------------------------------------------------------------ */

const COLLAPSE_KEY = 'bb.collapse.v1';

/**
 * Remember which cards are open.
 *
 * The toggling itself is native <details> behaviour; this only persists the
 * choice, so a coach who collapses the library keeps a short page next time
 * instead of re-collapsing it on every visit.
 */
function bindCollapsibles() {
  let saved = {};
  try {
    saved = JSON.parse(globalThis.localStorage?.getItem(COLLAPSE_KEY) || '{}') || {};
  } catch {
    saved = {};
  }

  for (const card of document.querySelectorAll('[data-collapse]')) {
    const key = card.dataset.collapse;
    if (key in saved) card.open = Boolean(saved[key]);

    card.addEventListener('toggle', () => {
      saved[key] = card.open;
      try {
        globalThis.localStorage?.setItem(COLLAPSE_KEY, JSON.stringify(saved));
      } catch {
        /* blocked storage: collapsing still works, it just won't be remembered */
      }
    });
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function bind() {
  for (const b of document.querySelectorAll('[data-tool]')) {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  }
  for (const b of document.querySelectorAll('[data-add]')) {
    b.addEventListener('click', () => addToken(b.dataset.add, b.dataset.label));
  }

  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', onPointerUp);
  svg.addEventListener('pointercancel', onPointerUp);
  svg.addEventListener('dblclick', onDoubleClick);

  $('#pb-undo').addEventListener('click', () => restore(S.undo, S.redo));
  $('#pb-redo').addEventListener('click', () => restore(S.redo, S.undo));
  $('#pb-delete').addEventListener('click', deleteSelection);
  $('#pb-clear').addEventListener('click', () => {
    if (!confirm('Clear everything on this step?')) return;
    pushUndo();
    S.play.frames[S.frame] = emptyFrame(frame().label);
    S.selection = null;
    render();
    scheduleSave();
  });

  $('#fr-prev').addEventListener('click', () => { S.frame = Math.max(0, S.frame - 1); S.selection = null; render(); });
  $('#fr-next').addEventListener('click', () => { S.frame = Math.min(S.play.frames.length - 1, S.frame + 1); S.selection = null; render(); });
  $('#fr-add').addEventListener('click', () => addFrame(false));
  $('#fr-dup').addEventListener('click', () => addFrame(true));
  $('#fr-del').addEventListener('click', deleteFrame);
  $('#fr-ghost').addEventListener('change', (e) => { S.ghost = e.target.checked; render(); });

  $('#lineup-clear').addEventListener('click', () => {
    S.lineup = {};
    writeLineup(S.lineup);
    renderLineup();
    render();
  });

  $('#p-new').addEventListener('click', () => {
    const play = newPlay();
    savePlay(play);
    loadPlay(play);
  });
  $('#p-dup').addEventListener('click', () => {
    const copy = duplicatePlay(S.play);
    if (copy) loadPlay(copy);
  });
  $('#p-pdf').addEventListener('click', () => printPlay(S.play, printDraw));
  $('#p-publish').addEventListener('click', onPublishClick);

  $('#p-export').addEventListener('click', () => {
    download(`${slugify(S.play.name)}.json`, exportPlay(S.play));
  });
  $('#p-delete').addEventListener('click', () => {
    if (!confirm(`Delete "${S.play.name}"? This can't be undone.`)) return;
    deletePlay(S.play.id);
    const rest = listPlays();
    if (rest.length) loadPlay(rest[rest.length - 1]);
    else { const play = newPlay(); savePlay(play); loadPlay(play); }
  });

  $('#lib-playbook').addEventListener('change', (e) => {
    S.lib.playbook = e.target.value;
    writePlaybookParam();
    renderLibraryAll();
  });
  $('#pb-new').addEventListener('click', onNewPlaybook);
  $('#pb-pdf').addEventListener('click', () => {
    const pb = currentPlaybook();
    const plays = playbookPlays(pb);
    if (plays.length === 0) { alert(`“${pb.name}” has no plays yet.`); return; }
    printPlaybook(pb, plays, printDraw);
  });
  $('#p-playbook').addEventListener('change', (e) => {
    S.play.playbook = e.target.value;
    scheduleSave();
    renderLibraryAll();
  });

  $('#lib-search').addEventListener('input', (e) => { S.lib.q = e.target.value; renderLibrary(); });
  $('#lib-category').addEventListener('change', (e) => { S.lib.category = e.target.value; renderLibrary(); });
  $('#lib-tag').addEventListener('change', (e) => { S.lib.tag = e.target.value; renderLibrary(); });

  $('#lib-export').addEventListener('click', () => {
    download(`playbook-${new Date().toISOString().slice(0, 10)}.json`, exportLibrary(listPlays()));
  });
  $('#lib-import').addEventListener('click', () => $('#lib-file').click());
  $('#lib-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const { plays, errors } = parseImport(await file.text());
    e.target.value = '';

    if (errors.length) alert(`Import problems:\n\n${errors.join('\n')}`);
    if (plays.length === 0) return;

    const added = importPlays(plays);
    renderLibrary();
    if (added.length) loadPlay(added[0]);
    alert(`Imported ${added.length} play${added.length === 1 ? '' : 's'}.`);
  });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (typing) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) restore(S.redo, S.undo);
      else restore(S.undo, S.redo);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (S.selection) { e.preventDefault(); deleteSelection(); }
      return;
    }

    const tools = { v: 'select', c: 'cut', p: 'pass', d: 'dribble', s: 'screen', t: 'text' };
    if (tools[e.key.toLowerCase()]) { setTool(tools[e.key.toLowerCase()]); return; }

    // Nudge a selected token a half-foot at a time.
    const nudges = { ArrowUp: [0, -SNAP], ArrowDown: [0, SNAP], ArrowLeft: [-SNAP, 0], ArrowRight: [SNAP, 0] };
    if (nudges[e.key] && S.selection && S.selection.type !== 'arrow') {
      const found = findItem(S.selection.id);
      if (!found) return;
      e.preventDefault();
      pushUndo();
      const [dx, dy] = nudges[e.key];
      const q = clampToCourt({ x: found.item.x + dx, y: found.item.y + dy });
      found.item.x = snap(q.x);
      found.item.y = snap(q.y);
      render();
      scheduleSave();
    }
  });
}

function init() {
  readPlaybookParam();
  bindForm();
  bind();
  bindCollapsibles();

  // Reopen whatever was last worked on rather than a blank floor.
  const existing = listPlays();
  if (existing.length) {
    const latest = [...existing].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    loadPlay(latest);
  } else {
    const play = newPlay();
    savePlay(play);
    loadPlay(play);
  }

  setTool('select');
  renderLineup();

  // Both need a token, and neither may run before sign-in has happened.
  whenSignedIn(() => {
    renderTeam();
    loadRoster();
  });
}

/**
 * Run `fn` once a site session exists — the roster needs a token.
 *
 * gate.js announces the sign-in, but modules execute in document order and
 * gate.js comes first, so on a reload with a session already stored it has
 * announced before this module exists. Checking the session directly covers
 * that; the listener covers the first sign-in of the visit. With the gate off
 * there is nothing to wait for.
 */
function whenSignedIn(fn) {
  const gate = CONFIG.gate || {};
  if (!isEnabled(gate) || sessionValid(readSession(), siteMaxAge(gate))) {
    fn();
    return;
  }
  document.addEventListener('bb:signedin', fn, { once: true });
}

init();
