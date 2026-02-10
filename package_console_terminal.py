#!/usr/bin/env python3
import argparse
import os
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Iterable, Set


DEFAULT_EXTS = {
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".json",
    ".css",
    ".scss",
    ".html",
    ".md",
    ".txt",
    ".yaml",
    ".yml",
    ".toml",
    ".py",
}

DEFAULT_EXCLUDE_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".idea",
    ".vscode",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
}

OUTPUTS_DIR = "/Users/rustamhudaygulyyev/Library/Mobile Documents/com~apple~CloudDocs/Downloads"


def _iter_files(root: Path, include_exts: Set[str], exclude_dirs: Set[str]) -> Iterable[Path]:
    for current_root, dirs, files in os.walk(root):
        dirs[:] = [
            d
            for d in dirs
            if d not in exclude_dirs
            and not d.startswith(".")
        ]
        for filename in files:
            if filename.startswith("."):
                continue
            path = Path(current_root) / filename
            if path.suffix.lower() in include_exts:
                yield path


def _read_file(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="latin-1", errors="replace")


def _copy_to_clipboard(text: str) -> None:
    try:
        subprocess.run(["pbcopy"], input=text.encode("utf-8"), check=True)
        return
    except Exception:
        pass
    try:
        import pyperclip  # type: ignore

        pyperclip.copy(text)
    except Exception as exc:
        raise RuntimeError(f"Failed to copy to clipboard: {exc}") from exc


def collect_code(root: Path, include_exts: Set[str], exclude_dirs: Set[str]) -> str:
    combined = ["# Combined Code Export\n"]
    for path in sorted(_iter_files(root, include_exts, exclude_dirs)):
        rel_path = path.relative_to(root)
        combined.append(f"\n\n# File: {rel_path}\n")
        combined.append(_read_file(path))
    return "".join(combined)


def main() -> None:
    default_root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(
        description="Concatenate code files under console-terminal and copy to clipboard."
    )
    parser.add_argument(
        "--root",
        default=str(default_root),
        help="Root folder to scan (default: console-terminal folder).",
    )
    parser.add_argument(
        "--include",
        default=",".join(sorted(DEFAULT_EXTS)),
        help="Comma-separated list of file extensions to include.",
    )
    parser.add_argument(
        "--exclude",
        default=",".join(sorted(DEFAULT_EXCLUDE_DIRS)),
        help="Comma-separated list of directory names to exclude.",
    )
    parser.add_argument(
        "--output",
        help="Optional output file path to save the combined code.",
    )
    args = parser.parse_args()

    root = Path(args.root).resolve()
    include_exts = {ext if ext.startswith(".") else f".{ext}" for ext in args.include.split(",") if ext}
    exclude_dirs = {d for d in args.exclude.split(",") if d}

    combined = collect_code(root, include_exts, exclude_dirs)

    if args.output:
        output_path = Path(args.output)
    else:
        timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
        output_path = Path(OUTPUTS_DIR) / f"combined_code_{timestamp}.txt"
    output_path.write_text(combined, encoding="utf-8")

    _copy_to_clipboard(combined)

    size_kb = len(combined.encode("utf-8")) / 1024
    print(f"Saved: {output_path}")
    print(f"Copied to clipboard ({size_kb:.1f} KB).")


if __name__ == "__main__":
    main()
