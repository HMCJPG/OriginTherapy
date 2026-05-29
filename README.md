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

Expected runtime is under a second for the visible 8-item batch on the
deterministic path. With the optional LLM summary enabled (see below),
add ~1-2s for the Claude Haiku call.

### Optional: LLM-generated batch summary

After triage completes, the agent prints a "morning huddle" summary to
**stderr**. By default this is a deterministic counts block. If you
set `ANTHROPIC_API_KEY` (copy `.env.example` to `.env` and fill it in),
the same stats are passed to Claude Haiku 4.5 which produces a 100-150
word natural-language briefing instead.

The summary is strictly stderr-only - it never touches `output.json`
or the audit trace, so the validator behaves identically with or
without the key. If the API call fails for any reason (auth, network,
malformed response), it logs the error and falls back to the
deterministic summary - the triage run itself never fails because of
a summary issue.

## 2. Stack and runtime

- **Language**: TypeScript (`type: module`, Node LTS, tsx loader).
- **Dependencies**:
  - Starter: `ajv` / `ajv-formats` for the validator, `tsx` to run TS
    without a build step, `ulid` for trace IDs.
  - Added: `@anthropic-ai/sdk` for the optional LLM summary path
    (dynamically imported so it's a no-op when the env var is absent).
- **LLM usage**: the **core triage logic is fully deterministic**
  (regex extraction + decision-tree classification + template drafts)
  so the output is auditable and reproducible against the hidden
  synthetic variants reviewers may run. The LLM is used in exactly
  one place: a stderr-only batch summary that never affects the
  validated output.
- **Tools**: the eight starter mocks in `src/tools.ts` are used
  unmodified. Every tool call goes through `withItemContext` and the
  reported `tools_called` array is read straight from
  `getToolCallsForItem` so the trace and the output stay aligned.

Assumptions:
- "Today" for due-date computation is wall-clock time when the agent
  runs (not the latest `received_at`), so tasks render with sensible
  forward-looking dates regardless of when reviewers execute it.
- Recipients prefer email when available, then phone, then a
  free-text fallback.
- Every output item is flagged `requires_human_review: true`. The
  validator requires this and it matches Origin's product framing -
  the agent drafts, surfaces, and holds; humans decide.

## 3. Architecture

The agent is split into focused modules under `src/agent/` so each
file has a single responsibility and is easy to extend in isolation.
`src/agent.ts` is a thin orchestrator (~200 lines).

```
src/
├── agent.ts                          # runAgent, triageItem orchestration
├── agent/
│   ├── constants.ts                  # named enums + keyword lists
│   ├── utils.ts                      # date + string helpers
│   ├── safe-call.ts                  # safe tool-call wrapper
│   ├── extraction.ts                 # intake field extractors
│   ├── signals.ts                    # signal detectors
│   ├── classification.ts             # classifyItem decision tree
│   ├── drafts.ts                     # message templates + pickers
│   ├── summary.ts                    # stderr batch summary (det + LLM)
│   └── handlers/
│       ├── index.ts                  # dispatchHandler
│       ├── shared.ts                 # HandlerCtx, HandlerOutcome, helpers
│       ├── safeguarding.ts           # P0 flow
│       ├── scheduling.ts             # P1 flow
│       ├── clinical-question.ts      # P2 - deflect to screening
│       ├── missing-paperwork.ts      # P2 - callback the referring office
│       ├── new-referral.ts           # P2 - main intake flow + sub-flows
│       └── other.ts                  # P2 fallback
```

Decision-tree summary (priority of checks, see
[src/agent/classification.ts](src/agent/classification.ts)):

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

### Adding a new classification

The module layout makes this a 5-step touch:

1. Add the constant in [`agent/constants.ts`](src/agent/constants.ts) under `CLASSIFICATION`.
2. Add a detector function in [`agent/signals.ts`](src/agent/signals.ts).
3. Add the check to `classifyItem` in [`agent/classification.ts`](src/agent/classification.ts) in the right priority slot.
4. Add a handler file in [`agent/handlers/`](src/agent/handlers/) following the existing handler shape.
5. Add the case to `dispatchHandler` in [`agent/handlers/index.ts`](src/agent/handlers/index.ts).

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
- **LLM summary regressions** - if the optional LLM summary
  hallucinates an action or invents an item_id, that's misleading to
  staff. The system prompt constrains it to the JSON we feed it, but
  in production this output should be evaluated against the
  deterministic summary on a sample.

A reasonable production eval would be: a held-out hand-labelled set
with safeguarding precision/recall, classification accuracy, per-field
intake F1, "would staff have accepted the draft as-is" rating, and
LLM-summary faithfulness against the underlying JSON. Run nightly;
alert on safeguarding recall regressions.

## 5. What I chose not to build, and why

- **No LLM in the core triage path**. The deterministic decision
  tree + template drafts make outputs reproducible against hidden
  synthetic variants and easy to audit. The LLM is reserved for the
  one place where it's safe and obviously additive (the stderr batch
  summary) and is always gated behind `ANTHROPIC_API_KEY`. An LLM in
  the safeguarding classifier or draft generator would help recall
  and naturalness but is too risky without an eval set - clinical
  advice slipping into drafts is a clear policy violation.
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
- **No unit tests.** Within the time budget I prioritised end-to-end
  validator pass plus careful per-item walk-throughs. The module
  split makes adding fixture-based tests later straightforward.
- **No anonymisation or PHI scrubbing.** All data is synthetic per the
  brief; production would route through a PHI-safe channel before any
  external LLM call.

## 6. What I would do with another 4 hours

1. **LLM-assisted safeguarding classifier with a strict precision
   floor.** Layer a small Claude classifier on top of the keyword
   detector, accept only high-confidence safeguarding flags, keep the
   keyword detector as a recall safety net. Evaluate on a
   hand-labelled set.
2. **LLM-naturalised drafts** with the policy/intake template as a
   constrained prompt + a policy-check pass. The current templates
   are operationally correct but stiff; LLM rewriting with a
   policy-checking pass would land closer to what staff would
   actually send.
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
6. **Per-handler unit tests** with a mocked `tools.ts` - the module
   split already shapes the code for this.
7. **Provider-preference ranking** - currently `find_slots` returns
   the mock's first match. For each in-network referral, rank slots
   against extracted `preferences` (time-of-day, day-of-week) before
   surfacing.
8. **Faithfulness check on the LLM summary** - after generating, do a
   second pass that asserts every item_id mentioned actually exists
   in the input and every action attributed matches the JSON. Reject
   and fall back if it fails.
