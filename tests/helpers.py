"""Shared helpers for the tests."""

import io
import zipfile


def write_zipped_pickle(path, frame):
    """Store a table the way ESA-ADB does: a pickle inside a zip, no extension on the inner file."""
    buffer = io.BytesIO()
    frame.to_pickle(buffer)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(path.stem, buffer.getvalue())
