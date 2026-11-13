/**
 * Opponent plays from the builder's side: which games a play can be saved
 * against, and the calls that save and remove one.
 *
 * An opponent play is kept by the Apps Script in a tab of its own and is never
 * part of the device, team or admin playbooks. Saving one here does not touch
 * the copy on this device unless the coach asks for that.
 */

import { CONFIG } from './config.js';
import { callScript, isEnabled, isViewer, bestToken } from './gate.js';
import { hasFeature } from './features.js';
import { dateParts, scoutMessage } from './scout.js';

/**
 * Whether the builder offers "Save to opponent playbook". Admin and coaches
 * with Scouting; never a viewer. The script checks again on every save.
 */
export const canSaveOpponentPlays = () =>
  isEnabled(CONFIG.gate) && hasFeature('scouting') && !isViewer() && Boolean(bestToken());

/** "Fri Nov 20 · North (Away)" */
export function gameLabel(game) {
  const d = dateParts(game.date);
  const ha = game.homeAway ? ` (${game.homeAway})` : '';
  return `${d.weekday} ${d.short} · ${game.opponent}${ha}`.trim();
}

/**
 * The picker's choices: upcoming games first, soonest at the top, then past
 * games, most recent first. One entry per game; the play lands on the game's
 * opponent, so picking any game against them gives the same result.
 *
 * @param {{upcoming?: Object[], past?: Object[]}} schedule  scoutGames' reply
 */
export function pickerGames(schedule) {
  const upcoming = [...(schedule?.upcoming || [])].sort((a, b) => a.daysAway - b.daysAway);
  const past = [...(schedule?.past || [])].sort((a, b) => b.daysAway - a.daysAway);
  return [
    ...upcoming.map((g) => ({ ...g, label: gameLabel(g), group: 'Upcoming' })),
    ...past.map((g) => ({ ...g, label: gameLabel(g), group: 'Past' })),
  ];
}

const call = (action, extra = {}) => callScript(CONFIG.gate.url, { action, token: bestToken(), ...extra });

export async function fetchSchedule() {
  const result = await call('scoutGames');
  const message = scoutMessage(result);
  return message ? { ok: false, message } : { ok: true, schedule: result.data };
}

/** What a failed save should say. */
export function opponentSaveMessage(result) {
  if (result?.ok && result.data?.reason === 'too_big') {
    return 'This play is too large to save. Split it into two plays or remove steps.';
  }
  if (result?.ok && result.data?.reason === 'bad_request') return "This play couldn't be read. Try again.";
  return scoutMessage(result);
}

/**
 * @returns {Promise<{ok: boolean, message: string, opponent?: string, replaced?: boolean}>}
 */
export async function saveOpponentPlay(gameId, play) {
  const result = await call('saveOpponentPlay', { gameId, play });
  const message = opponentSaveMessage(result);
  if (message) return { ok: false, message };
  return { ok: true, message: '', opponent: result.data.opponent, replaced: Boolean(result.data.replaced) };
}

export async function deleteOpponentPlay(gameId, id) {
  const result = await call('deleteOpponentPlay', { gameId, id });
  const message = scoutMessage(result);
  return { ok: message === '', message };
}
