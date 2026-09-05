/** Rend assets/icons/icon.svg en PNG (192, 512, et une variante maskable). */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const svg = readFileSync('assets/icons/icon.svg', 'utf8');
const maskable = svg
  .replace('rx="112"', 'rx="0"')
  .replace(/r="128"/, 'r="104"').replace(/r="44"/, 'r="36"')
  .replace('stroke-width="34"', 'stroke-width="28"')
  .replace('d="M256 350v104"', 'd="M256 326v84"');
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
for (const [name, size, source] of [['icon-192.png', 192, svg], ['icon-512.png', 512, svg], ['icon-maskable-512.png', 512, maskable]]) {
  const p = await (await b.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })).newPage();
  await p.setContent(`<style>html,body{margin:0;padding:0}svg{display:block;width:${size}px;height:${size}px}</style>${source}`);
  writeFileSync(`assets/icons/${name}`, await p.screenshot({ omitBackground: false }));
  console.log(name, size);
}
await b.close();
