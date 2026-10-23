# Recording checklist

Status: PLAN. NEEDS_HUMAN_APPROVAL.

Twenty-four takes are planned. None is recorded. Player names are
placeholders. Instrument, room, and microphone are `NEEDS_HUMAN_APPROVAL`.
Tempos below match `PILOT_OVERVIEW.md` and are part of GATE-1.

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

| Condition | Meter | Tempo | Tempo change | Planned duration |
| --- | --- | --- | --- | --- |
| straight_strum | 4/4 | 100 BPM | none | 38.4 s (16 bars) |
| fingerpicking | 4/4 | 80 BPM | none | 48.0 s (16 bars) |
| syncopated_strum | 4/4 | 96 BPM | none | 40.0 s (16 bars) |
| offbeat_heavy | 4/4 | 90 BPM | none | 42.667 s (16 bars) |
| tempo_change | 4/4 | 80 BPM, then 100 BPM | step at the downbeat of bar 9 | 43.2 s |
| quiet_and_percussive | 4/4 | 100 BPM | none; texture changes at bar 9 | 38.4 s (16 bars) |

`offbeat_heavy`: the click is the numbered beat. The player accents the
and-of-each-beat. The evaluation tactus is the numbered beat.

`quiet_and_percussive`: one take, two sections. Bars 1–8 are quiet. Bars
9–16 are percussive. This reading keeps the pilot at 24 takes. See the
overview.

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
