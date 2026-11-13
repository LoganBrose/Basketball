/**
 * The Scouting page.
 *
 * Everything here is shaped by what the Apps Script sends. The script decides
 * who may see which games and which fields — a viewer's reply simply has no
 * notes in it — so this file renders whatever arrived and never hides a field
 * it was given. Edit controls appear only when the script says `canEdit`, and
 * the script checks again on every save.
 *
 * All text goes in with textContent. Nothing a coach types is ever parsed as
 * HTML.
 */

import { CONFIG } from './config.js';
import { callScript, isEnabled, bestToken, readSession, sessionValid, siteMaxAge } from './gate.js';
import { hasFeature } from './features.js';
import {
  groupGames, dateParts, whenText, matchup, playerTitle, statsLink, savedText, scoutMessage,
} from './scout.js';
import { mountPlayViewer } from './playviewer.js';
import { deleteOpponentPlay } from './opponentplays.js';
import { listPlays, savePlay } from './library.js';
import { createDrawer } from './draw.js';
import { printScoutReport } from './printout.js';

/**
 * Renderers for paper. No lineup: these are the opponent's players, so the
 * tokens print their slot numbers, exactly as on the page.
 */
const opponentDraw = createDrawer({ playerFor: () => null });
const printDraw = {
  defs: (id) => opponentDraw.defs(id),
  renderToken: (t) => opponentDraw.renderToken(t),
  renderArrow: (a, markerId) => opponentDraw.renderArrow(a, false, markerId),
  renderText: (t) => opponentDraw.renderText(t),
};

const root = document.getElementById('scout-root');
const S = { schedule: null };

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const el = (tag, opts = {}, ...children) => {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = opts.text;
  for (const [k, v] of Object.entries(opts.attrs || {})) if (v != null) node.setAttribute(k, v);
  for (const child of children) if (child) node.append(child);
  return node;
};

const button = (text, onClick, cls = 'btn') => {
  const b = el('button', { class: cls, text, attrs: { type: 'button' } });
  b.addEventListener('click', onClick);
  return b;
};

const call = (action, extra = {}) => callScript(CONFIG.gate.url, { action, token: bestToken(), ...extra });

/** Somewhere this login cannot be: back to the playbook, as stats.html does. */
const leave = () => globalThis.location.replace('playbook.html');

/** A refusal that means "no scouting for you" — leave rather than show an error. */
const refused = (result) => result.ok && result.data?.reason === 'unknown_action';

/* ------------------------------------------------------------------ */
/* The schedule                                                        */
/* ------------------------------------------------------------------ */

async function loadSchedule() {
  root.replaceChildren(el('p', { class: 'small muted', text: 'Loading…' }));
  const result = await call('scoutGames');
  if (refused(result)) { leave(); return; }

  if (!result.ok || !result.data?.ok) {
    root.replaceChildren(el('div', { class: 'card' },
      el('p', { class: 'small missing', text: scoutMessage(result) }),
      button('Retry', loadSchedule)));
    return;
  }

  S.schedule = result.data;
  renderSchedule();
}

function renderSchedule() {
  const sched = S.schedule;
  const { next, week, later } = groupGames(sched.upcoming);
  const viewer = sched.role === 'viewer';
  root.replaceChildren();

  const lede = document.getElementById('scout-lede');
  if (lede) {
    lede.textContent = viewer
      ? `Each report opens ${sched.windowDays || 7} days before the game.`
      : 'The next game first. Tap any other game to open its report.';
  }

  if (!next) {
    root.append(el('div', { class: 'card' }, el('p', {
      class: 'muted',
      text: viewer ? 'No scouting reports are open yet.' : 'No upcoming games on the Games tab.',
    })));
  } else {
    // The next game: fully open, report and all.
    const card = el('section', { class: 'card scout-next' });
    card.append(gameHeading(next, 'h2'));
    const body = el('div', { class: 'scout-report' });
    card.append(body);
    root.append(el('h2', { class: 'section-label', text: 'Next game' }), card);
    loadReport(body, next.gameId);
  }

  if (week.length) {
    root.append(el('h2', { class: 'section-label', text: 'This week' }));
    for (const g of week) root.append(gameCard(g));
  }

  // Further out, and the archive: admin and coaches only. A player's list
  // never contains these — the script stops it at the window.
  if (later.length) root.append(gameGroup(`Later games (${later.length})`, later));
  if (sched.past?.length) root.append(gameGroup(`Past games (${sched.past.length})`, sched.past));
}

