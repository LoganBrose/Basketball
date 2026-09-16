/**
 * Entry point for admin.html.
 *
 * The inline script in <head> has normally already redirected anyone without an
 * admin session. This runs the same check again because a session can expire
 * while a tab sits open, and because a backstop in the module is cheap.
 */

import { hasAdminSession } from './gate.js';
import { mountAdminPage } from './admin.js';

function start() {
  if (!hasAdminSession()) {
    globalThis.location.replace('playbook.html');
    return;
  }
  mountAdminPage(document.getElementById('admin-root'));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
