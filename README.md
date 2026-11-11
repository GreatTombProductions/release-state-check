# Release State Check

Paste a dataset DOI and see whether the release behind it has actually been published or only announced.

**Use it:** https://greattombproductions.github.io/release-state-check/

A catalogue lists a new version. A paper cites a DOI. The download page offers something else, or nothing. From the outside, "not yet published" and "published but not served" look the same. This page asks the DOI system and the registry directly and prints what each one says, with the time it asked:

- **Not registered** — the DOI does not resolve. It was announced or misprinted.
- **Registered, no public record** — the DOI resolves, and its agency's public registry has no record for it. This is how a DOI looks when it was created ahead of a release, and when a record was withdrawn from listing. A citation carrying it is not evidence the release exists.
- **Public record** — the publisher has declared the item. The record's title, version field, dates, declared size and licence are shown.
- **Public record, newer named** — the record itself links to a later record.
- **Public record, update attached** — a correction, addendum or retraction notice is linked to the record (mostly articles).
- **Unknown** — a source did not answer. A failed read is never shown as a state.

It also flags a DOI that points at a site's front page instead of a dataset page, a record with no version field, and a record that is one version under a parent.

## What it cannot tell you

Whether you can get the files. A registry record is a declaration; the download site is a different system and can serve an older version, a different product, or nothing. The method page walks through three delivery-side checks you can run yourself in a few minutes, and shows two worked reads dated 11 November 2026 with every address and status in `receipts/2026-11-11.json`.

This is a dated read. Nothing runs after you close the page, and it will not tell you when a state changes. It reads DataCite and Crossref; DOIs held by other agencies are reported as not read. It never requests a data file and never tries a second route around a refusal.

## Privacy

Your browser asks `https://doi.org`, `https://api.datacite.org` and `https://api.crossref.org` directly. This site receives nothing and stores nothing. Those three services see the request the way they would if you had opened the address yourself.

## Command line

`check.py` is the same reader for a terminal, plus the sibling check a browser is not allowed to do. Python 3, standard library only.

```
python3 check.py doi 10.48690/he9y-d243
python3 check.py doi 10.5281/zenodo.20424537 --json
```

When a file address refuses you, ask the same host for another dataset to tell "this dataset is closed" from "this host refuses me":

```
python3 check.py hosts "https://HOST/DATASET-A/file.tif" --sibling "https://HOST/DATASET-B/"
```

It makes one request per address, does not follow redirects (a redirect can be a login gate) and does not retry.

`examples/compare_mirror_window.py` is the script behind the mirror comparison in the second worked read. It needs numpy, rasterio and zarr version 3, and is written for that one dataset; treat it as a pattern.

## Files

- `index.html`, `app.js`, `style.css` — the page
- `core.js` — the reading rules (pure functions)
- `check.py` — the command-line reader; implements the same rules
- `method.html` — method, delivery checks, worked reads, sources
- `receipts/2026-11-11.json` — addresses and statuses behind the worked reads
- `tests/cases.json` — recorded and synthetic source answers with the expected result

## Tests

```
node tests/test_core.js
python3 tests/test_check.py
python3 tests/run_browser_smoke.py
```

The first two run `tests/cases.json` through both implementations of the rules; they must agree. The third drives the page in a headless browser with the sources answered from the same file, and needs Node with Playwright installed. Set `SMOKE_LIVE=1` to let it ask the real sources instead.

## Sources

- DOI resolution and agency lookup: https://www.doi.org/the-identifier/resources/factsheets/doi-resolution-documentation
- DataCite DOI states: https://support.datacite.org/docs/doi-states
- DataCite public API: https://support.datacite.org/docs/api
- Crossref public API: https://www.crossref.org/documentation/retrieve-metadata/rest-api/

Not affiliated with any registry or publisher.

## License

MIT