/** "Fri · Nov 20" chip, "at North", "In 7 days · Away". */
function gameHeading(game, tag = 'h3') {
  const d = dateParts(game.date);
  const head = el('div', { class: 'scout-head' });
  head.append(el('span', { class: 'scout-date' },
    el('span', { class: 'scout-day', text: d.weekday }),
    el('span', { class: 'scout-md', text: d.short })));
  const title = el('div', { class: 'scout-title' });
  title.append(el(tag, { text: matchup(game) }));
  const bits = [whenText(game.daysAway), game.homeAway].filter(Boolean);
  title.append(el('span', { class: 'small muted', text: bits.join(' · ') }));
  head.append(title);
  return head;
}

/** A tappable game that opens its report in place, fetched the first time. */
function gameCard(game) {
  const card = el('details', { class: 'card scout-game' });
  const summary = el('summary', {}, gameHeading(game));
  const body = el('div', { class: 'scout-report' });
  card.append(summary, body);
  card.addEventListener('toggle', () => {
    if (card.open && !body.dataset.loaded) {
      body.dataset.loaded = '1';
      loadReport(body, game.gameId);
    }
  });
  return card;
}

function gameGroup(label, games) {
  const group = el('details', { class: 'panel scout-group' });
  group.append(el('summary', { text: label }));
  const inner = el('div', { class: 'panel-body' });
  for (const g of games) inner.append(gameCard(g));
  group.append(inner);
  return group;
}

/* ------------------------------------------------------------------ */
/* One report                                                          */
/* ------------------------------------------------------------------ */

async function loadReport(host, gameId) {
  host.replaceChildren(el('p', { class: 'small muted', text: 'Loading report…' }));
  const result = await call('scoutReport', { gameId });
  if (refused(result)) { leave(); return; }
  if (!result.ok || !result.data?.ok) {
    host.replaceChildren(el('p', { class: 'small missing', text: scoutMessage(result) }),
      button('Retry', () => loadReport(host, gameId)));
    return;
  }
  renderReport(host, result.data);
}

function renderReport(host, r) {
  host.replaceChildren();
  const reload = () => loadReport(host, r.game.gameId);
  const ctx = { gameId: r.game.gameId, canEdit: r.canEdit, reload };

  // Prints exactly what this login was sent: a coach's PDF has no private
  // notes because a coach's report never had any.
  host.append(el('div', { class: 'scout-report-actions' },
    button('Export scouting PDF', () => printScoutReport(r, printDraw), 'btn btn-small')));

  // Only what arrived is drawn; a viewer's reply has no notes in it at all.
  // Players get the overview's text only, and an empty one isn't shown to them.
  if (r.overview && (r.canEdit || String(r.overview.text || '').trim())) {
    host.append(notesBlock(ctx, {
      kind: 'overview', title: `About ${r.game.opponent}`, note: r.overview,
      hint: r.canEdit ? 'Kept for every game against them.' : '',
    }));
  }

  host.append(playersBlock(ctx, r.players || []));

  if (r.privateNotes) {
    host.append(notesBlock(ctx, {
      kind: 'private', title: 'Private notes', note: r.privateNotes,
      hint: 'Only you see these. Coaches and players never receive them.',
      cls: 'scout-private',
    }));
  }

  // Their plays go last, after everything said about them.
  host.append(theirPlaysBlock(ctx, r.game.opponent, r.plays || []));
}

/**
 * The opponent's plays: each one stepped through and animated like ours.
 * They are drawn in the play builder and saved here with "Save to opponent
 * playbook"; they never appear in any of our playbooks.
 */
