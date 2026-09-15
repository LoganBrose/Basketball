/**
 * Lineup: which player is standing in each offensive slot.
 *
 * This is a **display layer only**. It is never written into a play's JSON —
 * bake a name into a play and that play stops being reusable next season, or
 * with the JV team, or after a transfer. Plays store positions 1–5; the lineup
 * says who is filling them right now.
 */

const KEY = 'bb.lineup.v1';

/** The five offensive slots, matching the token labels a play stores. */
export const SLOTS = ['1', '2', '3', '4', '5'];

/** localStorage throws in private mode and when site data is blocked. */
export function readLineup() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeLineup(lineup) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(lineup));
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop slots whose player is no longer on the roster.
 *
 * Someone leaves the team and their ID stops resolving; the slot empties rather
 * than rendering a blank or a stale name.
 *
 * @returns {Object<string,string>} a new lineup, only valid slots kept
 */
export function pruneLineup(lineup, players) {
  const known = new Set((players || []).map((p) => p.playerId));
  const out = {};
  for (const slot of SLOTS) {
    const id = lineup?.[slot];
    if (id && known.has(id)) out[slot] = id;
  }
  return out;
}

/**
 * Players selectable in one slot: everyone not already standing somewhere else.
 * A player can't be in two places at once, and offering them twice invites a
 * lineup that can't exist.
 */
export function availableFor(slot, lineup, players) {
  const takenElsewhere = new Set(
    SLOTS.filter((s) => s !== slot).map((s) => lineup?.[s]).filter(Boolean),
  );
  return (players || []).filter((p) => !takenElsewhere.has(p.playerId));
}

/** The player standing in a slot, or null. */
export function playerInSlot(slot, lineup, players) {
  const id = lineup?.[slot];
  if (!id) return null;
  return (players || []).find((p) => p.playerId === id) || null;
}

/**
 * Assign a player to a slot, clearing them from whichever slot they were in.
 * Passing an empty id clears the slot.
 */
export function assignSlot(lineup, slot, playerId) {
  const out = { ...lineup };
  if (playerId) {
    for (const s of SLOTS) if (out[s] === playerId) delete out[s];
    out[slot] = playerId;
  } else {
    delete out[slot];
  }
  return out;
}

/** What goes inside the token: the jersey if there is one, else initials. */
export function tokenGlyph(player, fallbackLabel) {
  if (!player) return fallbackLabel;
  if (player.jersey) return String(player.jersey);
  const parts = String(player.fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallbackLabel;
  return parts.map((p) => p[0].toUpperCase()).join('');
}
