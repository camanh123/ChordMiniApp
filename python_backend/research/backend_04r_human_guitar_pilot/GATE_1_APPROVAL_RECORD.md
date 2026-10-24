# GATE-1 design approval record

Decision ID: CHORDMINI-GATE-1-DESIGN-APPROVAL

Decision date: 2026-10-24

Decision authority: Project owner, approval provided in ChatGPT conversation.

Approved specification: BACKEND-04R.2

Approved specification commit: `9b9bae00dfb978203a631c702d02a66bd47d02e7`

Approval status: APPROVED_DESIGN_ONLY

This record is the approval evidence. It is not a handwritten signature, not an external certificate, and not participant consent. No performer is named. No consent has been signed.

## What was approved

The project owner approved the BACKEND-04R.2 design, and only that design. The approved bytes are the protocol files at the commit above. This phase does not edit those files. Their text still says GATE-1 was waiting for final approval, because that was the wording being approved. This record is what changes the gate state.

GATE-1 = APPROVED_DESIGN_ONLY.

The approved scope is:

- Exactly 24 planned guitar recordings.
- Placeholder performers PLAYER_A and PLAYER_B. Real people are not identified.
- Two sessions per performer.
- Six conditions per session.
- Maximum 60 seconds per recording.
- The tempo-map equations and displayed durations already in the protocol.
- One quiet/percussive take, with the texture boundary at beat index 32.
- Optimal one-to-one beat matching.
- Pairwise tolerance at most 35 ms, inclusive.
- Agreement at least 95 percent, inclusive.
- Midpoint consensus for accepted matched pairs.
- Human adjudication of unmatched or ambiguous taps. No automatic interpolation.
- Half-open trim `[start_sample, end_sample)`.
- Latency compensation applied once. Positive latency means the guitar channel is later.
- Residual latency at most 5 ms, inclusive.
- Half-away-from-zero sample rounding.

PLAYER_A remains the 12 development recordings. PLAYER_B remains the 12 sealed evaluation recordings. Sixteen bars of 4/4 remain 64 beats. The tempo assignments remain 100, 80, 96, and 90 BPM for the four constant conditions, 80 BPM then 100 BPM from beat 32 for the step, and 100 BPM for the quiet/percussive take.

Sample rate and DAW rendering were not approved. They stay NEEDS_HUMAN_APPROVAL.

## What was not approved

This decision does not authorize pilot execution. All of the following stay false:

- PILOT_EXECUTION_AUTHORIZED
- RECORDING_AUTHORIZED
- CONSENT_SIGNED
- RIGHTS_CLEARED
- PERFORMERS_RECRUITED
- DATASET_COLLECTED
- MODEL_COMPARISON_AUTHORIZED

No recruitment, signature, recording, audio download, dataset acquisition, inference, checkpoint download, training, production change, or deployment is authorized.

GATE-2 through GATE-8 remain PENDING:

| Gate | Still required before any recording | Status |
| --- | --- | --- |
| GATE-2 | Two real performers identified and assigned | PENDING |
| GATE-3 | Each performer signs the consent template | PENDING |
| GATE-4 | Composition rights recorded for every take | PENDING |
| GATE-5 | Equipment and separate-channel routing verified | PENDING |
| GATE-6 | Two annotators and one dispute reviewer named | PENDING |
| GATE-7 | PLAYER_B assigned to sealed evaluation before model scoring | PENDING |
| GATE-8 | Storage and privacy arrangements approved | PENDING |

The manifest template stays `NOT_COLLECTED` for measured evidence and `NEEDS_HUMAN_APPROVAL` for consent, rights, instrument, room, and sample rate.

## Frozen rules

The technical contract at the approved commit is frozen. Protected files, their hashes, and the hash of the verification script are listed in `GATE_1_FREEZE_MANIFEST.json`. That manifest does not hash itself.

A later phase may cite this specification. It may not silently edit a protected file.

## Reopening the specification

A change to frozen protocol content requires all of the following:

1. A specifically identified reason.
2. A scoped change proposal.
3. A diff against the frozen baseline commit above.
4. The relevant verification tests.
5. Explicit project-owner reapproval.

Until those five exist, the approved bytes stand. An agent is not authorized to treat a later task as that reapproval unless the project owner says so.
