"""Read DICOM headers from each series on a CD/folder and report structure.

Run:
  ./.venv/bin/python tools/python/inspect_disc.py [disc_path]
  ./.venv/bin/python tools/python/inspect_disc.py [disc_path] --json

Default disc_path: /Volumes/Untitled UDF Volume
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import pydicom


DEFAULT_DISC = "/Volumes/Untitled UDF Volume"
SAFE_ID_RE = re.compile(r"[^a-z0-9._-]+")


def dicom_date_to_iso(value) -> str:
    text = str(value or "").strip()
    if len(text) == 8 and text.isdigit():
        return f"{text[:4]}-{text[4:6]}-{text[6:8]}"
    if re.match(r"^\d{4}-\d{2}-\d{2}$", text):
        return text
    return ""


def slug(value: str) -> str:
    out = SAFE_ID_RE.sub("-", value.lower()).strip("-")
    return out[:48] or "study"


def inspect(disc_path: Path) -> dict:
    images_dir = disc_path / "images"
    if not images_dir.exists():
        raise FileNotFoundError(f"No images/ dir at {images_dir}")

    series_dirs = sorted(p for p in images_dir.iterdir() if p.is_dir())
    summary = []
    study_dates = []
    for sd in series_dirs:
        files = sorted(p for p in sd.iterdir() if p.is_file())
        n = len(files)
        if n == 0:
            continue
        try:
            ds = pydicom.dcmread(files[0], stop_before_pixels=True, force=True)
        except Exception as e:
            summary.append({
                "series_id": sd.name,
                "n_slices": n,
                "modality": "",
                "series_description": f"ERROR reading: {type(e).__name__}",
                "rows": 0,
                "columns": 0,
                "frames_per_file": 1,
            })
            continue

        study_date = dicom_date_to_iso(getattr(ds, "StudyDate", ""))
        if study_date:
            study_dates.append(study_date)
        summary.append({
            "series_id": sd.name,
            "n_slices": n,
            "modality": str(getattr(ds, "Modality", "")),
            "series_description": str(getattr(ds, "SeriesDescription", "")),
            "image_type": "/".join(getattr(ds, "ImageType", [])) if hasattr(ds, "ImageType") else "",
            "view": str(getattr(ds, "ViewPosition", "")),
            "side": str(getattr(ds, "ImageLaterality", "")),
            "rows": int(getattr(ds, "Rows", 0) or 0),
            "columns": int(getattr(ds, "Columns", 0) or 0),
            "frames_per_file": int(getattr(ds, "NumberOfFrames", 1) or 1),
            "manufacturer": str(getattr(ds, "Manufacturer", "")),
            "model": str(getattr(ds, "ManufacturerModelName", "")),
        })

    study_date = sorted(set(study_dates))[0] if study_dates else ""
    volume_name = disc_path.name
    suggested_label = f"{study_date} scan" if study_date else f"{volume_name} scan"
    suggested_id = slug(f"{study_date or volume_name}-scan")
    signature_parts = [
        f"{s['modality'].upper()}::{s['series_description'].strip().lower()}::{s['n_slices']}"
        for s in summary
        if s["series_id"] != "SE00999" and s["series_description"].strip().lower() != "dose report"
    ]
    signature = f"{study_date}|{'|'.join(sorted(signature_parts))}"
    return {
        "path": str(disc_path),
        "volume_name": volume_name,
        "study_date": study_date,
        "suggested_label": suggested_label,
        "suggested_id": suggested_id,
        "signature": signature,
        "series": summary,
    }


def print_table(result: dict) -> None:
    print(f"\n{len(result['series'])} series on disc: {result['path']}")
    if result["study_date"]:
        print(f"Study date: {result['study_date']}")
    print()
    print(
        f"{'Series':<10} {'N files':>8}  {'Modality':<10} {'Description':<35} "
        f"{'Type':<25} {'View':<8} {'Side':<6} {'WxH':<12}"
    )
    print("-" * 130)
    for s in result["series"]:
        desc = str(s.get("series_description", ""))[:33]
        img_type = str(s.get("image_type", ""))[:23]
        view = str(s.get("view", ""))[:6]
        side = str(s.get("side", ""))[:4]
        wh = f"{s.get('columns', '?')}x{s.get('rows', '?')}"
        print(
            f"{s['series_id']:<10} {s['n_slices']:>8}  {s.get('modality', ''):<10} "
            f"{desc:<35} {img_type:<25} {view:<8} {side:<6} {wh:<12}"
        )

    print()
    print("=== Per-series detail (first file) ===\n")
    for s in result["series"]:
        print(
            f"[{s['series_id']}] {s['n_slices']} files, "
            f"frames/file={s.get('frames_per_file', 1)}, "
            f"{s.get('modality', '')} {s.get('view', '')}{s.get('side', '')} | "
            f"{s.get('series_description', '')}"
        )
        print(f"   type: {s.get('image_type', '')}")
        print(f"   manuf: {s.get('manufacturer', '')} {s.get('model', '')}")
        print()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("disc_path", nargs="?", default=DEFAULT_DISC)
    ap.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    args = ap.parse_args()

    try:
        result = inspect(Path(args.disc_path).expanduser().resolve())
    except Exception as e:
        if args.json:
            print(json.dumps({"error": type(e).__name__, "message": str(e)}))
        else:
            print(str(e), file=sys.stderr)
        raise SystemExit(1)

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print_table(result)


if __name__ == "__main__":
    main()
