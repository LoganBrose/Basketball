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
  newPlay, emptyFrame, carryOverTokens, uid, listPlays, savePlay, deletePlay, duplicatePlay,
  searchPlays, allCategories, allTags, parseImport, importPlays,
  exportPlay, exportLibrary, slugify, loadTeamPlaybook, normalizePlay, safeVideoUrl, youtubeEmbed,
  planStep, tokensAt,
} from './library.js';
import { CONFIG } from './config.js';
import { loadAll } from './data.js';
import {
  isEnabled, isViewer, readSession, sessionValid, siteMaxAge, signOutHere, watchSession,
} from './gate.js';
import {
  usingScript, canPublish, fetchTeamPlays, saveTeamPlay, deleteTeamPlay,
  canUseAdminBook, movePlay, fetchTeamPlay,
} from './teamplays.js';
import {
  node, defs, midpoint, createDrawer,
} from './draw.js';
import { printPlay, printPlaybook } from './printout.js';
import {
  canSaveOpponentPlays, fetchSchedule, pickerGames, saveOpponentPlay,
} from './opponentplays.js';
import {
  publishPlan, markPublished, fileUrl, minify, slugify as pubSlug,
} from './publish.js';
import {
  DEFAULT_PLAYBOOK, slugifyPlaybook, readLocalPlaybooks, addLocalPlaybook,
  mergePlaybooks, playbookOf, findSlugConflict, playbookExistsOnSite,
} from './playbooks.js';
import {
  SLOTS, readLineup, writeLineup, pruneLineup, availableFor, playerInSlot,
  assignSlot,
} from './lineup.js';

const $ = (s) => document.querySelector(s);
const svg = $('#court');

const SNAP = 0.5; // feet

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
  // The admin playbook: only ever filled for an admin session the script has
  // confirmed. Everyone else never gets the card, let alone the plays.
  admin: [],
  adminPlaybooks: [],
  adminError: null,
  adminOn: false,
  playbooks: [],
  lib: { q: '', category: '', tag: '', playbook: '' },
  saveTimer: null,
  // Who is standing in each offensive slot. Display only — never saved into a
  // play, so any play can be opened with any lineup.
  lineup: {},
  roster: [],
  rosterError: null,
  // Signed in with the view-only password: the team playbook, read-only.
  viewer: false,
  // The Play animation while it runs: { t, plan, raf, last }. Null otherwise.
  anim: null,
  // A player's page re-checks its sign-in every few minutes (watchSession).
  sessionWatch: null,
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
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/* The renderers, bound to this editor's selection and lineup. */
const draw = createDrawer({
  isSelected: (type, id) => isSelected(type, id),
  playerFor: (label) => playerInSlot(label, S.lineup, S.roster),
  nameDisplay: CONFIG.nameDisplay,
});
const { renderToken, renderArrow, renderText } = draw;

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

  if (S.anim) {
    renderAnimation(content);
    svg.append(content);
    renderFrames();
    return;
  }

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
/* Play animation                                                      */
/* ------------------------------------------------------------------ */

/** How long one step takes to play out, in milliseconds. */
const STEP_MS = 1400;
/** With reduced motion there is no tweening: each step is simply shown this long. */
const STEP_STILL_MS = 1000;
const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * One moment of the animation: the step's arrows faded underneath, and the
 * tokens wherever tokensAt says they are. Nothing here is selectable.
 */
function renderAnimation(content) {
  const f = frame();
  // Reduced motion shows each step as drawn, then the next — no in-between.
  const t = S.anim.still ? 0 : S.anim.t;
  const { tokens, flyingBalls } = tokensAt(f, t, S.anim.plan);
  const trail = node('g', { class: 'anim-trail' });
  for (const a of f.arrows) trail.append(renderArrow(a, true));
  content.append(trail);
  for (const t of tokens) content.append(renderToken(t, false, true));
  for (const b of flyingBalls) {
    content.append(node('circle', { cx: b.x, cy: b.y, r: 0.62, class: 'tok-ball anim-ball' }));
  }
  const notes = node('g', { class: 'anim-notes' });
  for (const t of f.texts) notes.append(renderText(t, true));
  content.append(notes);
}

