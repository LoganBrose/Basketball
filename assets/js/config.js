/**
 * The only file you need to edit.
 *
 * Stats are typed straight into the StatsLog tab — there is no Google Form.
 * See README.md for where each value comes from.
 */

export const CONFIG = {
  sheet: {
    /**
     * From the *editing* URL: docs.google.com/spreadsheets/d/<fileId>/edit
     * With this set, tabs are addressed by name, so nothing breaks when a tab is
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
     * number after `#gid=` in the URL while that tab is open.
     */
    tabs: {
      statslog: { name: 'StatsLog', gid: '2114409932' },
      players: { name: 'Players', gid: '335787751' },
      games: { name: 'Games', gid: '761754105' },
    },
  },

  /**
   * How players are shown: 'full' | 'jersey' | 'initials'.
   *
   * A GitHub Pages site is readable by anyone with the link, and so is a
   * published sheet. If this site will be shared beyond your staff, 'jersey' or
   * 'initials' keeps names off the public page.
   */
  nameDisplay: 'full',

  /**
   * Sign-in. Paste the Apps Script web app URL into `url` to turn it on;
   * leave it empty and the site behaves exactly as it did before.
   *
   * The passwords are NOT here. They live in the script's own Script
   * Properties, which is why this file is safe in a public repo. See the
   * "Sign-in setup" section of README.md.
   *
   * `days` and `adminHours` only decide when this browser stops offering a
   * stored session. The expiry that actually matters is signed into the token
   * and enforced by the script, because a browser can be told to lie about
   * this one.
   */
  gate: {
    url: 'https://script.google.com/macros/s/AKfycbz2tApnb1WlI2bDFSXC2nAETdAnH9nSd2ZbozLNldtR-e0QLqSELtMrDCGu1nKLac0a/exec',
    days: 30,
    adminHours: 24,
    title: 'Coach Tools',
  },

  /** Bundled fallback data, used when the sheet can't be reached. */
  sample: {
    statslog: 'data/sample/statslog.csv',
    players: 'data/sample/players.csv',
    games: 'data/sample/games.csv',
  },
};
