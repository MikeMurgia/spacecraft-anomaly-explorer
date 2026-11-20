import json

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from pipeline import config


@pytest.fixture
def client(tmp_path, monkeypatch):
    (tmp_path / "signals").mkdir()
    (tmp_path / "meta.json").write_text(json.dumps({"missions": []}))
    (tmp_path / "signals" / "m2_id_1.json").write_text(json.dumps({"id": "m2_id_1"}))
    monkeypatch.setattr(config, "STATIC_API", tmp_path)
    return TestClient(app)


def test_meta(client):
    assert client.get("/api/meta").json() == {"missions": []}


def test_signals(client):
    assert client.get("/api/events/m2_id_1/signals").json() == {"id": "m2_id_1"}


def test_unknown_event_is_404(client):
    assert client.get("/api/events/m2_id_999/signals").status_code == 404


def test_malformed_event_id_is_rejected(client):
    assert client.get("/api/events/secret/signals").status_code == 400


def test_console_page_is_served(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "SPACECRAFT ANOMALY EXPLORER" in response.text
