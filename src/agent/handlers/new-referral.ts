/**
 * New-referral / existing-patient flow.
 *
 * This is the most-branched handler because referrals exercise the
 * full intake workflow. The branching is:
 *
 *   1. search_patient (every referral - cheap, catches duplicates
 *      and surfaces guardian mismatches).
 *   2. verify_insurance (when we have a payer).
 *   3. Branch on insurance status:
 *        in_network         -> handleInNetworkReferral
 *        out_of_network     -> handleBenefitsConversation
 *        expired            -> handleBenefitsConversation
 *        unknown / no payer -> handleUnknownInsurance
 *   4. Spanish-preferred families:
 *        - lookup_policy(language_access)
 *        - find_slots filtered by language
 *        - drafts switched to es templates
 *   5. Existing-patient match with a guardian-name discrepancy
 *      reroutes to handleIdentityVerification regardless of
 *      insurance status (identity confirmation gates everything).
 *
 * Sub-flows live in this file because they share a lot of context
 * and splitting them across more files would mean passing a wide
 * ctx object to each one.
 */

import {
  create_task,
  draft_message,
  find_slots,
  hold_slot,
  lookup_policy,
  verify_insurance,
} from "../../tools.js";
import {
  ASSIGNEE,
  CLASSIFICATION,
  DUE_OFFSET_DAYS,
  INSURANCE,
  LANGUAGE,
  POLICY_TOPIC,
  URGENCY,
} from "../constants.js";
import {
  draftBenefitsConversationDraft,
  draftIdentityVerificationDraft,
  draftInNetworkAcknowledgement,
  draftUnknownInsuranceAcknowledgement,
  pickDraftChannel,
  pickRecipient,
} from "../drafts.js";
import { extractPreferences } from "../extraction.js";
import { safeCall } from "../safe-call.js";
import { detectSpanishPreferred } from "../signals.js";
import { dueDateString } from "../utils.js";
import {
  buildIntakeTaskNotes,
  findPatient,
  guardianMismatchDetected,
  pickDiscipline,
  type HandlerCtx,
  type HandlerOutcome,
} from "./shared.js";
import type { Classification, Patient, Slot } from "../../types.js";

// ---------------------------------------------------------------------
// Main entry - decides which sub-flow runs
// ---------------------------------------------------------------------

export async function handleNewReferral(ctx: HandlerCtx): Promise<HandlerOutcome> {
  const { item, intake, initial, errors } = ctx;

  // 1. Patient lookup. A match upgrades the classification.
  const patientMatch = await findPatient(intake, errors);
  const guardianMismatch = patientMatch
    ? guardianMismatchDetected(patientMatch, intake.parent_contact)
    : false;
  const refinedClassification: Classification = patientMatch
    ? CLASSIFICATION.EXISTING_PATIENT
    : initial.classification;

  // 2. Insurance verification (when we have a payer).
  let insuranceStatus:
    | typeof INSURANCE.IN_NETWORK
    | typeof INSURANCE.OUT_OF_NETWORK
    | typeof INSURANCE.EXPIRED
    | typeof INSURANCE.UNKNOWN = INSURANCE.UNKNOWN;
  let insurancePlan: string | undefined;

  if (intake.payer) {
    const insurance = await safeCall(
      "verify_insurance",
      () =>
        verify_insurance({
          payer: intake.payer ?? undefined,
          member_id: intake.member_id ?? undefined,
        }),
      errors,
    );
    if (insurance) {
      insuranceStatus = insurance.data.status;
      insurancePlan = insurance.data.plan;
    }
  }

  const spanishPreferred = detectSpanishPreferred(item);
  const language: "en" | "es" = spanishPreferred ? LANGUAGE.ES : LANGUAGE.EN;

  // 3. Identity-verification fast path - if there's a guardian
  //    mismatch we pause on scheduling regardless of insurance.
  if (guardianMismatch && patientMatch) {
    return handleIdentityVerification(
      { ...ctx, refinedClassification, language, patientMatch },
      insurancePlan,
    );
  }

  // 4. Insurance branch.
  if (
    insuranceStatus === INSURANCE.OUT_OF_NETWORK ||
    insuranceStatus === INSURANCE.EXPIRED
  ) {
    return handleBenefitsConversation({
      ...ctx,
      refinedClassification,
      insuranceStatus,
      insurancePlan,
      language,
      patientMatch,
    });
  }

  if (insuranceStatus === INSURANCE.IN_NETWORK) {
    return handleInNetworkReferral({
      ...ctx,
      refinedClassification,
      insurancePlan,
      language,
      spanishPreferred,
      patientMatch,
    });
  }

  return handleUnknownInsurance({
    ...ctx,
    refinedClassification,
    language,
    patientMatch,
  });
}

