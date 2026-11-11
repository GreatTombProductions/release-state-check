// Release State Check — reading rules. Pure functions, no network.
// The same rules are implemented in check.py; tests/cases.json is run through
// both and the verdict and finding codes must match exactly.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReleaseCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var READ_AGENCIES = ['DataCite', 'Crossref'];
  // DataCite relation types that say "something newer than this record exists".
  var NEWER = ['IsPreviousVersionOf', 'IsObsoletedBy'];

  function normalizeDoi(input) {
    var s = String(input == null ? '' : input).trim();
    try { s = decodeURIComponent(s); } catch (e) { /* keep as typed */ }
    s = s.replace(/^doi:\s*/i, '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    s = s.replace(/[.,;)\]]+$/, '');
    return /^10\.\d{4,9}\/\S+$/.test(s) ? s : null;
  }

  function doiPath(doi) {
    return doi.split('/').map(encodeURIComponent).join('/');
  }

  function prefixOf(doi) { return doi.split('/')[0]; }

  function readHandle(http, body) {
    if (http === 404 || (body && body.responseCode === 100)) return { status: 'missing' };
    if (http !== 200 || !body || body.responseCode !== 1) return { status: 'error', http: http };
    var url = null, stamp = null;
    (body.values || []).forEach(function (v) {
      if (v.type === 'URL' && v.data && typeof v.data.value === 'string') { url = v.data.value; stamp = v.timestamp || null; }
    });
    return { status: 'found', url: url, timestamp: stamp };
  }

  function readAgency(http, body) {
    if (http !== 200 || !Array.isArray(body) || !body.length) return { status: 'error', http: http };
    if (body[0].RA) return { status: 'ok', agency: body[0].RA };
    return { status: 'missing' };
  }

  function readDatacite(http, body) {
    if (http === 404) return { source: 'datacite', status: 'absent' };
    var a = body && body.data && body.data.attributes;
    if (http !== 200 || !a) return { source: 'datacite', status: 'error', http: http };
    return {
      source: 'datacite', status: 'public',
      record: {
        state: a.state || null,
        title: (a.titles && a.titles[0] && a.titles[0].title) || null,
        version: a.version || null,
        year: a.publicationYear || null,
        publisher: (a.publisher && a.publisher.name) || a.publisher || null,
        registered: a.registered || null,
        updated: a.updated || null,
        url: a.url || null,
        sizes: a.sizes || [],
        formats: a.formats || [],
        rights: (a.rightsList || []).map(function (r) { return r.rightsIdentifier || r.rights; }).filter(Boolean),
        contentUrls: a.contentUrl || [],
        related: (a.relatedIdentifiers || []).map(function (r) {
          return { relation: r.relationType, id: r.relatedIdentifier, idType: r.relatedIdentifierType };
        })
      }
    };
  }

  function readCrossref(http, body) {
    if (http === 404) return { source: 'crossref', status: 'absent' };
    var m = body && body.message;
    if (http !== 200 || !m) return { source: 'crossref', status: 'error', http: http };
    var related = (m['updated-by'] || []).map(function (u) {
      return { relation: 'UpdatedBy:' + (u.type || 'update'), id: u.DOI, idType: 'DOI' };
    });
    return {
      source: 'crossref', status: 'public',
      record: {
        state: 'public',
        title: (m.title && m.title[0]) || null,
        version: null,
        year: (m.issued && m.issued['date-parts'] && m.issued['date-parts'][0] && m.issued['date-parts'][0][0]) || null,
        publisher: m.publisher || null,
        registered: (m.created && m.created['date-time']) || null,
        updated: (m.deposited && m.deposited['date-time']) || null,
        url: (m.resource && m.resource.primary && m.resource.primary.URL) || null,
        sizes: [], formats: [], rights: [], contentUrls: [],
        related: related,
        kind: m.type || null
      }
    };
  }

  function readPrefix(http, body) {
    if (http !== 200 || !body || !body.meta || typeof body.meta.total !== 'number') return { status: 'error', http: http };
    return { status: 'ok', total: body.meta.total };
  }

  function isSiteRoot(url) {
    var m = /^https?:\/\/[^\/?#]+(\/?)([?#].*)?$/i.exec(String(url || '').trim());
    return !!m;
  }

  function sameAddress(a, b) {
    function norm(u) { return String(u || '').trim().replace(/^http:/i, 'https:').replace(/\/+$/, '').toLowerCase(); }
    return norm(a) === norm(b);
  }

  // ev: { doi, handle, agency, registry, prefix }
  function classify(ev) {
    var findings = [];
    function add(code, detail) { findings.push({ code: code, detail: detail === undefined ? null : detail }); }
    function done(code) {
      findings.sort(function (x, y) { return x.code < y.code ? -1 : x.code > y.code ? 1 : 0; });
      return { code: code, findings: findings };
    }

    if (!ev.doi) return done('not-a-doi');
    var h = ev.handle || { status: 'error' };
    if (h.status === 'missing') return done('not-registered');
    if (h.status !== 'found') return done('could-not-read');
    if (isSiteRoot(h.url)) add('landing-is-site-root', h.url);

    var ag = ev.agency || { status: 'error' };
    if (ag.status === 'error') return done('could-not-read');
    if (ag.status !== 'ok' || READ_AGENCIES.indexOf(ag.agency) === -1) return done('agency-not-read');

    var reg = ev.registry || { status: 'error' };
    if (reg.status === 'error') return done('could-not-read');
    if (reg.status === 'absent') {
      var p = ev.prefix;
      if (reg.source === 'datacite') {
        if (!p || p.status !== 'ok') add('prefix-not-read');
        else if (p.total > 0) add('prefix-has-public-records', p.total);
        else add('prefix-has-no-public-records');
      }
      return done('resolves-no-public-record');
    }

    var rec = reg.record;
    var newer = rec.related.filter(function (r) { return NEWER.indexOf(r.relation) !== -1; });
    if (newer.length) add('names-newer-record', newer.map(function (r) { return r.id; }));
    // Crossref update notices: addendum, correction, retraction, new version...
    var notices = rec.related.filter(function (r) { return /^UpdatedBy:/.test(r.relation); });
    if (notices.length) add('has-update-notice', notices.map(function (r) { return r.relation.slice(10) + ': ' + r.id; }));
    var parents = rec.related.filter(function (r) { return r.relation === 'IsVersionOf'; });
    if (parents.length) add('has-parent-record', parents.map(function (r) { return r.id; }));
    var children = rec.related.filter(function (r) { return r.relation === 'HasVersion'; });
    if (children.length) add('lists-versions', children.length);
    if (reg.source === 'datacite' && !rec.version) add('no-version-field');
    if (rec.url && h.url && !sameAddress(rec.url, h.url)) add('addresses-differ', [h.url, rec.url]);
    if (rec.contentUrls.length) add('direct-file-urls', rec.contentUrls.length);
    return done(newer.length ? 'public-record-newer-named' : notices.length ? 'public-record-update-notice' : 'public-record');
  }

  return {
    normalizeDoi: normalizeDoi, doiPath: doiPath, prefixOf: prefixOf,
    readHandle: readHandle, readAgency: readAgency, readDatacite: readDatacite,
    readCrossref: readCrossref, readPrefix: readPrefix, isSiteRoot: isSiteRoot, classify: classify,
    READ_AGENCIES: READ_AGENCIES
  };
});
