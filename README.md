# Origin AI Engineering Take-Home: Referral Inbox Triage Agent

Origin builds software for pediatric therapy practices. This repo implements a
prototype agent for a fictional practice, Cedar Kids Therapy, that triages a
shared inbox of fax referrals, parent voicemails, parent-portal messages, and
emails into a sorted, human-reviewable action plan.

## 1. How to run

```bash
npm install
npm run triage   -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
npm run validate -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
```

Both commands also work without flags (defaults match the lines above).
`npm run typecheck` runs `tsc --noEmit`.

Expected runtime is well under a second for the visible 8-item batch
(no LLM calls).

## 2. Stack and runtime

- **Language**: TypeScript (`type: module`, Node LTS, tsx loader).
- **Dependencies**: only the starter set - `ajv` / `ajv-formats` for the
  validator, `tsx` to run TS without a build step, `ulid` for trace IDs.
- **No LLM at runtime**. Classification and intake extraction are
  deterministic regex / decision-tree code so the output is auditable
  and reproducible against the hidden synthetic variants reviewers may
  run. (Claude Code was used at *build* time to scaffold and refine the
  agent.)
- **Tools**: the eight starter mocks in `src/tools.ts` are used
  unmodified. Every tool call goes through `withItemContext` and the
  reported `tools_called` array is read straight from
  `getToolCallsForItem` so the trace and the output stay aligned.

Assumptions:
- "Today" for due-date computation is wall-clock time when the agent
  runs (not the latest `received_at`), so tasks render with sensible
  forward-looking dates regardless of when reviewers execute it.
- Recipients prefer email when available, then phone, then a
  free-text fallback - the mock `draft_message` accepts any string.
- Every output item is flagged `requires_human_review: true`. The
  validator requires this and it matches Origin's product framing -
  the agent drafts, surfaces, and holds; humans decide.

## 3. Architecture

`src/agent.ts` is the only file changed beyond starter scaffolding.
It is organised top-down into clearly labelled sections:

1. **Constants** - named values for urgency, classification, assignee,
   policy topic, channels, due-date offsets, keyword lists, payer
   phrases, and blank markers. Nothing inline below this point uses
   magic strings.
2. **Date and string helpers** - `batchAnchor`, `dueDateString`,
   blank-marker check, regex escape, trailing-dot stripper.
3. **Intake extraction** - one extractor per `ExtractedIntake` field.
   Each is best-effort regex with documented fallback order; missing
   values become `null` and surface in `missing_info`.
4. **Signal detection** - pure functions that report safeguarding,
   clinical-question, scheduling/reschedule, Spanish-language
   preference, incomplete-referral, and generic new-intake signals.
5. **Classification (`classifyItem`)** - explicit decision tree that
   maps an item + intake onto an initial `(classification, urgency,
   rationaleSeed)`. Safeguarding is checked first so a safety signal
   buried in a routine eval request still escalates.
6. **Safe tool wrapper (`safeCall`)** - every tool call goes through
   this so a single tool failure doesn't crash the batch; the failure
   note is folded into `decision_rationale`.
7. **Draft message templates** - English and Spanish acknowledgements
   for in-network, out-of-network/expired, unknown-insurance,
   safeguarding, clinical-question deflection, and reschedule cases.
   They never give clinical advice and never imply the message was
   sent.
8. **Per-classification handlers** - `handleSafeguarding`,
   `handleClinicalQuestion`, `handleMissingPaperwork`,
   `handleScheduling`, `handleNewReferral` (with sub-flows
   `handleBenefitsConversation`, `handleInNetworkReferral`,
   `handleIdentityVerification`, `handleUnknownInsurance`), and
   `handleOther`. All return the same `HandlerOutcome` shape.
9. **`triageItem` / `runAgent`** - dispatcher, output assembler, and
   public entry point. Sequential processing keeps the trace
   deterministic.

Decision-tree summary (priority of checks):
- safeguarding language present -> **P0 safeguarding** (policy lookup,
  escalate, clinical-lead task, neutral acknowledgement).
- reschedule / illness / no-show language -> **P1 scheduling**
  (search_patient, scheduling-policy lookup, front-desk task, draft).
- portal/email clinical question without referral language ->
  **P2 clinical_question** (clinical-advice policy, intake task,
  deflecting draft).
- fax referral with 2+ blank required fields ->
  **P2 missing_paperwork** (front-desk task only; no draft because
  there is no parent contact).
- fax referral OR family-initiated intake request with a child name ->
  **P2 new_referral** routed through the insurance branch:
  - in_network -> find_slots, optional hold_slot (only when language
    constraint narrows to a clean single provider), intake task, draft.
    Spanish-preferred families also get `lookup_policy(language_access)`
    and a Spanish draft.
  - out_of_network / expired -> `lookup_policy(insurance)`, billing
    task, draft - no slot calls until benefits conversation closes.
  - unknown / no payer -> intake task to verify benefits, draft.
  - search_patient hit -> classification upgrades to
    `existing_patient_request`. If the stored guardian name disagrees
    with the inbound contact we route through
    `handleIdentityVerification` instead of scheduling.

Tool orchestration across the visible batch uses **all eight** of the
provided tools: `search_patient`, `verify_insurance`, `lookup_policy`,
`find_slots`, `hold_slot`, `create_task`, `draft_message`, `escalate`.

