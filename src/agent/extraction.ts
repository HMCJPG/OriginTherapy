/**
 * Intake extraction.
 *
 * One small parser per `ExtractedIntake` field, plus the top-level
 * `extractIntake` that runs all of them and the `listMissingIntake`
 * helper used to populate the output's `missing_info`.
 *
 * Each extractor is best-effort regex with documented fallback
 * order. We intentionally use deterministic regex chains instead of
 * an LLM here so the output is auditable, fast, and reproducible
 * against hidden synthetic input. Whatever can't be extracted
 * becomes null and shows up in `missing_info`.
 *
 * Adding a new field?
 *   1. Add it to ExtractedIntake in src/types.ts.
 *   2. Add it to schema/output.schema.json.
 *   3. Write a small `extract<Field>` here and wire it into
 *      `extractIntake` + `listMissingIntake`.
 */

import { KNOWN_PAYER_PHRASES } from "./constants.js";
import { escapeRegExp, isBlankMarker, stripTrailingDots, trimField } from "./utils.js";
import type { Discipline, ExtractedIntake, InboxItem } from "../types.js";

// ---------------------------------------------------------------------
// Field extractors
// ---------------------------------------------------------------------

/**
 * Pulls the child's name. Tried patterns in priority order:
 *   1. Labeled "Child:" fields (most reliable - structured fax).
 *   2. Subject "Referral for X" / "Referral: X".
 *   3. Relational phrasing in body ("my son X", "mi hija X").
 *   4. "for X" / "about X" inside the body.
 *   5. "N-year-old X" phrasing.
 *   6. "X threw / is / was / has / ..." sentence start (item_8 case).
 *   7. "X's DOB" phrasing.
 */
