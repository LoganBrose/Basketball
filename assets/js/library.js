/**
 * Play storage.
 *
 * Plays live in localStorage as structured JSON, never as images, so they stay
 * editable and searchable. Export/import moves the same JSON between devices —
 * on a static host that file *is* the sync mechanism.
 */

const KEY = 'bb.plays.v1';
export const SCHEMA_VERSION = 1;

/** localStorage throws in private mode and when site data is blocked. */
function readStore() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(plays) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(plays));
    return true;
  } catch {
    return false;
  }
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function emptyFrame(label = 'Initial') {
  return { label, tokens: [], arrows: [], texts: [] };
}

/** How far (feet) an arrow's end may sit from a player and still be theirs. */
const REACH = 2.5;
const MOVERS = new Set(['offense', 'defense', 'coach']);

/**
 * A point on an arrow, t from 0 to 1. A curved arrow is a quadratic Bézier
 * through its `ctrl` point; a straight one has none.
 */
export function pointAt(a, t) {
  if (!a.ctrl) {
    return { x: a.from.x + (a.to.x - a.from.x) * t, y: a.from.y + (a.to.y - a.from.y) * t };
  }
  const m = 1 - t;
  return {
    x: m * m * a.from.x + 2 * m * t * a.ctrl.x + t * t * a.to.x,
    y: m * m * a.from.y + 2 * m * t * a.ctrl.y + t * t * a.to.y,
  };
}

/**
 * What a step's arrows do to its tokens, worked out once and shared by
 * carryOverTokens (where the next step starts) and tokensAt (the animation),
 * so the two can never disagree.
 *
 * Arrows aren't linked to tokens, so each is claimed by the nearest player at
 * its start. Cuts, dribbles and screens move that player to the arrow's end;
 * a pass hands the ball to whoever is nearest its end, so passes are applied
 * after movement — a pass to a cutter lands on the cutter.
 *
 * Returns token indexes into frame.tokens, plus:
 *   mid   the tokens after movement, before any pass
 *   end   the tokens once the step is over
 *   moves    [{ index, arrow }]   a token following an arrow (a dribbled ball too)
 *   passes   [{ arrow, ballIdx, passerIdx, from, to }]  the ball in the air;
 *            ballIdx is null when the ball is a flag on the passer
 */
export function planStep(frame) {
  const tokens = structuredClone(frame.tokens || []).map((t) => ({ ...t, start: { x: t.x, y: t.y } }));
  const arrows = frame.arrows || [];
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const idx = (t) => (t ? tokens.indexOf(t) : null);

  const nearest = (pool, pt, at = (t) => [t.start]) => {
    let best = null;
    let bestD = REACH + 1e-9;
    for (const t of pool) {
      for (const p of at(t)) {
        const d = dist(p, pt);
        if (d < bestD) { best = t; bestD = d; }
      }
    }
    return best;
  };

  const balls = tokens.filter((t) => t.kind === 'ball');
  const moved = new Set();
  const moves = [];

  for (const a of arrows) {
    if (a.kind === 'pass') continue;
    const owner = nearest(tokens.filter((t) => MOVERS.has(t.kind) && !moved.has(t)), a.from);
    if (!owner) continue;
    moved.add(owner);
    moves.push({ index: idx(owner), arrow: a });
    if (a.kind === 'dribble') {
      const ball = nearest(balls.filter((b) => !moved.has(b)), owner.start);
      if (ball) {
        moved.add(ball);
        ball.x = a.to.x; ball.y = a.to.y;
        moves.push({ index: idx(ball), arrow: a });
      }
    }
    owner.x = a.to.x;
    owner.y = a.to.y;
  }

  const strip = (list) => list.map(({ start, ...t }) => structuredClone(t));
  const mid = strip(tokens);

  const players = tokens.filter((t) => MOVERS.has(t.kind));
  const passes = [];
  for (const a of arrows) {
    if (a.kind !== 'pass') continue;
    const passer = nearest(players, a.from);
    const receiver = nearest(players, a.to, (t) => [t.start, t]);
    const ball = nearest(balls, passer ? passer.start : a.from);
    const from = ball ? { x: ball.x, y: ball.y } : passer ? { x: passer.x, y: passer.y } : { ...a.from };

    if (receiver && receiver !== passer) {
      // The ball is either a flag on the passer or a loose token beside them.
      const flagged = Boolean(passer?.hasBall);
      if (passer) passer.hasBall = false;
      if (ball) { ball.x = receiver.x; ball.y = receiver.y; }
      if (flagged || !ball) receiver.hasBall = true;
      passes.push({
        arrow: a, ballIdx: idx(ball), passerIdx: idx(passer),
        from, to: { x: receiver.x, y: receiver.y },
      });
    } else if (ball) {
      ball.x = a.to.x;
      ball.y = a.to.y;
      passes.push({ arrow: a, ballIdx: idx(ball), passerIdx: idx(passer), from, to: { ...a.to } });
    }
  }

  return { mid, end: strip(tokens), moves, passes };
}

