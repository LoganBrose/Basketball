/**
 * Print view — how a play becomes a PDF.
 *
 * No PDF library. `@media print` plus `window.print()` is "Save as PDF" on a
 * computer and share-to-PDF on a phone, costs nothing to load, and produces
 * real selectable text. A library would only earn its place if print couldn't
 * give a clean result, and it can.
 *
 * The courts are drawn with the same renderers the editor uses, so whatever is
 * on screen — including the lineup names currently on the tokens — is what
 * comes out on the page. The saved play JSON is never touched.
 */

import { courtSize, renderCourt, SVG_NS } from './court.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * One frame as a self-contained SVG.
 *
 * @param {Object} frame
 * @param {Object} play
 * @param {{renderToken: Function, renderArrow: Function, renderText: Function}} draw
 */
function frameSvg(frame, play, draw) {
  const { w, h } = courtSize(play.courtType);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('class', 'print-court');

  // Arrowheads are referenced per-SVG, so each frame carries its own defs.
  svg.append(draw.defs());
  renderCourt(svg, { type: play.courtType, preset: play.preset });

  const content = document.createElementNS(SVG_NS, 'g');
  for (const a of frame.arrows || []) content.append(draw.renderArrow(a));
  for (const t of frame.tokens || []) content.append(draw.renderToken(t));
  for (const t of frame.texts || []) content.append(draw.renderText(t));
  svg.append(content);

  return svg;
}

/** A play: heading, every frame, then notes. */
export function playSection(play, draw, { startOnNewPage = false } = {}) {
  const section = el('section', 'print-play' + (startOnNewPage ? ' page-break' : ''));

  const head = el('header', 'print-head');
  head.append(el('h1', null, play.name || 'Untitled play'));

  const meta = [play.category, ...(play.tags || [])].filter(Boolean);
  if (meta.length) head.append(el('p', 'print-meta', meta.join(' · ')));
  section.append(head);

  const frames = play.frames || [];
  const grid = el('div', 'print-frames');
  frames.forEach((frame, i) => {
    const box = el('figure', 'print-frame');
    box.append(frameSvg(frame, play, draw));
    box.append(el('figcaption', null, frame.label || `Step ${i + 1}`));
    grid.append(box);
  });
  section.append(grid);

  if (play.notes) {
    const notes = el('div', 'print-notes');
    notes.append(el('h2', null, 'Notes'));
    notes.append(el('p', null, play.notes));
    section.append(notes);
  }

  return section;
}

/** Cover page for a whole playbook: name, description, numbered contents. */
export function coverPage(playbook, plays) {
  const cover = el('section', 'print-cover');
  cover.append(el('h1', null, playbook.name || 'Playbook'));
  if (playbook.description) cover.append(el('p', 'print-meta', playbook.description));

  const ol = el('ol', 'print-contents');
  for (const play of plays) ol.append(el('li', null, play.name || 'Untitled play'));
  cover.append(ol);

  cover.append(el('p', 'print-meta', `${plays.length} play${plays.length === 1 ? '' : 's'}`));
  return cover;
}

/** Replace the print container's contents and hand it back. */
function printRoot() {
  let root = document.getElementById('print-root');
  if (!root) {
    root = el('div');
    root.id = 'print-root';
    document.body.append(root);
  }
  root.replaceChildren();
  return root;
}

/**
 * Build the page and open the print dialog.
 *
 * The dialog is opened on the next frame so the browser has laid the SVGs out
 * first — printing mid-layout is how courts end up clipped.
 */
function present(root) {
  document.body.classList.add('printing');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.print();
      document.body.classList.remove('printing');
    });
  });
  return root;
}

export function printPlay(play, draw) {
  const root = printRoot();
  root.append(playSection(play, draw));
  return present(root);
}

export function printPlaybook(playbook, plays, draw) {
  const root = printRoot();
  root.append(coverPage(playbook, plays));
  // Each play starts its own page; the cover already occupies the first.
  for (const play of plays) root.append(playSection(play, draw, { startOnNewPage: true }));
  return present(root);
}
