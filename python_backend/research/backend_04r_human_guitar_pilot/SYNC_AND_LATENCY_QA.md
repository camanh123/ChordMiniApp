# Sync and latency QA

Status: PROPOSAL. GATE-1 is PENDING_FINAL_HUMAN_APPROVAL.

No loopback has been measured. No latency number in this repository is a
measurement. Thresholds below are the rules a future session must meet.
The person who will measure them is not named. Naming that person is part
of GATE-5, which is PENDING.

## Separate channels

The click is generated from the tempo map and recorded on a click channel.
The guitar is recorded on a guitar channel. The player hears the click only
in headphones. A speaker in the room carrying the click is not an acceptable
setup, because an acoustic guitar or a room microphone will capture it.

The model input, when a later phase is separately approved, is the trimmed
guitar channel. The annotator mix is that same guitar channel. The click is
never mixed into either file.

GATE-5 can be granted only after a person verifies the routing. This
revision does not grant it.

## One canonical timeline

Both channels of a session share one sample rate. The rate is
NEEDS_HUMAN_APPROVAL. This document does not choose 44100 Hz or 48000 Hz.
Bit depth is also NEEDS_HUMAN_APPROVAL.

The raw origin of each exported channel is sample index 0 at the same
session transport start. Times in seconds are not a second origin. They are
`sample_index / sample_rate` on the canonical timeline defined here.

Sign convention, measured on a loopback impulse before any musical take:

```
latency_samples = guitar_impulse_index - click_impulse_index
```

`latency_samples` is a signed integer.

- Positive: the impulse is later in the guitar file than in the click file.
  The guitar channel is late.
- Negative: the guitar channel is early.
- Zero: the impulses already share an index.

Compensation is applied once, to the guitar channel only:

```
canonical_guitar_sample = raw_guitar_sample - latency_samples
canonical_click_sample = raw_click_sample
```

The canonical timeline is the click file's sample index. Subtracting a
negative `latency_samples` moves the guitar later. The click timestamps are
not shifted. Shifting the guitar audio and also shifting the click, or
shifting the guitar and then subtracting `latency_samples` again from
annotation times, is double compensation and fails the session.

After that single shift, a second loopback impulse is measured on the
canonical timeline:

```
residual_samples = canonical_guitar_impulse_index - canonical_click_impulse_index
residual_seconds = abs(residual_samples) / sample_rate
```

The session passes the latency test only when `residual_seconds <= 0.005`.
Exactly 0.005 seconds passes. A larger residual fails the session. The
comparison stays in seconds so a half sample is not rounded before the rate
is chosen.

No DAW is named. Any software used later must implement this integer shift,
or the difference must be recorded as a deviation and is
NEEDS_HUMAN_APPROVAL before the musical takes.

Who measures: the recording reviewer named under GATE-5. That name is
NEEDS_HUMAN_APPROVAL. When: after the interface buffer and sample rate are
fixed, and before the first musical take of the session. The second impulse
is measured after compensation and still before the musical takes.

Evidence retained outside git, once a session exists: sample rate, both raw
impulse indices, signed `latency_samples`, a statement that only the guitar
channel was shifted, `residual_samples`, `residual_seconds`, pass or fail,
and the loopback audio. Until then every manifest `latency_samples` cell
stays `NOT_COLLECTED`. This pack does not invent those numbers.

Integer consequences, with residual samples as integers:

| Sample rate | Exactly 5 ms in samples | Largest passing abs(residual) | First failing abs(residual) |
| --- | --- | --- | --- |
| 44100 Hz | 220.5, not an integer | 220 samples, which is 220/44100 = 0.00498866... s | 221 samples, which is 0.00501133... s |
| 48000 Hz | 240 exactly | 240 samples, which is 0.005 s | 241 samples, which is 0.00502083... s |

A body tap on the guitar, with one simultaneous click, is a sanity check
after the loopback. It does not replace `residual_samples`. If the absolute
difference between the body-tap offset and the loopback residual is greater
than 0.005 seconds, the session fails.

## Trim

The kept region on the canonical timeline is the half-open interval
`[start_sample, end_sample)`. `start_sample` is included. `end_sample` is
excluded. The same integers are applied to the guitar channel and the click
channel after compensation, not before.

```
trimmed_sample = canonical_sample - start_sample
```

A canonical sample is kept when `start_sample <= canonical_sample < end_sample`.
Duration in seconds is `(end_sample - start_sample) / sample_rate`. If that
duration is greater than 60 seconds, the take is rejected.

Annotation taps are made on the trimmed guitar file, so they are already in
trimmed samples. Conversion back to the canonical timeline, if needed, is:

