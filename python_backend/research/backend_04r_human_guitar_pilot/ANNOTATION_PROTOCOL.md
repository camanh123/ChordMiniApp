# Annotation protocol

Status: PROPOSAL. GATE-1 is PENDING_FINAL_HUMAN_APPROVAL.

Annotators are not named yet. GATE-6 is PENDING and must name two
independent annotators and one dispute reviewer before any tapping starts.
This protocol does not invent their names and does not invent taps.

No model output is ground truth. Madmom, Beat This, a DAW beat detector, and
any other tracker are not used to create, edit, fill, or choose taps. The
click is not played to the annotator. The tempo map, a MIDI guide, and model
predictions are not shown while they tap. A reviewer is not preferred
because their taps sit closer to a model.

## Three different objects

These are not the same thing, and agreement between two of them is not
assumed.

| Object | What it is | Role |
| --- | --- | --- |
| A. DAW click grid | The tempo-map times, rendered as the headphone click | Intended grid. Diagnostic only after tapping. |
| B. Guitar performance | What the player actually played, including late strums and percussive attacks | Not a beat list. A loud transient is not a beat. |
| C. Tapped reference | Two people tapping the guitar-only file, then the agreement rule below | The evaluation reference, if a later phase is approved and the take is TAKE_ACCEPTED. |

A is not automatically B. B is not automatically C. The click can be early
or late relative to the hands. The hands can accent an offbeat while the
tactus stays on the numbered beat. Scoring, if it ever happens, uses C
after the checks below. It does not use A as a silent substitute, and it
does not use model output.

## Audio the annotator hears

The file is the trimmed guitar channel only, at the session sample rate,
on the canonical timeline in `SYNC_AND_LATENCY_QA.md`. The click channel is
absent. A mix of guitar and click is a protocol failure, and the annotation
pass is discarded.

Annotators work independently. They do not watch each other tap and they do
not see the other stream until both are stored.

A performer may not be the only annotator of their own take. Whether a
performer may be one of the two annotators on the other player's takes is
NEEDS_HUMAN_APPROVAL under GATE-6. The default in this proposal is that
annotators are not the performer of the take they label.

## What a beat is

A beat is the tactus: the pulse a listener would tap as "the beat," which
for this pilot is the pre-registered numbered beat unless the reviewer
later finds that the performance does not carry that pulse. A note onset,
a strum, a pick attack, and a subdivision are not beats merely because they
are audible. Louder playing is not a phase change.

The offbeat accent in `offbeat_heavy` is not the tactus. The numbered click
beat is the intended tactus, and the annotators have to hear that pulse in
the guitar without hearing the click.

In `quiet_and_percussive`, bars 1–8 are quiet and bars 9–16 are percussive.
The tactus does not reset at bar 9. Annotators tap through the boundary.
In a note stored after both streams exist, each annotator may say whether
the pulse felt ambiguous at the texture change. That note does not move
their taps. If they cannot keep one tactus across the boundary, the take
follows the outcomes below.

A downbeat is the first beat of a bar in the pre-registered 4/4 meter. The
authoritative bar index is the tempo map, not a guess from accent strength.
Annotators mark a downbeat only when they hear a bar start. Downbeat scores
are reported later only if the downbeat rule passes. A take may keep its
beats and drop its downbeats.

Leading or trailing partial beats are ordinary taps. A pickup before beat 0,
or an extra tap after the last beat, is not deleted automatically. If the
other annotator has no tap within 35 ms, it counts as unmatched.

## Two annotations

Each annotator stores tap times on the trimmed guitar timeline, in seconds,
as `sample_index / sample_rate`. The sample index is an integer. Times are
not rounded to milliseconds before the agreement test. The comparison uses
exact decimal seconds, with the threshold `0.035`, because `0.035` is not
an exact binary floating-point value.

Proposed tap file, not yet created for any take:

- recording ID
- annotator ID
- beat times in seconds
- optional downbeat flags on those beats
- optional transition note for `quiet_and_percussive`

Duplicate taps are kept as separate timestamps. They are not merged. A
second tap on the same attack usually lowers agreement, because it raises
the larger count without a partner.

