"""Loopback-only Flask process for the Next.js integration test.

Usage: serve_localhost_inference.py PORT

The inference secret is taken from the process environment. This script does
not print it and refuses every bind address other than 127.0.0.1.
"""

import os
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


def main() -> int:
    if len(sys.argv) != 2 or not sys.argv[1].isdigit():
        print("usage: serve_localhost_inference.py PORT", file=sys.stderr)
        return 2
    port = int(sys.argv[1])
    if port < 1 or port > 65535:
        print("refusing an invalid port", file=sys.stderr)
        return 2

    os.environ["TESTING"] = "1"
    os.environ.pop("PORT", None)
    os.environ.pop("FLASK_ENV", None)

    from app_factory import create_app

    app = create_app("testing")
    app.run(
        host="127.0.0.1",
        port=port,
        debug=False,
        use_reloader=False,
        threaded=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
