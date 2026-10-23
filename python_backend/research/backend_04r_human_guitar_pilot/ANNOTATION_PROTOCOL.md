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

- Interval ratio. This compares the two annotators with each other. It is
  the median gap between consecutive taps in A, divided by the same median
  in B. It is not a comparison of either annotator with the tempo map, and
  it is not a comparison of one inter-tap gap with the next gap inside a
  single stream. A ratio from 0.9 through 1.1 is the same subdivision rate.
  A ratio from 0.45 through 0.55, or from 1.8 through 2.2, means one stream
  is tapping about twice as fast as the other. That is an alternating
  metrical level, including quarters against eighths. The 0.9–1.1 band is
  unchanged and still needs final GATE-1 approval. On `tempo_change`, both
  annotators who follow 80 BPM and then 100 BPM have the same median gap, so
  the ratio stays 1 and the step is not rejected. The gap that crosses beat
  32 changes from 0.75 s to 0.60 s, a ratio of 1.25. That local change must
  not be run through the 0.9–1.1 band. The tempo map may be read after
  tapping to name beat 32. It does not replace a human time.
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
| TAKE_ACCEPTED | Numeric agreement is at least 0.95, every tap is in a matched pair or an unmatched tap was explicitly resolved, the interval ratio is inside 0.9 to 1.1, the streams are not on different tactus levels, and the reference samples defined below are strictly increasing. |
| TAKE_REVIEW_REQUIRED | Agreement is at least 0.95 but at least one tap is unmatched; or the numeric test failed and both streams are non-empty; or the interval ratio shows two metrical levels; or the taps are a half-beat apart; or a note says the beat-32 step or the bar-9 texture change broke the pulse; or rounded reference samples collide or go backwards. |
| TAKE_REJECTED | Either stream is empty; the reviewer cannot resolve an unmatched tap or cannot confirm one tactus; annotators were tapping onsets or heard the click or a model; click bleed; duration over 60 seconds; an unintended meter change; an unplanned tempo discontinuity; the bar-9 boundary in the files is not beat 32 of the tempo map; or the take is a duplicate or lacks composition rights. |

TAKE_ACCEPTED is a proposal outcome. No take has this status. The manifest
field `final_acceptance_status` stays `NOT_COLLECTED`.
`annotation_qa_status` stays `NOT_COLLECTED`.

## Reference beats

This contract is a proposal. It is not human-approved. GATE-1 remains
PENDING_FINAL_HUMAN_APPROVAL. No reference series in this repository has
been built, because no taps exist.

When the numeric test passes and the metrical checks agree, each accepted
matched pair proposes one reference time: the midpoint of the two
timestamps. Pair `k` keeps beat index `k` in matcher order, which is
chronological. The click, Madmom, Beat This, and any other model do not
choose that time and do not move it afterward.

Unmatched taps are not deleted and are not filled by interpolation. A take
with agreement of at least 0.95 and one unmatched tap, including 19 matches
out of 20, is TAKE_REVIEW_REQUIRED. The 19 midpoints stay provisional. They
are not an authoritative series until the unmatched tap is explicitly kept
or rejected.

The authoritative series exists only for TAKE_ACCEPTED. It is the midpoints
of the surviving matched pairs, followed by any reviewer time added for a
resolved unmatched tap, in time order. A reviewer time is that person's
guitar-only tap. It is not a midpoint with a missing partner, and it is not
the nearest click or model beat.

## Timestamp precision

Midpoints are computed in exact decimal seconds on the trimmed guitar
timeline: `(time_A + time_B) / 2`. Intermediate values are not rounded to
milliseconds.

Conversion to a sample index happens once, after the midpoint exists, and
only if a sample rate has been chosen. The rate is still
NEEDS_HUMAN_APPROVAL. The index on the trimmed timeline is
`round_half_away_from_zero(midpoint_seconds × sample_rate)`. A tie at
`n + 0.5` samples rounds away from zero, so a positive tie moves to `n + 1`.

Those trimmed indices must be strictly increasing. A repeated index or a
reversal is not a reference series. It is TAKE_REVIEW_REQUIRED, and
TAKE_REJECTED if a reviewer cannot make the indices strictly increasing
without the click or a model.

The annotators already heard the trimmed file, so latency compensation is
already inside that file. Mapping back to the canonical timeline is
`canonical_sample = trimmed_sample + start_sample`. `latency_samples` is
not subtracted again. The trim remains `[start_sample, end_sample)`.

## Third reviewer

The reviewer is used only for TAKE_REVIEW_REQUIRED, and only if GATE-6 has
named them. They hear the guitar-only file. They do not hear the click.
They do not see the tempo map, MIDI, Madmom, Beat This, or any other
tracker. A candidate is not kept because it is closer to a model or to the
click. That distance is not computed.

| Dispute | What the reviewer does | Result |
| --- | --- | --- |
| Missing or extra tap, including a duplicate timestamp left unmatched | For each unmatched tap, explicitly confirm one guitar-only time or explicitly reject that tap. Do not invent the time by interpolating its neighbors. | TAKE_ACCEPTED only if every unmatched tap is resolved and the sample indices are strictly increasing. Otherwise TAKE_REJECTED. |
| Timing already inside 35 ms | No reviewer. The midpoint is the proposal. | TAKE_ACCEPTED when the other acceptance tests pass. |
| Half-beat phase, or two metrical levels | Tap the whole guitar-only file once. | Midpoints are formed with the annotator they match at 0.95 or above on the same metrical level. If neither annotator qualifies, TAKE_REJECTED. |
| Tempo step at beat 32 | Review only the unmatched taps around that beat, if any. A followed 80-to-100 step is not itself a dispute. | Same unmatched-tap rule. The tempo map is not copied over the taps. |
| Bar-9 quiet-to-percussive change | Review unmatched taps around beat 32. A louder attack is not automatically the beat. | Same unmatched-tap rule. |
| Reviewer still cannot name one tactus | Stop. | TAKE_REJECTED. |

For `offbeat_heavy`, the pre-registered tactus is the numbered beat, not the
accent. If the reviewer cannot hear that numbered pulse in the guitar, the
take is TAKE_REJECTED. Confirmed human times are not slid onto the click.

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
