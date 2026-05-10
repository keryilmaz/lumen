"""Extract DICOM series from the disc into PHI-scrubbed PNGs + metadata sidecar.

Output layout:
  data/
    <series_id>/
      meta.json              # series-level metadata (PHI-scrubbed)
      slice_0000.png         # one PNG per slice, sorted by slice position
      slice_0001.png
      ...

Run:
  ./.venv/bin/python tools/python/extract.py [disc_path] [--series SE00012] [--workers 8]

PHI tags removed: PatientName, PatientID, PatientBirthDate, AccessionNumber,
InstitutionName, InstitutionAddress, ReferringPhysicianName, OperatorsName,
PhysicianOfRecord, RequestingPhysician, StudyID, StudyDate, StudyTime.

We keep: Modality, SeriesDescription, ImageType, ViewPosition, ImageLaterality,
SliceLocation, ImagePositionPatient, PixelSpacing, SliceThickness,
RescaleSlope/Intercept, WindowCenter/Width, RadiopharmaceuticalInformationSequence
(for PET SUV calc — does not contain PHI), Manufacturer, ManufacturerModelName.
"""
from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import pydicom
from PIL import Image


DEFAULT_DISC = "/Volumes/Untitled UDF Volume"
DEFAULT_OUT = Path(__file__).resolve().parents[2] / "data"


def _safe_get(ds, name, default=None):
    return getattr(ds, name, default)


def _scrubbed_meta(ds: pydicom.Dataset) -> dict:
    """Return non-PHI metadata for the series."""
    meta = {
        "modality": str(_safe_get(ds, "Modality", "")),
        "series_description": str(_safe_get(ds, "SeriesDescription", "")),
        "series_number": int(_safe_get(ds, "SeriesNumber", 0) or 0),
        "image_type": list(_safe_get(ds, "ImageType", []) or []),
        "view_position": str(_safe_get(ds, "ViewPosition", "")),
        "laterality": str(_safe_get(ds, "ImageLaterality", "")),
        "manufacturer": str(_safe_get(ds, "Manufacturer", "")),
        "model": str(_safe_get(ds, "ManufacturerModelName", "")),
        "rows": int(_safe_get(ds, "Rows", 0) or 0),
        "columns": int(_safe_get(ds, "Columns", 0) or 0),
        "pixel_spacing": [float(x) for x in (_safe_get(ds, "PixelSpacing", []) or [])],
        "slice_thickness": float(_safe_get(ds, "SliceThickness", 0) or 0),
        "window_center": _to_list_float(_safe_get(ds, "WindowCenter", None)),
        "window_width": _to_list_float(_safe_get(ds, "WindowWidth", None)),
        "rescale_slope": float(_safe_get(ds, "RescaleSlope", 1) or 1),
        "rescale_intercept": float(_safe_get(ds, "RescaleIntercept", 0) or 0),
    }
    return meta


def _to_list_float(v):
    if v is None:
        return None
    try:
        if hasattr(v, "__iter__") and not isinstance(v, str):
            return [float(x) for x in v]
        return [float(v)]
    except (TypeError, ValueError):
        return None


def _slice_position(ds: pydicom.Dataset) -> float:
    """Return the slice's z-position for sorting."""
    if hasattr(ds, "SliceLocation") and ds.SliceLocation is not None:
        try:
            return float(ds.SliceLocation)
        except (TypeError, ValueError):
            pass
    if hasattr(ds, "ImagePositionPatient") and ds.ImagePositionPatient is not None:
        try:
            return float(ds.ImagePositionPatient[2])
        except (TypeError, ValueError, IndexError):
            pass
    if hasattr(ds, "InstanceNumber") and ds.InstanceNumber is not None:
        try:
            return float(ds.InstanceNumber)
        except (TypeError, ValueError):
            pass
    return 0.0