// ---------------------------------------------------------------------
// Sub-flow ctx types
// ---------------------------------------------------------------------

interface ReferralCtx extends HandlerCtx {
  refinedClassification: Classification;
  language: "en" | "es";
  patientMatch: Patient | null;
}

interface BenefitsCtx extends ReferralCtx {
  insuranceStatus: typeof INSURANCE.OUT_OF_NETWORK | typeof INSURANCE.EXPIRED;
  insurancePlan?: string;
}

interface InNetworkCtx extends ReferralCtx {
  insurancePlan?: string;
  spanishPreferred: boolean;
}

interface IdentityCtx extends Omit<ReferralCtx, "patientMatch"> {
  patientMatch: Patient;
}

// ---------------------------------------------------------------------
// Sub-flow: out-of-network or expired coverage
// ---------------------------------------------------------------------

/**
 * Out-of-network OR expired coverage. Policy requires a benefits
 * conversation before any slot work. Route to billing, draft a
 * message that sets that expectation.
 */
async function handleBenefitsConversation(ctx: BenefitsCtx): Promise<HandlerOutcome> {
  const {
    item,
    intake,
    initial,
    anchor,
    errors,
    refinedClassification,
    insuranceStatus,
    insurancePlan,
    language,
    patientMatch,
  } = ctx;

  await safeCall(
    "lookup_policy(insurance)",
    () => lookup_policy({ topic: POLICY_TOPIC.INSURANCE }),
    errors,
  );

  const planLabel = insurancePlan ?? intake.payer ?? "the stated payer";
  const statusLabel =
    insuranceStatus === INSURANCE.OUT_OF_NETWORK ? "out of network" : "expired";

  const taskTitle =
    insuranceStatus === INSURANCE.OUT_OF_NETWORK
      ? `Out-of-network benefits conversation for ${intake.child_name ?? "referral"}`
      : `Expired coverage discrepancy for ${intake.child_name ?? "referral"}`;

  const taskNotes =
    insuranceStatus === INSURANCE.OUT_OF_NETWORK
      ? `Verified ${planLabel} as out of network. Call the family before any slot work to walk through self-pay or alternate-payer options.`
      : `Billing system shows ${planLabel} as expired (referral document may be stale). Confirm current coverage with the family before any scheduling.`;

  const task = await safeCall(
    "create_task(billing)",
    () =>
      create_task({
        assignee: ASSIGNEE.BILLING,
        title: taskTitle,
        due: dueDateString(anchor, DUE_OFFSET_DAYS.NEXT_DAY),
        notes: taskNotes,
      }),
    errors,
  );

  // The status note inside the draft is language- and status-specific.
  const statusNote = formatStatusNote({
    insuranceStatus,
    planLabel,
    language,
  });

  const draftBody = draftBenefitsConversationDraft({ intake, language }, statusNote);
  const draftResult = await safeCall(
    "draft_message",
    () =>
      draft_message({
        recipient: pickRecipient(item, intake),
        channel: pickDraftChannel(item),
        body: draftBody,
        language,
      }),
    errors,
  );

  const guardianNote =
    patientMatch && guardianMismatchDetected(patientMatch, intake.parent_contact)
      ? ` Stored guardian "${patientMatch.guardian_name}" differs from inbound contact "${intake.parent_contact}" - flag for identity verification.`
      : "";

  return {
    classification: refinedClassification,
    urgency: URGENCY.P2,
    decision_rationale: `${initial.rationaleSeed} verify_insurance returned ${statusLabel} for ${planLabel}; policy requires a benefits conversation before any slot work.${guardianNote}`,
    recommended_next_action: `Billing reviews ${statusLabel} options with the family before staff considers any appointment hold.`,
    draft_reply: draftResult ? draftBody : null,
    task_ids: task ? [task.data.task_id] : [],
    escalation: null,
  };
}

/** One-liner that explains the OON/expired status, in the family's language. */
function formatStatusNote(args: {
  insuranceStatus: typeof INSURANCE.OUT_OF_NETWORK | typeof INSURANCE.EXPIRED;
  planLabel: string;
  language: "en" | "es";
}): string {
  if (args.insuranceStatus === INSURANCE.OUT_OF_NETWORK) {
    return args.language === LANGUAGE.ES
      ? `Verificamos que ${args.planLabel} esta fuera de la red.`
      : `Our billing team needs to review the ${args.planLabel} plan because it appears to be out of network.`;
  }
  return args.language === LANGUAGE.ES
    ? `Nuestro sistema indica que la cobertura de ${args.planLabel} esta vencida.`
    : `Our billing system shows the ${args.planLabel} coverage as expired, so we need to confirm current benefits.`;
}

