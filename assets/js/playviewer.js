/**
 * A play you can look at but not edit: the court, the step it is on, and
 * Previous / Next / ▶ Play — the same animation as the builder, from the same
 * planStep and tokensAt, at the same speed.
 *
 * Used on the Scouting page for the opponent's plays. Their tokens show the
 * slot number only: our lineup names belong on our plays, not theirs.
 */

import { courtSize, renderCourt } from './court.js';
import { planStep, tokensAt, normalizePlay } from './library.js';
import { createDrawer, node } from './draw.js';

/** The builder's timings, so a play moves the same everywhere. */
export const STEP_MS = 1400;
export const STEP_STILL_MS = 1000;

/** The step to show after pressing Previous or Next, kept inside the play. */
export function stepTo(index, delta, count) {
  return Math.max(0, Math.min(count - 1, index + delta));
}

/** "Step 2 of 4 · Swing", leaving out a label nobody wrote. */
export function stepLabel(frame, index, count) {
  const label = frame && frame.label ? ` · ${frame.label}` : '';
  return `Step ${index + 1} of ${count}${label}`;
}

let seq = 0;

/**
 * @param {HTMLElement} host  emptied and filled with the viewer
 * @param {Object} raw        a play, as saved
 * @returns {{stop: Function}}
 */
export function mountPlayViewer(host, raw) {
  const play = normalizePlay(raw);
  const draw = createDrawer({ playerFor: () => null });
  const markerId = `ah-view-${++seq}`;
  const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const state = { frame: 0, anim: null };
  const count = play.frames.length;

  const svg = node('svg', { class: 'pv-court', role: 'img', 'aria-label': `Diagram: ${play.name}` });
  const wrap = document.createElement('div');
  wrap.className = 'court-wrap pv-wrap';
  wrap.append(svg);

  const label = document.createElement('span');
  label.className = 'small muted pv-step';

  const mk = (text, title, onClick, cls = 'btn btn-icon') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
  };
  const prev = mk('‹', 'Previous step', () => go(-1));
  const next = mk('›', 'Next step', () => go(1));
  const playBtn = mk('▶ Play', 'Watch the play move, from this step to the end', () => (state.anim ? stop() : start()), 'btn btn-play');

  const controls = document.createElement('div');
  controls.className = 'pv-controls';
  controls.append(prev, next, playBtn, label);

  host.replaceChildren(wrap, controls);
  if (play.notes) {
    const notes = document.createElement('p');
    notes.className = 'scout-text small';
    notes.textContent = play.notes;
    host.append(notes);
  }

  function frame() { return play.frames[state.frame]; }

  function render() {
    const { w, h } = courtSize(play.courtType);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.aspectRatio = `${w} / ${h}`;
    svg.replaceChildren(draw.defs(markerId));
    renderCourt(svg, { type: play.courtType, preset: play.preset });

    const f = frame();
    const content = node('g', { class: 'content' });
    if (state.anim) {
      const t = state.anim.still ? 0 : state.anim.t;
      const { tokens, flyingBalls } = tokensAt(f, t, state.anim.plan);
      const trail = node('g', { class: 'anim-trail' });
      for (const a of f.arrows) trail.append(draw.renderArrow(a, true, markerId));
      content.append(trail);
      for (const tok of tokens) content.append(draw.renderToken(tok, false, true));
      for (const b of flyingBalls) {
        content.append(node('circle', { cx: b.x, cy: b.y, r: 0.62, class: 'tok-ball anim-ball' }));
      }
      for (const tx of f.texts) content.append(draw.renderText(tx, true));
    } else {
      for (const a of f.arrows) content.append(draw.renderArrow(a, false, markerId));
      for (const tok of f.tokens) content.append(draw.renderToken(tok, false, true));
      for (const tx of f.texts) content.append(draw.renderText(tx, false));
    }
    svg.append(content);

    label.textContent = stepLabel(f, state.frame, count);
    prev.disabled = state.frame === 0 && !state.anim;
    next.disabled = state.frame >= count - 1 && !state.anim;
    playBtn.textContent = state.anim ? '■ Stop' : '▶ Play';
    playBtn.setAttribute('aria-pressed', state.anim ? 'true' : 'false');
  }

  function go(delta) {
    stop();
    state.frame = stepTo(state.frame, delta, count);
    render();
  }

  function start() {
    if (state.anim) return;
    // On the last step, Play replays the whole play.
    if (state.frame >= count - 1 && count > 1 && !(frame().arrows || []).length) state.frame = 0;
    state.anim = { t: 0, plan: planStep(frame()), raf: 0, last: null, still: reduced() };
    state.anim.raf = requestAnimationFrame(tick);
    render();
  }

  function tick(now) {
    const a = state.anim;
    if (!a) return;
    const dt = a.last == null ? 0 : now - a.last;
    a.last = now;
    a.t += dt / (a.still ? STEP_STILL_MS : STEP_MS);
    if (a.t >= 1) {
      if (state.frame >= count - 1) { stop(); return; }
      state.frame += 1;
      a.t = 0;
      a.plan = planStep(frame());
    }
    render();
    a.raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (!state.anim) return;
    cancelAnimationFrame(state.anim.raf);
    state.anim = null;
    render();
  }

  render();
  return { stop };
}