function setPlayButton() {
  const btn = $('#fr-play');
  if (!btn) return;
  btn.textContent = S.anim ? '■ Stop' : '▶ Play';
  btn.setAttribute('aria-pressed', S.anim ? 'true' : 'false');
  btn.title = S.anim ? 'Stop the animation' : 'Watch the play move, from this step to the end';
}

/** Start from the current step and run to the end of the play. */
function startAnimation() {
  if (S.anim) return;
  // Pressing Play on the last step replays the whole play rather than one step.
  if (S.frame >= S.play.frames.length - 1 && S.play.frames.length > 1 && !hasMotion(frame())) S.frame = 0;
  S.selection = null;
  S.drag = null;
  S.draft = null;
  S.anim = { t: 0, plan: planStep(frame()), raf: 0, last: null, still: reducedMotion() };
  setPlayButton();
  S.anim.raf = requestAnimationFrame(tick);
}

const hasMotion = (f) => (f.arrows || []).length > 0;

function tick(now) {
  const a = S.anim;
  if (!a) return;
  const dt = a.last == null ? 0 : now - a.last;
  a.last = now;
  a.t += dt / (a.still ? STEP_STILL_MS : STEP_MS);

  if (a.t >= 1) {
    if (S.frame >= S.play.frames.length - 1) {
      stopAnimation();
      return;
    }
    S.frame += 1;
    a.t = 0;
    a.plan = planStep(frame());
  }

  render();
  a.raf = requestAnimationFrame(tick);
}

/** Stop, and leave the step on screen exactly as it was drawn. */
function stopAnimation() {
  if (!S.anim) return;
  cancelAnimationFrame(S.anim.raf);
  S.anim = null;
  setPlayButton();
  render();
}

/* ------------------------------------------------------------------ */
/* Mutation + undo                                                     */
/* ------------------------------------------------------------------ */

