/**
 * P1 same-day scheduling flow.
 *
 * Sequence:
 *   1. lookup_policy(scheduling) - cite the policy.
 *   2. search_patient            - confirm the patient if we can.
 *   3. create_task(front_desk)   - release today's slot + find a makeup.
 *   4. draft_message             - English acknowledgement.
 *
 * find_slots is intentionally skipped here: the mock only exposes
 * evaluation slots, and an existing-patient reschedule does not
 * need an evaluation. Surfacing eval slots would mislead staff.
 */

import {
  create_task,
  draft_message,
  lookup_policy,
} from "../../tools.js";
import {
  ASSIGNEE,
  CLASSIFICATION,
  DUE_OFFSET_DAYS,
  LANGUAGE,
  POLICY_TOPIC,
  URGENCY,
} from "../constants.js";
import { draftRescheduleAcknowledgement, pickDraftChannel, pickRecipient } from "../drafts.js";
import { safeCall } from "../safe-call.js";
import { dueDateString } from "../utils.js";
import { findPatient, type HandlerCtx, type HandlerOutcome } from "./shared.js";

export async function handleScheduling(ctx: HandlerCtx): Promise<HandlerOutcome> {
  const { item, intake, initial, anchor, errors } = ctx;

  await safeCall(
    "lookup_policy(scheduling)",
    () => lookup_policy({ topic: POLICY_TOPIC.SCHEDULING }),
    errors,
  );

  const patientMatch = await findPatient(intake, errors);

  const patientLabel = patientMatch
    ? `${patientMatch.name} (${patientMatch.patient_id})`
    : intake.child_name ?? "the patient";

  const task = await safeCall(
    "create_task(front_desk)",
    () =>
      create_task({
        assignee: ASSIGNEE.FRONT_DESK,
        title: `Release today's slot and arrange makeup for ${patientLabel}`,
        due: dueDateString(anchor, DUE_OFFSET_DAYS.SAME_DAY),
        notes: `Family reported a same-day cancellation/illness. Release today's appointment, call ${pickRecipient(item, intake)}, and offer a makeup slot per provider capacity. Discipline on file: ${intake.discipline?.join(", ") ?? "unspecified"}.`,
      }),
    errors,
  );

  const draftBody = draftRescheduleAcknowledgement({ intake, language: LANGUAGE.EN });
  const draftResult = await safeCall(
    "draft_message",
    () =>
      draft_message({
        recipient: pickRecipient(item, intake),
        channel: pickDraftChannel(item),
        body: draftBody,
        language: LANGUAGE.EN,
      }),
    errors,
  );

  const rationale = patientMatch
    ? `${initial.rationaleSeed} Patient match confirmed (${patientMatch.name}). find_slots intentionally skipped because the mock only returns evaluation slots, which do not apply to an existing-patient reschedule.`
    : `${initial.rationaleSeed} No patient match in the system; staff should confirm identity at callback before releasing or rebooking a slot.`;

  return {
    classification: CLASSIFICATION.SCHEDULING,
    urgency: URGENCY.P1,
    decision_rationale: rationale,
    recommended_next_action: `Front desk releases today's slot for ${patientLabel} and calls the family to offer a makeup time.`,
    draft_reply: draftResult ? draftBody : null,
    task_ids: task ? [task.data.task_id] : [],
    escalation: null,
  };
}
