# BACKEND-04R human guitar beat benchmark approval pack

Status: PROPOSAL. GATE-1 is PENDING_FINAL_HUMAN_APPROVAL.

BACKEND-04R.1 incorporates a conditional technical revision. The project
owner accepted the 24-clip structure and did not grant final GATE-1
approval. This file is not permission to record, not a signed consent, and
not a dataset. No audio is included. No performer has been identified. No
signature in this directory is valid, because none has been signed. GATE-2
through GATE-8 are PENDING.

Baseline of the BACKEND-04R pack: `72ef9148c64f9326b400e457c0bc5851f8b5d95a`.
Sealed model baseline under that commit: `d81e12076b850e10cfb5099fbb87f49eaba54368`.

## Research purpose

ChordMiniApp needs a guitar beat-tracking comparison that is independent of
GuitarSet and independent of the recordings used to train the Beat This
checkpoints under consideration. BACKEND-04Q found no published guitar corpus
that supplies a documented tactus, a research-usable license, and that
separation at the same time.

The proposed route is a small set of new human guitar performances with a
click kept on a separate channel and with beat labels tapped by people. The
later comparison, which this package does not run, would keep production
Madmom frozen as the control and would admit one pinned Beat This checkpoint
only after its license statement and training manifest exclude every pilot
file.

## Scope

The minimum pilot is 24 takes:

- Two human guitarists, identified later as PLAYER_A and PLAYER_B.
- Two sessions per guitarist, S1 and S2.
- Six conditions in every session, one take each.

| Condition | Tempo map | Displayed length |
| --- | --- | --- |
| straight_strum | CONSTANT 100 BPM, 4/4, 16 bars, 64 beats | 38.400 s |
| fingerpicking | CONSTANT 80 BPM, 4/4, 16 bars, 64 beats | 48.000 s |
| syncopated_strum | CONSTANT 96 BPM, 4/4, 16 bars, 64 beats | 40.000 s |
| offbeat_heavy | CONSTANT 90 BPM, 4/4, 16 bars, 64 beats | 42.667 s |
| tempo_change | STEP, 80 BPM for beats 0–31, 100 BPM from beat 32 | 43.200 s |
| quiet_and_percussive | CONSTANT 100 BPM, 4/4, 16 bars, 64 beats; texture changes at beat 32 | 38.400 s |

Displayed lengths use three decimal places, half-up. Exact values are in
the tempo-map section. Every length is under 60 seconds. Tempos were not
chosen to favor a model. They remain NEEDS_HUMAN_APPROVAL as part of final
GATE-1. A human may replace them only by editing this overview, the
recording checklist, the manifest template, and `validate_protocol.py`
together. No DAW has been selected. The equations below are vendor-neutral.
Whether a particular DAW renders them unchanged is NEEDS_HUMAN_APPROVAL.

PLAYER_A is the development split. PLAYER_B is the sealed evaluation split.
Real names are unknown and are left blank in the consent template.

### Sixth condition

The sixth condition stays one take. Bars 1–8 are quiet articulation. Bars
9–16 are percussive articulation. It is not split into two recordings.

The meter and the tactus stay 4/4 at 100 BPM through the boundary. There is
no silent tempo reset at bar 9. The click continues without a gap. Bar 9
begins at beat index 32, which is exactly 19.200 seconds after beat 0.
A model prediction does not place that boundary. A louder transient is not
a beat by itself.

The intensity change can still confuse the tactus. Percussive attacks may
land off the numbered beat, or they may sound like a new downbeat, so two
listeners can lock onto different phases after bar 9 even though the click
did not move. That risk is recorded here and does not change the 24-take
structure. `ANNOTATION_PROTOCOL.md` says when that ambiguity rejects the
take.

### Tempo map

Beat index 0 is the downbeat of bar 1, at time 0 on the tempo-map clock,
before latency compensation and trim. Each bar holds 4 beats. Sixteen bars
hold 64 beats, indices 0 through 63. The take ends at the time where beat
index 64 would fall. Beat 64 is the downbeat of a bar 17 that is not played
and is not a click.

For a CONSTANT map at `BPM`:

```
t(n) = n × 60 / BPM
duration = t(64) = 64 × 60 / BPM
```

For the STEP map, beats 0 through 31 use 80 BPM and beats 32 through 63 use
100 BPM. The position of beat 32 is still computed from the first section:

```
t(n) = n × 60 / 80                         for 0 ≤ n ≤ 32
t(n) = 24 + (n − 32) × 60 / 100            for 32 ≤ n ≤ 64
duration = t(64) = 24 + 19.2 = 43.2 seconds exactly
```

There is no RAMP in this pilot. A ramp is not authorized. Linear BPM over
time and linear BPM over beats are different conventions and must not be
mixed. If a later approval adds a ramp, that convention is
NEEDS_HUMAN_APPROVAL and has to be written before recording.

The click grid is one event at each beat index 0, 1, ..., 63. That is 64
clicks. Downbeats are indices 0, 4, 8, ..., 60. The bar-9 downbeat is index
32. No click is placed at index 64.