function pushUndo() {
  if (S.viewer) return;
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
  if (S.viewer) return;   // a viewer never writes, not even to this browser
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
  if (S.viewer) {
    pill.className = 'pill';
    pill.textContent = 'View only';
    return;
  }
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
  if (S.viewer) return;
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
  if (S.viewer || !S.selection) return;
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
  if (S.viewer) return;
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
  if (S.viewer) return;
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
    if (!S.viewer) chip.title = 'Double-click to rename';
    chip.addEventListener('click', () => {
      S.frame = i;
      S.selection = null;
      render();
    });
    chip.addEventListener('dblclick', () => {
      if (S.viewer) return;
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

function addFrame() {
  if (S.viewer) return;
  pushUndo();
  const label = `Action ${S.play.frames.length}`;
  const next = emptyFrame(label);
  // Players start where this step left them; arrows and notes start clean.
  next.tokens = carryOverTokens(frame());

  S.play.frames.splice(S.frame + 1, 0, next);
  S.frame += 1;
  S.selection = null;
  render();
  scheduleSave();
}

function deleteFrame() {
  if (S.viewer || S.play.frames.length <= 1) return;
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
  $('#p-video').value = S.play.youtube || '';
  renderVideoLink();
  renderViewBox();
  $('#p-court').value = S.play.courtType;
  $('#p-preset').value = S.play.preset;
}

/** "▶ Watch video", shown only when the play has a usable link. */
function renderVideoLink() {
  const url = safeVideoUrl(S.play.youtube);
  $('#p-video-row').hidden = url === '';
}

/** The viewer's small play box: the name, and the video when there is one. */
function renderViewBox() {
  $('#vb-name').textContent = S.play.name || '';
  $('#vb-video').hidden = safeVideoUrl(S.play.youtube) === '';
}

/* ------------------------------------------------------------------ */
/* Video player                                                        */
/* ------------------------------------------------------------------ */

let videoOpener = null;

/**
 * Play the current play's video. A YouTube link plays in an overlay on this
 * page, so the watch link is never shown; anything else opens in a new tab.
 */
function openVideo(e) {
  const embed = youtubeEmbed(S.play.youtube);
  if (!embed) {
    const url = safeVideoUrl(S.play.youtube);
    if (url) window.open(url, '_blank', 'noopener');
    return;
  }
  videoOpener = e && e.currentTarget;
  const frame = document.createElement('iframe');
  frame.src = embed;
  frame.title = S.play.name ? `Video: ${S.play.name}` : 'Play video';
  frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  frame.allowFullscreen = true;
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  $('#video-frame').replaceChildren(frame);
  $('#video-overlay').hidden = false;
  $('#video-close').focus();
}

/** Removing the iframe is what stops the video playing. */
function closeVideo() {
  const overlay = $('#video-overlay');
  if (overlay.hidden) return;
  overlay.hidden = true;
  $('#video-frame').replaceChildren();
  if (videoOpener) videoOpener.focus();
  videoOpener = null;
}

function bindVideo() {
  $('#vb-video').addEventListener('click', openVideo);
  $('#p-video-open').addEventListener('click', openVideo);
  $('#video-close').addEventListener('click', closeVideo);
  $('#video-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeVideo();
  });
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
  text('#p-video', (v) => {
    S.play.youtube = v.trim() || null;
    renderVideoLink();
  });
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
  if (S.anim) { cancelAnimationFrame(S.anim.raf); S.anim = null; setPlayButton(); }
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

  const adminById = new Map(S.admin.map((p) => [p.id, p]));
  const matches = markPublished(scopedPlays(searchPlays(plays, S.lib.q, S.lib)), S.team)
    .map((p) => {
      const saved = adminById.get(p.id);
      return saved
        ? { ...p, inAdmin: true, newerThanAdmin: String(p.updatedAt || '') > String(saved.updatedAt || '') }
        : { ...p, inAdmin: false, newerThanAdmin: false };
    });
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

  for (const play of matches) list.append(playRow(play, 'device'));
}

/**
 * One card in a play list.
 * @param {Object} play
 * @param {'device'|'team'|'admin'} source  which list the card is in
 */
function playRow(play, source) {
  const readOnly = source !== 'device';
  const li = document.createElement('li');
  li.className = 'play-row' + ((!readOnly || S.viewer) && play.id === S.play.id ? ' active' : '');

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
  if (source === 'admin') {
    badge.className = 'src-badge admin';
    badge.textContent = 'Admin';
  } else if (readOnly) {
    badge.className = 'src-badge team';
    badge.textContent = 'Team';
  } else if (play.published) {
    badge.className = 'src-badge published';
    badge.textContent = play.newerThanTeam ? 'Edited since publishing' : 'Published';
  } else if (play.inAdmin) {
    badge.className = 'src-badge admin';
    badge.textContent = play.newerThanAdmin ? 'Edited since saving' : 'In admin playbook';
  } else {
    badge.className = 'src-badge device';
    badge.textContent = 'This device';
  }
  top.append(badge);
  btn.append(top);

  const meta = document.createElement('span');
  meta.className = 'play-meta';
  // A player's list carries the step count, not the steps themselves.
  const steps = play.summary ? play.stepCount : play.frames.length;
  const bits = [`${steps} step${steps === 1 ? '' : 's'}`];
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
    if (S.viewer) {
      // Just look at it. Nothing is copied into this browser.
      openViewerPlay(play);
      // On a phone the list sits above the court, so take them to the play.
      if (globalThis.matchMedia?.('(max-width: 900px)').matches) {
        $('#pb-viewbox').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
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

  // A viewer can open plays and nothing else.
  if (S.viewer) return li;

  // Row actions, kept off the open-the-play button so a stray tap can't
  // destroy something.
  const actions = document.createElement('div');
  actions.className = 'play-actions';

  // Only meaningful while the team playbook is files in the repo. Once it lives
  // in the sheet there is no file behind this play, and a link to one would
  // point at something that is either absent or out of date.
  if (source === 'team' && !usingScript()) {
    const link = document.createElement('a');
    link.className = 'play-action';
    link.href = fileUrl(play.path || `plays/${pubSlug(play.name)}.json`);
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'On GitHub';
    link.title = 'To remove it from the team playbook, delete the file on GitHub.';
    actions.append(link);
  }

  const keptElsewhere = play.published || play.inAdmin;
  if (!readOnly && keptElsewhere) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'play-action';
    remove.textContent = 'Remove local copy';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      const where = play.published ? 'the team playbook' : 'the admin playbook';
      if (!confirm(`Remove the local copy of “${play.name}”? It stays in ${where}.`)) return;
      deletePlay(play.id);
      if (S.play.id === play.id) {
        const kept = S.team.find((t) => t.id === play.id) || S.admin.find((t) => t.id === play.id);
        if (kept) loadPlay(structuredClone(kept));
      }
      renderLibrary();
    });
    actions.append(remove);
  }

  if (!readOnly && !keptElsewhere) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'play-action danger';
    del.textContent = 'Delete';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteDevicePlay(play); });
    actions.append(del);
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
    // Device -> admin playbook. Keeps the local copy, exactly as publishing to
    // the team playbook does.
    if (S.adminOn) {
      actions.append(actionButton(
        play.inAdmin ? 'Update in admin playbook' : 'Save to admin playbook',
        (b) => saveToAdmin(play, b),
      ));
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

    if (source === 'admin') {
      actions.append(actionButton('Move to team playbook', (b) => moveBetween(play, 'admin', 'team', b)));
      const del = actionButton('Remove from admin playbook', (b) => removeFromAdmin(play, b));
      del.classList.add('danger');
      actions.append(del);
    } else if (S.adminOn) {
      actions.append(actionButton('Move to admin playbook', (b) => moveBetween(play, 'team', 'admin', b)));
    }

    // Any coach may remove from the team playbook (a viewer may not), and it
    // asks first: it changes what the whole team sees.
    if (source === 'team' && usingScript() && canPublish() && !S.viewer) {
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

/** Delete a play from this device, keeping something open in the editor. */
function deleteDevicePlay(play) {
  if (!confirm(`Delete "${play.name}"? This can't be undone.`)) return;
  deletePlay(play.id);
  if (S.play.id === play.id) {
    const rest = listPlays();
    if (rest.length) loadPlay(rest[rest.length - 1]);
    else { const fresh = newPlay(); savePlay(fresh); loadPlay(fresh); }
  }
  renderLibraryAll();
}

/** A row action button that does not also open the play. */
function actionButton(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'play-action';
  b.textContent = label;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(b); });
  return b;
}

