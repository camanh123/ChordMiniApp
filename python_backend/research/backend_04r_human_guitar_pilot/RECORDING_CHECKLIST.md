# Recording checklist

Status: PLAN. GATE-1 is PENDING_FINAL_HUMAN_APPROVAL.

Twenty-four takes are planned. None is recorded. Player names are
placeholders. Instrument, room, and microphone are `NEEDS_HUMAN_APPROVAL`.
Tempos below match `PILOT_OVERVIEW.md`. Final GATE-1 approval is still
required before any of these rows is recorded.

Every take:

- Duration planned under 60 seconds, and rejected if the kept file exceeds
  60 seconds.
- Guitar channel and click channel recorded separately.
- Click heard in headphones, not from a speaker in the room.
- Session S1 and session S2 for the same player differ in time and in room
  or microphone placement.
- The same instrument for a player across S1 and S2, unless GATE-1 records
  a deviation.

PLAYER_A is development. PLAYER_B is sealed evaluation. That assignment is
GATE-7 and is fixed before any model is scored. It is not fixed by this
unsigned checklist alone.

## Shared musical plan

Every condition is 4/4, 16 bars, 64 beats, indices 0 through 63. Duration
is `t(64)` from the tempo-map section of `PILOT_OVERVIEW.md`. The displayed
second value is three decimal places, half-up. No take is planned past 60
seconds.

| Condition | Type | Endpoints | Bar-9 event | Exact duration | Display |
| --- | --- | --- | --- | --- | --- |
| straight_strum | CONSTANT | 100 BPM | none | 64 × 60 / 100 = 192/5 s | 38.400 s |
| fingerpicking | CONSTANT | 80 BPM | none | 64 × 60 / 80 = 48 s | 48.000 s |
| syncopated_strum | CONSTANT | 96 BPM | none | 64 × 60 / 96 = 40 s | 40.000 s |
| offbeat_heavy | CONSTANT | 90 BPM | none | 64 × 60 / 90 = 128/3 s | 42.667 s |
| tempo_change | STEP | 80 BPM, then 100 BPM | tempo step at beat 32 | 32 × 60 / 80 + 32 × 60 / 100 = 216/5 s | 43.200 s |
| quiet_and_percussive | CONSTANT | 100 BPM | texture change at beat 32, tempo unchanged | 64 × 60 / 100 = 192/5 s | 38.400 s |

The 42.667 s display is 128/3 seconds rounded half-up to three decimals.
128/3 is 42.666... seconds. Calculations keep the fraction.

Click events: beat indices 0 through 63 inclusive. No click at index 64.
No ramp. DAW software is not selected. Rendering these equations is
NEEDS_HUMAN_APPROVAL once a DAW is chosen.

`offbeat_heavy`: the click is the numbered beat. The player accents the
and-of-each-beat. The evaluation tactus is the numbered beat.

`quiet_and_percussive`: one take, not two. Bars 1–8 are quiet. Bars 9–16
are percussive. Beat 32 is exactly 19.200 seconds (96/5 s) after beat 0.
The click does not stop or restart there. A louder attack at the boundary
is not the definition of beat 32. Percussive noise can pull a listener
onto a different phase; that risk is annotated under the annotation
protocol and does not add a 25th take.

`tempo_change`: beat 32 is exactly 24 seconds after beat 0. The step is
instantaneous at that beat. The first 32 beat intervals use 80 BPM. The
next 32 use 100 BPM. There is no ramp and no third tempo.

`tempo_change`: no ramp and no third tempo.

## Takes

Instrument for every row: NEEDS_HUMAN_APPROVAL.

Room and microphone for every row: NEEDS_HUMAN_APPROVAL.

Channels for every row: separate click and guitar, routing verified only
when GATE-5 is granted.

| Planned ID | Player | Session | Split | Condition |
| --- | --- | --- | --- | --- |
| pilot04q_A_S1_straight_strum | PLAYER_A | S1 | development | straight_strum |
| pilot04q_A_S1_fingerpicking | PLAYER_A | S1 | development | fingerpicking |
| pilot04q_A_S1_syncopated_strum | PLAYER_A | S1 | development | syncopated_strum |
| pilot04q_A_S1_offbeat_heavy | PLAYER_A | S1 | development | offbeat_heavy |
| pilot04q_A_S1_tempo_change | PLAYER_A | S1 | development | tempo_change |
| pilot04q_A_S1_quiet_and_percussive | PLAYER_A | S1 | development | quiet_and_percussive |
| pilot04q_A_S2_straight_strum | PLAYER_A | S2 | development | straight_strum |
| pilot04q_A_S2_fingerpicking | PLAYER_A | S2 | development | fingerpicking |
| pilot04q_A_S2_syncopated_strum | PLAYER_A | S2 | development | syncopated_strum |
| pilot04q_A_S2_offbeat_heavy | PLAYER_A | S2 | development | offbeat_heavy |
| pilot04q_A_S2_tempo_change | PLAYER_A | S2 | development | tempo_change |
| pilot04q_A_S2_quiet_and_percussive | PLAYER_A | S2 | development | quiet_and_percussive |
| pilot04q_B_S1_straight_strum | PLAYER_B | S1 | sealed_evaluation | straight_strum |
| pilot04q_B_S1_fingerpicking | PLAYER_B | S1 | sealed_evaluation | fingerpicking |
| pilot04q_B_S1_syncopated_strum | PLAYER_B | S1 | sealed_evaluation | syncopated_strum |
| pilot04q_B_S1_offbeat_heavy | PLAYER_B | S1 | sealed_evaluation | offbeat_heavy |
| pilot04q_B_S1_tempo_change | PLAYER_B | S1 | sealed_evaluation | tempo_change |
| pilot04q_B_S1_quiet_and_percussive | PLAYER_B | S1 | sealed_evaluation | quiet_and_percussive |
| pilot04q_B_S2_straight_strum | PLAYER_B | S2 | sealed_evaluation | straight_strum |
| pilot04q_B_S2_fingerpicking | PLAYER_B | S2 | sealed_evaluation | fingerpicking |
| pilot04q_B_S2_syncopated_strum | PLAYER_B | S2 | sealed_evaluation | syncopated_strum |
| pilot04q_B_S2_offbeat_heavy | PLAYER_B | S2 | sealed_evaluation | offbeat_heavy |
| pilot04q_B_S2_tempo_change | PLAYER_B | S2 | sealed_evaluation | tempo_change |
| pilot04q_B_S2_quiet_and_percussive | PLAYER_B | S2 | sealed_evaluation | quiet_and_percussive |

## Before the first take of a session

- GATE-1 through GATE-8 granted.
- Signed consent and composition forms stored outside git.
- Sample rate and bit depth written on the session sheet.
- Loopback residual at or under 5 ms, or the session is not started.
- Headphone check: the click is inaudible from the guitar microphone on a
  short test, under the listening rule in `SYNC_AND_LATENCY_QA.md`.

## After each take

- Planned ID spoken or slated without covering the performance, or recorded
  in the DAW marker, not as a musical claim.
- Export guitar-only and click-only.
- Confirm the planned duration was not exceeded.
- Leave hashes, dates, and QA fields `NOT_COLLECTED` until the files exist.

No row in this checklist has a recording date, because no take has been
made.