## Matcher

This rule replaces the earlier greedy matcher. Greedy pairing can keep fewer
pairs than an optimal pairing. One pathological case, checked by
`validate_protocol.py`, is A = 0.00 s and 0.05 s against B = 0.03 s and
0.08 s. The closest pair is 0.05 with 0.03, and greedy then stops at one
pair. The optimal matching has two pairs: 0.00 with 0.03, and 0.05 with
0.08. The pilot uses the optimal matching.

The rule is still a proposal. Final GATE-1 has not accepted it. A human who
wants a different denominator edits every document before any tapping, not
after.

1. Represent each annotation as ordered timestamps in seconds.
2. Match at most one timestamp from each stream per pair.
3. A valid pair has absolute difference `<= 0.035` seconds. Exactly 35 ms
   is valid. A larger difference is not a candidate.
4. Among valid pairs, choose a one-to-one matching with the maximum number
   of pairs. Because the taps lie on a line, a crossing pair can be
   uncrossed without losing a pair or increasing the total absolute error,
   so the search considers non-crossing matchings. The implementation is
   the dynamic program in `validate_protocol.py`.
5. If several matchings have that same count, choose the one with the
   smallest total absolute error.
6. If a tie remains, choose the lexicographically smallest sequence of
   `(index_in_A, index_in_B)` in index order.
7. `agreement = matched_pairs / max(count_A, count_B)`.
8. The beat layer meets the numeric test only when `agreement >= 0.95`.
   Exactly 0.95 passes. The numeric test is not, by itself, TAKE_ACCEPTED.

If `max(count_A, count_B)` is 0, agreement is undefined and the take is
TAKE_REJECTED. An empty stream against a non-empty stream has agreement 0.

One missing beat gives `n / (n + 1)` when every other tap matches. That
value is at least 0.95 only when the larger count is at least 20. Nineteen
matches out of 20 is exactly 0.95 and meets the numeric test. Eighteen
matches out of 19 is below 0.95.

The same matcher is applied to taps both annotators marked as downbeats.
Downbeats use the same 35 ms and 95 percent numbers. If the downbeat layer
fails the numeric test, beats may still pass, and later scoring omits
downbeats. If the beat layer fails the outcome rules, the take is not
accepted.

The matcher does not know the tempo map. It still applies across the step
in `tempo_change` and across the texture change in `quiet_and_percussive`,
because it compares times only.

This rule is not retuned after a model is run.

## Same metrical level

Two annotators can agree with each other and still both be on the offbeat.
Agreement does not prove they found the intended tactus. After both streams
are stored, a QA pass that the annotators do not see during tapping computes
four diagnostics. None of them moves a timestamp.

- Interval ratio. Median gap between consecutive taps in A, divided by the
  same median in B. A ratio from 0.9 through 1.1 is the same subdivision
  rate. A ratio from 0.45 through 0.55, or from 1.8 through 2.2, means one
  stream is tapping about twice as fast as the other. That is an alternating
  metrical level, including quarters against eighths.
- Half-period phase against the click. For each human tap, take the signed
  offset to the nearest click time. If the median absolute offset is within
  35 ms, that stream sits on the click tactus. If it sits within 35 ms of
  half the local click period, that stream sits on the half-beat. At every
  tempo in this pilot the half-period is longer than 35 ms (300 ms at 100
  BPM, 375 ms at 80 BPM), so a pure half-beat shift produces no valid pairs.
- Bar consistency. Downbeat flags should fall every four beats of that
  annotator's own tactus. If one annotator's downbeats land on another beat
  of the other's 4/4 cycle, the bar phase disagrees.
- Independent review. The third reviewer, when required, taps the
  guitar-only file once, without the click and without any model.

Both annotators on the half-beat of the click is not TAKE_ACCEPTED, even
if their agreement is 1. They agreed with each other on a shared offbeat
reading. The pre-registered tactus for `offbeat_heavy` is the numbered
beat. The labels are not slid onto the click, and the click is not slid
onto the labels.

## Outcomes