Exact durations:

| Condition | Equation | Exact seconds | Display |
| --- | --- | --- | --- |
| straight_strum | 64 × 60 / 100 | 192/5 | 38.400 s |
| fingerpicking | 64 × 60 / 80 | 48 | 48.000 s |
| syncopated_strum | 64 × 60 / 96 | 40 | 40.000 s |
| offbeat_heavy | 64 × 60 / 90 | 128/3 | 42.667 s |
| tempo_change | 32 × 60 / 80 + 32 × 60 / 100 | 216/5 | 43.200 s |
| quiet_and_percussive | 64 × 60 / 100 | 192/5 | 38.400 s |

The previous 42.667 second figure for 16 bars of 4/4 at 90 BPM is this
display rounding of 128/3, which is 42.666... seconds. It is not a second,
rougher estimate. Full-precision timestamps keep 128/3. Rounding is applied
only when a document shows three decimal places.

Sample indices for the click are computed only after a person chooses the
sample rate. Until then the rate is NEEDS_HUMAN_APPROVAL. The conversion
rule is in `SYNC_AND_LATENCY_QA.md`. At 44100 Hz the 96 BPM grid places
beat 1 halfway between two samples, so a DAW that truncates and a DAW that
rounds can differ by one sample. That compatibility check is
NEEDS_HUMAN_APPROVAL after the DAW is chosen.

### Offbeat relationship

For `offbeat_heavy`, the click marks the numbered beats of the 4/4 bar. The
player accents the and-of-each-beat. The evaluation tactus is the numbered
beat, not the accent. If the annotators do not agree on that tactus, the
take is rejected. The grid is not moved onto the accents after the fact.

## Why this is a pilot

Twenty-four clips from two players can test whether the recording, sync, and
annotation rules produce usable labels. They cannot support a claim about
guitar beat tracking in general, about a style that was not played, or about
a population of players. A later corpus of six or more players would be a
different project and needs its own approval.

## Recording workflow

Recording starts only after every gate in the approval list below is
recorded as granted. Until then the workflow is a plan.

1. The project owner confirms the tempo plan, sample rate, and bit depth.
2. A loopback measurement is stored before musical recording, as specified
   in `SYNC_AND_LATENCY_QA.md`.
3. The player hears the click only in headphones. The click is recorded on
   its own channel. The guitar is recorded on another channel.
4. Each take follows the checklist row for its planned ID.
5. The same sample trim is applied to both channels. Hashes are computed on
   the trimmed files that will be annotated and, later, scored.
6. A person inspects the guitar channel for click bleed.
7. Two annotators tap the guitar-only file under `ANNOTATION_PROTOCOL.md`.
8. The manifest row is filled from the files. Empty evidence stays
   `NOT_COLLECTED` until that happens.
9. PLAYER_B remains sealed from both models. Annotation of PLAYER_B is
   allowed, because the labels have to exist before scoring. Listening that
   changes the protocol stays on PLAYER_A. A PLAYER_B take that fails QA is
   rejected. It is not used to rewrite the protocol.

No step in this list has been executed.

## Equipment

Required before GATE-5 can be marked granted:

- A guitar for each player. The scope asks for one acoustic and one electric
  across the two players when both are available. Which player uses which
  instrument is NEEDS_HUMAN_APPROVAL. A player keeps the same instrument
  across S1 and S2 unless a deviation is approved.
- An interface that can record the guitar and the click as separate
  channels at one shared sample rate.
- Closed headphones for the player, so the click is not played into the
  room by a speaker.
- A DAW or equivalent recorder that can export the tempo map as sample
  positions and can play the click from that map.
- Disk storage outside the git repository.
- A quiet room. S1 and S2 for the same player differ in time and in room or
  microphone placement.

The sample rate and bit depth are NEEDS_HUMAN_APPROVAL. This pack does not
choose 44100 Hz or 48000 Hz. Both channels of a session use the rate that
was written down before the first take of that session.

## Risks

- The click leaks into the guitar microphone.
- Monitoring latency makes the performance sit far from the click, or the
  compensation is applied twice.
- Annotators disagree about the tactus on the offbeat take.
- A commercial cover is played, and the composition rights do not exist.
- One player withdraws, and the sealed split disappears.
- The pilot is later described as a general benchmark.
- Someone builds labels from Madmom or Beat This.
- GuitarSet audio, including reserve and locked files, is mixed in.
- Pilot audio is published and a later Beat This checkpoint trains on it.
- Madmom weights are used outside the research setting already recorded as
  LICENSE_BLOCKED for commercial use.

## Acceptance criteria

This documentation revision is consistent when the files in this directory
agree on the constants below and `validate_protocol.py` passes. It does not
grant GATE-1, and it does not require a recording, a signature, or a
recruited player.

A future recording phase, which is not started here, is accepted only when:

