"""
Downloads the frontend libs (Bootstrap, jQuery) into ./libs.

Usage:
  podman compose run --rm downloader
"""

import os
import sys
import urllib.request

LIBS_DIR = os.environ.get("LIBS_DIR", "/downloads/libs")

FRONTEND_LIBS = [
    ("https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css",      "bootstrap.min.css"),
    ("https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js", "bootstrap.bundle.min.js"),
    ("https://code.jquery.com/jquery-3.7.1.min.js",                                  "jquery.min.js"),
]


def fetch(url: str, label: str) -> bytes:
    print(f"  GET {label} … ", end="", flush=True)
    req = urllib.request.Request(url, headers={"Accept": "*/*", "User-Agent": "python-downloader/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    print(f"OK ({len(data) // 1024} KB)")
    return data


def download_frontend_libs():
    print("\n[Bootstrap + jQuery]")
    os.makedirs(LIBS_DIR, exist_ok=True)
    for url, filename in FRONTEND_LIBS:
        dest = os.path.join(LIBS_DIR, filename)
        if os.path.exists(dest):
            print(f"  {filename} already exists — skipping")
            continue
        data = fetch(url, filename)
        with open(dest, "wb") as f:
            f.write(data)


def main():
    try:
        download_frontend_libs()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    print("\nDone.")


if __name__ == "__main__":
    main()