function theirPlaysBlock(ctx, opponent, plays) {
  const block = el('section', { class: 'scout-block' });
  block.append(el('div', { class: 'scout-block-head' }, el('h3', { text: 'Their plays' })));

  if (plays.length === 0) {
    block.append(el('p', {
      class: 'small muted',
      text: ctx.canEdit
        ? `None yet. Draw one in the Playbook, then press “Save to opponent playbook” and pick a game against ${opponent}.`
        : 'None yet.',
    }));
    return block;
  }

  for (const p of plays) {
    const item = el('div', { class: 'scout-opp-play' });
    item.append(el('h4', { text: p.name || p.play?.name || 'Untitled play' }));
    const viewer = el('div');
    item.append(viewer);
    mountPlayViewer(viewer, p.play || {});

    if (ctx.canEdit) {
      const meta = savedText(p);
      if (meta) item.append(el('p', { class: 'small muted', text: meta }));
      const actions = el('div', { class: 'play-actions' });
      actions.append(button('Open in builder', () => openInBuilder(p), 'play-action'));
      const del = button('Remove', async () => {
        if (!confirm(`Remove “${p.name}” from ${opponent}'s plays? It comes off every report against them.`)) return;
        del.disabled = true;
        const result = await deleteOpponentPlay(ctx.gameId, p.id);
        if (!result.ok) {
          del.disabled = false;
          alert(result.message);
          return;
        }
        ctx.reload();
      }, 'play-action danger');
      actions.append(del);
      item.append(actions);
    }
    block.append(item);
  }
  return block;
}

/**
 * Copy an opponent play onto this device and open it in the builder, like
 * opening a team play. It keeps the id it was saved from, so "Save to opponent
 * playbook" afterwards updates this play rather than adding a second one.
 */
function openInBuilder(p) {
  const id = p.sourceId || p.id;
  const existing = listPlays().find((x) => x.id === id);
  const replace = !existing || confirm(
    `This device already has “${existing.name}”.\n\nOK: replace it with the version in the scouting report.\nCancel: open the copy on this device.`,
  );
  if (replace) savePlay({ ...structuredClone(p.play), id, name: p.name || p.play?.name }, { touch: false });
  globalThis.location.href = `playbook.html?open=${encodeURIComponent(id)}`;
}

/** Overview or private notes: text, who saved it, and Edit. */
function notesBlock(ctx, { kind, title, note, hint, cls = '' }) {
  const block = el('section', { class: `scout-block ${cls}`.trim() });
  const head = el('div', { class: 'scout-block-head' }, el('h3', { text: title }));
  block.append(head);

  const view = el('div');
  view.append(note.text
    ? el('p', { class: 'scout-text', text: note.text })
    : el('p', { class: 'small muted', text: 'Nothing yet.' }));
  const meta = savedText(note);
  const foot = [hint, meta].filter(Boolean).join(' ');
  if (foot) view.append(el('p', { class: 'small muted', text: foot }));
  block.append(view);

  if (!ctx.canEdit) return block;

  head.append(button('Edit', () => {
    const area = el('textarea', { attrs: { rows: '5', maxlength: '5000', 'aria-label': title } });
    area.value = note.text || '';
    const status = el('p', { class: 'small' });
    const save = button('Save', async () => {
      save.disabled = true;
      save.textContent = 'Saving…';
      const result = await call('saveScoutNotes', { gameId: ctx.gameId, kind, text: area.value });
      if (refused(result) && kind !== 'private') { leave(); return; }
      const msg = scoutMessage(result);
      if (msg) {
        save.disabled = false;
        save.textContent = 'Save';
        status.className = 'small missing';
        status.textContent = msg;
        return;
      }
      ctx.reload();
    }, 'btn btn-primary');
    const form = el('div', { class: 'scout-form' }, area,
      el('div', { class: 'pb-actions' }, save, button('Cancel', () => form.replaceWith(view))), status,
      el('p', { class: 'small muted', text: 'If someone else saves this at the same time, the later save replaces the earlier one.' }));
    view.replaceWith(form);
    area.focus();
  }, 'btn btn-small'));

  return block;
}

/** Key players: who to know, a line on each, and their stats page. */
function playersBlock(ctx, players) {
  const block = el('section', { class: 'scout-block' });
  const head = el('div', { class: 'scout-block-head' }, el('h3', { text: 'Key players' }));
  block.append(head);

  const list = el('ul', { class: 'scout-players' });
  if (players.length === 0) {
    list.append(el('li', { class: 'small muted', text: 'No key players yet.' }));
  }
  for (const p of players) list.append(playerItem(ctx, p));
  block.append(list);

  if (ctx.canEdit) {
    head.append(button('Add player', () => {
      const form = playerForm(ctx, {}, () => form.remove());
      list.before(form);
    }, 'btn btn-small'));
  }
  return block;
}