/** Run a sheet change from a row button, showing progress and any failure. */
async function rowAction(button, busy, run, statusSel) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busy;
  const result = await run();
  if (!result.ok) {
    button.disabled = false;
    button.textContent = label;
    const status = $(statusSel);
    if (status) {
      status.className = 'small missing';
      status.textContent = result.message;
    }
    return false;
  }
  return true;
}

/** Device -> admin playbook. The copy on this device is kept. */
async function saveToAdmin(play, button) {
  const ok = await rowAction(button, 'Saving…', () => saveTeamPlay(play, 'admin'), '#admin-status');
  if (ok) renderAdminBook();
}

async function removeFromAdmin(play, button) {
  if (!confirm(`Remove “${play.name}” from the admin playbook?\n\nA copy on this device, if there is one, is kept.`)) return;
  const ok = await rowAction(button, 'Removing…', () => deleteTeamPlay(play.id, 'admin'), '#admin-status');
  if (ok) renderAdminBook();
}

/**
 * Team <-> admin playbook, in one script call. Taking a play off the team
 * playbook changes what everyone sees, so that direction asks first.
 */
async function moveBetween(play, from, to, button) {
  const question = from === 'team'
    ? `Move “${play.name}” to the admin playbook?\n\nIt comes off the team playbook: everyone else loses it on their next refresh.`
    : `Move “${play.name}” to the team playbook?\n\nEveryone sees it on their next refresh, and it comes out of the admin playbook.`;
  if (!confirm(question)) return;

  const status = from === 'admin' ? '#admin-status' : '#team-status';
  const ok = await rowAction(button, 'Moving…', () => movePlay(play.id, from, to), status);
  if (!ok) return;
  await Promise.all([renderTeam(), renderAdminBook()]);
}

async function renderTeam() {
  const { plays, playbooks, error } = await fetchTeamPlays();
  S.team = plays;
  S.teamPlaybooks = playbooks || [];
  S.teamError = error;

  renderLibraryAll();   // published badges depend on the team list
  if (S.viewer) openFirstTeamPlay();
}

/** A viewer lands on a team play, never on a blank floor. */
function openFirstTeamPlay() {
  const shown = scopedPlays(S.team);
  if (shown.some((p) => p.id === S.play.id)) return;
  if (shown.length) openViewerPlay(shown[0]);
}

let viewerSeq = 0;

