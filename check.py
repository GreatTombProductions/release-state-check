#!/usr/bin/env python3
"""Release State Check, command-line form. Standard library only.

  python3 check.py doi 10.48690/he9y-d243
      Read a DOI's public state: does it resolve, which agency holds it, and
      does that agency's public registry have a record for it.

  python3 check.py hosts TARGET_URL --sibling URL [--sibling URL ...]
      Ask a download host for one file and for other datasets on the same host,
      to tell "this dataset is refused" from "this host refuses me".

Every read is a dated observation. Nothing here retries, signs in, follows a
login redirect, or tries a different route around a refusal.
"""
import argparse
import datetime
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

UA = "release-state-check/1.0 (static reader; no retries)"
TIMEOUT = 25
READ_AGENCIES = ("DataCite", "Crossref")
NEWER = ("IsPreviousVersionOf", "IsObsoletedBy")


# ---- reading rules (mirrors core.js; tests/cases.json runs through both) ----

def normalize_doi(text):
    s = urllib.parse.unquote(str(text or "").strip())
    s = re.sub(r"^doi:\s*", "", s, flags=re.I)
    s = re.sub(r"^https?://(dx\.)?doi\.org/", "", s, flags=re.I)
    s = re.sub(r"[.,;)\]]+$", "", s)
    return s if re.match(r"^10\.\d{4,9}/\S+$", s) else None


def doi_path(doi):
    return "/".join(urllib.parse.quote(part, safe="") for part in doi.split("/"))


def read_handle(http, body):
    if http == 404 or (isinstance(body, dict) and body.get("responseCode") == 100):
        return {"status": "missing"}
    if http != 200 or not isinstance(body, dict) or body.get("responseCode") != 1:
        return {"status": "error", "http": http}
    url = stamp = None
    for v in body.get("values") or []:
        data = v.get("data") or {}
        if v.get("type") == "URL" and isinstance(data.get("value"), str):
            url, stamp = data["value"], v.get("timestamp")
    return {"status": "found", "url": url, "timestamp": stamp}


def read_agency(http, body):
    if http != 200 or not isinstance(body, list) or not body:
        return {"status": "error", "http": http}
    if body[0].get("RA"):
        return {"status": "ok", "agency": body[0]["RA"]}
    return {"status": "missing"}


def read_datacite(http, body):
    if http == 404:
        return {"source": "datacite", "status": "absent"}
    a = ((body or {}).get("data") or {}).get("attributes") if isinstance(body, dict) else None
    if http != 200 or not a:
        return {"source": "datacite", "status": "error", "http": http}
    titles = a.get("titles") or []
    publisher = a.get("publisher")
    if isinstance(publisher, dict):
        publisher = publisher.get("name")
    return {"source": "datacite", "status": "public", "record": {
        "state": a.get("state"),
        "title": titles[0].get("title") if titles else None,
        "version": a.get("version") or None,
        "year": a.get("publicationYear"),
        "publisher": publisher,
        "registered": a.get("registered"),
        "updated": a.get("updated"),
        "url": a.get("url"),
        "sizes": a.get("sizes") or [],
        "formats": a.get("formats") or [],
        "rights": [r.get("rightsIdentifier") or r.get("rights") for r in a.get("rightsList") or []
                   if r.get("rightsIdentifier") or r.get("rights")],
        "contentUrls": a.get("contentUrl") or [],
        "related": [{"relation": r.get("relationType"), "id": r.get("relatedIdentifier"),
                     "idType": r.get("relatedIdentifierType")} for r in a.get("relatedIdentifiers") or []],
    }}


def read_crossref(http, body):
    if http == 404:
        return {"source": "crossref", "status": "absent"}
    m = (body or {}).get("message") if isinstance(body, dict) else None
    if http != 200 or not m:
        return {"source": "crossref", "status": "error", "http": http}
    try:
        year = m["issued"]["date-parts"][0][0]
    except (KeyError, IndexError, TypeError):
        year = None
    return {"source": "crossref", "status": "public", "record": {
        "state": "public",
        "title": (m.get("title") or [None])[0],
        "version": None,
        "year": year,
        "publisher": m.get("publisher"),
        "registered": (m.get("created") or {}).get("date-time"),
        "updated": (m.get("deposited") or {}).get("date-time"),
        "url": ((m.get("resource") or {}).get("primary") or {}).get("URL"),
        "sizes": [], "formats": [], "rights": [], "contentUrls": [],
        "related": [{"relation": "UpdatedBy:" + (u.get("type") or "update"), "id": u.get("DOI"), "idType": "DOI"}
                    for u in m.get("updated-by") or []],
        "kind": m.get("type"),
    }}


def read_prefix(http, body):
    total = ((body or {}).get("meta") or {}).get("total") if isinstance(body, dict) else None
    if http != 200 or not isinstance(total, int):
        return {"status": "error", "http": http}
    return {"status": "ok", "total": total}


def is_site_root(url):
    return bool(re.match(r"^https?://[^/?#]+(/?)([?#].*)?$", str(url or "").strip(), flags=re.I))