def _to_8bit(arr: np.ndarray, modality: str, ds: pydicom.Dataset) -> np.ndarray:
    """Normalize a 2D array to 8-bit grayscale appropriate for the modality.

    - CT: applies a soft-tissue window (W=400, L=40) by default; if the
      DICOM has a WindowCenter/Width, uses the first one instead.
    - PT (PET): uses percentile-based clip (1st-99th) to handle the long tail
      of high-uptake regions; maps to 8-bit so hot regions stay bright.
    - OT / others: rescales to full dynamic range.
    """
    arr = arr.astype(np.float32)
    slope = float(getattr(ds, "RescaleSlope", 1) or 1)
    intercept = float(getattr(ds, "RescaleIntercept", 0) or 0)
    arr = arr * slope + intercept

    if modality == "CT":
        wc = getattr(ds, "WindowCenter", None)
        ww = getattr(ds, "WindowWidth", None)
        if wc is not None and ww is not None:
            try:
                wc = float(wc[0]) if hasattr(wc, "__iter__") and not isinstance(wc, str) else float(wc)
                ww = float(ww[0]) if hasattr(ww, "__iter__") and not isinstance(ww, str) else float(ww)
            except (TypeError, ValueError):
                wc, ww = 40.0, 400.0
        else:
            wc, ww = 40.0, 400.0
        lo, hi = wc - ww / 2.0, wc + ww / 2.0
    elif modality == "PT":
        lo = float(np.percentile(arr, 1))
        hi = float(np.percentile(arr, 99.5))
        if hi <= lo:
            hi = lo + 1.0
    else:  # OT, etc.
        lo = float(arr.min())
        hi = float(arr.max())
        if hi <= lo:
            hi = lo + 1.0

    arr = np.clip((arr - lo) / (hi - lo), 0.0, 1.0)
    return (arr * 255.0 + 0.5).astype(np.uint8)


def _convert_one(args):
    src_path, dst_path, modality = args
    try:
        ds = pydicom.dcmread(str(src_path), force=True)
        if not hasattr(ds, "PixelData"):
            return (src_path, "skipped: no pixel data")
        pixels = ds.pixel_array

        if pixels.ndim == 2:
            img8 = _to_8bit(pixels, modality, ds)
            Image.fromarray(img8, mode="L").save(str(dst_path), optimize=True)
            return (src_path, "ok")

        # 3D: either RGB color (last dim == 3) or multi-frame stack
        if pixels.ndim == 3:
            photo = str(getattr(ds, "PhotometricInterpretation", "")).upper()
            last = pixels.shape[-1]
            if last in (3, 4) and ("RGB" in photo or "YBR" in photo or "PALETTE" in photo or last == 3):
                # Color image (e.g., PET/CT fusion). Save as RGB PNG; clip to 0-255.
                arr = pixels.astype(np.float32)
                if arr.max() > 255 or arr.min() < 0:
                    lo, hi = float(arr.min()), float(arr.max())
                    if hi <= lo:
                        hi = lo + 1.0
                    arr = np.clip((arr - lo) / (hi - lo) * 255.0, 0, 255)
                rgb = arr[..., :3].astype(np.uint8)
                Image.fromarray(rgb, mode="RGB").save(str(dst_path), optimize=True)
                return (src_path, "ok")
            # Multi-frame: take middle frame for the per-file PNG (each file is one entry in the series)
            mid = pixels.shape[0] // 2
            img8 = _to_8bit(pixels[mid], modality, ds)
            Image.fromarray(img8, mode="L").save(str(dst_path), optimize=True)
            return (src_path, "ok (multi-frame, mid)")

        return (src_path, f"skipped: ndim={pixels.ndim}")
    except Exception as e:
        return (src_path, f"error: {type(e).__name__}: {e}")