/**
 * The tokens a new step starts with: everyone where the last step left them.
 */
export function carryOverTokens(frame) {
  return planStep(frame).end.map((t) => ({ ...t, id: uid() }));
}

/** Slow out of the start and into the finish, so a cut reads as a cut. */
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);
const clamp01 = (t) => Math.min(1, Math.max(0, t));

/** The share of a step spent moving; the rest is the ball in the air. */
export const MOVE_SHARE = 0.6;

/**
 * Where everything is at moment t (0 to 1) of a step, for the Play animation.
 *
 * Players move first, along their arrows' curves, then passes fly — the same
 * order carryOverTokens applies them in, so t = 1 is exactly where the next
 * step starts. A step with only movement or only passes gives it the whole
 * time.
 *
 * Returns { tokens, flyingBalls }: flyingBalls are balls in the air that, when
 * still, are drawn as a flag on a player rather than as a token.
 */
export function tokensAt(frame, t, plan = planStep(frame)) {
  t = clamp01(Number(t) || 0);
  if (t >= 1) return { tokens: structuredClone(plan.end), flyingBalls: [] };

  const hasMoves = plan.moves.length > 0;
  const hasPasses = plan.passes.length > 0;
  const moveEnd = !hasPasses ? 1 : !hasMoves ? 0 : MOVE_SHARE;

  if (t < moveEnd || !hasPasses) {
    const u = ease(clamp01(t / moveEnd));
    const tokens = structuredClone(frame.tokens || []);
    for (const m of plan.moves) {
      // An arrow is drawn from near the player, not from their centre: start
      // where they stand and blend onto the curve, so nobody jumps at t = 0.
      const t0 = tokens[m.index];
      const on = pointAt(m.arrow, u);
      const dx = t0.x - m.arrow.from.x;
      const dy = t0.y - m.arrow.from.y;
      t0.x = on.x + dx * (1 - u);
      t0.y = on.y + dy * (1 - u);
    }
    return { tokens, flyingBalls: [] };
  }

  const v = ease(clamp01((t - moveEnd) / (1 - moveEnd)));
  const tokens = structuredClone(plan.mid);
  const flyingBalls = [];
  for (const pass of plan.passes) {
    // Follow the arrow's curve, nudged so the flight starts at the ball and
    // lands on the receiver even when the arrow was drawn a little off them.
    const on = pointAt(pass.arrow, v);
    const p = {
      x: on.x + (pass.from.x - pass.arrow.from.x) * (1 - v) + (pass.to.x - pass.arrow.to.x) * v,
      y: on.y + (pass.from.y - pass.arrow.from.y) * (1 - v) + (pass.to.y - pass.arrow.to.y) * v,
    };
    if (pass.ballIdx != null) {
      tokens[pass.ballIdx].x = p.x;
      tokens[pass.ballIdx].y = p.y;
    } else {
      if (pass.passerIdx != null) tokens[pass.passerIdx].hasBall = false;
      flyingBalls.push(p);
    }
  }
  return { tokens, flyingBalls };
}

