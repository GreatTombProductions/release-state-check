'use strict';
// Runs tests/cases.json through core.js. The same file runs through check.py
// (tests/test_check.py); both must give the same verdict and finding codes.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const here = __dirname;
const corePath = [path.join(here, '..', 'frontend', 'core.js'), path.join(here, '..', 'core.js')].find(fs.existsSync);
const core = require(corePath);
const cases = JSON.parse(fs.readFileSync(path.join(here, 'cases.json'), 'utf8'));

function run(c) {
  const s = c.sources || {};
  const doi = core.normalizeDoi(c.input);
  const ev = { doi };
  if (s.handle) ev.handle = core.readHandle(s.handle[0], s.handle[1]);
  if (s.agency) ev.agency = core.readAgency(s.agency[0], s.agency[1]);
  if (s.registry) {
    const reader = ev.agency && ev.agency.agency === 'Crossref' ? core.readCrossref : core.readDatacite;
    ev.registry = reader(s.registry[0], s.registry[1]);
  }
  if (s.prefix) ev.prefix = core.readPrefix(s.prefix[0], s.prefix[1]);
  return core.classify(ev);
}

let n = 0;
for (const c of cases.doi_cases) {
  const r = run(c);
  assert.strictEqual(r.code, c.expect.code, c.name);
  assert.deepStrictEqual(r.findings.map((f) => f.code), c.expect.findings, c.name);
  n++;
}

// input handling
assert.strictEqual(core.normalizeDoi(' https://doi.org/10.48690/lsm/zew2-1n91 '), '10.48690/lsm/zew2-1n91');
assert.strictEqual(core.normalizeDoi('DOI: 10.5281/zenodo.20424537).'), '10.5281/zenodo.20424537');
assert.strictEqual(core.normalizeDoi('https://doi.org/10.1002/%28SICI%291097'), '10.1002/(SICI)1097');
assert.strictEqual(core.normalizeDoi(''), null);
assert.strictEqual(core.normalizeDoi('https://example.org/10.5281/x'), null);
assert.strictEqual(core.doiPath('10.1002/(SICI)1097<a>#b'), '10.1002/(SICI)1097%3Ca%3E%23b');
// a front page is a front page with or without the slash, a query or a fragment
for (const u of ['https://landscan.ornl.gov', 'https://landscan.ornl.gov/', 'http://x.org/#/home', 'https://x.org?a=1'])
  assert.strictEqual(core.isSiteRoot(u), true, u);
for (const u of ['https://x.org/data', 'https://x.org/a/b.html', '', null])
  assert.strictEqual(core.isSiteRoot(u), false, String(u));
// the 2026-11-11 captures carry the detail the page prints
const first = run(cases.doi_cases[0]);
assert.strictEqual(first.findings.find((f) => f.code === 'prefix-has-public-records').detail, 86);

console.log(`core: ${n} cases + input checks passed`);
