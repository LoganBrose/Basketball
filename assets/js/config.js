/**
 * The only file you need to edit.
 *
 * See README.md for where each value comes from. If neither `fileId` nor the
 * per-tab `gid`s are filled in, the site tries to read the tab list off the
 * published page, and failing that falls back to the sample data in data/sample/.
 */

export const CONFIG = {
  /**
   * Which tab the stats come from.
   *
   *   'statslog'  — the StatsLog tab, typed into the sheet by hand.
   *   'responses' — the Google Form's own responses tab.
   *
   * Switch this to 'responses' once the Form exists; that's the whole change.
   */
  statsSource: 'statslog',

  sheet: {
    /**
     * From the *editing* URL: docs.google.com/spreadsheets/d/<fileId>/edit
     * With this set, tabs are addressed by name — nothing breaks when a tab is
     * moved or re-created. Requires the sheet's General access to be
     * "Anyone with the link".
     */
    fileId: '1RRmiDGS5j4IWGc5B6BnC7aNXMzZLbtOTSLaIKkqIc8s',

    /**
     * From the "Publish to web" URL:
     *   docs.google.com/spreadsheets/d/e/<pubKey>/pubhtml
     * Used with the gids below as the fallback when the fileId route is blocked.
     */
    pubKey: '2PACX-1vTIRdvaoK3plhKwEcOT6WVW3RGxAqjaQM7cahSE7Kmt1ce5yej-oriu6_hpQA6PYvPbYOojBRS3dCKR',

    /**
     * Tab names (used with fileId) and gids (used with pubKey). A gid is the
     * number in the tab's own URL after `#gid=`.
     */
    tabs: {
      players: { name: 'Players', gid: '335787751' },
      games: { name: 'Games', gid: '761754105' },
      statslog: { name: 'StatsLog', gid: '2114409932' },
      // Created by Google when you wire up the Form; no gid until then.
      responses: { name: 'Form Responses 1', gid: '' },
    },
  },

  /**
   * Your Google Form's public link. Powers the "Log a stat" button, which is
   * how stats get entered from a phone. Leave blank to hide the button.
   */
  formUrl: '',

  /**
   * How players are shown: 'full' | 'jersey' | 'initials'.
   *
   * A GitHub Pages site is readable by anyone with the link, and so is a
   * published sheet. If this site will be shared beyond your staff, 'jersey' or
   * 'initials' keeps names off the public page.
   */
  nameDisplay: 'full',

  /** Bundled fallback data, used when the sheet can't be reached. */
  sample: {
    players: 'data/sample/players.csv',
    games: 'data/sample/games.csv',
    statslog: 'data/sample/statslog.csv',
    responses: 'data/sample/responses.csv',
  },
};
