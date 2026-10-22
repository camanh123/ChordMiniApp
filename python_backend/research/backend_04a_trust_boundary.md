# BACKEND-04A trust boundary

This note records the localhost Next.js to Flask contract proved in this
phase. It does not approve a production deployment or a shared desktop secret.

## What this phase proves

When `CHORDMINI_INFERENCE_AUTH=required` (or any unknown mode) on a Next.js
server that is not the Electron desktop process, the route handlers for
`POST /api/detect-beats` and `POST /api/recognize-chords` read
`CHORDMINI_INFERENCE_SECRET` from the server environment and send it only as
the `X-ChordMini-Inference-Token` header on the upstream Flask request.

`local` and an unset mode keep the previous proxy: no inference header is
attached, even if a secret happens to be present. That preserves the current
same-origin browser API and the desktop missing-service errors.

The browser cannot supply the credential. Incoming
`X-ChordMini-Inference-Token` headers are ignored. Form fields that look like
credentials, server paths, or remote audio URLs are removed before the upload
is forwarded. The secret is not placed in the Flask URL.

A missing, short, placeholder, or `SECRET_KEY`-equal secret fails closed with
HTTP 503 and `INFERENCE_AUTH_NOT_CONFIGURED` before Flask is called. Flask
401 responses and Flask 503 authentication codes are replaced with fixed JSON.
Upstream bodies are not copied into the Next.js response or into route logs.

## Desktop is not a trusted secret store

An Electron-installed Next.js process runs on a machine the end user controls.
Environment variables there are not production secrets.

`buildChildEnv` drops `CHORDMINI_INFERENCE_SECRET` and
`NEXT_PUBLIC_CHORDMINI_INFERENCE_SECRET` before the desktop server starts.
If the desktop process is nevertheless started with protected mode, the route
returns HTTP 503 `INFERENCE_AUTH_NOT_AVAILABLE` and does not call Flask.
The existing availability gate still runs first, so a missing local service
keeps `ANALYSIS_SERVICE_NOT_CONFIGURED` or `ANALYSIS_SERVICE_UNAVAILABLE`.

No Windows installer, Electron renderer, or `NEXT_PUBLIC_*` value carries the
inference secret. This phase uses an ephemeral secret only inside the isolated
test process.

## Future production design (not implemented)

Do not reuse this shared header as production authentication.

- A hosted Next.js server is the only future trusted caller. It would hold a
  server-side credential outside the desktop package and call Flask on a
  private network.
- The Windows desktop app is an untrusted public client. It may call the
  hosted Next.js origin. It must not hold the Flask credential.
- A future iPad client is the same kind of untrusted public client.
- Production access needs per-user or per-session authentication, authorization,
  and rate limits on the hosted server.
- Flask stays private. The public clients do not receive its address or its
  inference token.

None of that identity, authorization, or private-network control is built here.

`PRODUCTION_AUTH_APPROVED` remains no. `SERVER_DEPLOYED` remains no.

## Frozen error contract

Beat failures from Flask stay HTTP 500. The Next.js beat route treats
`response.ok === false` as failure and returns its existing generic error. It
does not pass the Flask JSON through, so fields such as `model_used` on a
failed beat response are not visible to the browser.

Chord failures from Flask stay HTTP 200 with `success: false`. The Next.js
chord route returns that JSON unchanged when the HTTP status is 200. The
browser chord client already checks both the HTTP status and `success`.

A later compatible change could pass a sanitized beat error JSON through while
keeping HTTP 500. This phase does not make that change.

## Chord confidence

`confidence: 1.0` on Chord-CNN-LSTM rows is written by the lab parser in
`python_backend/services/detectors/chord_cnn_lstm_detector.py`. The detector
does not measure confidence. Callers must not treat `1.0` as a model score.

## Still outside this phase

`recognize-chords-btc-sl`, `recognize-chords-btc-pl`, and the Firebase offload
routes do not attach the inference header. Protected Flask rejects those
calls. They are not part of this localhost contract.
