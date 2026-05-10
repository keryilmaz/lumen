/**
 * Plain-language naming for medical imaging concepts.
 *
 * The DICOM headers expose modality codes (CT, PT, OT) and Turkish/technical
 * series descriptions (CT_ABD_INCE_KESIT, PET AC, KORONAL). None of that means
 * anything to the patient or their family. This module maps them to phrases
 * a non-medical user actually understands. The original technical name is
 * preserved as a `subtitle` for anyone who wants to see it (tooltips, etc.).
 *
 * Keep medical jargon out of every label this returns.
 */

import type { SeriesMeta } from "./types";

export type FriendlyName = {
  /** Patient-facing primary label. No jargon. */
  title: string;
  /** Optional one-line explanation of what this view shows. */
  hint: string;
  /** Original technical label, for tooltips / power-users. */
  technical: string;
  /** Tiny tag for compact UIs (tabs). */
  short: string;
};

const MODALITY_FRIENDLY: Record<string, { word: string; hint: string }> = {
  CT: {
    word: "Body scan",
    hint: "X-ray-style 3D view of the body's structure (bones, organs, tissues).",
  },
  PT: {
    word: "Glucose scan",
    hint: "Shows where the body is using sugar most — active tissue glows. The brain, heart, kidneys, and bladder are normally bright.",
  },
  PET: {
    word: "Glucose scan",
    hint: "Shows where the body is using sugar most — active tissue glows. The brain, heart, kidneys, and bladder are normally bright.",
  },
  OT: {
    word: "Combined view",
    hint: "A processed view from the scanner — usually the body scan and glucose scan overlaid.",
  },
  MR: {
    word: "MRI scan",
    hint: "Detailed soft-tissue image using magnets (no radiation).",
  },
  US: { word: "Ultrasound", hint: "Sound-wave image of internal organs." },
  NM: { word: "Bone scan", hint: "Whole-body image of the skeleton using a tracer." },
  XR: { word: "X-ray", hint: "Standard 2D X-ray image." },
  MG: { word: "Mammogram", hint: "X-ray of the breast." },
};

/** Series-description regex → friendly suffix. Order matters — most specific first. */
const SERIES_PATTERNS: { match: RegExp; suffix: string; hint?: string }[] = [
  { match: /MIP|MAXIMUM\s*INTENSITY/i, suffix: "3D summary", hint: "A glowing 3D-style summary that highlights bright spots from any angle." },
  { match: /KORONAL|CORONAL/i, suffix: "front-back", hint: "Slices going from the front of the body to the back (like cutting from belly to spine)." },
  { match: /SAGIT|SAGITTAL/i, suffix: "side-side", hint: "Slices going from one side of the body to the other." },
  { match: /AXIAL/i, suffix: "top-down", hint: "Slices going from head to feet (each image is a horizontal cross-section through the body)." },
  { match: /LUNG.*BONE|BONE.*LUNG/i, suffix: "lungs & bones", hint: "Tuned to make air spaces in the lungs and bone detail clearer." },
  { match: /LUNG/i, suffix: "lungs", hint: "Tuned for the lungs." },
  { match: /BONE/i, suffix: "bones", hint: "Tuned for bone detail." },
  { match: /ABD.*INCE.*KESIT|ABD.*THIN|ABDOMEN.*THIN/i, suffix: "belly (detailed)", hint: "Belly area at the highest detail the scan offers." },
  { match: /ABD|ABDOMEN/i, suffix: "belly", hint: "The belly area." },
  { match: /HEAD|BRAIN|CRANIAL/i, suffix: "head", hint: "The head and brain area." },
  { match: /CHEST|THORAX/i, suffix: "chest", hint: "The chest area." },
  { match: /PELV/i, suffix: "pelvis", hint: "The pelvis area." },
  { match: /STANDARD/i, suffix: "standard view", hint: "" },
  { match: /^PET\s*AC$|^AC$/i, suffix: "", hint: "" }, // AC = "attenuation corrected" — the normal PET view, not worth surfacing
  { match: /DOSE\s*REPORT/i, suffix: "dose report", hint: "Radiation dose summary, not an image." },
];

export function friendlyName(meta: SeriesMeta): FriendlyName {
  const modality = (meta.modality ?? "").toUpperCase();
  const desc = (meta.series_description ?? "").trim();
  const mod = MODALITY_FRIENDLY[modality] ?? {
    word: modality || "Scan",
    hint: "",
  };

  let suffix = "";
  let hint = mod.hint;
  for (const p of SERIES_PATTERNS) {
    if (p.match.test(desc)) {
      suffix = p.suffix;
      if (p.hint) hint = p.hint;
      break;
    }
  }

  // For OT (combined) views, prefer the orientation suffix as primary distinguishing info
  let title: string;
  let short: string;
  if (modality === "OT") {
    title = suffix ? `Combined — ${suffix}` : "Combined view";
    short = suffix ? `Combined · ${suffix}` : "Combined";
  } else if (modality === "PT" || modality === "PET") {
    // PET tends to be just "PET AC" — no useful suffix to add
    title = mod.word;
    short = mod.word;
  } else {
    title = suffix ? `${mod.word} — ${suffix}` : mod.word;
    short = suffix ? `Body · ${suffix}` : mod.word;
  }

  return {
    title,
    hint,
    technical: `${modality} · ${desc || "—"}`,
    short,
  };
}

/** When two series produce the same short label (e.g. two OT/AXIAL series),
 *  append the image count so users can tell them apart in the tab strip. */
export function disambiguateShorts(series: { series_id: string; n_slices: number; short: string }[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const s of series) counts.set(s.short, (counts.get(s.short) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const s of series) {
    if ((counts.get(s.short) ?? 0) > 1) {
      out.set(s.series_id, `${s.short} (${s.n_slices})`);
    } else {
      out.set(s.series_id, s.short);
    }
  }
  return out;
}

/** "image" feels less clinical than "slice" to a non-medical user. */
export function imageWord(plural = false): string {
  return plural ? "images" : "image";
}

/** "marked" / "circled" instead of "drew annotations on". */
export function annotationVerb(): string {
  return "marked";
}
