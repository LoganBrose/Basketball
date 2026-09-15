/**
 * The only file you need to edit.
 *
 * See README.md for where each value comes from. If neither `fileId` nor the
 * per-tab `gid`s are filled in, the site falls back to the bundled sample data
 * in data/sample/ and says so on the page.
 */

export const CONFIG = {
  sheet: {
    /**
     * From your "Publish to web" URL:
     *   docs.google.com/spreadsheets/d/e/<pubKey>/pubhtml
     * Used with the per-tab `gid`s below.
     */
    pubKey: '2PACX-1vTIRdvaoK3plhKwEcOT6WVW3RGxAqjaQM7cahSE7Kmt1ce5yej-oriu6_hpQA6PYvPbYOojBRS3dCKR',

    /**
     * Optional but preferred. The file ID from the *editing* URL:
     *   docs.google.com/spreadsheets/d/<fileId>/edit
     * With this set, tabs are addressed by name, so you never have to look up a
     * gid and nothing breaks when a tab is moved. Requires the sheet's General
     * access to be "Anyone with the link".
     */
    fileId: '',

    /**
     * Tab names (used by the fileId strategy) and gids (used by the pubKey
     * strategy). Read a gid from the tab's URL: ...#gid=123456789
     */
    tabs: {
      players: { name: 'Players', gid: '' },
      games: { name: 'Games', gid: '' },
      // The Google Form's own responses tab — this is the stats source.
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

  /** Bundled fallback data, used when the sheet isn't configured yet. */
  sample: {
    players: 'data/sample/players.csv',
    games: 'data/sample/games.csv',
    responses: 'data/sample/responses.csv',
  },
};
