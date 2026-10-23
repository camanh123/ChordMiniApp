# Annotation protocol

Status: PROPOSAL. NEEDS_HUMAN_APPROVAL.

Annotators are not named yet. GATE-6 names two independent annotators and
one dispute reviewer before any tapping starts. This protocol does not
invent their names and does not invent taps.

No model output is ground truth. Madmom, Beat This, a DAW beat detector, and
any other tracker are not used to create, edit, or fill taps. The click is
not played to the annotator. The tempo map is not shown to the annotator
while they tap. Those files are comparison material for the QA report after
both tap streams exist.

## Audio the annotator hears

The file is the trimmed guitar channel only, at the session sample rate.
The click channel is absent. A mix of guitar and click is a protocol
failure, and the annotation pass is discarded.

Annotators work independently. They do not watch each other tap and they do
not see the other stream until both are stored.

A performer may not be the only annotator of their own take. Whether a
performer may be one of the two annotators on the other player's takes is
NEEDS_HUMAN_APPROVAL under GATE-6. The default in this proposal is that
annotators are not the performer of the take they label.

## What a beat is

A beat is the tactus: the pulse a listener would tap as "the beat." A note
onset, a strum, a pick attack, and a subdivision are not beats merely
because they are audible. The offbeat accent in `offbeat_heavy` is not the
tactus. The numbered click beat is the intended tactus for that condition,
and the annotators have to hear that pulse in the guitar without hearing
the click. If they cannot, the take is rejected for an ambiguous tactus.
The labels are not rewritten to follow the accents.

A downbeat is the first beat of a bar in the pre-registered 4/4 meter. The
authoritative bar index is the tempo map, not a guess from accent strength
in the guitar. Annotators mark a downbeat only when they hear a bar start.
Downbeat scores are reported later only if the downbeat rule below passes.
A take may keep its beats and drop its downbeats.

## Two annotations

Each annotator stores tap times on the trimmed guitar timeline, in seconds,
as `sample_index / sample_rate` using the session rate. The sample index is
an integer on that trimmed timeline. Times are not rounded to milliseconds
before the agreement test. The test uses the full-precision second values.

Proposed tap file, not yet created for any take:

- recording ID
- annotator ID
- beat times in seconds
- optional downbeat flags on those beats

## Agreement rule

BACKEND-04Q required taps within 35 ms of each other on at least 95 percent
of beats. It did not define pairing or the denominator. The formula below
is the proposed operational rule. It is NEEDS_HUMAN_APPROVAL as part of
GATE-1. Documents in this pack all use this formula. A human who wants a
different denominator changes every document before recording, rather than
changing it after the taps exist.

Proposed pairing:

1. Let A and B be the two sets of beat times in seconds.
2. Build every candidate pair whose absolute difference is at most 0.035
   seconds.
3. Accept pairs greedily, smallest absolute difference first. Ties break by
   earlier time in A, then earlier time in B. Each tap is used at most once.
4. Let M be the number of accepted pairs.
5. If max(count of A, count of B) is 0, reject the take.
6. Agreement = M / max(count of A, count of B).
7. Accept the beat layer when agreement is at least 0.95.

Unmatched taps count against the take because they enlarge the denominator
without increasing M. A 35 ms gap is the maximum accepted difference, not a
second looser check after a wider match. Exactly 35 ms is accepted. A
difference of 35.1 ms is not a candidate pair.

The same formula is applied to the subset of taps both annotators marked as
downbeats, with the other annotator's downbeat flags as the second set.
Downbeat acceptance uses the same 35 ms and 95 percent numbers. If the
downbeat layer fails, beats may still pass, and later scoring omits
downbeats for that take. If the beat layer fails, the take is rejected.

## Third annotator or rejection

If agreement is below 0.95, the dispute reviewer may tap the guitar-only
file once, without seeing a model and without hearing the click. The
reviewer stream then replaces the comparison: agreement is recomputed
between the reviewer and annotator A, and between the reviewer and
annotator B, with the same formula. The take is kept only if at least one
of those pairs reaches 0.95. The kept label stream is the reviewer stream
when the reviewer was required. If both pairs stay below 0.95, the take is
rejected.

The reviewer is not used to average the two original streams. Averaging is
not defined and is not permitted.

If the two original annotators disagree about which pulse is the tactus,
including the numbered beat versus the offbeat accent, the take is rejected
even if a later pairing of unlike pulses happens to land inside 35 ms. The
dispute reviewer may confirm one tactus. If the reviewer cannot, the take
is rejected. Rejection is the expected outcome for an ambiguous tactus, not
a problem to be repaired by moving the click.

## Tempo-map storage

The tempo map is stored per take, outside git, and is withheld from
annotators during tapping. Proposed fields:

- recording ID
- sample rate
- meter, proposed 4/4 for every take
- beat index, downbeat index, sample index on the trimmed timeline, and BPM
  at that beat
- the bar-9 boundary for `tempo_change` and for `quiet_and_percussive`
- latency compensation in samples, as defined in the latency protocol
- trim start and trim end

The map is the intended click grid. It is not the evaluation label. After
both human streams exist, QA may report the median absolute offset between
the accepted human beats and the click grid. A stable offset is recorded.
The human times are not shifted onto the click, and the click is not
shifted onto the human times.

Manifest field `tempo_map_reference` stays `NOT_COLLECTED` until a file
exists. Manifest field `annotation_reference` stays `NOT_COLLECTED` until
the tap files exist. `annotation_qa_status` stays `NOT_COLLECTED` until the
agreement fraction is computed. No example fraction is filled in, because
no taps exist.

## Rejection list

Reject the take, and do not score it, when any of these is true:

- Annotators heard the click or a model output.
- Beat agreement stays under 95 percent after the dispute step.
- The tactus is ambiguous, including numbered beat versus offbeat accent.
- Either annotator reports that they were tapping note onsets rather than
  the pulse.
- The kept guitar file is longer than 60 seconds.
- Click bleed was found in the guitar channel.
- The take is a duplicate or a derivative mix of another take.
- The composition rights form does not cover the material that was played.

A rejected take remains in the manifest with `final_acceptance_status`
set, later, to `REJECTED` and a short reason. Until a decision is recorded,
that field stays `NOT_COLLECTED`.