def extract_series(disc_path: Path, series_id: str, out_root: Path, workers: int = 8) -> dict:
    series_src = disc_path / "images" / series_id
    if not series_src.is_dir():
        raise FileNotFoundError(f"Series not found: {series_src}")

    files = [p for p in series_src.iterdir() if p.is_file()]
    if not files:
        return {"series_id": series_id, "n_slices": 0, "status": "empty"}

    # Sort by slice position using header reads (cheap with stop_before_pixels)
    print(f"[{series_id}] reading {len(files)} headers for sort...")
    indexed = []
    for f in files:
        try:
            ds = pydicom.dcmread(str(f), stop_before_pixels=True, force=True)
            indexed.append((_slice_position(ds), f, ds))
        except Exception:
            indexed.append((0.0, f, None))
    indexed.sort(key=lambda t: t[0])

    # Use the first sortable file for series-level metadata
    first_ds = next((ds for _, _, ds in indexed if ds is not None), None)
    if first_ds is None:
        return {"series_id": series_id, "n_slices": 0, "status": "no readable headers"}

    modality = str(getattr(first_ds, "Modality", ""))
    out_dir = out_root / series_id
    out_dir.mkdir(parents=True, exist_ok=True)

    meta = _scrubbed_meta(first_ds)
    meta["series_id"] = series_id
    meta["n_slices"] = len(indexed)
    meta["slices"] = []

    jobs = []
    for i, (pos, src, ds) in enumerate(indexed):
        dst = out_dir / f"slice_{i:04d}.png"
        jobs.append((src, dst, modality))
        meta["slices"].append({
            "index": i,
            "filename": dst.name,
            "z_position": float(pos),
            "instance_number": int(getattr(ds, "InstanceNumber", i) or i) if ds is not None else i,
        })

    print(f"[{series_id}] converting {len(jobs)} slices ({modality}) with {workers} workers...")
    n_ok = 0
    n_err = 0
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for path, status in pool.map(_convert_one, jobs, chunksize=8):
            if status == "ok":
                n_ok += 1
            else:
                n_err += 1
                if n_err <= 5:
                    print(f"  ! {path.name}: {status}")

    meta["n_converted"] = n_ok
    meta["n_errors"] = n_err

    with open(out_dir / "meta.json", "w") as f:
        json.dump(meta, f, indent=2)

    print(f"[{series_id}] done: {n_ok} ok, {n_err} errors → {out_dir}")
    return {"series_id": series_id, "n_slices": len(jobs), "n_ok": n_ok, "status": "ok"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("disc_path", nargs="?", default=DEFAULT_DISC)
    ap.add_argument("--series", help="Single series ID (e.g. SE00012). Default: all viewable series.")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    disc = Path(args.disc_path)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    images_dir = disc / "images"
    if args.series:
        series_list = [args.series]
    else:
        # Skip the single-file dose report; convert everything else
        series_list = sorted(p.name for p in images_dir.iterdir() if p.is_dir())
        series_list = [s for s in series_list if s != "SE00999"]

    print(f"Extracting from: {disc}")
    print(f"Output dir: {out}")
    print(f"Series: {series_list}\n")

    results = []
    for sid in series_list:
        try:
            results.append(extract_series(disc, sid, out, workers=args.workers))
        except Exception as e:
            print(f"[{sid}] FAILED: {e}", file=sys.stderr)
            results.append({"series_id": sid, "status": f"failed: {e}"})

    # Rebuild study manifest from ALL series with a meta.json on disk (not just this run),
    # so per-series re-runs don't drop other series from the manifest.
    all_series = []
    for series_dir in sorted(out.iterdir()):
        if not series_dir.is_dir():
            continue
        meta_path = series_dir / "meta.json"
        if not meta_path.exists():
            continue
        try:
            m = json.loads(meta_path.read_text())
            all_series.append({
                "series_id": m.get("series_id", series_dir.name),
                "modality": m.get("modality", ""),
                "series_description": m.get("series_description", ""),
                "n_slices": m.get("n_slices", 0),
            })
        except Exception:
            pass

    study_meta = {"source": str(disc), "series": all_series}
    with open(out / "study.json", "w") as f:
        json.dump(study_meta, f, indent=2)
    print(f"\nWrote study manifest → {out / 'study.json'} ({len(all_series)} series)")


if __name__ == "__main__":
    main()