def same_address(a, b):
    def norm(u):
        return re.sub(r"/+$", "", re.sub(r"^http:", "https:", str(u or "").strip(), flags=re.I)).lower()
    return norm(a) == norm(b)


def classify(ev):
    findings = []

    def add(code, detail=None):
        findings.append({"code": code, "detail": detail})

    def done(code):
        findings.sort(key=lambda f: f["code"])
        return {"code": code, "findings": findings}

    if not ev.get("doi"):
        return done("not-a-doi")
    h = ev.get("handle") or {"status": "error"}
    if h["status"] == "missing":
        return done("not-registered")
    if h["status"] != "found":
        return done("could-not-read")
    if is_site_root(h.get("url")):
        add("landing-is-site-root", h.get("url"))

    ag = ev.get("agency") or {"status": "error"}
    if ag["status"] == "error":
        return done("could-not-read")
    if ag["status"] != "ok" or ag.get("agency") not in READ_AGENCIES:
        return done("agency-not-read")

    reg = ev.get("registry") or {"status": "error"}
    if reg["status"] == "error":
        return done("could-not-read")
    if reg["status"] == "absent":
        p = ev.get("prefix")
        if reg.get("source") == "datacite":
            if not p or p.get("status") != "ok":
                add("prefix-not-read")
            elif p["total"] > 0:
                add("prefix-has-public-records", p["total"])
            else:
                add("prefix-has-no-public-records")
        return done("resolves-no-public-record")

    rec = reg["record"]
    newer = [r for r in rec["related"] if r["relation"] in NEWER]
    if newer:
        add("names-newer-record", [r["id"] for r in newer])
    # Crossref update notices: addendum, correction, retraction, new version...
    notices = [r for r in rec["related"] if str(r["relation"]).startswith("UpdatedBy:")]
    if notices:
        add("has-update-notice", [f"{r['relation'][10:]}: {r['id']}" for r in notices])
    parents = [r for r in rec["related"] if r["relation"] == "IsVersionOf"]
    if parents:
        add("has-parent-record", [r["id"] for r in parents])
    children = [r for r in rec["related"] if r["relation"] == "HasVersion"]
    if children:
        add("lists-versions", len(children))
    if reg.get("source") == "datacite" and not rec.get("version"):
        add("no-version-field")
    if rec.get("url") and h.get("url") and not same_address(rec["url"], h["url"]):
        add("addresses-differ", [h["url"], rec["url"]])
    if rec["contentUrls"]:
        add("direct-file-urls", len(rec["contentUrls"]))
    if newer:
        return done("public-record-newer-named")
    return done("public-record-update-notice" if notices else "public-record")


