import { chromium } from 'playwright';
import fs from 'fs';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }});
const page = await ctx.newPage();
const msgs = [];
page.on('console', m => msgs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => msgs.push(`[PAGEERROR] ${e.message}`));
await page.goto('http://localhost:8080/Apps/Sandcastle/gallery/glTF%20PBR%20Extensions.html?renderer=webgpu', { waitUntil: 'networkidle', timeout: 60000 });
// KTX2 takes time to load — give it 30s
await page.waitForTimeout(30000);
fs.writeFileSync('Tools/visual-regression/output/pbr-test-webgpu.png', await page.screenshot({ type: 'png' }));
// Check WebGPU console for cubemap-related errors
const errs = msgs.filter(m => m.includes('error') || m.includes('PAGEERROR') || m.toLowerCase().includes('texture') || m.toLowerCase().includes('cubemap') || m.toLowerCase().includes('cube'));
console.log('Filtered msgs:');
errs.slice(-10).forEach(e => console.log(' ', e.substring(0, 220)));
await browser.close();
