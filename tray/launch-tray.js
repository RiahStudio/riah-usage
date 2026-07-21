'use strict';
/**
 * Best-effort: show the Windows tray icon (hover = meters at a glance).
 * The tray script is a singleton (named mutex), so calling this twice is safe.
 * Never throws, never blocks. Opt out: RIAH_USAGE_NO_TRAY=1
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function maybeStartTray(root) {
  try {
    if (process.platform !== 'win32') return false;
    if (process.env.RIAH_USAGE_NO_TRAY === '1') return false;
    const vbs = path.join(root, 'tray', 'tray-hidden.vbs');
    if (!fs.existsSync(vbs)) return false;
    const child = spawn('wscript.exe', ['//B', '//Nologo', vbs], {
      cwd: path.join(root, 'tray'),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { maybeStartTray };