# ---- network ----

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def get_json(url):
    """Return (http_status, parsed_body_or_None). Status 0 means no answer."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as err:
        status, raw = err.code, err.read()
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, None
    try:
        return status, json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return status, None


def probe(url):
    """One request, redirects not followed. Returns (status, location)."""
    opener = urllib.request.build_opener(_NoRedirect)
    for method, extra in (("HEAD", {}), ("GET", {"Range": "bytes=0-0"})):
        req = urllib.request.Request(url, method=method, headers={"User-Agent": UA, **extra})
        try:
            with opener.open(req, timeout=TIMEOUT) as resp:
                return resp.status, None
        except urllib.error.HTTPError as err:
            if err.code in (405, 501) and method == "HEAD":
                continue
            return err.code, err.headers.get("Location")
        except (urllib.error.URLError, TimeoutError, OSError):
            return 0, None
    return 0, None


def gather(doi):
    ev = {"doi": doi}
    path = doi_path(doi)
    ev["handle"] = read_handle(*get_json("https://doi.org/api/handles/" + path))
    if ev["handle"]["status"] != "found":
        return ev
    ev["agency"] = read_agency(*get_json("https://doi.org/doiRA/" + path))
    agency = ev["agency"].get("agency")
    if agency == "DataCite":
        ev["registry"] = read_datacite(*get_json("https://api.datacite.org/dois/" + path))
        if ev["registry"]["status"] == "absent":
            prefix = urllib.parse.quote(doi.split("/")[0], safe="")
            ev["prefix"] = read_prefix(*get_json("https://api.datacite.org/dois?prefix=" + prefix + "&page%5Bsize%5D=1"))
    elif agency == "Crossref":
        ev["registry"] = read_crossref(*get_json("https://api.crossref.org/works/" + path))
    return ev


VERDICTS = {
    "not-a-doi": "That is not a DOI. A DOI starts with 10. followed by a number, a slash and a name.",
    "not-registered": "This DOI is not registered. It does not resolve anywhere.",
    "could-not-read": "Unknown. A source did not answer, so no state is reported.",
    "agency-not-read": "The DOI resolves, but its registration agency is one this tool does not read.",
    "resolves-no-public-record": "The DOI resolves, but its agency's public registry has no record for it.",
    "public-record": "The agency's public registry has a record for this DOI.",
    "public-record-newer-named": "Public record, and the registry names a newer record.",
    "public-record-update-notice": "Public record, and the publisher has attached an update notice to it.",
}
FINDINGS = {
    "landing-is-site-root": "The DOI points at a site's front page, not a page for this dataset: {0}",
    "prefix-has-public-records": "The same DOI prefix has {0} public record(s). The registry is reachable for this publisher; this record is the exception.",
    "prefix-has-no-public-records": "The same DOI prefix has no public records at all.",
    "prefix-not-read": "Sibling records under the same prefix could not be read.",
    "names-newer-record": "The record names a newer record: {0}",
    "has-update-notice": "Update notice(s) attached (correction, addendum, retraction or new version): {0}",
    "has-parent-record": "The record is one version of a parent record: {0}",
    "lists-versions": "The record lists {0} version(s) under it.",
    "no-version-field": "The record carries no version field.",
    "addresses-differ": "The DOI and the registry record give different addresses: {0}",
    "direct-file-urls": "The record lists {0} direct file address(es).",
}


def cmd_doi(args):
    doi = normalize_doi(args.doi)
    ev = gather(doi) if doi else {"doi": None}
    result = classify(ev)
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    if args.json:
        print(json.dumps({"read_at": now, "evidence": ev, "result": result}, indent=2))
        return 0
    print(f"DOI: {doi or args.doi}")
    print(f"Read: {now}")
    print(f"Result: {VERDICTS[result['code']]}")
    handle, reg = ev.get("handle") or {}, ev.get("registry") or {}
    if handle.get("url"):
        print(f"Points at: {handle['url']} (address last set {handle.get('timestamp') or 'unknown'})")
    if (ev.get("agency") or {}).get("agency"):
        print(f"Agency: {ev['agency']['agency']}")
    rec = reg.get("record")
    if rec:
        print(f"Title: {rec.get('title')}")
        version = f"Version field: {rec.get('version') or 'none'} | " if reg.get("source") == "datacite" else ""
        print(f"{version}Year: {rec.get('year')} | Registered: {rec.get('registered')}")
        if rec.get("sizes") or rec.get("formats"):
            print(f"Declared size/format: {', '.join(rec['sizes']) or 'none'} / {', '.join(rec['formats']) or 'none'}")
    for f in result["findings"]:
        detail = f["detail"]
        if isinstance(detail, list):
            detail = " | ".join(str(d) for d in detail)
        print(" - " + FINDINGS[f["code"]].format(detail))
    print("A registry record is not a download. Whether the files are served is a separate check: see 'hosts'.")
    return 0


def judge_hosts(target, siblings):
    """target/siblings: (url, status). Returns a verdict code."""
    t_url, t_status = target
    host = urllib.parse.urlsplit(t_url).netloc.lower()
    same = [s for u, s in siblings if urllib.parse.urlsplit(u).netloc.lower() == host]
    if t_status == 0:
        return "no-answer"
    if 200 <= t_status < 300:
        return "served"
    if 300 <= t_status < 400:
        return "redirected"
    if t_status == 404:
        return "not-there"
    if t_status in (401, 403):
        if not same:
            return "refused-no-comparison"
        if any(200 <= s < 300 for s in same):
            return "refused-dataset-level"
        if all(s in (401, 403) for s in same):
            return "refused-host-level"
        return "refused-mixed"
    return "other"


HOST_VERDICTS = {
    "served": "The host served the target to this machine.",
    "redirected": "The host redirected. A redirect can be a login gate, so it was not followed.",
    "not-there": "The host says the target path does not exist (404).",
    "no-answer": "Unknown. The host did not answer.",
    "refused-dataset-level": "Dataset-level refusal: the host served a sibling dataset to this machine and refused the target.",
    "refused-host-level": "The host refused the target and every sibling. This cannot separate a block on your address from a closed host.",
    "refused-mixed": "The host refused the target; siblings gave neither a clean yes nor a clean refusal. No conclusion.",
    "refused-no-comparison": "The host refused the target. No sibling on the same host was given, so nothing can be compared.",
    "other": "The host answered with a status this tool does not interpret.",
}


def cmd_hosts(args):
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    host = urllib.parse.urlsplit(args.target).netloc.lower()
    print(f"Read: {now}")
    t_status, t_loc = probe(args.target)
    print(f"{t_status or 'no answer':>9}  target   {args.target}" + (f"  -> {t_loc}" if t_loc else ""))
    siblings = []
    for url in args.sibling or []:
        status, loc = probe(url)
        other = "" if urllib.parse.urlsplit(url).netloc.lower() == host else "  (different host: not compared)"
        print(f"{status or 'no answer':>9}  sibling  {url}" + (f"  -> {loc}" if loc else "") + other)
        siblings.append((url, status))
    print("Result: " + HOST_VERDICTS[judge_hosts((args.target, t_status), siblings)])
    print("This is what one machine saw at one time. It does not try another route.")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("doi", help="read a DOI's public release state")
    d.add_argument("doi")
    d.add_argument("--json", action="store_true", help="print the evidence and result as JSON")
    d.set_defaults(func=cmd_doi)
    h = sub.add_parser("hosts", help="compare a refused file with sibling datasets on the same host")
    h.add_argument("target")
    h.add_argument("--sibling", action="append", help="another dataset's address on the same host (repeatable)")
    h.set_defaults(func=cmd_hosts)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