- All eight gates below are recorded as granted by a person.
- Every kept take is at most 60 seconds, has separate guitar and click
  files, passes the latency rule, and passes the annotation rule.
- Rejected takes stay in the manifest with a reason and are not scored.
- PLAYER_B was assigned to sealed evaluation before either model was run.
- No model output was written into the beat labels.

## Approval gates

No future phase may treat these as already granted.

| Gate | Required human act | Status |
| --- | --- | --- |
| GATE-1 | Project owner gives final approval of this revised scope, the tempo equations, the matcher, and the trim convention | PENDING_FINAL_HUMAN_APPROVAL |
| GATE-2 | Two real performers are identified and assigned to PLAYER_A and PLAYER_B | PENDING |
| GATE-3 | Each performer signs `PERFORMER_CONSENT_TEMPLATE.md` | PENDING |
| GATE-4 | Composition rights for every take are recorded on `COMPOSITION_RIGHTS_TEMPLATE.md` | PENDING |
| GATE-5 | Equipment and separate-channel routing are verified, including headphone click and a successful loopback | PENDING |
| GATE-6 | Two annotators and one dispute reviewer are named | PENDING |
| GATE-7 | PLAYER_B is assigned to sealed evaluation before any model scoring | PENDING |
| GATE-8 | Storage location, access list, and privacy arrangements are approved | PENDING |

## Research integrity

The following stay in force:

- GuitarSet v1.1.0 remains the sealed chord and beat baseline. Diagnostic,
  development, locked, and reserve recordings stay closed. This pilot does
  not open them and does not add them to the 24 takes.
- Beat This checkpoints trained on GuitarSet accompaniment mixes, including
  final0–final2 and small0–small2, are not an independent evaluation of
  those recordings. A future checkpoint is usable on this pilot only after
  its file hash and training manifest are pinned and shown to exclude every
  pilot ID and hash.
- The `correct=False` Madmom experiment remains REJECTED.
- The octave tempo guard remains REJECTED.
- Production Madmom stays frozen.
- Commercial use of the installed Madmom weights remains LICENSE_BLOCKED.
  Public hosted use remains UNVERIFIED. This pilot does not grant commercial
  rights and does not deploy a service.
- Beat This weight text is used only as published by its authors. This pack
  does not add a broader grant.

## Constants shared by every document

| Item | Value |
| --- | --- |
| Takes | 24 |
| Players | 2 placeholders, PLAYER_A and PLAYER_B |
| Sessions | 2 per player, S1 and S2 |
| Conditions per session | 6, one take each |
| Development split | PLAYER_A, all sessions |
| Sealed evaluation split | PLAYER_B, all sessions |
| Maximum duration | 60 seconds per take |
| Annotation agreement | optimal one-to-one pairs at most 35 ms inclusive, agreement = matches / max(count), pass at 0.95 inclusive |
| Reference beats | proposed midpoint of each matched pair; unmatched taps are adjudicated, not dropped or interpolated; not yet granted |
| Latency acceptance | abs(residual_samples) / sample_rate <= 0.005; exactly 5 ms passes |
| Channels | guitar and click recorded separately; click is absent from the model input and from the annotator mix |
| Labels | human taps only |

## Ambiguities left open

These are written down so a later editor does not fill them in silently.

- Sample rate, bit depth, and which DAW renders the tempo equations:
  NEEDS_HUMAN_APPROVAL. The 5 ms test is defined in seconds. At 44100 Hz
  the largest integer residual that still passes is 220 samples. At 48000
  Hz, 240 samples is exactly 5 ms and passes.
- The matcher, the 95 percent denominator, and the half-open trim
  `[start_sample, end_sample)` are now specified. They are still part of
  final GATE-1 and are not granted by this revision.
- Click-bleed judgment is a human listening check. No decibel threshold is
  set, because none was measured.
- Legal effect of withdrawal after an analysis number has been written:
  NEEDS_HUMAN_APPROVAL. This pack is not legal advice.
- Storage path, encrypt-at-rest choice, and the access list:
  NEEDS_HUMAN_APPROVAL.

## Documents

- `PILOT_OVERVIEW.md` — this file.
- `PERFORMER_CONSENT_TEMPLATE.md` — unsigned consent form.
- `COMPOSITION_RIGHTS_TEMPLATE.md` — unsigned composition form.
- `RECORDING_CHECKLIST.md` — the 24 planned takes.
- `ANNOTATION_PROTOCOL.md` — human beat labels and rejection rules.
- `SYNC_AND_LATENCY_QA.md` — loopback, trim, and bleed rules.
- `DATA_MANIFEST_TEMPLATE.csv` — one row per planned take. Planned timing
  fields are filled. Measured evidence stays `NOT_COLLECTED`. Consent,
  composition rights, instrument, room, and sample rate stay
  `NEEDS_HUMAN_APPROVAL`.
- `validate_protocol.py` — checks the 24-row plan, the tempo arithmetic,
  the matcher, the trim examples, and the 5 ms threshold. It does not
  record or score audio.
