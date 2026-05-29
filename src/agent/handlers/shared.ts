/**
 * Shared types + helpers used by every handler.
 *
 * Every handler in ./handlers/* takes the same `HandlerCtx` and
 * returns the same `HandlerOutcome`, so the dispatcher in
 * ./handlers/index.ts can route uniformly and the orchestrator in
 * src/agent.ts can assemble the final ItemOutput uniformly.
 */

import { search_patient } from "../../tools.js";
import { safeCall } from "../safe-call.js";
import type {
  Classification,
  ExtractedIntake,
  InboxItem,
  Patient,
  Slot,
  Urgency,
} from "../../types.js";
import type { InitialDecision } from "../classification.js";

// ---------------------------------------------------------------------
// Common shapes
// ---------------------------------------------------------------------

/**
 * Inputs every handler receives. The handler is responsible for any
 * tool calls (always via `safeCall`) and for producing a
 * `HandlerOutcome`.
 */
export interface HandlerCtx {
  item: InboxItem;
  intake: ExtractedIntake;
  initial: InitialDecision;
  anchor: Date;
  errors: string[];
}

/**
 * What every handler returns. The orchestrator merges this with the
 * extracted intake and the per-item tool trace into the final
 * `ItemOutput`.
 *
 * Handlers may upgrade `classification` (e.g. new_referral ->
 * existing_patient_request after search_patient finds a match) but
 * should never change urgency without a clear, named reason.
 */
export interface HandlerOutcome {
  classification: Classification;
  urgency: Urgency;
  decision_rationale: string;
  recommended_next_action: string;
  draft_reply: string | null;
  task_ids: string[];
  escalation: { reason: string; severity: "P0" | "P1" } | null;
}

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

/**
 * Calls search_patient with whatever identifier we extracted. Returns
 * the first matching Patient, or null if no match. Used by both the
 * scheduling and new-referral flows.
 */
export async function findPatient(
  intake: ExtractedIntake,
  errors: string[],
): Promise<Patient | null> {
  if (!intake.child_name) return null;

  const isIsoDob =
    intake.dob_or_age !== null && /^\d{4}-\d{2}-\d{2}$/.test(intake.dob_or_age);

  const result = await safeCall(
    "search_patient",
    () =>
      search_patient({
        name: intake.child_name ?? undefined,
        dob: isIsoDob ? intake.dob_or_age ?? undefined : undefined,
      }),
    errors,
  );

  return result?.data[0] ?? null;
}

/**
 * Returns true if the contact name on the inbound message disagrees
 * with the stored guardian. Compares on the first name to tolerate
 * differences like "Smith" vs "Smith Jr.".
 */
export function guardianMismatchDetected(
  patient: Patient,
  parentContact: string | null,
): boolean {
  if (!parentContact) return false;
  const storedFirst = patient.guardian_name.split(" ")[0].toLowerCase();
  return !parentContact.toLowerCase().includes(storedFirst);
}

/**
 * Picks the first discipline from the extracted list. Most referrals
 * are single-discipline; if multiple are tagged we take the first and
 * note it in the task so staff can split intake.
 */
export function pickDiscipline(intake: ExtractedIntake): "SLP" | "OT" | "PT" | undefined {
  return intake.discipline?.[0];
}

/**
 * Builds the intake task notes block for in-network referrals.
 *
 * Centralised so the slot/language/patient-match story shows up in
 * the same shape every time. Each conditional adds one sentence;
 * irrelevant sections drop out.
 */
export function buildIntakeTaskNotes(args: {
  intake: ExtractedIntake;
  insurancePlan: string | undefined;
  slots: Slot[];
  heldSlotId: string | null;
  spanishPreferred: boolean;
  patientMatch: Patient | null;
  preferences: string | undefined;
}): string {
  const parts: string[] = [];
  parts.push(
    `Discipline: ${args.intake.discipline?.join(", ") ?? "unspecified"}. Concern: ${args.intake.diagnosis_or_concern ?? "not stated"}.`,
  );
  if (args.insurancePlan) {
    parts.push(`Insurance verified in-network (${args.insurancePlan}).`);
  }
  if (args.preferences) {
    parts.push(`Family preference: ${args.preferences}.`);
  }
  if (args.spanishPreferred) {
    parts.push("Family prefers Spanish; pair with Spanish-capable provider/staff.");
  }
  if (args.patientMatch) {
    parts.push(
      `Existing patient match: ${args.patientMatch.name} (${args.patientMatch.patient_id}), stored guardian ${args.patientMatch.guardian_name}.`,
    );
  }
  if (args.slots.length > 0) {
    parts.push(
      `Surfaced ${args.slots.length} eval slot option(s); earliest ${args.slots[0].start} with ${args.slots[0].provider_name}.`,
    );
  } else {
    parts.push("find_slots returned no matching options - staff to coordinate availability.");
  }
  if (args.heldSlotId) {
    parts.push(`Held earliest slot for review as ${args.heldSlotId} (pending_review).`);
  }
  return parts.join(" ");
}