| Outcome | When |
| --- | --- |
| TAKE_ACCEPTED | Numeric agreement is at least 0.95, the interval ratio is inside 0.9 to 1.1, the half-beat diagnostic is not "both on the half-beat," bar flags do not show a shifted cycle, and neither annotator reported an unrecoverable loss of tactus. |
| TAKE_REVIEW_REQUIRED | The numeric test failed, but the streams are not empty and are not a pure half-beat opposition; or both annotators landed on the half-beat together; or the interval ratio shows two metrical levels; or a transition note says the bar-9 texture change broke the pulse. |
| TAKE_REJECTED | Either stream is empty; the reviewer cannot confirm one tactus; annotators were tapping onsets or heard the click or a model; click bleed; duration over 60 seconds; an unintended meter change; an unplanned tempo discontinuity; the bar-9 boundary in the files is not beat 32 of the tempo map; or the take is a duplicate or lacks composition rights. |

TAKE_ACCEPTED is a proposal outcome. No take has this status. The manifest
field `final_acceptance_status` stays `NOT_COLLECTED`.
`annotation_qa_status` stays `NOT_COLLECTED`.

On TAKE_ACCEPTED without a reviewer, the reference times are the matched
taps of the annotator with the lexicographically smaller annotator ID.
Unmatched extras are not reference beats. The midpoint of a pair is not
used. On acceptance after review, the reference times are the reviewer's
taps that matched the partner stream which reached 0.95. This choice of
which stream is kept is part of final GATE-1 and is not granted yet.

## Third reviewer

The reviewer is used only for TAKE_REVIEW_REQUIRED, and only if GATE-6 has
named them. They tap once, guitar only, no click, no tempo map, no MIDI, no
Madmom, no Beat This, and no other tracker. Their stream is not chosen
because it is closer to a model. Distance to a model is not computed for
this decision.

Recompute agreement between the reviewer and annotator A, and between the
reviewer and annotator B, with the same matcher. Also repeat the metrical
diagnostics against the click. The take becomes TAKE_ACCEPTED only if at
least one of those pairs meets the TAKE_ACCEPTED tests, with the reviewer
as one side. The kept label stream is the reviewer stream. If neither pair
qualifies, the take is TAKE_REJECTED.

The reviewer does not average the original streams. Averaging is not
permitted.

If the dispute is which pulse is the tactus, including the numbered beat
versus the offbeat accent or a phase jump at bar 9, and the reviewer cannot
hear one tactus through the take, the result is TAKE_REJECTED. The click is
not moved to match the accents.

## Tempo-map storage

The tempo map is stored per take, outside git, and is withheld from
annotators during tapping. Fields:

- recording ID
- sample rate, once a person has chosen it
- meter 4/4
- for each beat index 0..63: downbeat flag, BPM in force for the interval
  that follows that beat, and exact time `t(n)` as a rational number of
  seconds
- bar-9 marker at beat 32: time 19.200 s for `quiet_and_percussive`, time
  24 s for `tempo_change`, and no tempo event for the other conditions
- latency compensation in signed samples, as defined in the latency protocol
- trim start and trim end on the canonical timeline

Manifest field `tempo_map_reference` stays `NOT_COLLECTED` until a file
exists. No example annotation fraction is filled in, because no taps exist.

## Rejection list

The take is TAKE_REJECTED, and is not scored, when any of these is true:

- Annotators heard the click, a MIDI guide, or a model output.
- The outcome table says TAKE_REJECTED.
- Either annotator reports that they were tapping note onsets rather than
  the pulse.
- The kept guitar file is longer than 60 seconds.
- Click bleed was found in the guitar channel.
- The performed meter changes, or the tempo jumps where the map does not.
- For `quiet_and_percussive` or `tempo_change`, the recorded boundary
  cannot be reconciled with beat index 32. Reconciliation means the tempo
  map and the click file place beat 32 at the planned time. It does not
  mean a model picked the first loud transient.
- The take is a duplicate or a derivative mix of another take.
- The composition rights form does not cover the material that was played.

A rejected take remains in the manifest. Until a person records the
decision, `final_acceptance_status` stays `NOT_COLLECTED`.
