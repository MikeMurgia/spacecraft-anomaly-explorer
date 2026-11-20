import pytest

from pipeline import config


def test_output_paths_stay_inside_repo():
    assert config.DATA_PROCESSED.is_relative_to(config.ROOT)
    assert config.STATIC_API.is_relative_to(config.ROOT)


def test_esa_root_requires_env_var(monkeypatch):
    monkeypatch.delenv("ESA_ROOT", raising=False)
    with pytest.raises(RuntimeError, match="Set ESA_ROOT"):
        config.esa_root()


def test_esa_root_rejects_missing_folder(monkeypatch, tmp_path):
    monkeypatch.setenv("ESA_ROOT", str(tmp_path / "nope"))
    with pytest.raises(RuntimeError, match="does not exist"):
        config.esa_root()


def test_esa_root_accepts_existing_folder(monkeypatch, tmp_path):
    monkeypatch.setenv("ESA_ROOT", str(tmp_path))
    assert config.esa_root() == tmp_path.resolve()
