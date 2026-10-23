# Sync and latency QA

Status: PROPOSAL. NEEDS_HUMAN_APPROVAL.

No loopback has been measured. No session is rejected yet, because no
session has been recorded. Thresholds below are the rules a future session
must meet.

## Separate channels

The click is generated from the tempo map and recorded on a click channel.
The guitar is recorded on a guitar channel. The player hears the click only
in headphones. A speaker in the room carrying the click is not an acceptable
setup, because an acoustic guitar or a room microphone will capture it.

The model input, when a later phase is separately approved, is the guitar
channel after the trim below. The annotator mix is that same guitar
channel. The click is never mixed into either file.

GATE-5 is granted only after a person verifies the routing: one test
recording shows energy on the click channel during a click and no intended
click path into the guitar channel. The listening check below still applies
to every musical take.

## Loopback measurement

Before the first musical take of a session:

1. Replace the guitar with a loopback from the click output into the guitar
   input, using the same interface, buffer, and sample rate planned for the
   session. The sample rate itself is NEEDS_HUMAN_APPROVAL and is written
   down before this measurement.
2. Play one click impulse.
3. Measure the integer sample delay from the click-channel impulse to the
   guitar-channel impulse.
4. Store that delay as `latency_compensation_samples`, the value that will
   be written into `latency_samples` on each manifest row for the session
   once the measurement exists. Until then the manifest says
   `NOT_COLLECTED`.

Compensation is applied once. The protocol records whether it was applied
by shifting the guitar audio or by shifting the click timestamps. Applying
both is a session failure.

After compensation, repeat one impulse. The residual is the remaining
integer sample offset. Convert it to seconds with the session sample rate:

```
residual_seconds = abs(residual_samples) / sample_rate
```

Reject the session when `residual_seconds > 0.005`. A residual of exactly
0.005 seconds is accepted. This comparison stays in seconds so that a 44100
Hz session is not forced to round 5 ms to 220 or 221 samples before the
rate is chosen. At 44100 Hz, 5 ms is 220.5 samples. At 48000 Hz, 5 ms is
240 samples. The rate is chosen by a person under GATE-1. This document
does not choose it.

A body tap on the guitar, recorded on the guitar channel while one click is
recorded on the click channel, is a sanity check after the loopback. It
does not replace the loopback number. If the body-tap offset and the
loopback residual disagree by more than 5 ms, the session is rejected and
the routing is inspected. "Disagree" uses the same `> 0.005` seconds test.

## Sample-accurate timestamps

Sample positions are integers. Times in seconds are
`sample_index / sample_rate` on the trimmed timeline. Annotation agreement
uses those second values. Files are not resampled after the session rate is
fixed. A later resample is a new recording identity and needs new hashes.

Proposed trim convention, NEEDS_HUMAN_APPROVAL under GATE-1: the kept
region is the half-open sample interval `[start, end)`. The same `start`
and `end` are applied to the guitar channel and the click channel. Click
timestamps and tempo-map sample indices that fall in that interval are
shifted by subtracting `start`. Events outside the interval are dropped.
`end - start` divided by the sample rate is the duration. If that duration
is greater than 60 seconds, the take is rejected.

The half-open convention is a proposal because BACKEND-04Q required
sample-aligned trims and did not define whether the end index is kept.
Both documents that mention the trim use `[start, end)`.

## Click bleed

No automatic level threshold is defined. None was measured, and this pack
does not invent a decibel cutoff.

The designated recording reviewer, named under GATE-5 or GATE-6 and
currently NEEDS_HUMAN_APPROVAL, listens to the guitar channel on
headphones at a normal monitoring level. If a click is audible on that
channel, the take is rejected. A rejected take is not repaired by noise
gating or by spectral editing, because that would be a derivative the
protocol has not defined.

The reviewer records pass or fail in the session notes. Until that listen
happens, manifest QA fields stay `NOT_COLLECTED`.

## Guitar and click identity

After the trim:

- `guitar_sha256` is the SHA-256 of the trimmed guitar file.
- `click_sha256` is the SHA-256 of the trimmed click file.

Both fields are `NOT_COLLECTED` in the template. A hash of a file that does
not exist is not written. The two hashes must differ. Identical hashes mean
the channels were not separated, and the take is rejected.

## Session and take rejection

Reject the whole session when:

- The loopback was not done before the musical takes.
- Compensation was applied twice, or the direction of the shift was not
  recorded.
- `residual_seconds > 0.005`.
- The body-tap check disagrees with the loopback by more than 5 ms.
- The sample rate changed during the session.
- The click was played on a speaker in the room.

Reject the take, and keep the rest of a passing session, when:

- Click bleed is audible on the guitar channel.
- The trimmed duration is over 60 seconds.
- The trim was applied to only one channel.
- The guitar file and the click file have the same hash.
- The tempo map does not match the planned condition, including a missing
  bar-9 step on `tempo_change` or a missing bar-9 texture boundary on
  `quiet_and_percussive`.

Rejected sessions are not scored. Their manifest rows, once recording has
actually happened, record the reason. This template does not pre-fill a
rejection, because nothing has been measured.