// ---------------------------------------------------------------------
// Sub-flow: in-network referral
// ---------------------------------------------------------------------

/**
 * In-network referral.
 *
 *   - Spanish-preferred? lookup_policy(language_access) first.
 *   - find_slots filtered by discipline + (es when Spanish).
 *   - hold_slot ONLY when language narrows availability to a clean
 *     single match (currently: Spanish-preferred batches).
 *   - create_task(intake), draft_message.
 */
async function handleInNetworkReferral(ctx: InNetworkCtx): Promise<HandlerOutcome> {
  const {
    item,
    intake,
    initial,
    anchor,
    errors,
    refinedClassification,
    insurancePlan,
    language,
    spanishPreferred,
    patientMatch,
  } = ctx;

  if (spanishPreferred) {
    await safeCall(
      "lookup_policy(language_access)",
      () => lookup_policy({ topic: POLICY_TOPIC.LANGUAGE_ACCESS }),
      errors,
    );
  }

  const discipline = pickDiscipline(intake);
  const preferences = extractPreferences(item) ?? undefined;

  let slots: Slot[] = [];
  if (discipline) {
    const slotsResult = await safeCall(
      "find_slots",
      () =>
        find_slots({
          discipline,
          preferences,
          language: spanishPreferred ? LANGUAGE.ES : undefined,
        }),
      errors,
    );
    if (slotsResult) slots = slotsResult.data;
  }

  // hold_slot is justified when the language constraint produces a
  // narrow provider match and we want to reserve the earliest option
  // for staff review. Otherwise we leave slot selection to staff.
  let heldSlotId: string | null = null;
  if (spanishPreferred && slots.length > 0) {
    const slot = slots[0];
    const patientRef =
      patientMatch?.patient_id ?? `${intake.child_name ?? "patient"} (pending intake)`;
    const holdResult = await safeCall(
      "hold_slot",
      () => hold_slot({ slot_id: slot.slot_id, patient_ref: patientRef }),
      errors,
    );
    if (holdResult) heldSlotId = holdResult.data.hold_id;
  }

  const taskTitle = patientMatch
    ? `Confirm scheduling for existing patient ${patientMatch.name}`
    : `Open intake for ${intake.child_name ?? "new patient"}`;
  const taskNotes = buildIntakeTaskNotes({
    intake,
    insurancePlan,
    slots,
    heldSlotId,
    spanishPreferred,
    patientMatch,
    preferences,
  });

  const task = await safeCall(
    "create_task(intake)",
    () =>
      create_task({
        assignee: ASSIGNEE.INTAKE,
        title: taskTitle,
        due: dueDateString(anchor, DUE_OFFSET_DAYS.STANDARD),
        notes: taskNotes,
      }),
    errors,
  );

  const draftBody = draftInNetworkAcknowledgement({ intake, language });
  const draftResult = await safeCall(
    "draft_message",
    () =>
      draft_message({
        recipient: pickRecipient(item, intake),
        channel: pickDraftChannel(item),
        body: draftBody,
        language,
      }),
    errors,
  );

  const nextAction = heldSlotId
    ? `Intake confirms hold ${heldSlotId} with the family within one business day, then releases it back if the family declines.`
    : slots.length > 0
      ? `Intake calls ${pickRecipient(item, intake)} to confirm a slot from the surfaced options within one business day.`
      : `Intake calls ${pickRecipient(item, intake)} within one business day to schedule once provider availability opens.`;

  const slotSummary =
    slots.length > 0
      ? ` find_slots surfaced ${slots.length} option(s); earliest ${slots[0].start} with ${slots[0].provider_name}.`
      : " find_slots returned no matching options.";

  return {
    classification: refinedClassification,
    urgency: URGENCY.P2,
    decision_rationale: `${initial.rationaleSeed} verify_insurance returned in_network${insurancePlan ? ` (${insurancePlan})` : ""}.${slotSummary}${heldSlotId ? ` Earliest slot held for review as ${heldSlotId} due to narrow language-matched availability.` : ""}`,
    recommended_next_action: nextAction,
    draft_reply: draftResult ? draftBody : null,
    task_ids: task ? [task.data.task_id] : [],
    escalation: null,
  };
}

// ---------------------------------------------------------------------
// Sub-flow: identity verification
// ---------------------------------------------------------------------

/**
 * Existing patient with a guardian-name mismatch.
 *
 * Pause on scheduling until staff confirms the caller is who they
 * claim to be. We still acknowledge receipt, but the draft avoids
 * disclosing any stored patient details until identity is verified.
 */