function playerItem(ctx, p) {
  const li = el('li', { class: 'scout-player' });
  const top = el('div', { class: 'scout-player-top' });
  top.append(el('strong', { text: playerTitle(p) }));

  const link = statsLink(p.statsUrl);
  if (link) {
    top.append(el('a', {
      class: 'btn btn-small',
      text: 'View stats',
      attrs: { href: link, target: '_blank', rel: 'noopener noreferrer' },
    }));
  }
  li.append(top);
  if (p.blurb) li.append(el('p', { class: 'scout-text', text: p.blurb }));

  if (ctx.canEdit) {
    const meta = savedText(p);
    if (meta) li.append(el('p', { class: 'small muted', text: meta }));
    const actions = el('div', { class: 'play-actions' });
    actions.append(button('Edit', () => li.replaceWith(playerForm(ctx, p, () => ctx.reload())), 'play-action'));
    const del = button('Remove', async () => {
      if (!confirm(`Remove ${playerTitle(p) || 'this player'} from the scouting report?`)) return;
      del.disabled = true;
      const result = await call('deleteScoutPlayer', { gameId: ctx.gameId, id: p.id });
      if (refused(result)) { leave(); return; }
      ctx.reload();
    }, 'play-action danger');
    actions.append(del);
    li.append(actions);
  }
  return li;
}

/** Add or edit one key player. */
function playerForm(ctx, p, onCancel) {
  const field = (label, input) => el('div', { class: 'field' }, el('label', { text: label }), input);
  const input = (attrs, value = '') => {
    const i = el('input', { attrs });
    i.value = value;
    return i;
  };

  const number = input({ type: 'text', maxlength: '4', inputmode: 'numeric', placeholder: '23' }, p.number);
  const name = input({ type: 'text', maxlength: '60', placeholder: 'Full name' }, p.name);
  const position = input({ type: 'text', maxlength: '20', placeholder: 'G, F, C…' }, p.position);
  const blurb = el('textarea', { attrs: { rows: '3', maxlength: '500', placeholder: 'Left-handed. Wants to drive middle.' } });
  blurb.value = p.blurb || '';
  const stats = input({ type: 'url', maxlength: '500', inputmode: 'url', placeholder: 'https://www.maxpreps.com/…' }, p.statsUrl);
  const status = el('p', { class: 'small' });

  const save = button('Save player', async () => {
    const typed = stats.value.trim();
    const url = typed ? statsLink(typed) : '';
    if (typed && !url) {
      status.className = 'small missing';
      status.textContent = "That stats link isn't a web address. It should start with https://";
      return;
    }
    save.disabled = true;
    save.textContent = 'Saving…';
    const result = await call('saveScoutPlayer', {
      gameId: ctx.gameId,
      player: {
        id: p.id || undefined, number: number.value, name: name.value, position: position.value,
        blurb: blurb.value, statsUrl: url, order: p.order || 0,
      },
    });
    if (refused(result)) { leave(); return; }
    const msg = scoutMessage(result);
    if (msg) {
      save.disabled = false;
      save.textContent = 'Save player';
      status.className = 'small missing';
      status.textContent = msg;
      return;
    }
    ctx.reload();
  }, 'btn btn-primary');

  const form = el('div', { class: 'scout-form scout-player-form' },
    el('div', { class: 'pb-two' }, field('Number', number), field('Position', position)),
    field('Name', name),
    field('Blurb', blurb),
    field('Stats link', stats),
    el('p', { class: 'small muted', text: 'Any page with their stats, such as MaxPreps or a league site. The link is stored; nothing is fetched from it.' }),
    el('div', { class: 'pb-actions' }, save, button('Cancel', onCancel)),
    status);
  return form;
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

/**
 * Run once a site session exists. gate.js may already have announced the
 * sign-in before this module ran, so the stored session is checked first.
 */
function whenSignedIn(fn) {
  const gate = CONFIG.gate || {};
  if (sessionValid(readSession(), siteMaxAge(gate))) {
    fn();
    return;
  }
  document.addEventListener('bb:signedin', fn, { once: true });
}

function start() {
  // Scouting lives in the script; with sign-in off there is nothing to show.
  if (!isEnabled(CONFIG.gate)) { leave(); return; }

  whenSignedIn(() => {
    if (!hasFeature('scouting')) { leave(); return; }
    loadSchedule();
  });

  // A stage rolled back while this page was open.
  document.addEventListener('bb:features', () => {
    if (!hasFeature('scouting')) leave();
  });

  document.getElementById('scout-refresh')?.addEventListener('click', loadSchedule);
}

start();
