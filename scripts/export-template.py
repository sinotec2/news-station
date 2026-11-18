"""Export an independent News Station source template from the committed checkout."""

import argparse
import io
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
PROJECT_FILES = {
    ".env.example", ".gitignore", ".openai/hosting.json", "ARCHITECTURE.md",
    "EDITORIAL.md", "NEURAL-AUDIO.md", "OPERATIONS.md", "README.md",
    "SOURCE-REGISTRY.yaml", "build.mjs", "content/editions.json",
    "package.json", "package-lock.json",
}
CODE = {
    "worker": {".js"}, "web": {".js"},
    "scripts": {".mjs", ".py", ".sh"}, "tests": {".js"}, "tests/fixtures": {".js"},
}
UPSTREAM_NOTE = re.compile(r"<!-- source-repository-only -->.*?<!-- /source-repository-only -->\s*", re.S)


def source_path(name):
    path = PurePosixPath(name)
    return name in PROJECT_FILES or (
        not path.name.startswith(".") and ".env." not in path.name and path.suffix in CODE.get(str(path.parent), ())
    )


def export(destination):
    git = ["git", "-C", str(ROOT)]
    worktree = subprocess.check_output([*git, "rev-parse", "--show-toplevel"], text=True).strip()
    if Path(worktree).resolve() != ROOT:
        raise ValueError("Run the exporter from its own committed News Station checkout.")
    # Read Git blobs, including executable modes. Local runtime files never enter the archive.
    tar = subprocess.check_output([*git, "archive", "--format=tar", "HEAD", "--",
                                   *sorted(PROJECT_FILES), "worker", "web", "scripts", "tests"])
    result = io.BytesIO()
    archived = set()
    with tarfile.open(fileobj=io.BytesIO(tar)) as source, zipfile.ZipFile(result, "w") as template:
        for item in source:
            if not item.isfile() or not source_path(item.name):
                continue
            if item.name == "content/editions.json":
                data = b"[]\n"
            elif item.name == ".openai/hosting.json":
                data = b'{\n  "r2": "EDITION_BUCKET"\n}\n'
            else:
                data = source.extractfile(item).read()
                if item.name == "README.md":
                    data = UPSTREAM_NOTE.sub("", data.decode("utf-8")).encode("utf-8")
            entry = zipfile.ZipInfo("news-station/" + item.name)
            entry.create_system = 3
            entry.external_attr = (0o100755 if item.mode & 0o111 else 0o100644) << 16
            template.writestr(entry, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
            archived.add(item.name)
    required = PROJECT_FILES | {"scripts/export-template.py", "scripts/cron-edition.sh", "worker/index.js"}
    if required - archived:
        raise ValueError("Committed template files missing: " + ", ".join(sorted(required - archived)))
    with destination.open("xb") as output:
        output.write(result.getbuffer())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="new .zip file")
    args = parser.parse_args()
    try:
        export(args.output)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Export failed: {error}\n")
    print(args.output)
