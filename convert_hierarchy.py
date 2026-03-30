#!/usr/bin/env python3
"""
rmp_folder_structure.py — Save the subfolder hierarchy of an .rmp lesson
folder as a JSON file.

Only folders that contain at least one .rmp file (directly or deeper)
are included — empty branches are omitted.

Output: a 'folder_structure.json' written next to the source folder.

Usage:
    python rmp_folder_structure.py lessons/
    python rmp_folder_structure.py lessons/ -o my_structure.json
"""

import os
import sys
import json
import argparse


def has_rmp(path: str) -> bool:
    """Return True if path contains any .rmp file anywhere beneath it."""
    for _, _, files in os.walk(path):
        if any(f.lower().endswith(".rmp") for f in files):
            return True
    return False


def build_tree(folder: str) -> dict:
    """
    Recursively build a nested dict representing the subfolder hierarchy.
    Each key is a folder name; its value is either:
      - a nested dict  (if it has subfolders with .rmp files), or
      - {}             (leaf folder — contains .rmp files but no relevant subfolders)
    """
    tree = {}
    try:
        entries = sorted(os.scandir(folder), key=lambda e: e.name)
    except PermissionError:
        return tree

    for entry in entries:
        if entry.is_dir(follow_symlinks=False) and has_rmp(entry.path):
            tree[entry.name] = build_tree(entry.path)

    return tree


def main():
    parser = argparse.ArgumentParser(
        description="Export the subfolder hierarchy of an .rmp lesson folder to JSON.")
    parser.add_argument("folder", help="Root folder containing .rmp lesson files")
    parser.add_argument("-o", "--output",
                        help="Output JSON path (default: folder_structure.json "
                             "next to the source folder)")
    args = parser.parse_args()

    root = os.path.normpath(args.folder)
    if not os.path.isdir(root):
        print(f"Error: '{root}' is not a directory.")
        sys.exit(1)

    tree = {os.path.basename(root): build_tree(root)}

    if args.output:
        out_path = args.output
    else:
        out_path = os.path.join(os.path.dirname(root), "folder_structure.json")

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(tree, f, indent=2, ensure_ascii=False)

    print(f"Saved folder structure to: {out_path}")


if __name__ == "__main__":
    main()