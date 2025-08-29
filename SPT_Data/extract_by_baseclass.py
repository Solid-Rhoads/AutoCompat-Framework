#!/usr/bin/env python3
"""
extract_by_baseclass.py

Reads items.json from the script's directory, reads BaseClasses.d.ts (if present)
to build base-class mappings and exclusions, follows each item's _parent chain
and collects top-level item keys that ultimately inherit from WEAPON, MOD, or AMMO.

Writes vanillaItems.json in the same directory.
"""

import os
import re
import json
import sys

# Fallback mapping if BaseClasses.d.ts is not present or can't be parsed.
FALLBACK_BASE_CLASSES = {
    "WEAPON": "5422acb9af1c889c16000029",
    "MOD": "5448fe124bdc2da5018b4567",
    "AMMO": "5485a8684bdc2da71d8b4567",
}

def script_dir():
    if "__file__" in globals():
        return os.path.dirname(os.path.abspath(__file__))
    return os.getcwd()

def parse_baseclasses_from_file(path):
    """
    Parse lines like:
      WEAPON = "5422acb9af1c889c16000029",
    Returns dict {NAME: id}
    """
    mapping = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except Exception:
        return mapping

    # Match NAME = "24hexchars"
    for m in re.finditer(r'([A-Z0-9_]+)\s*=\s*"([0-9a-f]{24})"', text):
        name = m.group(1)
        _id = m.group(2)
        mapping[name] = _id
    return mapping

def load_items(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def find_baseclass_ancestor(item_id, data, target_ids):
    """
    Follow _parent chain from item_id. If any ancestor equals one of target_ids,
    return the matching baseclass id. Otherwise return None.
    """
    # If the item itself is a target (rare); treat as found
    if item_id in target_ids:
        return item_id

    visited = set()
    cur = item_id

    while True:
        entry = data.get(cur)
        if not entry:
            return None

        parent = entry.get("_parent")
        # no parent or empty parent
        if not parent:
            return None

        if parent in target_ids:
            return parent

        if parent in visited:
            # cycle detected
            return None
        visited.add(parent)

        cur = parent

def main():
    base_dir = script_dir()
    infile = os.path.join(base_dir, "items.json")
    baseclasses_file = os.path.join(base_dir, "BaseClasses.d.ts")
    outfile = os.path.join(base_dir, "vanillaItems.json")

    if not os.path.isfile(infile):
        print(f"ERROR: cannot find {infile}. Place items.json in the same folder as this script.")
        sys.exit(1)

    # Parse BaseClasses.d.ts if present
    parsed = {}
    if os.path.isfile(baseclasses_file):
        parsed = parse_baseclasses_from_file(baseclasses_file)
        if not parsed:
            print(f"Warning: found {baseclasses_file} but couldn't parse entries. Falling back to built-in mapping.")
    else:
        print("Note: BaseClasses.d.ts not found — using fallback mapping for WEAPON, MOD, and AMMO.")

    # Build mapping: prefer parsed values when available, otherwise fall back
    baseclasses = {}
    for key in ("WEAPON", "MOD", "AMMO"):
        if key in parsed:
            baseclasses[key] = parsed[key]
        else:
            baseclasses[key] = FALLBACK_BASE_CLASSES[key]

    # Build full exclusions set from parsed (if available) OR at least include our known baseclasses
    exclusions = set()
    if parsed:
        exclusions.update(parsed.values())
    else:
        exclusions.update(FALLBACK_BASE_CLASSES.values())

    try:
        data = load_items(infile)
    except Exception as e:
        print(f"ERROR loading JSON from {infile}: {e}")
        sys.exit(1)

    target_ids = set(baseclasses.values())
    result = {name: [] for name in baseclasses.keys()}

    for top_id in data.keys():
        # Skip any top-level key that is itself a base-class id (we don't want baseclass nodes)
        if top_id in exclusions:
            continue

        ancestor = find_baseclass_ancestor(top_id, data, target_ids)
        if ancestor:
            # map ancestor id -> name
            for name, bid in baseclasses.items():
                if bid == ancestor:
                    result[name].append(top_id)
                    break

    # Sort lists for reproducibility
    for name in result:
        result[name].sort()

    try:
        with open(outfile, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"ERROR writing {outfile}: {e}")
        sys.exit(1)

    counts = {k: len(v) for k, v in result.items()}
    print(f"Wrote {outfile}. Counts: {counts}")
    print(f"Excluded {len(exclusions)} base-class ids from output.")

if __name__ == "__main__":
    main()
