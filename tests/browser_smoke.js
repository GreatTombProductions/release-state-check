'use strict';
// Browser smoke for Release State Check. SMOKE_BASE = site root URL.
// By default the four sources are answered from tests/cases.json, so the run is
// repeatable. SMOKE_LIVE=1 lets the requests through to the real sources.
// SHOT_DIR=<dir> writes screenshots.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8')).doi_cases;
const byName = (frag) => cases.find((c) => c.name.includes(frag));
const LIVE = process.env.SMOKE_LIVE === '1';
const SHOTS = process.env.SHOT_DIR;

function sourceFor(url, c) {
  const s = c.sources || {};
  if (url.includes('doi.org/api/handles/')) return s.handle;
  if (url.includes('doi.org/doiRA/')) return s.agency;
  if (url.includes('api.datacite.org/dois?prefix=')) return s.prefix;
  if (url.includes('api.datacite.org/dois/') || url.includes('api.crossref.org/works/')) return s.registry;
  return null;
}

(async () => {
  const base = process.env.SMOKE_BASE;
  const origin = new URL(base).origin;
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const foreign = [];
  let active = null;
  const ALLOWED = ['https://doi.org/', 'https://api.datacite.org/', 'https://api.crossref.org/'];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith(origin) && !ALLOWED.some((a) => u.startsWith(a))) foreign.push(u);
    });
    if (!LIVE) {
      await page.route((u) => ALLOWED.some((a) => u.href.startsWith(a)), (route) => {
        const src = active && sourceFor(route.request().url(), active);
        if (!src || src[0] === 0) return route.abort();
        return route.fulfill({
          status: src[0], contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: src[1] === null ? 'not json' : JSON.stringify(src[1]),
        });
      });
    }
    const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); };
    const verdict = async (code) => {
      await page.waitForSelector(`#verdict[data-code="${code}"]`, { timeout: 30000 });
      return page.locator('#result').innerText();
    };

    const resp = await page.goto(base, { waitUntil: 'networkidle' });
    assert(resp.ok(), 'index ' + resp.status());
    assert(await page.locator('#result').isHidden(), 'result shown before any check');
    await shot('01-empty');

    // typed the way people paste it: a full address with trailing punctuation
    active = byName('registry has no public record, prefix has siblings');
    await page.fill('#doi', ' https://doi.org/10.48690/he9y-d243. ');
    await page.click('#btnCheck');
    let text = await verdict('resolves-no-public-record');
    assert(text.includes('Registered, but there is no public record'), text);
    assert(text.includes('landscan.ornl.gov'), 'address missing');
    assert(/has \d+ public records?\. The registry is working for this publisher/.test(text), 'sibling finding missing: ' + text);
    assert(text.includes('front page'), 'front-page finding missing');
    assert(text.includes('What this cannot tell you'));
    assert(/Read \d{4}-\d\d-\d\d \d\d:\d\d UTC · 10\.48690\/he9y-d243/.test(text), 'dated header missing');
    assert(page.url().endsWith('?doi=10.48690%2Fhe9y-d243'), 'address bar not updated: ' + page.url());
    // a front-page address is not offered as a file to probe
    assert((await page.locator('.cmd').innerText()).includes('https://HOST/PATH/TO/FILE'));
    await page.click('#btnCopy');
    const copied = await page.inputValue('#copyBox');
    assert(copied.includes('Registered, but there is no public record') && copied.includes('?doi=10.48690%2Fhe9y-d243') && /Read \d{4}/.test(copied), copied);
    await shot('02-registered-no-record');

    if (!LIVE) {
      // deep link, public record under a parent
      active = byName('one version of a parent');
      await page.goto(base + '?doi=10.5281%2Fzenodo.20424537', { waitUntil: 'networkidle' });
      text = await verdict('public-record');
      assert(text.includes('World Settlement Footprint') && text.includes('20260101') && text.includes('cc-by-4.0'), text);
      assert(text.includes('one version under a parent record') && text.includes('10.5281/zenodo.20424536'), text);
      assert((await page.inputValue('#doi')) === '10.5281/zenodo.20424537');
      await shot('03-public-record');

      // a newer record is named and linked; its own state is read
      active = byName('naming a newer record');
      await page.goto(base + '?doi=10.6084%2Fm9.figshare.34978270.v1', { waitUntil: 'networkidle' });
      text = await verdict('public-record-newer-named');
      assert(text.includes('names a newer record: 10.6084/m9.figshare.34978270'), text);
      assert((await page.locator('.findings a[href^="?doi="]').count()) >= 1);

      active = byName('Crossref article with an addendum');
      await page.goto(base + '?doi=10.1038%2Fsdata.2016.18', { waitUntil: 'networkidle' });
      text = await verdict('public-record-update-notice');
      assert(text.includes('Crossref') && text.includes('journal-article') && !text.includes('Version field'), text);
      assert(text.includes('addendum 10.1038/example-addendum') && !text.includes('newer record'), text);

      active = byName('unregistered DOI');
      await page.goto(base + '?doi=10.48690%2Fdoes-not-exist-zz9', { waitUntil: 'networkidle' });
      text = await verdict('not-registered');
      assert(!text.includes('What this cannot tell you'), 'delivery block shown for an unregistered DOI');

      // a source that fails is Unknown, and says which source
      active = byName('registry error is unknown');
      await page.goto(base + '?doi=10.48690%2Fhe9y-d243', { waitUntil: 'networkidle' });
      text = await verdict('could-not-read');
      assert(text.includes('Unknown') && text.includes('No answer from: the DataCite registry'), text);
      assert(!text.includes('no public record'), 'a failed read was shown as a state');
      active = byName('handle service did not answer');
      await page.goto(base + '?doi=10.48690%2Fhe9y-d243', { waitUntil: 'networkidle' });
      text = await verdict('could-not-read');
      assert(text.includes('No answer from: the DOI resolver'), text);

      active = byName('agency this tool does not read');
      await page.goto(base + '?doi=10.1234%2Fabc', { waitUntil: 'networkidle' });
      text = await verdict('agency-not-read');
      assert(text.includes('mEDRA') && text.includes('example.org/item/abc'), text);

      // record text is inserted as text, never as markup
      active = JSON.parse(JSON.stringify(byName('one version of a parent')));
      active.sources.registry[1].data.attributes.titles[0].title = '<img src=x onerror="window.__x=1"><b>bold</b>';
      await page.goto(base + '?doi=10.5281%2Fzenodo.20424537', { waitUntil: 'networkidle' });
      text = await verdict('public-record');
      assert(text.includes('<b>bold</b>'), 'title not shown literally');
      assert.strictEqual(await page.evaluate(() => window.__x), undefined, 'markup from a record executed');
    }

    // not a DOI: no request, plain message
    active = null;
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.fill('#doi', 'landscan mosaic v2');
    await page.click('#btnCheck');
    text = await verdict('not-a-doi');
    assert(text.includes('does not look like a DOI'));
    assert((await page.locator('#btnCopy').count()) === 0);

    // phone width: no sideways scroll on a result with long addresses
    await page.setViewportSize({ width: 390, height: 800 });
    active = byName('synthetic: obsoleted');
    await page.goto(base + (LIVE ? '?doi=10.48690%2Fhe9y-d243' : '?doi=10.1234%2Fgrid.v1'), { waitUntil: 'networkidle' });
    await page.waitForSelector('#verdict');
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(over <= 1, 'page scrolls sideways at 390px by ' + over);
    await shot('04-phone');

    // method page and downloads
    await page.setViewportSize({ width: 1280, height: 900 });
    const m = await page.goto(base + 'method.html', { waitUntil: 'networkidle' });
    assert(m.ok());
    for (const id of ['delivery', 'reads', 'limits', 'sources']) assert(await page.locator('#' + id).count(), 'method.html missing #' + id);
    const over2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(over2 <= 1, 'method page scrolls sideways');
    await shot('05-method');
    await page.setViewportSize({ width: 390, height: 800 });
    const over3 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(over3 <= 1, 'method page scrolls sideways at 390px by ' + over3);
    await shot('06-method-phone');
    for (const f of ['check.py', 'receipts/2026-11-11.json', 'examples/compare_mirror_window.py', 'core.js']) {
      const r = await ctx.request.get(base + f);
      assert(r.ok(), f + ' ' + r.status());
    }
    const receipts = await (await ctx.request.get(base + 'receipts/2026-11-11.json')).json();
    assert.strictEqual(receipts.reads.length, 2);

    assert.deepStrictEqual(errors, [], 'console errors: ' + errors.join(' | '));
    assert.deepStrictEqual(foreign, [], 'requests outside the three sources: ' + foreign.join(' | '));
    console.log('browser smoke passed' + (LIVE ? ' (live sources)' : ' (sources answered from cases.json)'));
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