```
canonical_sample = trimmed_sample + start_sample
```

Do not subtract `latency_samples` again. The latency shift already happened
when the trimmed guitar file was built.

Rounding order: stay in integer samples until a second value is required,
then divide by the sample rate once. Do not round a time to milliseconds
and convert back. That path can miss by one sample.

Worked case at both rates. Compensation `latency_samples = +100` (guitar
late by 100 samples). Trim `[1000, 5000)`.

- A click at raw index 1000 has canonical index 1000 and trimmed index 0.
  It is kept.
- A click at raw index 4999 has trimmed index 3999. It is kept.
- A click at raw index 5000 has trimmed index 4000. It is excluded.
- A guitar impulse at raw index 1100 has canonical index 1000. After the
  trim it is trimmed index 0, aligned with the click at raw 1000.
- An annotator tap at trimmed sample 10 is canonical sample 1010. It is not
  moved by another 100 samples.

Duration of this example trim is 4000 samples: `4000/44100` seconds at
44100 Hz, and `4000/48000 = 1/12` seconds at 48000 Hz.

One-sample error from millisecond rounding, at either rate. Canonical
sample 1:

- At 44100 Hz the time is `1/44100` seconds, which is 0.0226757... ms.
  Nearest-millisecond rounding yields 0 ms, and 0 ms converts back to
  sample 0. The error is one sample.
- At 48000 Hz the time is `1/48000` seconds, which is 0.0208333... ms.
  Nearest-millisecond rounding yields 0 ms, and the converted index is
  sample 0. The error is one sample.

Half-sample render example, used only to show DAW risk. For
`syncopated_strum`, beat 1 is at `60/96 = 0.625` seconds.

- At 48000 Hz, `0.625 × 48000 = 30000` exactly.
- At 44100 Hz, `0.625 × 44100 = 27562.5`.

The pilot's render rule, if a rate has been chosen and the product is not
an integer, is round half away from zero. `27562.5` becomes sample 27563.
A DAW that truncates toward zero would store 27562. Those differ by one
sample. No DAW is selected, so this compatibility check is
NEEDS_HUMAN_APPROVAL. Tempo-map times stay as exact rationals until that
rate exists. The bar-9 times that are exact in seconds are also exact in
samples at both rates: 19.200 s is sample 846720 at 44100 Hz and sample
921600 at 48000 Hz; 24 s is sample 1058400 at 44100 Hz and sample 1152000
at 48000 Hz.

This pilot does not resample. A later resample would be a new file identity,
with new hashes, and is not authorized. If one were ever approved, each
integer sample index would be converted once by

```
new_index = round_half_away_from_zero(old_index × new_rate / old_rate)
```

and not by an intermediate millisecond value. Chaining through milliseconds
is the one-sample failure above. DAW compatibility for that formula is
NEEDS_HUMAN_APPROVAL and is unused in this pilot.

## Click bleed

No automatic level threshold is defined. None was measured, and this pack
does not invent a decibel cutoff.

The designated recording reviewer, currently unnamed, listens to the guitar
channel on headphones at a normal monitoring level. If a click is audible
on that channel, the take is rejected. A rejected take is not repaired by
noise gating or by spectral editing. Bleed is a take-level failure. It does
not, by itself, fail the other takes in a session that passed latency QA.

The reviewer records pass or fail outside git. Until that listen happens,
manifest QA fields stay `NOT_COLLECTED`.

## Guitar and click identity

After the trim:

- `guitar_sha256` is the SHA-256 of the trimmed guitar file.
- `click_sha256` is the SHA-256 of the trimmed click file.

Both fields are `NOT_COLLECTED` in the template. The two hashes must differ
once files exist. Identical hashes mean the channels were not separated, and
the take is rejected.

## Session and take rejection

The whole session fails when:

- The loopback was not done before the musical takes.
- Compensation was applied twice, or the sign convention was not recorded.
- `residual_seconds > 0.005`.
- The body-tap check disagrees with the loopback by more than 0.005 seconds.
- The sample rate changed during the session.
- The click was played on a speaker in the room.

The take fails, and a passing session may keep its other takes, when:

- Click bleed is audible on the guitar channel.
- The trimmed duration is over 60 seconds.
- The trim was applied to only one channel, or was applied before
  compensation.
- The guitar file and the click file have the same hash.
- The tempo map does not match the planned condition, including a missing
  beat-32 step on `tempo_change` or a missing beat-32 texture boundary on
  `quiet_and_percussive`.
- `quiet_and_percussive` contains a tempo reset at bar 9.

Failed sessions are not scored. This template does not pre-fill a failure,
because nothing has been measured.