export function newPlay(overrides = {}) {
  const now = new Date().toISOString();
  return {
    schema: SCHEMA_VERSION,
    id: uid(),
    name: 'Untitled play',
    category: '',
    playbook: 'general',
    tags: [],
    notes: '',
    courtType: 'half',
    preset: 'hs',
    youtube: null,
    frames: [emptyFrame()],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export const listPlays = () => readStore();

export const getPlay = (id) => readStore().find((p) => p.id === id) || null;

/**
 * @param {Object} play
 * @param {{touch?: boolean}} opts `touch: false` keeps the existing
 *   `updatedAt` — used when copying a play down from the team playbook, which
 *   is not an edit and must not look like one.
 */
export function savePlay(play, { touch = true } = {}) {
  const plays = readStore();
  const next = touch
    ? { ...play, updatedAt: new Date().toISOString() }
    : { ...play, updatedAt: play.updatedAt || new Date().toISOString() };
  const i = plays.findIndex((p) => p.id === play.id);
  if (i === -1) plays.push(next);
  else plays[i] = next;
  return writeStore(plays) ? next : null;
}

export function deletePlay(id) {
  return writeStore(readStore().filter((p) => p.id !== id));
}

/** A copy is a new play, not a second reference to the same one. */
export function duplicatePlay(play) {
  return savePlay({
    ...structuredClone(play),
    id: uid(),
    name: `${play.name} (copy)`,
    createdAt: new Date().toISOString(),
  });
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

/**
 * Free-text search across everything a coach might remember about a play —
 * including the labels on the tokens, so searching "5" finds plays for the 5.
 */
export function searchPlays(plays, query, { category = '', tag = '' } = {}) {
  const q = String(query || '').trim().toLowerCase();

  return plays.filter((play) => {
    if (category && play.category !== category) return false;
    if (tag && !(play.tags || []).includes(tag)) return false;
    if (!q) return true;

    const haystack = [
      play.name,
      play.category,
      play.notes,
      play.youtube,
      ...(play.tags || []),
      ...(play.frames || []).flatMap((f) => [
        f.label,
        ...(f.tokens || []).map((t) => t.label),
        ...(f.texts || []).map((t) => t.text),
      ]),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return haystack.includes(q);
  });
}

export function allCategories(plays) {
  return [...new Set(plays.map((p) => p.category).filter(Boolean))].sort();
}

export function allTags(plays) {
  return [...new Set(plays.flatMap((p) => p.tags || []).filter(Boolean))].sort();
}

/* ------------------------------------------------------------------ */
/* Import / export                                                     */
/* ------------------------------------------------------------------ */

/**
 * Accept either a single play or a whole library, so a coach can hand over one
 * file without having to know which kind it is.
 *
 * @returns {{plays: Object[], errors: string[]}}
 */
export function parseImport(text) {
  const errors = [];
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { plays: [], errors: [`Not valid JSON: ${err.message}`] };
  }

  const candidates = Array.isArray(data) ? data : (Array.isArray(data.plays) ? data.plays : [data]);
  const plays = [];

  for (const [i, candidate] of candidates.entries()) {
    const where = candidates.length > 1 ? `Play ${i + 1}` : 'This file';
    if (!candidate || typeof candidate !== 'object') {
      errors.push(`${where}: not a play object.`);
      continue;
    }
    if (!Array.isArray(candidate.frames) || candidate.frames.length === 0) {
      errors.push(`${where}: no frames — this doesn't look like a play.`);
      continue;
    }
    plays.push(normalizePlay(candidate));
  }

  return { plays, errors };
}

/**
 * A video link that is safe to put in an href, or ''.
 *
 * Only http and https survive, so a pasted `javascript:` link can never become
 * something a viewer clicks. A link typed without its scheme (youtu.be/abc)
 * gets https:// added rather than being thrown away.
 */
export function safeVideoUrl(raw) {
  let text = String(raw == null ? '' : raw).trim();
  if (text === '') return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (!url.hostname.includes('.')) return '';
    return url.href;
  } catch {
    return '';
  }
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be', 'www.youtu.be',
]);

/** "90", "1m30s", "1h2m3s" → seconds, or 0. */
function youtubeStart(raw) {
  const text = String(raw || '').trim();
  if (/^\d+s?$/.test(text)) return parseInt(text, 10);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (!m || text === '') return 0;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

/**
 * The 11-character video ID of a YouTube link, or ''.
 *
 * Accepts watch?v=, youtu.be/, /shorts/, /embed/, /live/ and /v/ forms.
 */
export function youtubeId(raw) {
  const safe = safeVideoUrl(raw);
  if (!safe) return '';
  const url = new URL(safe);
  if (!YT_HOSTS.has(url.hostname.toLowerCase())) return '';
  const parts = url.pathname.split('/').filter(Boolean);
  let id = '';
  if (url.hostname.toLowerCase().endsWith('youtu.be')) id = parts[0] || '';
  else if (parts[0] === 'watch') id = url.searchParams.get('v') || '';
  else if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) id = parts[1] || '';
  return YT_ID.test(id) ? id : '';
}

/**
 * The privacy-enhanced embed address for a YouTube link, or '' when the link
 * isn't YouTube. Plays in the page so viewers never see the watch link.
 */
export function youtubeEmbed(raw) {
  const id = youtubeId(raw);
  if (!id) return '';
  const url = new URL(safeVideoUrl(raw));
  const start = youtubeStart(url.searchParams.get('t') || url.searchParams.get('start'));
  const params = new URLSearchParams({ rel: '0', modestbranding: '1', playsinline: '1', autoplay: '1' });
  if (start > 0) params.set('start', String(start));
  return `https://www.youtube-nocookie.com/embed/${id}?${params}`;
}

/** Fill in anything an older or hand-edited file is missing. */
export function normalizePlay(raw) {
  const frames = (raw.frames || []).map((f, i) => ({
    label: f.label || (i === 0 ? 'Initial' : `Action ${i}`),
    tokens: (f.tokens || []).map((t) => ({
      id: t.id || uid(),
      kind: t.kind || 'offense',
      label: t.label == null ? '' : String(t.label),
      x: Number(t.x) || 0,
      y: Number(t.y) || 0,
      hasBall: Boolean(t.hasBall),
    })),
    arrows: (f.arrows || []).map((a) => ({
      id: a.id || uid(),
      kind: a.kind || 'cut',
      from: { x: Number(a.from?.x) || 0, y: Number(a.from?.y) || 0 },
      to: { x: Number(a.to?.x) || 0, y: Number(a.to?.y) || 0 },
      ctrl: a.ctrl ? { x: Number(a.ctrl.x) || 0, y: Number(a.ctrl.y) || 0 } : null,
    })),
    texts: (f.texts || []).map((t) => ({
      id: t.id || uid(),
      x: Number(t.x) || 0,
      y: Number(t.y) || 0,
      text: String(t.text || ''),
    })),
  }));

  return {
    schema: SCHEMA_VERSION,
    id: raw.id || uid(),
    name: raw.name || 'Untitled play',
    category: raw.category || '',
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    notes: raw.notes || '',
    courtType: raw.courtType === 'full' ? 'full' : 'half',
    preset: ['hs', 'ncaa', 'nba'].includes(raw.preset) ? raw.preset : 'hs',
    // Which playbook this play belongs to — a sibling of name/category, never
    // mixed into frames, and never tied to the lineup, which stays out of the
    // play entirely so any play opens under any lineup.
    playbook: raw.playbook || 'general',
    youtube: safeVideoUrl(raw.youtube) || null,
    frames: frames.length ? frames : [emptyFrame()],
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || new Date().toISOString(),
  };
}

/**
 * Add imported plays. An ID that already exists gets a fresh one rather than
 * overwriting — importing should never destroy a play you already had.
 */
export function importPlays(incoming) {
  const existing = readStore();
  const ids = new Set(existing.map((p) => p.id));
  const added = [];

  for (const play of incoming) {
    const copy = ids.has(play.id) ? { ...play, id: uid(), name: `${play.name} (imported)` } : play;
    ids.add(copy.id);
    existing.push(copy);
    added.push(copy);
  }

  writeStore(existing);
  return added;
}

export function exportPlay(play) {
  return JSON.stringify(play, null, 2);
}

export function exportLibrary(plays) {
  return JSON.stringify(
    { exported: new Date().toISOString(), schema: SCHEMA_VERSION, plays },
    null,
    2,
  );
}

/** Safe-ish filename from a play name. */
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'play';
}

