"""Read DICOM headers from each series on the disc and report structure.

Run: ./.venv/bin/python tools/python/inspect_disc.py [disc_path]
Default disc_path: /Volumes/Untitled UDF Volume
"""
import sys
from pathlib import Path
from collections import defaultdict
import pydicom


DEFAULT_DISC = "/Volumes/Untitled UDF Volume"

KEY_TAGS = [
    "Modality",
    "SeriesDescription",
    "ImageType",
    "PresentationIntentType",
    "ViewPosition",
    "ImageLaterality",
    "Manufacturer",
    "ManufacturerModelName",
    "Rows",
    "Columns",
    "BitsAllocated",
    "PhotometricInterpretation",
    "NumberOfFrames",
]


def summarize(disc_path: Path):
    images_dir = disc_path / "images"
    if not images_dir.exists():
        print(f"No images/ dir at {images_dir}")
        return

    series_dirs = sorted(p for p in images_dir.iterdir() if p.is_dir())
    print(f"\n{len(series_dirs)} series on disc: {disc_path}\n")
    print(f"{'Series':<10} {'N files':>8}  {'Modality':<10} {'Description':<35} {'Type':<25} {'View':<8} {'Side':<6} {'WxH':<12}")
    print("-" * 130)

    summary = []
    for sd in series_dirs:
        files = sorted(sd.iterdir())
        n = len(files)
        if n == 0:
            continue
        # Read first file
        try:
            ds = pydicom.dcmread(files[0], stop_before_pixels=True, force=True)
        except Exception as e:
            print(f"{sd.name:<10} {n:>8}  ERROR reading: {e}")
            continue

        modality = str(getattr(ds, "Modality", "?"))
        desc = str(getattr(ds, "SeriesDescription", ""))[:33]
        img_type = "/".join(getattr(ds, "ImageType", []))[:23] if hasattr(ds, "ImageType") else ""
        view = str(getattr(ds, "ViewPosition", ""))[:6]
        side = str(getattr(ds, "ImageLaterality", ""))[:4]
        rows = getattr(ds, "Rows", "?")
        cols = getattr(ds, "Columns", "?")
        wh = f"{cols}x{rows}"
        nframes = getattr(ds, "NumberOfFrames", 1)

        print(f"{sd.name:<10} {n:>8}  {modality:<10} {desc:<35} {img_type:<25} {view:<8} {side:<6} {wh:<12}")

        summary.append({
            "series": sd.name,
            "n_files": n,
            "modality": modality,
            "desc": desc,
            "type": img_type,
            "view": view,
            "side": side,
            "rows": rows,
            "cols": cols,
            "frames_per_file": nframes,
            "manufacturer": str(getattr(ds, "Manufacturer", "")),
            "model": str(getattr(ds, "ManufacturerModelName", "")),
        })

    print()
    print("=== Per-series detail (first file) ===\n")
    for s in summary:
        print(f"[{s['series']}] {s['n_files']} files, frames/file={s['frames_per_file']}, "
              f"{s['modality']} {s['view']}{s['side']} | {s['desc']}")
        print(f"   type: {s['type']}")
        print(f"   manuf: {s['manufacturer']} {s['model']}")
        print()


if __name__ == "__main__":
    disc = Path(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DISC)
    summarize(disc)
