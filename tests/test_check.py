#!/usr/bin/env python3
"""Runs tests/cases.json through check.py. The same file runs through core.js."""
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CHECK = next(p for p in (HERE.parent / "frontend" / "check.py", HERE.parent / "check.py") if p.exists())
spec = importlib.util.spec_from_file_location("check", CHECK)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)
CASES = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))


def run(case):
    s = case.get("sources") or {}
    ev = {"doi": check.normalize_doi(case["input"])}
    if "handle" in s:
        ev["handle"] = check.read_handle(*s["handle"])
    if "agency" in s:
        ev["agency"] = check.read_agency(*s["agency"])
    if "registry" in s:
        reader = check.read_crossref if (ev.get("agency") or {}).get("agency") == "Crossref" else check.read_datacite
        ev["registry"] = reader(*s["registry"])
    if "prefix" in s:
        ev["prefix"] = check.read_prefix(*s["prefix"])
    return check.classify(ev)


def main():
    for case in CASES["doi_cases"]:
        got = run(case)
        assert got["code"] == case["expect"]["code"], (case["name"], got)
        assert [f["code"] for f in got["findings"]] == case["expect"]["findings"], (case["name"], got)
        assert got["code"] in check.VERDICTS
        for f in got["findings"]:
            assert f["code"] in check.FINDINGS, f
    for case in CASES["host_cases"]:
        got = check.judge_hosts(tuple(case["target"]), [tuple(s) for s in case["siblings"]])
        assert got == case["expect"], (case, got)
        assert got in check.HOST_VERDICTS
    assert check.normalize_doi(" https://doi.org/10.48690/lsm/zew2-1n91 ") == "10.48690/lsm/zew2-1n91"
    assert check.normalize_doi("DOI: 10.5281/zenodo.20424537).") == "10.5281/zenodo.20424537"
    assert check.normalize_doi("https://doi.org/10.1002/%28SICI%291097") == "10.1002/(SICI)1097"
    assert check.normalize_doi("https://example.org/10.5281/x") is None
    assert check.doi_path("10.1002/(SICI)1097<a>#b") == "10.1002/%28SICI%291097%3Ca%3E%23b"
    for u in ("https://landscan.ornl.gov", "https://landscan.ornl.gov/", "http://x.org/#/home", "https://x.org?a=1"):
        assert check.is_site_root(u), u
    for u in ("https://x.org/data", "", None):
        assert not check.is_site_root(u), u
    print(f"check.py: {len(CASES['doi_cases'])} DOI cases + {len(CASES['host_cases'])} host cases passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
