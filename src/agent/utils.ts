/**
 * Tiny shared helpers - dates, strings, regex escaping.
 *
 * Nothing in this file depends on the agent's domain types, so it can
 * be imported from anywhere without creating cycles.
 */

import { BLANK_MARKER_RE } from "./constants.js";
import type { InboxItem } from "../types.js";

// ---------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------

/**
 * Picks a single "today" anchor for the whole batch.
 *
 * Uses real wall-clock time so task due dates render relative to
 * when staff see them, not relative to when the synthetic data was
 * generated. If we ever want reproducible-against-fixtures runs we
 * can swap this for `new Date(latestReceivedAt)`.
 */
export function batchAnchor(): Date {
  return new Date();
}

/**
 * Returns a YYYY-MM-DD string `daysOut` days after `anchor`.
 *
 * The schema accepts any string in task `due`, but staff read
 * date-only values more easily than full timestamps. Time of day
 * is irrelevant for daily task queues.
 */
export function dueDateString(anchor: Date, daysOut: number): string {
  const d = new Date(anchor);
  d.setDate(d.getDate() + daysOut);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------

/**
 * Trims trailing punctuation/whitespace from a field value captured
 * by regex. Lets extraction patterns stay simple.
 */
export function trimField(value: string): string {
  return value.replace(/[.,;:\s]+$/, "").trim();
}

/** True if a captured field value is a "blank" placeholder. */
export function isBlankMarker(value: string): boolean {
  return BLANK_MARKER_RE.test(value.trim());
}

/** Escapes a string so it can be safely embedded in a RegExp source. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Trims trailing dots/periods from an email captured by regex.
 *
 * Our email pattern `[\w.-]+` greedily eats trailing sentence
 * periods - this strips them back off so recipients render cleanly.
 */
export function stripTrailingDots(value: string | null): string | null {
  if (value == null) return null;
  return value.replace(/\.+$/, "");
}

/**
 * Lowercased combined subject + body used for all keyword-based
 * signal detectors. Pre-combining keeps detectors one-liners.
 */
export function searchableText(item: InboxItem): string {
  return `${item.subject}\n${item.body}`.toLowerCase();
}

/** First name from a stored full name, with a polite fallback. */
export function firstName(fullName: string | null): string {
  if (!fullName) return "the family";
  return fullName.split(/[\s,]+/)[0] ?? fullName;
}
