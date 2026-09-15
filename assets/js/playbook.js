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
  lib: { q: '', category: '', tag: '' },
  saveTimer: null,
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
    g.append(node('circle', { r: TOKEN_R, class: 'tok-body' }));
    g.append(textNode(t.label, { class: 'tok-label', 'font-size': 1.55 }));
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

  const matches = searchPlays(plays, S.lib.q, S.lib);
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

  const name = document.createElement('span');
  name.className = 'play-name';
  name.textContent = play.name;
  btn.append(name);

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
      // Copying is the only way to edit a team play, so the shared copy stays put.
      const copy = { ...structuredClone(play), id: uid(), name: `${play.name} (team copy)` };
      savePlay(copy);
      loadPlay(copy);
    } else {
      loadPlay(play);
    }
  });

  li.append(btn);
  return li;
}

async function renderTeam() {
  const { plays } = await loadTeamPlaybook();
  S.team = plays;
  if (plays.length === 0) return;

  $('#team-card').hidden = false;
  $('#team-count').textContent = String(plays.length);
  const list = $('#team-list');
  list.replaceChildren();
  for (const play of plays) list.append(playRow(play, true));
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

  $('#p-new').addEventListener('click', () => {
    const play = newPlay();
    savePlay(play);
    loadPlay(play);
  });
  $('#p-dup').addEventListener('click', () => {
    const copy = duplicatePlay(S.play);
    if (copy) loadPlay(copy);
  });
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
  bindForm();
  bind();

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
  renderTeam();
}

init();
