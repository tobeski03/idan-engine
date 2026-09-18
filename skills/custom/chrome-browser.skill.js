const { chromium } = require('playwright-core');

let browser;
async function page(index = 0) {
  if (!browser) browser = await chromium.connectOverCDP(process.env.IDAN_CHROME_CDP_URL || 'http://127.0.0.1:9222');
  const context = browser.contexts()[0] || await browser.newContext();
  const pages = context.pages();
  return pages[Number(index) || 0] || pages[0] || context.newPage();
}
async function inspect(p) {
  const interactive = await p.locator('a,button,input,textarea,select,[role="button"],[role="textbox"],[contenteditable="true"],[placeholder]').evaluateAll((items) => items.slice(0, 160).map((el, index) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); if (!r.width || !r.height || s.visibility === 'hidden' || s.display === 'none') return null; el.setAttribute('data-idan-ref', `mobile-${index}`); return { index, selector: `[data-idan-ref="mobile-${index}"]`, tag: el.tagName.toLowerCase(), text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180), placeholder: el.getAttribute('placeholder') || '', ariaLabel: el.getAttribute('aria-label') || '', role: el.getAttribute('role') || '', contentEditable: el.getAttribute('contenteditable') === 'true' }; }).filter(Boolean));
  return { url: p.url(), title: await p.title().catch(() => ''), text: (await p.locator('body').innerText().catch(() => '')).slice(0, 20000), interactive };
}
function selector(args) { return String(args.target || args.selector || '').trim(); }

module.exports = {
  id: 'chrome-browser',
  name: 'Chrome Browser Controller',
  enabled: true,
  toolDeclarations: [
    { name: 'chrome_browser', description: 'Control the real logged-in Chrome browser through its CDP endpoint. Always inspect before acting. Supports dynamic web apps, Google Docs, scrolling, tabs, links, forms, and page extraction.', parameters: { type: 'OBJECT', properties: { operation: { type: 'STRING', enum: ['open', 'inspect', 'tabs', 'switch_tab', 'back', 'forward', 'reload', 'click', 'fill', 'type', 'press', 'scroll', 'extract', 'screenshot'] }, url: { type: 'STRING' }, target: { type: 'STRING' }, selector: { type: 'STRING' }, value: { type: 'STRING' }, key: { type: 'STRING' }, index: { type: 'NUMBER' }, amount: { type: 'NUMBER' }, file: { type: 'STRING' } }, required: ['operation'] } }
  ],
  async handleTool(name, args) {
    if (name !== 'chrome_browser') return { ok: false, error: 'Unknown Chrome tool' };
    const p = await page(args.index || 0);
    const op = args.operation;
    if (op === 'open') { if (!/^https?:\/\//i.test(args.url || '')) throw new Error('Chrome URLs must use http or https'); await p.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); return inspect(p); }
    if (op === 'inspect') return inspect(p);
    if (op === 'tabs') { const pages = browser.contexts()[0]?.pages() || []; return Promise.all(pages.map(async (tab, i) => ({ index: i, url: tab.url(), title: await tab.title().catch(() => '') }))); }
    if (op === 'switch_tab') { await p.bringToFront(); return inspect(p); }
    if (op === 'back' || op === 'forward') { await p[op === 'back' ? 'goBack' : 'goForward']({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); return inspect(p); }
    if (op === 'reload') { await p.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); return inspect(p); }
    if (op === 'click') { await p.locator(selector(args)).first().click({ timeout: 15000 }); await p.waitForTimeout(300); return inspect(p); }
    if (op === 'fill') { const loc = p.locator(selector(args)).first(); if (await loc.getAttribute('contenteditable') === 'true') { await loc.click(); await p.keyboard.insertText(String(args.value || '')); } else await loc.fill(String(args.value || '')); return inspect(p); }
    if (op === 'type') { const target = selector(args); const loc = target ? p.locator(target).first() : p.locator("[role='textbox'],textarea,input,[contenteditable='true'],.kix-appview-editor").filter({ visible: true }).first(); if (await loc.count()) await loc.click({ timeout: 15000 }); else await p.mouse.click(500, 400); await p.keyboard.insertText(String(args.value || '')); return { typed: String(args.value || '').slice(0, 200), inputDispatched: true, ...(await inspect(p)) }; }
    if (op === 'press') { await p.locator(selector(args)).first().press(args.key || 'Enter'); return inspect(p); }
    if (op === 'scroll') { await p.mouse.wheel(0, Number(args.amount) || 700); return inspect(p); }
    if (op === 'extract') return { selector: selector(args) || 'body', items: await p.locator(selector(args) || 'body').evaluateAll((els) => els.slice(0, 100).map((el) => ({ text: (el.innerText || el.textContent || '').trim().slice(0, 4000), href: el.href || '' }))) };
    if (op === 'screenshot') { const file = args.file || `/tmp/idan-chrome-${Date.now()}.png`; await p.screenshot({ path: file }); return { screenshot: file, url: p.url() }; }
    throw new Error(`Unsupported Chrome operation: ${op}`);
  }
};