/* ------------------------------------------------------------------ */
/* Team playbook (read-only, committed to the repo)                    */
/* ------------------------------------------------------------------ */

/**
 * Load the shared playbook from plays/index.json.
 * A missing index is normal — it just means no team plays are committed yet.
 */
export async function loadTeamPlaybook() {
  // no-store, not no-cache: a phone must not serve a stale index after a
  // deploy, and "revalidate" isn't the same as "don't reuse".
  const bust = () => `?t=${Date.now()}`;

  try {
    const res = await fetch('plays/index.json' + bust(), { cache: 'no-store' });
    if (!res.ok) {
      // A 404 and "nothing published yet" are different problems with
      // different fixes, so they must not look the same.
      return { playbooks: [], plays: [], error: `HTTP ${res.status} loading plays/index.json` };
    }

    const index = await res.json();

    // The index groups plays by playbook folder. A phone may still hold the
    // previous flat `{plays: […]}` index during a deploy, so that shape is read
    // as a single "general" playbook rather than as nothing at all.
    const playbooks = Array.isArray(index.playbooks)
      ? index.playbooks
      : [{
        slug: 'general',
        name: 'General',
        description: '',
        order: 1,
        plays: (Array.isArray(index.plays) ? index.plays : [])
          .map((p) => ({ ...p, path: p.path || `plays/${p.file}` })),
      }];

    const failed = [];

    const loaded = await Promise.all(playbooks.map(async (pb) => {
      const plays = await Promise.all((pb.plays || []).map(async (entry) => {
        // `path` is what publishing needs in order to edit this exact file.
        const path = entry.path || `plays/${pb.slug}/${entry.file}`;
        try {
          const r = await fetch(path + bust(), { cache: 'no-store' });
          if (!r.ok) {
            failed.push(`${path} (HTTP ${r.status})`);
            return null;
          }
          return { ...normalizePlay(await r.json()), path, playbook: pb.slug };
        } catch (err) {
          failed.push(`${path} (${err.message})`);
          return null;
        }
      }));
      return { ...pb, plays: plays.filter(Boolean) };
    }));

    return {
      playbooks: loaded,
      plays: loaded.flatMap((pb) => pb.plays),
      error: failed.length ? `Could not load ${failed.join(', ')}` : null,
    };
  } catch (err) {
    return { playbooks: [], plays: [], error: err.message };
  }
}
