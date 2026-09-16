/**
 * Entry point for admin.html.
 *
 * The admin prompt prefills your name from the site session, so it must not be
 * built until that sign-in has happened — at load, it usually has not.
 */

import { CONFIG } from './config.js';
import { isEnabled, readSession, sessionValid, siteMaxAge } from './gate.js';
import { mountAdminPage } from './admin.js';

function start() {
  const host = document.getElementById('admin-root');
  const gate = CONFIG.gate || {};

  if (isEnabled(gate) && !sessionValid(readSession(), siteMaxAge(gate))) {
    document.addEventListener('bb:signedin', () => mountAdminPage(host), { once: true });
    return;
  }

  mountAdminPage(host);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