async function handleIdentityVerification(
  ctx: IdentityCtx,
  insurancePlan: string | undefined,
): Promise<HandlerOutcome> {
  const {
    item,
    intake,
    initial,
    anchor,
    errors,
    refinedClassification,
    language,
    patientMatch,
  } = ctx;

  // PRIVACY: the caller's identity is not yet confirmed, so the
  // family-facing draft uses the name *as the caller wrote it*, not
  // the stored patient name. Otherwise we'd leak the suffix (e.g.
  // "Mateo Ramirez" -> "Mateo Ramirez Jr.") and effectively confirm
  // we have a matching patient on file to an unverified caller.
  // Staff-facing fields (task title, notes, decision_rationale) keep
  // the full stored name so staff can act on it.
  const familyFacingName =
    intake.child_name?.replace(/[.\s]+$/, "") ?? "your child";
  const storedPatientLabel = patientMatch.name.replace(/[.\s]+$/, "");

  const taskNotes = `Existing patient ${patientMatch.name} (${patientMatch.patient_id}) has stored guardian "${patientMatch.guardian_name}" but the inbound contact is "${intake.parent_contact}". Insurance verified${insurancePlan ? ` (${insurancePlan})` : ""}. Confirm caller identity before opening a new referral or sharing patient information; reach the stored guardian if needed.`;

  const task = await safeCall(
    "create_task(intake)",
    () =>
      create_task({
        assignee: ASSIGNEE.INTAKE,
        title: `Verify caller identity for ${storedPatientLabel}`,
        due: dueDateString(anchor, DUE_OFFSET_DAYS.NEXT_DAY),
        notes: taskNotes,
      }),
    errors,
  );

  const draftBody = draftIdentityVerificationDraft({ intake, language }, familyFacingName);
  const draftResult = await safeCall(
    "draft_message",
    () =>
      draft_message({
        recipient: pickRecipient(item, intake),
        channel: pickDraftChannel(item),
        body: draftBody,
        language,
      }),
    errors,
  );

  return {
    classification: refinedClassification,
    urgency: URGENCY.P2,
    decision_rationale: `${initial.rationaleSeed} Patient match found (${patientMatch.name}) but stored guardian "${patientMatch.guardian_name}" differs from inbound contact "${intake.parent_contact}". Pausing on scheduling until intake confirms identity, regardless of in-network coverage status.`,
    recommended_next_action:
      "Intake verifies caller identity against the stored guardian record before any scheduling or patient-data disclosure.",
    draft_reply: draftResult ? draftBody : null,
    task_ids: task ? [task.data.task_id] : [],
    escalation: null,
  };
}

// ---------------------------------------------------------------------
// Sub-flow: unknown / unrecognised insurance
// ---------------------------------------------------------------------

/**
 * Unknown insurance status or missing payer information. Open an
 * intake task to verify benefits before any scheduling work.
 */
async function handleUnknownInsurance(ctx: ReferralCtx): Promise<HandlerOutcome> {
  const {
    item,
    intake,
    initial,
    anchor,
    errors,
    refinedClassification,
    language,
    patientMatch,
  } = ctx;

  const task = await safeCall(
    "create_task(intake)",
    () =>
      create_task({
        assignee: ASSIGNEE.INTAKE,
        title: `Verify benefits for ${intake.child_name ?? "new referral"}`,
        due: dueDateString(anchor, DUE_OFFSET_DAYS.STANDARD),
        notes: `Insurance verification returned ${intake.payer ? "unknown" : "no payer provided"}. Confirm benefits with the family before opening a scheduling workflow. ${patientMatch ? `Existing patient match: ${patientMatch.name} (${patientMatch.patient_id}).` : ""}`.trim(),
      }),
    errors,
  );

  const draftBody = draftUnknownInsuranceAcknowledgement({ intake, language });
  const draftResult = await safeCall(
    "draft_message",
    () =>
      draft_message({
        recipient: pickRecipient(item, intake),
        channel: pickDraftChannel(item),
        body: draftBody,
        language,
      }),
    errors,
  );

  return {
    classification: refinedClassification,
    urgency: URGENCY.P2,
    decision_rationale: `${initial.rationaleSeed} Insurance status could not be verified (${intake.payer ? "payer unrecognised" : "no payer extracted"}); intake will verify benefits before any slot work.`,
    recommended_next_action:
      "Intake calls the family to verify benefits, then routes to scheduling once coverage is confirmed.",
    draft_reply: draftResult ? draftBody : null,
    task_ids: task ? [task.data.task_id] : [],
    escalation: null,
  };
}
