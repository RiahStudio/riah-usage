#!/usr/bin/env node
/**
 * Pin the fonts + Mac/Windows start surface so a later edit cannot silently
 * ship Georgia fallbacks or a Windows-only Cursor login path.
 *
 * Run:  node tests/test-fonts-and-mac.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;

function check(name, pass, detail) {
  if (pass) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const fontsCss = fs.readFileSync(path.join(ROOT, 'assets', 'fonts', 'fonts.css'), 'utf8');
const refs = [...fontsCss.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
const expected = [
  'instrument-serif-latin-400-normal.woff2',
  'instrument-serif-latin-400-italic.woff2',
  'space-grotesk-latin-400-normal.woff2',
  'space-grotesk-latin-500-normal.woff2',
  'space-grotesk-latin-600-normal.woff2',
  'space-grotesk-latin-700-normal.woff2',
  'space-mono-latin-400-normal.woff2',
  'space-mono-latin-700-normal.woff2',
];

console.log('\nBundled fonts');
check('fonts.css names all eight faces', expected.every((f) => refs.includes(f)) && refs.length === 8, `got ${refs.join(', ')}`);

for (const rel of refs) {
  const p = path.join(ROOT, 'assets', 'fonts', rel);
  const buf = fs.existsSync(p) ? fs.readFileSync(p) : Buffer.alloc(0);
  check(`${rel} exists`, buf.length > 100, `bytes=${buf.length}`);
  check(
    `${rel} is wOFF2`,
    buf.slice(0, 4).toString('ascii') === 'wOF2',
    `magic=${buf.slice(0, 4).toString('hex')}`
  );
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
check('board loads local fonts.css, not a CDN', /href="assets\/fonts\/fonts\.css"/.test(html) && !/fonts\.googleapis/.test(html));
check('board asks for Instrument Serif', /Instrument Serif/.test(html));
check('board asks for Space Grotesk', /Space Grotesk/.test(html));
check('board asks for Space Mono', /Space Mono/.test(html));

const serve = fs.readFileSync(path.join(ROOT, 'serve.js'), 'utf8');
check("desk serves .woff2 as font/woff2 (Safari)", /'\.woff2':\s*'font\/woff2'/.test(serve));

const sh = fs.readFileSync(path.join(ROOT, 'start.sh'));
check('start.sh has no Windows CR (macOS shebang survives)', !sh.includes(0x0d));
check('start.sh has a unix shebang', sh.slice(0, 19).toString() === '#!/usr/bin/env bash');

const collect = fs.readFileSync(path.join(ROOT, 'collect-usage.js'), 'utf8');
check('non-Windows Python tries python3 first', /:\s*\['python3',\s*'python'\]/.test(collect));

const cursor = fs.readFileSync(path.join(ROOT, 'lib', 'pull-cursor.py'), 'utf8');
check('Cursor login path includes macOS Application Support', cursor.includes('Library') && cursor.includes('Application Support') && cursor.includes('state.vscdb'));
check('Cursor login path still includes Windows APPDATA', /APPDATA/.test(cursor));

const copilot = fs.readFileSync(path.join(ROOT, 'lib', 'pull-copilot.py'), 'utf8');
check(
  'Copilot login path includes macOS Application Support',
  copilot.includes('"Library", "Application Support", "github-copilot"')
);

const startBg = fs.readFileSync(path.join(ROOT, 'start-background.js'), 'utf8');
check('Mac start can open with `open`', /darwin/.test(startBg) && /exec\(`open/.test(startBg));

const tray = fs.readFileSync(path.join(ROOT, 'tray', 'launch-tray.js'), 'utf8');
check('tray stays Windows-only (Mac uses the web page)', /process\.platform !== 'win32'/.test(tray));

console.log(failures === 0 ? '\nAll font/platform pins passed.\n' : `\n${failures} font/platform pin(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
