# BACKEND-04R human guitar beat benchmark approval pack

Status: PROPOSAL. NEEDS_HUMAN_APPROVAL.

This directory is an approval package for a future recording pilot. It is not
permission to record, not a signed consent, and not a dataset. No audio is
included. No performer has been identified. No signature in this directory is
valid, because none has been signed.

Baseline commit for this proposal: `d81e12076b850e10cfb5099fbb87f49eaba54368`.

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

| Condition | Proposed tempo plan | Proposed length |
| --- | --- | --- |
| straight_strum | 100 BPM, 4/4, no change, 16 bars | 38.4 s |
| fingerpicking | 80 BPM, 4/4, no change, 16 bars | 48.0 s |
| syncopated_strum | 96 BPM, 4/4, no change, 16 bars | 40.0 s |
| offbeat_heavy | 90 BPM, 4/4, no change, 16 bars | 42.667 s |
| tempo_change | 80 BPM for bars 1–8, step to 100 BPM at the downbeat of bar 9, through bar 16 | 43.2 s |
| quiet_and_percussive | 100 BPM, 4/4, no change, 16 bars; bars 1–8 quiet, bars 9–16 percussive | 38.4 s |

Every proposed length is under the 60-second cap. These tempos, the meter,
and the bar counts are a proposal. They are NEEDS_HUMAN_APPROVAL before a
session is scheduled. A human may replace them only by editing this overview,
the recording checklist, and the manifest template together.

PLAYER_A is the development split. PLAYER_B is the sealed evaluation split.
Real names are unknown and are left blank in the consent template.

### Sixth-condition ambiguity

BACKEND-04Q described the sixth slot as "a quiet take plus a percussive
take" and also fixed the pilot at 24 takes, which is two players times two
sessions times six conditions. This pack keeps the count at 24 by planning
one take that contains both a quiet section and a percussive section, with
the section boundary written in the tempo map before recording. Splitting
that slot into two takes would make 28 takes or would require dropping
another condition. That change is NEEDS_HUMAN_APPROVAL and is not authorized
by this draft.

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

This documentation phase is accepted when the seven files in this directory
agree on the constants below. It does not require a recording, a signature,
or a recruited player.

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
| GATE-1 | Project owner approves this scope, including the proposed tempos and the one-take reading of the quiet/percussive slot | NEEDS_HUMAN_APPROVAL |
| GATE-2 | Two real performers are identified and assigned to PLAYER_A and PLAYER_B | NEEDS_HUMAN_APPROVAL |
| GATE-3 | Each performer signs `PERFORMER_CONSENT_TEMPLATE.md` | NEEDS_HUMAN_APPROVAL |
| GATE-4 | Composition rights for every take are recorded on `COMPOSITION_RIGHTS_TEMPLATE.md` | NEEDS_HUMAN_APPROVAL |
| GATE-5 | Equipment and separate-channel routing are verified, including headphone click and a successful loopback | NEEDS_HUMAN_APPROVAL |
| GATE-6 | Two annotators and one dispute reviewer are named | NEEDS_HUMAN_APPROVAL |
| GATE-7 | PLAYER_B is assigned to sealed evaluation before any model scoring | NEEDS_HUMAN_APPROVAL |
| GATE-8 | Storage location, access list, and privacy arrangements are approved | NEEDS_HUMAN_APPROVAL |

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
| Annotation agreement | absolute tap difference at most 35 ms on at least 95 percent of beats, using the pairing rule in the annotation protocol |
| Latency rejection | residual strictly greater than 5 ms rejects the session |
| Channels | guitar and click recorded separately; click is absent from the model input and from the annotator mix |
| Labels | human taps only |

## Ambiguities left open

These are written down so a later editor does not fill them in silently.

- Sample rate and bit depth: NEEDS_HUMAN_APPROVAL. The 5 ms test is defined
  in seconds in the latency protocol so it does not depend on rounding a
  half sample at 44100 Hz.
- How two tap streams are paired, and what the 95 percent denominator is:
  a proposed formula is in `ANNOTATION_PROTOCOL.md` and is itself
  NEEDS_HUMAN_APPROVAL.
- Whether a trim interval is half-open: proposed as half-open
  `[start, end)` in the latency protocol, NEEDS_HUMAN_APPROVAL.
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
- `DATA_MANIFEST_TEMPLATE.csv` — one row per planned take, evidence
  `NOT_COLLECTED` or `NEEDS_HUMAN_APPROVAL`.
