"""Static checks on the frontend: every file the page asks for exists, and every path is relative.

GitHub Pages serves the site from /spacecraft-anomaly-explorer/, so a path starting with "/" would
work on the local server but break on the live site. These tests catch that, and a typo in an
import or font path, without needing a browser.
"""

import re
from pathlib import Path

import pytest

FRONTEND = Path(__file__).resolve().parents[1] / "frontend"
JS_FILES = sorted((FRONTEND / "js").glob("*.js"))


def local_refs(text: str, pattern: str) -> list[str]:
    refs = re.findall(pattern, text)
    return [r for r in refs if not r.startswith(("http:", "https:", "data:", "#", "mailto:"))]


def test_index_html_references_exist():
    html = (FRONTEND / "index.html").read_text(encoding="utf-8")
    refs = local_refs(html, r'(?:src|href)="([^"]+)"')
    assert refs, "expected the page to reference local files"
    for ref in refs:
        assert not ref.startswith("/"), f"{ref} must be relative for GitHub Pages"
        assert (FRONTEND / ref).is_file(), f"index.html references missing file {ref}"


def test_css_urls_exist():
    for css in (FRONTEND / "css").glob("*.css"):
        for ref in local_refs(css.read_text(encoding="utf-8"), r'url\("?([^")]+)"?\)'):
            assert (css.parent / ref).resolve().is_file(), f"{css.name} references missing file {ref}"


@pytest.mark.parametrize("path", JS_FILES, ids=lambda p: p.name)
def test_js_imports_exist(path):
    for ref in re.findall(r'^import .* from "([^"]+)";', path.read_text(encoding="utf-8"), flags=re.M):
        assert ref.startswith("./"), f"{path.name}: import {ref} should be a relative module path"
        assert (path.parent / ref).resolve().is_file(), f"{path.name} imports missing module {ref}"


@pytest.mark.parametrize("path", JS_FILES, ids=lambda p: p.name)
def test_js_fetches_are_relative(path):
    for ref in re.findall(r'["`](/?api/[^"`$]*)', path.read_text(encoding="utf-8")):
        assert not ref.startswith("/"), f"{path.name}: {ref} must be relative for GitHub Pages"


def test_every_bundled_font_has_its_licence():
    families = {f.name.split("-latin-")[0] for f in (FRONTEND / "fonts").glob("*.woff2")}
    assert families == {"rajdhani", "ibm-plex-mono", "ibm-plex-sans"}
    for family in families:
        assert (FRONTEND / "fonts" / f"OFL-{family}.txt").is_file()
