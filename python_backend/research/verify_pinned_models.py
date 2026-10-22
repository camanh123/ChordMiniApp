"""Check the pinned Beat-Transformer and Chord-CNN-LSTM blobs.

This reads the local submodule checkouts and compares size and SHA-256 to
model_asset_manifest.json. It does not download files and it does not import
the model code.
"""

import hashlib
import json
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
MANIFEST_PATH = Path(__file__).with_name("model_asset_manifest.json")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    failures = []
    for model in manifest["models"]:
        license_path = REPO_ROOT / model["license_file"]
        if not license_path.is_file() or "MIT License" not in license_path.read_text(encoding="utf-8"):
            failures.append(f"{model['name']}: MIT license file missing at {license_path}")
        checkout = REPO_ROOT / Path(model["paths"][0]["path"]).parents[1]
        git_dir = checkout / ".git"
        if not git_dir.exists():
            failures.append(f"{model['name']}: submodule checkout missing at {checkout}")
        for item in model["paths"]:
            path = REPO_ROOT / item["path"]
            if not path.is_file():
                failures.append(f"missing {item['path']}")
                continue
            size = path.stat().st_size
            digest = sha256(path)
            if size != item["bytes"] or digest != item["sha256"]:
                failures.append(
                    f"mismatch {item['path']}: size {size} sha256 {digest}"
                )
            else:
                print(f"ok {item['bytes']} {digest} {item['path']}")
    if failures:
        for failure in failures:
            print(f"FAIL {failure}", file=sys.stderr)
        return 1
    print("pinned model assets match the manifest")
    return 0


if __name__ == "__main__":
    sys.exit(main())
