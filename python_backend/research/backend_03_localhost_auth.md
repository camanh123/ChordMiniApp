# BACKEND-03 localhost inference authentication

This is a local research control for the two Flask routes that run beat and
chord inference. It is not a production authentication architecture, and it
is not approval to distribute a shared secret with a client.

## Protected routes

- `POST /api/detect-beats`
- `POST /api/recognize-chords`

Both routes accept one multipart upload field, `file`. They do not accept
`audio_path`, `audioUrl`, or a Firebase URL. `force=true` still selects a
detector, but it cannot raise the upload cap.

## Mode

`CHORDMINI_INFERENCE_AUTH`:

| Value | Non-production config | Production config |
| --- | --- | --- |
| unset | Local compatibility | Required |
| `local` | Local compatibility | Required (override ignored) |
| `required` | Required | Required |
| anything else | Required | Required |

Production config means `create_app("production")`, or the auto-selected
production config when `FLASK_ENV=production` or `PORT` is set.

Required mode fails closed with HTTP 503 `AUTH_NOT_CONFIGURED` when
`CHORDMINI_INFERENCE_SECRET` is missing, shorter than 32 characters, a known
placeholder, or equal to `SECRET_KEY`. No model code runs.

## Request credential

Header only:

```
X-ChordMini-Inference-Token: <server-side secret>
```

The comparison hashes both values and uses `hmac.compare_digest`. The secret
is not read from the query string, a JSON body, or the `Authorization`
header. A credential-like query parameter is rejected with HTTP 400 and is
not copied into the error body or an application log line.

Missing header: HTTP 401 `AUTH_REQUIRED`. Wrong header: HTTP 401
`AUTH_FAILED`. Both happen before a temporary file is written and before a
detector is called.

## Local compatibility

Local compatibility keeps health, documentation, and model-info routes
working without the header so an existing local Flask process is not
silently broken. The two inference routes still reject server paths, enforce
the upload cap, validate audio bytes, and delete temporary files.

This mode is only for a machine the developer controls. It must not be
exposed on a public interface. Setting `CHORDMINI_INFERENCE_AUTH=local` does
not reopen those exceptions once the process is in production config.

## Future Next.js to Flask boundary

A later private deployment would authenticate server to server:

1. The Next.js route handler, running on the server, reads
   `CHORDMINI_INFERENCE_SECRET` from its own environment.
2. It forwards the multipart upload to Flask over a private address.
3. It sets `X-ChordMini-Inference-Token` on that request only.

The secret must not be read from `NEXT_PUBLIC_*`, sent to the browser,
written into the Electron renderer, copied by `buildChildEnv`, or packaged
in the Windows installer or an iPad build. Putting the secret in the Windows
machine environment is not secure distribution: the desktop server inherits
the parent environment.

This phase does not change those Next.js routes. They keep forwarding
`FormData` without the header. Local compatibility therefore preserves the
current desktop and web proxy. Protected mode rejects that proxy until a
later acceptance gate adds the server-side header. Windows-to-remote
authentication is a separate gate.

## Upload rules

- Cap: `CHORDMINI_INFERENCE_MAX_UPLOAD_BYTES`, otherwise
  `CHORDMINI_INFERENCE_MAX_UPLOAD_MB`, otherwise
  `DIRECT_UPLOAD_SIZE_LIMIT_MB` (50, or 5 under the testing config), and
  never above Flask `MAX_CONTENT_LENGTH`.
- A declared `Content-Length` above the cap plus 16 KiB of multipart overhead
  is rejected before the body is saved.
- The saved byte count is capped again while streaming to disk.
- Format is decided from the bytes (WAV via the `wave` module, plus MP3,
  FLAC, Ogg, AIFF, and MP4/`ftyp`). The filename is ignored.
- Uploads are written under a `chordmini_upload_` temporary directory,
  renamed to a sniffed suffix such as `.wav`, and removed on success,
  rejection, and model exceptions.
- Failure responses use a fixed message. They do not include the temporary
  path, a traceback, or the secret. A successful service dictionary is
  returned unchanged, except that a top-level `traceback` is dropped and a
  leaked path inside `error` is replaced.

## Hazardous routes left for local mode

These stay mounted so local development is unchanged, and they return HTTP
403 `ENDPOINT_DISABLED` whenever inference auth is required:

- `/api/detect-beats-firebase` fetches an arbitrary URL and runs beat inference.
- `/api/recognize-chords-firebase` treats a URL as safe when it merely
  contains `firebasestorage.googleapis.com` or `storage.googleapis.com`.
- `/api/songformer/segment` downloads caller-supplied audio and can PATCH a
  caller-supplied callback.
- `/api/genius-lyrics` and `/api/lrclib-lyrics` call external lyric services
  without this research credential.
- `/api/test-*`, `/api/debug-*`, and `/debug/files` can return tracebacks or
  filesystem details. `/api/debug-environment` redacts env names containing
  SECRET, TOKEN, PASSWORD, CREDENTIAL, PRIVATE_KEY, and API_KEY, and the
  route is disabled in required mode.

The YouTube blueprint is not registered by the application factory. Docker
Compose still publishes `8080:8080`, and the image still runs gunicorn on
`0.0.0.0:8080`. `python app.py` binds `127.0.0.1` only. Publishing the
container port, or running gunicorn on all interfaces, remains a deployment
blocker. This phase does not start that process and does not approve
production authentication.

## Tests

Security tests use Flask's in-process client. They do not bind a socket.
The real Madmom and Chord-CNN-LSTM regression replays the BACKEND-02 fixture
through an authorized test client when Flask is installed in the isolated
environment, and it does not overwrite the accepted evidence file.
