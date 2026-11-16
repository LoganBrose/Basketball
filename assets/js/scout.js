/**
 * Scouting, the parts that need no browser: how the schedule is grouped, how a
 * date reads, and what each failure should say.
 *
 * The date RULES — what counts as today, which games a player may open — live
 * in the Apps Script, in the team's time zone. Every game arrives here with
 * `daysAway` already worked out, so the page never does time-zone arithmetic
 * of its own and cannot disagree with the script about it.
 */

import { safeVideoUrl } from './library.js';

/** "That week": the next game, then anything else within this many days. */
export const WEEK_DAYS = 7;

/**
 * Split the upcoming games for the page.
 *
 *   next  — the first game; shown fully open at the top
 *   week  — the rest within WEEK_DAYS of today; tappable cards
 *   later — everything after that (admin and coaches only; a player's list
 *           never reaches this far, because the script stops it at 7 days)
 *
 * @param {{gameId: string, daysAway: number}[]} upcoming  in date order
 */
export function groupGames(upcoming = []) {
  const games = [...upcoming].sort((a, b) => a.daysAway - b.daysAway);
  const [next = null, ...rest] = games;
  return {
    next,
    week: rest.filter((g) => g.daysAway <= WEEK_DAYS),
    later: rest.filter((g) => g.daysAway > WEEK_DAYS),
  };
}

/**
 * A yyyy-MM-dd date as people read it. Worked out in UTC on purpose: the date
 * is already the team's local date, and reading it in the browser's own time
 * zone could shift it a day.
 */
export function dateParts(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return { weekday: '', short: String(key || ''), long: String(key || '') };
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const fmt = (opts) => d.toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
  return {
    weekday: fmt({ weekday: 'short' }),
    short: fmt({ month: 'short', day: 'numeric' }),
    long: fmt({ weekday: 'long', month: 'long', day: 'numeric' }),
  };
}

/** "Today", "Tomorrow", "In 3 days", "2 days ago". */
export function whenText(daysAway) {
  const n = Number(daysAway);
  if (!Number.isFinite(n)) return '';
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  return n > 0 ? `In ${n} days` : `${-n} days ago`;
}

/** "vs Central" at home, "at North" away, just the name when it isn't said. */
export function matchup(game) {
  if (!game) return '';
  if (game.homeAway === 'Home') return `vs ${game.opponent}`;
  if (game.homeAway === 'Away') return `at ${game.opponent}`;
  return game.opponent;
}

/** "#23 Jay Tall · C · 6'5"", leaving out whatever is blank. */
export function playerTitle(p) {
  const head = [p.number ? `#${p.number}` : '', p.name || ''].filter(Boolean).join(' ');
  return [head, p.position || '', p.height || ''].filter(Boolean).join(' · ');
}

/**
 * A key player's season line, in the order it reads. `pct` fields are 0-100.
 * The same list and rules are in Code.gs (SCOUT_STATS, cleanStats): the script
 * cleans again on save, this copy lets the form point at the wrong box first.
 */
export const STAT_FIELDS = [
  { key: 'gp', label: 'GP' },
  { key: 'ppg', label: 'PPG' },
  { key: 'rpg', label: 'RPG' },
  { key: 'apg', label: 'APG' },
  { key: 'spg', label: 'SPG' },
  { key: 'fg', label: 'FG%', pct: true },
  { key: '3p', label: '3P%', pct: true },
  { key: 'ft', label: 'FT%', pct: true },
];

/** One stat as typed → "38", "18.4", '' for blank, or null when it isn't a number in range. */
export function cleanStat(raw, pct = false) {
  const text = String(raw ?? '').trim().replace(/%$/, '').trim();
  if (text === '') return '';
  if (!/^\d*\.?\d+$/.test(text)) return null;
  let n = Number(text);
  // .38 under a percentage is a fraction: the coach means 38%.
  if (pct && n > 0 && n < 1) n *= 100;
  n = Math.round(n * 10) / 10;
  if (n < 0 || n > (pct ? 100 : 999)) return null;
  return String(n);
}

/**
 * Clean a whole stat line. `stats` keeps the known fields that have a value;
 * `bad` lists the keys that were typed but aren't numbers in range.
 */
export function cleanStats(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const stats = {};
  const bad = [];
  for (const f of STAT_FIELDS) {
    if (!Object.hasOwn(src, f.key)) continue;
    const v = cleanStat(src[f.key], f.pct);
    if (v === null) bad.push(f.key);
    else if (v !== '') stats[f.key] = v;
  }
  return { stats, bad };
}

/** "12 GP · 18.4 PPG · 38% 3P", leaving out blanks; '' when there are none. */
export function statLine(stats) {
  const s = stats || {};
  return STAT_FIELDS
    .filter((f) => s[f.key] !== undefined && s[f.key] !== '')
    .map((f) => (f.pct ? `${s[f.key]}% ${f.label.replace('%', '')}` : `${s[f.key]} ${f.label}`))
    .join(' · ');
}

/** One of our players as a dropdown and the matchup line show them: "#12 John Smith". */
export const rosterLabel = (r) => (r ? [r.number ? `#${r.number}` : '', r.name || ''].filter(Boolean).join(' ') : '');

/** Our roster by jersey number (blank or odd numbers last), then name. */
export function sortByJersey(roster = []) {
  const num = (r) => {
    const n = String(r.number ?? '').trim() === '' ? NaN : Number(r.number);
    return Number.isFinite(n) ? n : Infinity;
  };
  return [...roster].sort((a, b) => {
    const x = num(a);
    const y = num(b);
    return (x === y ? 0 : x < y ? -1 : 1) || String(a.name || '').localeCompare(String(b.name || ''));
  });
}

/**
 * "Guarded by #12 John Smith (help: #7 Jane Doe)", "Help: #7 Jane Doe" with
 * only a help defender, or '' when nobody is set.
 */
export function matchupText(m) {
  const guard = rosterLabel(m?.guard);
  const help = rosterLabel(m?.help);
  if (guard && help) return `Guarded by ${guard} (help: ${help})`;
  if (guard) return `Guarded by ${guard}`;
  if (help) return `Help: ${help}`;
  return '';
}

/**
 * The stats link a button may point at, or ''. The script already refuses to
 * store anything but http(s); this is the same rule again on the way out,
 * because a link that reaches an href is the one that matters.
 */
export const statsLink = (raw) => safeVideoUrl(raw);

/** "Saved by Casey Jones · 11/13/2026 9:14:02", or '' for nothing saved yet. */
export function savedText(item) {
  if (!item || !item.updatedBy) return '';
  return item.updated ? `Saved by ${item.updatedBy} · ${item.updated}` : `Saved by ${item.updatedBy}`;
}

/**
 * The sentence for each way a scouting call can fail. The script answers a
 * login that may not use scouting exactly like an action that does not exist,
 * and from here that is indistinguishable from an expired sign-in — so that is
 * what it says.
 */
export function scoutMessage(result) {
  if (!result || !result.ok) return "Couldn't reach the scouting reports. Try again.";
  const data = result.data || {};
  if (data.ok) return '';
  switch (data.reason) {
    case 'unknown_action':
    case 'auth':
      return 'Your sign-in has expired. Sign in again.';
    case 'not_found':
      return "That game isn't available.";
    case 'too_many':
      return 'This opponent already has 30 key players. Remove one first.';
    case 'bad_request':
      return 'Give the player a name or a number.';
    default:
      return 'Something went wrong. Try again.';
  }
}