export function extractChildName(item: InboxItem): string | null {
  const sources = [item.body, item.subject];
  const patterns: RegExp[] = [
    /Child:\s*([^.\n]+)/i,
    /Referral(?:\s+for|:)\s+([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)+)/,
    /(?:my (?:son|daughter|child)|mi (?:hija|hijo))\s+([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)?)/i,
    /(?:for|about)\s+([A-Z][\w'.-]+\s+[A-Z][\w'.-]+)/,
    /\d{1,2}[-\s]year[-\s]old\s+([A-Z][\w'.-]+)/i,
    /([A-Z][\w'.-]+\s+[A-Z][\w'.-]+)\s+(?:threw|is|was|has|fell|tripped|got)/,
    /([A-Z][\w'.-]+)'s\s+DOB/,
  ];

  for (const pattern of patterns) {
    for (const source of sources) {
      const match = source.match(pattern);
      if (!match) continue;
      const value = trimField(match[1]);
      if (value && !isBlankMarker(value)) return value;
    }
  }
  return null;
}

/**
 * Returns an ISO date if `YYYY-MM-DD` appears, otherwise the literal
 * "age N" if an age phrase appears, otherwise null.
 *
 * Downstream code uses the ISO form for `search_patient` and treats
 * "age N" as a missing-DOB-but-known-age signal.
 */
export function extractDobOrAge(item: InboxItem): string | null {
  const body = item.body;

  const iso = body.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];

  const explicitAge = body.match(
    /(?:is|tiene|age)\s+(\d{1,2})(?:\s*(?:years?|yo|year-old|anos|años))?\b/i,
  );
  if (explicitAge) return `age ${explicitAge[1]}`;

  const yearOld = body.match(/(\d{1,2})[-\s]year[-\s]old/i);
  if (yearOld) return `age ${yearOld[1]}`;

  return null;
}

/**
 * Assembles a parent/guardian contact string.
 *
 * Tried in order:
 *   1. Labeled "Parent:" / "Parent/guardian:" field. Sentence-aware
 *      so emails with internal periods (daniel.lee@example.com)
 *      survive the capture.
 *   2. "I am his parent, X" / "soy X" / "this is X" relational
 *      phrasing in the body.
 *   3. Inbound sender if it looks like a person (skips referring
 *      clinics by checking for fax/pediatrics/clinic in the name).
 *
 * Phone and email are picked up separately and joined onto whatever
 * name we extracted. Returns null when the "Parent:" label was
 * explicitly marked blank, so item_6-style stubs surface as missing.
 */
export function extractParentContact(item: InboxItem): string | null {
  const body = item.body;

  // Stop at sentence boundary (period + space + capital) so emails
  // with internal periods survive the capture.
  const labeled = body.match(
    /Parent(?:\/guardian)?:\s*([^\n]+?)(?=\s*\.\s+[A-Z]|\.\s*$|\n|$)/i,
  );
  if (labeled) {
    const value = trimField(labeled[1]);
    if (!value || isBlankMarker(value)) return null;
    return value;
  }

  const phone = body.match(/\b(\d{3}[-.\s]?\d{4})\b/)?.[1] ?? null;
  const email = stripTrailingDots(
    body.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ??
      item.sender.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ??
      null,
  );

  let parentName: string | null = null;

  // No `/i` flag - the name capture needs strict capital letters so
  // the second word doesn't gobble lowercase trailing prose. The
  // leading anchors use char classes for local case-insensitivity.
  const relational = body.match(
    /(?:[Ii] am|[Ii]'m|[Tt]his is|[Ss]oy)\s+(?:[Hh]is|[Hh]er|[Tt]heir)?\s*(?:[Pp]arent,?\s+|[Mm]other,?\s+|[Ff]ather,?\s+|[Mm]om,?\s+|[Dd]ad,?\s+)?([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)\b/,
  );
  if (relational) parentName = trimField(relational[1]);

  if (!parentName) {
    const cleanedSender = item.sender
      .replace(/<[^>]+>/g, "")
      .replace(/voicemail|via parent portal|fax/gi, "")
      .trim();
    if (
      cleanedSender &&
      /^[A-Z]/.test(cleanedSender) &&
      !/pediatrics|clinic|hospital|fax/i.test(cleanedSender)
    ) {
      parentName = cleanedSender;
    }
  }

  const parts = [parentName, phone, email].filter(
    (value): value is string => Boolean(value),
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Detects SLP / OT / PT from labeled fields and inline vocabulary.
 * Returns null if nothing recognisable was found.
 */
export function extractDisciplines(item: InboxItem): Discipline[] | null {
  const text = `${item.subject}\n${item.body}`;
  const found = new Set<Discipline>();

  const labeled = text.match(/Discipline(?:\s+requested)?:\s*([^.\n]+)/i);
  if (labeled && !isBlankMarker(labeled[1])) {
    for (const tag of labeled[1].toUpperCase().match(/\b(SLP|OT|PT)\b/g) ?? []) {
      found.add(tag as Discipline);
    }
  }

  if (/\bSLP\b|speech|articulation|language|R sound|habla/i.test(text)) {
    found.add("SLP");
  }
  if (/\bOT\b|occupational|sensory|feeding|fine motor/i.test(text)) {
    found.add("OT");
  }
  if (/\bPT\b|physical therapy|gait|toe walking|gross motor|tripping/i.test(text)) {
    found.add("PT");
  }

  return found.size > 0 ? Array.from(found) : null;
}

/**
 * Pulls the chief concern / diagnosis. Tries labeled fields first,
 * then common referral phrasing ("evaluation for X", "concern is X").
 */
export function extractConcern(item: InboxItem): string | null {
  const body = item.body;

  const labels = ["Concern", "Diagnosis/concern", "Diagnosis"];
  for (const label of labels) {
    const re = new RegExp(`${label}:\\s*([^.\\n]+)`, "i");
    const match = body.match(re);
    if (match && !isBlankMarker(match[1])) return trimField(match[1]);
  }

  const evalFor = body.match(
    /(?:looking for|for an?|for a)\s+(?:[A-Z]+\s+)?evaluation\s+for\s+([^.\n]+)/i,
  );
  if (evalFor) return trimField(evalFor[1]);

  const concernAbout = body.match(/(?:concern|issue|problem)\s+(?:is|with|about)\s+([^.\n]+)/i);
  if (concernAbout) return trimField(concernAbout[1]);

  return null;
}

/**
 * Pulls the payer name. Tries labeled "Insurance:" fields, "Insurance
 * is X" phrasing, then scans for any known payer-name fragment so we
 * still catch unstructured mentions like "Tenemos Medicaid".
 */
export function extractPayer(item: InboxItem): string | null {
  const body = item.body;

  const labeled = body.match(/Insurance:\s*([^.\n,]+)/i);
  if (labeled) {
    const value = trimField(labeled[1]);
    if (value && !isBlankMarker(value)) return value;
    if (isBlankMarker(value)) return null;
  }

  const inline = body.match(/Insurance is\s+([^.,\n]+)/i);
  if (inline) return trimField(inline[1]);

  for (const phrase of KNOWN_PAYER_PHRASES) {
    const phraseRe = new RegExp(
      `\\b(${escapeRegExp(phrase)}(?:\\s+(?:PPO|HMO|EPO|POS))?)`,
      "i",
    );
    const match = body.match(phraseRe);
    if (match) return trimField(match[1]);
  }

  return null;
}

/** Pulls a member ID from "Member ID: X" or Spanish "miembro X". */
export function extractMemberId(item: InboxItem): string | null {
  const body = item.body;

  const labeled = body.match(/Member ID:\s*([A-Z0-9-]+)/i);
  if (labeled && !isBlankMarker(labeled[1])) return trimField(labeled[1]);

  const inline = body.match(/member\s+(?:id\s+|number\s+)?([A-Z]{2,}-\d+)/i);
  if (inline) return trimField(inline[1]);

  const spanish = body.match(/miembro\s+([A-Z0-9-]+)/i);
  if (spanish) return trimField(spanish[1]);

  return null;
}

/**
 * Pulls the family's stated scheduling preference. Optional - used
 * as a hint passed to find_slots and surfaced to staff in task notes.
 */
export function extractPreferences(item: InboxItem): string | null {
  const labeled = item.body.match(/Preferred(?:\s+availability)?:\s*([^.\n]+)/i);
  if (labeled) return trimField(labeled[1]);

  const prefers = item.body.match(/(?:family\s+)?prefers?\s+([^.\n]+)/i);
  if (prefers) return trimField(prefers[1]);

  return null;
}

// ---------------------------------------------------------------------
// Aggregate intake + missing-info
// ---------------------------------------------------------------------

/**
 * Runs every extractor and returns the full ExtractedIntake shape
 * the schema requires (all fields always present, nullable).
 */
export function extractIntake(item: InboxItem): ExtractedIntake {
  return {
    child_name: extractChildName(item),
    dob_or_age: extractDobOrAge(item),
    parent_contact: extractParentContact(item),
    discipline: extractDisciplines(item),
    diagnosis_or_concern: extractConcern(item),
    payer: extractPayer(item),
    member_id: extractMemberId(item),
  };
}

/**
 * Lists intake fields that came back null. Surfaced to staff via
 * `missing_info` so they know what to follow up on. Strings are
 * intentionally plain-English (not field identifiers) because they
 * show up directly in the output for human readers.
 */
export function listMissingIntake(intake: ExtractedIntake): string[] {
  const missing: string[] = [];
  if (!intake.child_name) missing.push("child name");
  if (!intake.dob_or_age) missing.push("date of birth or age");
  if (!intake.parent_contact) missing.push("parent/guardian contact");
  if (!intake.discipline) missing.push("discipline requested");
  if (!intake.diagnosis_or_concern) missing.push("diagnosis or concern");
  if (!intake.payer) missing.push("insurance payer");
  if (!intake.member_id) missing.push("insurance member ID");
  return missing;
}