/**
 * Show one team play to a player.
 *
 * A player's list holds names only (the script sends nothing more), so the
 * play itself is downloaded on every tap — even one opened a minute ago.
 * Nothing is kept for re-use: each tap is checked against the sign-in as it is
 * now, so after "Sign everyone out" the very next tap ends the session.
 *
 * Without a newer script the list already holds the full plays, and they are
 * simply shown as before.
 */
async function openViewerPlay(entry) {
  if (!entry.summary) {
    viewerStatus('');
    loadPlay(structuredClone(entry));
    renderTeamList();
    return;
  }

  const seq = ++viewerSeq;
  // Clear the court at once: the previous play must not sit there looking
  // like the one just tapped.
  loadPlay({ ...newPlay({ name: entry.name }), id: entry.id, courtType: entry.courtType });
  renderTeamList();
  viewerStatus('Loading play…', { loading: true });

  const result = await fetchTeamPlay(entry.id);
  if (seq !== viewerSeq) return;   // a newer tap has taken over

  if (result.ok) {
    viewerStatus('');
    loadPlay(result.play);
    renderTeamList();
    return;
  }
  if (result.reason === 'auth') {
    signOutHere();
    return;
  }
  viewerStatus(result.message, { retry: () => openViewerPlay(entry) });
}

/** The line under the play's name in the player's view: loading, or a problem with Retry. */
function viewerStatus(text, { loading = false, retry = null } = {}) {
  const status = $('#vb-status');
  if (!status) return;
  $('.court-wrap')?.classList.toggle('loading', loading);
  status.replaceChildren();
  status.hidden = text === '';
  if (!text) return;
  status.className = loading ? 'small muted' : 'small missing';
  status.append(document.createTextNode(text));
  if (retry) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-small';
    b.textContent = 'Retry';
    b.addEventListener('click', retry);
    status.append(document.createTextNode(' '), b);
  }
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

  // Only mention publishing to someone who can actually do it.
  const deviceBlurb = $('#device-blurb');
  if (deviceBlurb) {
    deviceBlurb.textContent = canPublish()
      ? 'Saved only in this browser. Publish to team playbook to see it on other devices.'
      : 'Saved only in this browser.';
  }

  const blurb = $('#team-blurb');
  if (blurb && S.viewer) {
    blurb.textContent = 'View only — tap a play to see it.';
  } else if (blurb) {
    blurb.textContent = usingScript()
      ? 'Saved in the team sheet — the same on every device, and not readable without signing in. Opening one copies it here so you can edit it.'
      : 'Published to the site in plays/ — the same on every device. Opening one copies it here so you can edit it.';
  }

  for (const play of shown) list.append(playRow(play, 'team'));
}

/* ------------------------------------------------------------------ */
/* Admin playbook                                                      */
/* ------------------------------------------------------------------ */

/**
 * Build the admin playbook card, or take it away.
 *
 * Like the Stats and Admin links, the card is created by JavaScript for an
 * admin only, so for everyone else it is not hidden — it is never built. The
 * script is the real limit: it answers a non-admin token as if the admin
 * playbook did not exist.
 */
function syncAdminCard() {
  const want = !S.viewer && canUseAdminBook();
  const existing = $('#admin-card');

  if (!want) {
    if (existing) existing.remove();
    S.adminOn = false;
    S.admin = [];
    S.adminPlaybooks = [];
    return false;
  }
  if (existing) return true;

  const card = document.createElement('details');
  card.className = 'card collapsible';
  card.id = 'admin-card';
  card.dataset.collapse = 'admin';
  card.open = true;

  const summary = document.createElement('summary');
  summary.className = 'pb-side-head';
  const h2 = document.createElement('h2');
  h2.textContent = 'Admin playbook';
  const count = document.createElement('span');
  count.className = 'pill';
  count.id = 'admin-count';
  count.textContent = '0';
  summary.append(h2, count);

  const blurb = document.createElement('p');
  blurb.className = 'small muted';
  blurb.textContent = 'Only you see this. Saved in the sheet, so it is the same on all your devices. Opening one copies it here so you can edit it.';
  const status = document.createElement('p');
  status.className = 'small';
  status.id = 'admin-status';
  const list = document.createElement('ul');
  list.className = 'play-list';
  list.id = 'admin-list';

  card.append(summary, blurb, status, list);
  $('#team-card').after(card);
  bindCollapsible(card, readCollapsed());

  S.adminOn = true;
  return true;
}

