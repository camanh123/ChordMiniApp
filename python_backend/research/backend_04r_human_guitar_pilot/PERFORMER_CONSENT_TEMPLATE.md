# Performer consent template

Status: UNSIGNED TEMPLATE. NEEDS_HUMAN_APPROVAL.

A blank copy of this form is not consent. Do not sign on behalf of a
performer. Do not invent a name, a date, or a signature. One completed form
is required for each performer before that performer is recorded. This form
is not legal advice. A lawyer or the project owner may replace it before
GATE-3 is granted. Recording is not authorized by the existence of this file.

## Performer

| Field | Entry |
| --- | --- |
| Legal name | |
| Contact | |
| Player code | PLAYER_A or PLAYER_B |
| Date of birth or age confirmation | The performer confirms they are an adult. Age is otherwise left blank. |

Player code is assigned by the project under GATE-2 and GATE-7. PLAYER_A is
development. PLAYER_B is sealed evaluation. The assignment is written before
recording and is not changed to improve a score.

## Purpose

The recording is for a research pilot of guitar beat tracking. The pilot is
24 takes from two players, as described in `PILOT_OVERVIEW.md`. Each take is
at most 60 seconds. The player will hear a click in headphones. The guitar
and the click are stored as separate audio files. People will tap beats on
the guitar file. A later research comparison may run two existing beat
trackers on the guitar file only. This form does not authorize that
comparison by itself, and it does not authorize a public service.

The pilot cannot support a general claim about guitar playing.

## Ownership

The performer keeps the copyright in their performance unless they later
sign a separate assignment. This template does not assign copyright to the
project. The project receives only the permissions the performer marks
below.

Composition rights are recorded on `COMPOSITION_RIGHTS_TEMPLATE.md`. A
performance of a song the performer does not have rights to is not accepted.
Commercial covers are not part of this pilot.

## Permitted research use

If the performer signs, the project may:

- Store the guitar channel, the click channel, the tempo map, and the human
  beat taps for this pilot.
- Let named annotators listen to the guitar channel.
- Run research beat-tracking comparisons on the guitar channel, with the
  click and the taps withheld from the models.
- Report aggregate scores. Audio is not embedded in a report unless the
  redistribution choice below is marked yes.

This permission is for non-commercial research. It does not make the
installed Madmom weights commercially licensed. Those weights remain
LICENSE_BLOCKED for commercial use. It does not permit a public inference
endpoint.

## Optional redistribution

The performer marks exactly one line. Neither line is pre-selected.

- [ ] Redistribution declined. Audio, click, and taps stay inside the
  approved access list and are not published, uploaded, or committed to git.
- [ ] Research redistribution granted. The project may publish the guitar
  audio, the click, the tempo map, and the taps under a license the
  performer names here: ____________________. Suggested option, not a
  choice already made: CC BY 4.0.

Leaving both boxes empty means redistribution is not granted.

## Retention, access, and withdrawal

Storage location: NEEDS_HUMAN_APPROVAL.

Access list: NEEDS_HUMAN_APPROVAL. Until that list exists, only the project
owner and the people named on the signed form may hear the audio.

Audio and click files stay outside git. A manifest may later store IDs,
dates, and hashes. Hashes are not a substitute for access control.

Withdrawal before any model is run on that player's files: the project
deletes that player's audio, click, tempo map, and taps from the pilot
storage, and marks the manifest rows withdrawn. Those takes are not scored.

Withdrawal after a model has been run, or after an aggregate number has been
written into a report: NEEDS_HUMAN_APPROVAL. This template does not decide
the legal effect of that later withdrawal. The practical minimum, pending
that decision, is that the project stops using the files and does not
publish them.

The performer may request withdrawal by contacting the project owner named
below.

## What the performer is asked to play

Original grooves or public-domain patterns written for this pilot, in the
six conditions on the checklist. The player may refuse any take. A refused
take is not recorded.

## Signature

Signing is done by hand or by a verified electronic signature process the
project owner specifies later. This file in git stays unsigned.

```
Performer legal name: ________________________________
Player code: ________________________________
Date: ________________________________
Performer signature: ________________________________

Project owner name: ________________________________
Date: ________________________________
Project owner signature: ________________________________
```

Consent status in the manifest stays `NEEDS_HUMAN_APPROVAL` until a signed
copy exists outside this repository and a person records that fact.