## 4. Failure modes and production eval

Known failure modes that staff or evals should watch for:

- **Safeguarding miss** - keyword detection over a fixed list. New
  euphemisms, sarcasm, or paraphrased reports will slip past. In
  production this should be the primary thing evaluated: precision is
  acceptable, recall is the metric that matters. A small LLM classifier
  for safeguarding (with conservative thresholding plus human review on
  every borderline) would tighten this without changing the rest of
  the pipeline.
- **Extraction silently degraded** - intake extractors are regex chains.
  When they fail they emit `null` and that field shows up in
  `missing_info`, but a wrong extraction (e.g. wrong child captured)
  is harder to spot. Evals should hand-label intake fields on a
  sample and measure field-level precision/recall.
- **Classification drift** - the decision tree depends on keyword
  lists that will rot. Track the percentage of items hitting
  `classification: "other"` and the rate of staff manually re-routing
  items as drift indicators.
- **Insurance state staleness** - `verify_insurance` is the source of
  truth, but it can return `unknown` or be unavailable. The agent
  degrades by opening an intake task, but a high `unknown` rate would
  silently increase staff load. Alert on it.
- **Identity collisions** - `handleIdentityVerification` only catches
  *named* discrepancies. Two children named "Mateo Ramirez" with the
  same DOB would still confuse the system; production would want a
  stronger match score and explicit ambiguous-match handling.
- **Spanish-language reach** - we detect Spanish via two-phrase
  threshold or the literal word "espanol/español". A bilingual email
  in mostly English with a Spanish phrase would not flip. Eval against
  staff-tagged language preferences.
- **Tool failures** - `safeCall` captures any tool exception and
  records it in `decision_rationale` (`Tool warnings: ...`). The item
  still produces output and is still routed for human review. Per-item
  tool-failure rate is a production health signal.

A reasonable production eval would be: a held-out hand-labelled set
with safeguarding precision/recall, classification accuracy, per-field
intake F1, and a "would staff have accepted the draft as-is" rating.
Run nightly; alert on safeguarding recall regressions.

## 5. What I chose not to build, and why

- **No runtime LLM**. The brief allows but doesn't require it.
  Deterministic code makes the output reproducible, easy to audit, and
  testable against hidden synthetic variants without depending on a
  reviewer-provided API key. An LLM would help most on safeguarding
  recall and on naturalising draft replies - both worth doing later,
  neither blocking for the prototype.
- **No `hold_slot` for the clean English in-network cases.** Holding
  a slot before staff confirms the family's preference is performative
  and would clutter staff queues. I reserve `hold_slot` for the case
  where the constraint set narrows to a clear single match - in this
  batch that is item_7 (Spanish-language Medicaid referral, single
  matching SLP provider).
- **No `find_slots` for the same-day reschedule (item_8).** The mock
  only exposes evaluation slots, not makeup slots, so surfacing them
  for a reschedule would mislead staff. The handler skips `find_slots`
  and tasks the front desk to coordinate manually - documented in the
  rationale.
- **No retry/backoff on tool failures.** The starter tools are
  in-process mocks. `safeCall` records the failure and degrades the
  flow; retry semantics belong with the real tool implementations.
- **No multi-discipline split.** Items only request one discipline in
  the visible set; if more than one is detected, the task notes
  surface it for staff to handle.
- **No unit tests.** Within the 2-hour budget I prioritised end-to-end
  validator pass plus careful per-item walk-throughs. The handlers are
  small enough that adding fixture-based tests later is straightforward.
- **No anonymisation or PHI scrubbing.** All data is synthetic per the
  brief; production would route through a PHI-safe channel before any
  external LLM call.

## 6. What I would do with another 4 hours

1. **LLM-assisted safeguarding classifier with a strict precision
   floor.** Layer a small Claude/GPT-class classifier on top of the
   keyword detector, accept only high-confidence safeguarding flags,
   keep the keyword detector as a recall safety net. Evaluate on a
   hand-labelled set.
2. **LLM-naturalised drafts** with the policy/intake template as a
   constrained prompt. The current templates are operationally correct
   but stiff; LLM rewriting with a policy-checking pass would land
   closer to what staff would actually send.
3. **Field-level eval harness** - hand-label intake fields on a 30-50
   item sample and add a `npm run eval` that reports field-level
   precision/recall plus classification accuracy.
4. **Insurance-discrepancy surfacing** - when the referral document
   lists a payer that disagrees with `verify_insurance`, surface the
   discrepancy explicitly in the rationale and task notes (policy
   already says billing-system-of-record wins).
5. **Patient deduplication** - when `search_patient` returns no match
   but name + DOB look plausible, run a fuzzier search and flag
   "possible match: <name>" so intake doesn't create duplicate records.
6. **Trace observability** - emit a per-batch summary (counts by
   classification/urgency, tool failure rate, top missing-info fields)
   to stdout at the end of `npm run triage` so smoke-testing is fast.
7. **Provider-preference ranking** - currently `find_slots` returns
   the mock's first match. For each in-network referral, rank slots
   against extracted `preferences` (time-of-day, day-of-week) before
   surfacing.
8. **Tests** - fixture-based snapshot tests on each handler with a
   tiny mocked `tools.ts`, plus a property test that
   `requires_human_review` is always true.