async function renderAdminBook() {
  if (!syncAdminCard()) {
    renderLibraryAll();
    return;
  }
  const { plays, playbooks, error } = await fetchTeamPlays('admin');
  S.admin = plays;
  S.adminPlaybooks = playbooks || [];
  S.adminError = error;
  renderLibraryAll();   // device badges and the playbook picker depend on it
}

/** Render only — changing the playbook picker must not refetch the sheet. */
function renderAdminList() {
  const list = $('#admin-list');
  if (!list) return;
  const status = $('#admin-status');
  const shown = scopedPlays(S.admin);

  $('#admin-count').textContent = String(shown.length);
  list.replaceChildren();

  if (S.adminError) {
    status.className = 'small missing';
    status.textContent = `Couldn't load the admin playbook — ${S.adminError}`;
  } else if (S.admin.length === 0) {
    status.className = 'small muted';
    status.textContent = 'Nothing here yet. Use “Save to admin playbook” on a play on this device.';
  } else if (shown.length === 0) {
    status.className = 'small muted';
    status.textContent = 'Nothing in this playbook here yet.';
  } else {
    status.className = 'small muted';
    status.textContent = '';
  }

  for (const play of shown) list.append(playRow(play, 'admin'));
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

/** Read and remove ?open=<id>, so a reload doesn't keep reopening it. */
function takeOpenParam() {
  const q = new URLSearchParams(location.search);
  const id = q.get('open');
  if (id == null) return null;
  q.delete('open');
  const qs = q.toString();
  history.replaceState(null, '', qs ? `${location.pathname}?${qs}` : location.pathname);
  return id;
}

function writePlaybookParam() {
  const q = new URLSearchParams(location.search);
  if (S.lib.playbook) q.set('playbook', S.lib.playbook);
  else q.delete('playbook');
  const qs = q.toString();
  history.replaceState(null, '', qs ? `${location.pathname}?${qs}` : location.pathname);
}

function refreshPlaybooks() {
  // A viewer has no device plays or playbooks of their own, so the picker
  // counts the team's plays only.
  S.playbooks = S.viewer
    ? mergePlaybooks(S.teamPlaybooks.map((pb) => ({ ...pb, plays: [] })), [], S.team)
    : mergePlaybooks(S.teamPlaybooks, [...readLocalPlaybooks(), ...S.adminPlaybooks], listPlays());

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
  renderAdminList();
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
 * Any coach signed in with the team password (or the admin) can publish. A
 * view-only sign-in never sees the button.
 */
function refreshPublishToSheet(link, note) {
  link.removeAttribute('href');
  link.dataset.action = 'sheet';

  const published = S.team.some((t) => t.id === S.play.id);

  // Not disabled with a label — removed. A viewer sees a playbook to read, and
  // nothing else.
  if (!canPublish() || S.viewer) {
    link.hidden = true;
    note.hidden = true;
    return;
  }

  link.hidden = false;
  note.hidden = false;
  link.classList.remove('disabled');
  link.textContent = published ? 'Update on team playbook' : 'Publish to team playbook';
  note.className = 'small muted';
  note.textContent = 'Saves straight to the team playbook — everyone sees it on their next refresh.';
}

async function publishToSheet() {
  const link = $('#p-publish');
  const note = $('#publish-note');
  if (!canPublish() || S.viewer) return;

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
  defs: (id) => defs(id),
  renderToken: (t) => renderToken(t),
  renderArrow: (a, markerId) => renderArrow(a, false, markerId),
  renderText: (t) => renderText(t),
};

/* ------------------------------------------------------------------ */
/* Save to opponent playbook                                           */
/* ------------------------------------------------------------------ */

/**
 * Admin and coaches with Scouting get the button; nobody else has it at all.
 * The script refuses anyone else's save regardless.
 */
function syncOpponentButton() {
  $('#p-opponent').hidden = S.viewer || !canSaveOpponentPlays();
}

let pickerOpener = null;

async function openOpponentPicker(e) {
  if (S.viewer || !canSaveOpponentPlays()) return;
  pickerOpener = e && e.currentTarget;
  const select = $('#opp-game');
  const status = $('#opp-status');
  const save = $('#opp-save');

  select.replaceChildren(new Option('Loading games…', ''));
  select.disabled = true;
  save.disabled = true;
  $('#opp-remove').checked = false;
  status.className = 'small';
  status.textContent = '';
  $('#opp-picker').hidden = false;
  select.focus();

  const res = await fetchSchedule();
  if ($('#opp-picker').hidden) return;   // closed while loading
  if (!res.ok) {
    select.replaceChildren(new Option('—', ''));
    status.className = 'small missing';
    status.textContent = res.message;
    return;
  }

  const games = pickerGames(res.schedule);
  select.replaceChildren();
  if (games.length === 0) {
    select.append(new Option('No games on the schedule', ''));
    status.className = 'small muted';
    status.textContent = 'Add the game to the Games tab first.';
    return;
  }
  const groups = new Map();
  for (const g of games) {
    if (!groups.has(g.group)) {
      const og = document.createElement('optgroup');
      og.label = g.group;
      groups.set(g.group, og);
      select.append(og);
    }
    groups.get(g.group).append(new Option(g.label, g.gameId));
  }
  select.disabled = false;
  save.disabled = false;
  select.focus();
}

function closeOpponentPicker() {
  $('#opp-picker').hidden = true;
  pickerOpener?.focus?.();
  pickerOpener = null;
}

async function onSaveOpponentPlay() {
  const gameId = $('#opp-game').value;
  if (!gameId) return;
  const save = $('#opp-save');
  const status = $('#opp-status');
  save.disabled = true;
  save.textContent = 'Saving…';

  // Whatever is on screen right now, including edits the autosave hasn't
  // written yet.
  const play = structuredClone(S.play);
  const result = await saveOpponentPlay(gameId, play);
  save.textContent = 'Save';

  if (!result.ok) {
    save.disabled = false;
    status.className = 'small missing';
    status.textContent = result.message;
    return;
  }

  const removeLocal = $('#opp-remove').checked;
  closeOpponentPicker();

  if (removeLocal) {
    deletePlay(play.id);
    const rest = listPlays();
    if (rest.length) loadPlay(rest[rest.length - 1]);
    else { const fresh = newPlay(); savePlay(fresh); loadPlay(fresh); }
    renderLibraryAll();
  }

  // Last, because loading a play rewrites this line.
  const note = $('#publish-note');
  note.className = 'small';
  note.textContent = `${result.replaced ? 'Updated' : 'Saved'} “${play.name || 'Untitled play'}” in ${result.opponent}'s scouting report.`
    + (removeLocal ? ' The copy on this device was removed.' : '');
}

function bindOpponentPicker() {
  $('#p-opponent').addEventListener('click', openOpponentPicker);
  $('#opp-cancel').addEventListener('click', closeOpponentPicker);
  $('#opp-save').addEventListener('click', onSaveOpponentPlay);
  // A tap on the dimmed background closes it, like the video player.
  $('#opp-picker').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeOpponentPicker();
  });
}

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
function readCollapsed() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(COLLAPSE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function bindCollapsible(card, saved) {
  const key = card.dataset.collapse;
  if (key in saved) card.open = Boolean(saved[key]);

  card.addEventListener('toggle', () => {
    // Re-read, so two cards toggled in one visit don't overwrite each other.
    const now = readCollapsed();
    now[key] = card.open;
    try {
      globalThis.localStorage?.setItem(COLLAPSE_KEY, JSON.stringify(now));
    } catch {
      /* blocked storage: collapsing still works, it just won't be remembered */
    }
  });
}

function bindCollapsibles() {
  const saved = readCollapsed();
  for (const card of document.querySelectorAll('[data-collapse]')) bindCollapsible(card, saved);
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
  $('#fr-add').addEventListener('click', addFrame);
  $('#fr-del').addEventListener('click', deleteFrame);
  $('#fr-play').addEventListener('click', () => (S.anim ? stopAnimation() : startAnimation()));

  // Touching anything else — the court, a step, a tool, another play — stops
  // the animation first, so it never fights an edit. Capture phase, so this
  // runs before whatever the press was meant for.
  document.addEventListener('pointerdown', (e) => {
    if (S.anim && !e.target.closest?.('#fr-play')) stopAnimation();
  }, true);
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
  bindOpponentPicker();

  $('#p-export').addEventListener('click', () => {
    download(`${slugify(S.play.name)}.json`, exportPlay(S.play));
  });
  $('#p-delete').addEventListener('click', () => deleteDevicePlay(S.play));

  $('#lib-playbook').addEventListener('change', (e) => {
    S.lib.playbook = e.target.value;
    writePlaybookParam();
    renderLibraryAll();
    if (S.viewer) openFirstTeamPlay();
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
    // The video overlay takes over the keyboard while it is open.
    if (!$('#opp-picker').hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeOpponentPicker(); }
      return;
    }
    if (!$('#video-overlay').hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeVideo(); }
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (typing) return;

    if (S.anim) {
      // Space toggles; any other key stops and then does what it normally does.
      if (e.key === ' ' && e.target.id !== 'fr-play') { e.preventDefault(); stopAnimation(); return; }
      stopAnimation();
    } else if (e.key === ' ' && e.target === document.body) {
      e.preventDefault();
      startAnimation();
      return;
    }

    // A viewer gets the arrow keys for stepping through, and nothing that edits.
    if (S.viewer) {
      if (e.key === 'ArrowLeft') $('#fr-prev').click();
      if (e.key === 'ArrowRight') $('#fr-next').click();
      return;
    }

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
  bindVideo();
  bind();
  bindCollapsibles();

  // A returning viewer is known before anything loads, so their browser never
  // gets a blank play saved into it. A first-time viewer is caught at sign-in.
  if (isViewer()) {
    enterViewerMode();
  } else if (listPlays().length) {
    // ?open=<id> opens that play (the Scouting page's "Open in builder" sends
    // you here); otherwise reopen whatever was last worked on.
    const existing = listPlays();
    const asked = takeOpenParam();
    const latest = existing.find((p) => p.id === asked)
      || [...existing].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
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
    if (!S.viewer && isViewer()) enterViewerMode();
    renderTeam();
    if (!S.viewer) {
      loadRoster();
      if (canUseAdminBook()) renderAdminBook();
    }
    syncOpponentButton();
  });

  // The script's answer about features arrives after the page has loaded, and
  // can change between visits. Add or take away the admin card to match.
  document.addEventListener('bb:features', () => {
    if (!S.viewer) renderAdminBook();
    syncOpponentButton();
  });
}

/**
 * Turn the editor into a viewer for the team playbook.
 *
 * Runs after sign-in rather than at load, because a first-time viewer signs
 * in after this module has already started. The CSS under `.viewer` hides the
 * editing controls; the S.viewer guards make sure nothing hidden can still be
 * reached by keyboard. The server is the real limit: a viewer token can read
 * plays and do nothing else.
 */
function enterViewerMode() {
  S.viewer = true;
  document.documentElement.classList.add('viewer');
  const heading = document.querySelector('main > h1');
  if (heading) heading.textContent = 'Team Playbook';
  $('#pb-viewbox').hidden = false;

  clearTimeout(S.saveTimer);
  S.undo.length = 0;
  S.redo.length = 0;
  S.selection = null;
  S.lineup = {};

  // Nothing typed here would be kept, so nothing here takes typing.
  for (const sel of ['#p-name', '#p-category', '#p-tags', '#p-notes']) {
    $(sel).readOnly = true;
    $(sel).placeholder = '';   // example text reads as content in a read-only box
  }
  for (const sel of ['#p-court', '#p-preset', '#p-playbook']) $(sel).disabled = true;

  // The playbook picker lives in the device card, which a viewer doesn't see.
  const picker = $('#lib-playbook')?.closest('.field');
  const teamCard = $('#team-card');
  if (picker && teamCard) teamCard.querySelector('#team-blurb').after(picker);

  // A cancelled sign-in ends this page within minutes, even if nobody taps
  // anything: the page re-checks every few minutes and on returning to it.
  if (!S.sessionWatch && isEnabled(CONFIG.gate)) S.sessionWatch = watchSession();

  // Never show a device play to a viewer, even for the moment before the team
  // playbook arrives.
  S.play = newPlay({ name: '' });
  S.frame = 0;
  fillForm();
  render();
  setSaveState('saved');
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
