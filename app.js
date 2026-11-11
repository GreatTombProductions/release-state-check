// Release State Check — page behaviour. Reading rules live in core.js.
(function () {
  'use strict';
  var C = window.ReleaseCore;
  var TIMEOUT_MS = 20000;
  var $ = function (id) { return document.getElementById(id); };

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function link(href, text) { return el('a', { href: href, rel: 'noopener', target: '_blank', text: text || href }); }
  function doiLink(doi) { return el('a', { href: '?doi=' + encodeURIComponent(doi), text: doi }); }

  // One GET. Resolves to [status, json|null]; status 0 = no answer.
  function getJson(url) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
    return fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer' })
      .then(function (r) {
        return r.text().then(function (t) {
          var body = null;
          try { body = JSON.parse(t); } catch (e) { body = null; }
          return [r.status, body];
        });
      })
      .catch(function () { return [0, null]; })
      .then(function (out) { clearTimeout(timer); return out; });
  }

  function gather(doi) {
    var path = C.doiPath(doi);
    var ev = { doi: doi, unanswered: [] };
    return getJson('https://doi.org/api/handles/' + path).then(function (h) {
      ev.handle = C.readHandle(h[0], h[1]);
      if (ev.handle.status === 'error') ev.unanswered.push('the DOI resolver (doi.org)');
      if (ev.handle.status !== 'found') return ev;
      return getJson('https://doi.org/doiRA/' + path).then(function (a) {
        ev.agency = C.readAgency(a[0], a[1]);
        if (ev.agency.status === 'error') { ev.unanswered.push('the agency lookup (doi.org)'); return ev; }
        if (ev.agency.agency === 'DataCite') {
          return getJson('https://api.datacite.org/dois/' + path).then(function (r) {
            ev.registry = C.readDatacite(r[0], r[1]);
            if (ev.registry.status === 'error') ev.unanswered.push('the DataCite registry');
            if (ev.registry.status !== 'absent') return ev;
            return getJson('https://api.datacite.org/dois?prefix=' + encodeURIComponent(C.prefixOf(doi)) + '&page%5Bsize%5D=1')
              .then(function (p) { ev.prefix = C.readPrefix(p[0], p[1]); return ev; });
          });
        }
        if (ev.agency.agency === 'Crossref') {
          return getJson('https://api.crossref.org/works/' + path).then(function (r) {
            ev.registry = C.readCrossref(r[0], r[1]);
            if (ev.registry.status === 'error') ev.unanswered.push('the Crossref registry');
            return ev;
          });
        }
        return ev;
      });
    });
  }

  // For each newer record the registry names, say whether it has a public record itself.
  function readNewer(ids) {
    var dois = ids.map(C.normalizeDoi).filter(Boolean).slice(0, 3);
    return Promise.all(dois.map(function (d) {
      return getJson('https://api.datacite.org/dois/' + C.doiPath(d)).then(function (r) {
        var reg = C.readDatacite(r[0], r[1]);
        return { doi: d, status: reg.status, record: reg.record || null };
      });
    }));
  }

  var VERDICT = {
    'not-a-doi': {
      tone: 'neutral', head: 'That does not look like a DOI.',
      body: 'A DOI starts with 10. then a number, a slash, and a name. For example 10.5281/zenodo.20424537. You can paste the whole https://doi.org/ address.'
    },
    'not-registered': {
      tone: 'bad', head: 'This DOI is not registered.',
      body: 'It does not resolve to anything. Check for a typo first. If it is printed this way in a paper, a catalogue or a data portal, the identifier was announced and never created, or was misprinted at the source.'
    },
    'could-not-read': {
      tone: 'neutral', head: 'Unknown: a source did not answer.',
      body: 'This is not a finding about the dataset. No state is reported when a source fails. Try again later.'
    },
    'agency-not-read': {
      tone: 'neutral', head: 'The DOI resolves. Its registry is not one this page reads.',
      body: 'This page reads the public registries of DataCite and Crossref, which hold most dataset and article DOIs. For other agencies, the address below is all it can report.'
    },
    'resolves-no-public-record': {
      tone: 'warn', head: 'Registered, but there is no public record.',
      body: 'The DOI resolves to an address, and its agency\u2019s public registry has no record for it. An identifier that works without a public record is how a DOI looks when it was created ahead of a release, and also when a record was pulled back from public listing. This page cannot tell you which. What it does tell you: a citation or catalogue entry carrying this DOI is not evidence that the release exists yet.'
    },
    'public-record': {
      tone: 'good', head: 'There is a public record for this DOI.',
      body: 'The publisher has declared this item in the public registry. That is a statement about the record. It is not a statement that the files are being served: see \u201cWhat this cannot tell you\u201d below.'
    },
    'public-record-update-notice': {
      tone: 'warn', head: 'There is a public record, and the publisher has attached an update to it.',
      body: 'A correction, addendum, retraction or new-version notice is linked to this record. Read the notice before you rely on the item.'
    },
    'public-record-newer-named': {
      tone: 'warn', head: 'There is a public record, and it names a newer one.',
      body: 'The registry record for this DOI points to a later record. If you were about to download, cite or pay for this one, look at the newer record first.'
    }
  };

  function findingNode(f, ev, newer) {
    var d = f.detail;
    switch (f.code) {
      case 'landing-is-site-root':
        return el('li', {}, ['The DOI points at a site\u2019s front page (', link(d), '), not at a page for this dataset. Which product, year or version that site hands out is decided by its download form, which no registry describes.']);
      case 'prefix-has-public-records':
        return el('li', { text: 'The same publisher prefix (' + C.prefixOf(ev.doi) + ') has ' + d.toLocaleString('en-US') + ' public record' + (d === 1 ? '' : 's') + '. The registry is working for this publisher; this record is the exception.' });
      case 'prefix-has-no-public-records':
        return el('li', { text: 'The same publisher prefix (' + C.prefixOf(ev.doi) + ') has no public records at all. This publisher may not list anything publicly, so the missing record says less.' });
      case 'prefix-not-read':
        return el('li', { text: 'Unknown: the list of sibling records under the same prefix could not be read.' });
      case 'names-newer-record': {
        var li = el('li', {}, ['The record names a newer record: ']);
        d.forEach(function (id, i) {
          if (i) li.appendChild(document.createTextNode('; '));
          li.appendChild(C.normalizeDoi(id) ? doiLink(C.normalizeDoi(id)) : document.createTextNode(String(id)));
          var n = (newer || []).filter(function (x) { return x.doi === C.normalizeDoi(id); })[0];
          if (n && n.status === 'public') li.appendChild(document.createTextNode(' (public record' + (n.record.version ? ', version field \u201c' + n.record.version + '\u201d' : '') + ')'));
          else if (n && n.status === 'absent') li.appendChild(document.createTextNode(' (no public DataCite record)'));
          else li.appendChild(document.createTextNode(' (state not read)'));
        });
        li.appendChild(document.createTextNode('.'));
        return li;
      }
      case 'has-update-notice': {
        var lu = el('li', {}, ['Update notice' + (d.length === 1 ? '' : 's') + ' attached: ']);
        d.forEach(function (t, i) {
          var parts = String(t).split(': ');
          if (i) lu.appendChild(document.createTextNode('; '));
          lu.appendChild(document.createTextNode(parts[0].replace(/_/g, ' ') + ' '));
          lu.appendChild(link('https://doi.org/' + parts[1], parts[1]));
        });
        lu.appendChild(document.createTextNode('.'));
        return lu;
      }
      case 'has-parent-record': {
        var lp = el('li', {}, ['This is one version under a parent record: ']);
        d.forEach(function (id, i) {
          if (i) lp.appendChild(document.createTextNode('; '));
          lp.appendChild(C.normalizeDoi(id) ? doiLink(C.normalizeDoi(id)) : document.createTextNode(String(id)));
        });
        lp.appendChild(document.createTextNode('. A parent record usually resolves to the latest version. This page does not work out whether yours is the latest; open the parent to see.'));
        return lp;
      }
      case 'lists-versions':
        return el('li', { text: 'The record lists ' + d + ' version' + (d === 1 ? '' : 's') + ' under it.' });
      case 'no-version-field':
        return el('li', { text: 'The record carries no version field. If the title or the landing page names a version, the registry does not back it up either way.' });
      case 'addresses-differ':
        return el('li', {}, ['The DOI resolves to ', link(d[0]), ' while the registry record gives ', link(d[1]), '. One of the two is out of date.']);
      case 'direct-file-urls':
        return el('li', { text: 'The record lists ' + d + ' direct file address' + (d === 1 ? '' : 'es') + ' (shown below). A browser page cannot test another site\u2019s files; the command-line reader can.' });
    }
    return el('li', { text: f.code });
  }

  function facts(ev) {
    var rows = [];
    var h = ev.handle || {}, rec = ev.registry && ev.registry.record;
    if (h.url) rows.push(['Points at', link(h.url)]);
    if (h.timestamp) rows.push(['Address last set', h.timestamp.slice(0, 10)]);
    if (ev.agency && ev.agency.agency) rows.push(['Registration agency', ev.agency.agency]);
    if (rec) {
      rows.push(['Title', rec.title || 'none given']);
      if (rec.kind) rows.push(['Type', rec.kind]);
      if (ev.registry.source === 'datacite') rows.push(['Version field', rec.version || 'none']);
      rows.push(['Publisher', rec.publisher || 'none given']);
      rows.push(['Year', rec.year ? String(rec.year) : 'none given']);
      if (rec.registered) rows.push(['Record registered', rec.registered.slice(0, 10)]);
      if (rec.updated) rows.push(['Record last updated', rec.updated.slice(0, 10)]);
      if (rec.sizes.length || rec.formats.length) rows.push(['Declared size and format', (rec.sizes.join(', ') || 'no size') + ' / ' + (rec.formats.join(', ') || 'no format') + ' (as declared; not measured)']);
      if (rec.rights.length) rows.push(['Licence, as declared', rec.rights.join(', ')]);
      rec.contentUrls.slice(0, 5).forEach(function (u) { rows.push(['File address', link(u)]); });
    }
    var dl = el('dl', { class: 'facts' });
    rows.forEach(function (r) {
      dl.appendChild(el('dt', { text: r[0] }));
      dl.appendChild(el('dd', {}, [r[1]]));
    });
    return rows.length ? dl : null;
  }

  function stamp(d) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' UTC';
  }

  function plainText(node) {
    return node.innerText.replace(/\n{3,}/g, '\n\n').trim();
  }

  function render(input, ev, result, newer, when) {
    var v = VERDICT[result.code];
    var out = $('result');
    out.innerHTML = '';
    out.className = 'result tone-' + v.tone;
    var card = el('div', { id: 'read' });
    card.appendChild(el('p', { class: 'meta', id: 'readMeta', text: 'Read ' + stamp(when) + (ev.doi ? ' \u00b7 ' + ev.doi : '') }));
    card.appendChild(el('h2', { id: 'verdict', 'data-code': result.code, text: v.head }));
    card.appendChild(el('p', { class: 'verdict-body', text: v.body }));
    if (result.code === 'could-not-read' && ev.unanswered && ev.unanswered.length)
      card.appendChild(el('p', { class: 'verdict-body', text: 'No answer from: ' + ev.unanswered.join(', ') + '.' }));
    if (result.code === 'agency-not-read' && ev.agency && ev.agency.agency)
      card.appendChild(el('p', { class: 'verdict-body', text: 'Agency: ' + ev.agency.agency + '.' }));
    var f = facts(ev);
    if (f && result.code !== 'not-a-doi') card.appendChild(f);
    if (result.findings.length) {
      card.appendChild(el('h3', { text: 'What else the record shows' }));
      var ul = el('ul', { class: 'findings' });
      result.findings.forEach(function (x) { ul.appendChild(findingNode(x, ev, newer)); });
      card.appendChild(ul);
    }
    out.appendChild(card);

    var registered = ['resolves-no-public-record', 'public-record', 'public-record-newer-named', 'public-record-update-notice', 'agency-not-read'].indexOf(result.code) !== -1;
    if (registered) {
      var lim = el('div', { class: 'limits', id: 'limits' });
      lim.appendChild(el('h3', { text: 'What this cannot tell you' }));
      lim.appendChild(el('p', { text: 'Whether you can get the files. A registry record is a declaration by the publisher. The download site is a different system, and it can serve an older version, a different product, or nothing, whatever the record says. The reverse also happens: files are sometimes served before the record goes public.' }));
      lim.appendChild(el('p', {}, ['To check the delivery side yourself, work through ', el('a', { href: 'method.html#delivery', text: 'the three delivery checks' }), '. They take a few minutes and need no account.']));
      var files = (ev.registry && ev.registry.record && ev.registry.record.contentUrls) || [];
      var target = files[0] || 'https://HOST/PATH/TO/FILE';
      lim.appendChild(el('p', { class: 'small', text: 'If a download address refuses you, this compares it with another dataset on the same host:' }));
      lim.appendChild(el('pre', { class: 'cmd', text: 'python3 check.py hosts "' + target + '" --sibling "https://SAME-HOST/ANOTHER-DATASET/"' }));
      out.appendChild(lim);
    }

    var actions = el('div', { class: 'actions' });
    var copy = el('button', { type: 'button', class: 'btn', id: 'btnCopy', text: 'Copy this read as text' });
    copy.addEventListener('click', function () {
      var text = 'Release State Check\n' + plainText(card) + '\n\nA registry record is not a download. This is what public sources said at the time shown; states change.\n' + location.href;
      $('copyBox').value = text;
      $('copyBox').hidden = false;
      $('copyBox').select();
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { copy.textContent = 'Copied'; }, function () {});
    });
    actions.appendChild(copy);
    actions.appendChild(el('textarea', { id: 'copyBox', hidden: 'hidden', rows: '8', readonly: 'readonly', 'aria-label': 'This read as text' }));
    if (result.code !== 'not-a-doi') out.appendChild(actions);
    out.hidden = false;
  }

  var running = 0;
  function check(raw, push) {
    var mine = ++running;
    var doi = C.normalizeDoi(raw);
    var out = $('result');
    if (!doi) {
      render(raw, { doi: null }, C.classify({ doi: null }), [], new Date());
      return Promise.resolve();
    }
    if (push) history.replaceState(null, '', '?doi=' + encodeURIComponent(doi));
    out.hidden = false;
    out.className = 'result tone-neutral';
    out.innerHTML = '';
    out.appendChild(el('p', { class: 'meta', id: 'working', text: 'Reading doi.org and the registry for ' + doi + ' \u2026' }));
    return gather(doi).then(function (ev) {
      var result = C.classify(ev);
      var named = result.findings.filter(function (f) { return f.code === 'names-newer-record'; })[0];
      return (named ? readNewer(named.detail) : Promise.resolve([])).then(function (newer) {
        if (mine === running) render(raw, ev, result, newer, new Date());
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('form').addEventListener('submit', function (e) {
      e.preventDefault();
      check($('doi').value, true);
    });
    var q = new URLSearchParams(location.search).get('doi');
    if (q) { $('doi').value = q; check(q, false); }
  });
})();
