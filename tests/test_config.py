import pytest

from pipeline import config


def test_output_paths_stay_inside_repo():
    assert config.DATA_RAW.is_relative_to(config.ROOT)
    assert config.DATA_PROCESSED.is_relative_to(config.ROOT)
    assert config.STATIC_API.is_relative_to(config.ROOT)


def test_esa_root_defaults_to_data_raw(monkeypatch, tmp_path):
    monkeypatch.delenv("ESA_ROOT", raising=False)
    monkeypatch.setattr(config, "DATA_RAW", tmp_path)
    assert config.esa_root() == tmp_path


def test_esa_root_uses_env_var(monkeypatch, tmp_path):
    monkeypatch.setenv("ESA_ROOT", str(tmp_path))
    assert config.esa_root() == tmp_path.resolve()


def test_esa_root_rejects_missing_folder(monkeypatch, tmp_path):
    monkeypatch.setenv("ESA_ROOT", str(tmp_path / "nope"))
    with pytest.raises(RuntimeError, match="not found"):
        config.esa_root()
