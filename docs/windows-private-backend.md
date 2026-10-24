# Private Windows backend for local guitar analysis

This procedure is for a private, non-commercial test on a Windows machine the operator controls. It starts the existing Flask process beside the already built ChordMini `0.6.5` installer. It does not change that installer, install Python for all users, or download model weights.

This document was written from the repository and from an isolated Linux environment. It has not been executed on a Windows device. A successful reading of this page is not a Windows AI run.

## What stays on the machine

- Use a virtual environment. Do not run `pip install` against the Windows system Python.
- Do not put Madmom weights or the Chord-CNN-LSTM checkpoints into `ChordMini-Setup-0.6.5-x64.exe`.
- Do not publish Flask on `0.0.0.0`, a LAN address, or a public hostname.
- Do not set `CHORDMINI_HOSTED_GATEWAY_URL` or `CHORDMINI_HOSTED_STAGING_AUTH` on the desktop process.
- Do not put `CHORDMINI_INFERENCE_SECRET` in the desktop environment. The Electron shell removes it before the Next.js process starts. `CHORDMINI_INFERENCE_AUTH=required` therefore cannot succeed from the installed app.

## Python 3.10

The pinned backend expects CPython 3.10. The requirements note names 3.10.16. The isolated environment that has already run the unchanged detectors used 3.10.22. Python 3.12 is not a supported interpreter for this stack.

From a checkout of this repository, in `cmd`:

```bat
py -3.10 -m venv .venv-chordmini
.venv-chordmini\Scripts\activate
python -m pip install --upgrade pip "setuptools==79.0.1" wheel
```

`python` after activation must print a 3.10 version. If `py -3.10` is missing, install the 3.10 series for the current user and run the command again. Do not point the virtual environment at the Windows `py` launcher's 3.12 default.

## Dependencies

Install from the activated environment, with the working directory at the repository root:

```bat
python -m pip install torch==2.6.0 torchaudio --index-url https://download.pytorch.org/whl/cpu
python -m pip install -r python_backend\requirements.txt
```

The CPU index keeps the test off a CUDA wheel. GPU is not required. The requirements file also installs Flask 3.0.3, librosa 0.10.1, numpy 1.26.4, TensorFlow 2.15.1, and Madmom from this exact commit:

`https://github.com/CPJKU/madmom.git@27f032e8947204902c675e5e341a3faf5dc86dae`

That install needs Git and, when Madmom builds its extensions, the Microsoft C++ Build Tools. Nothing in this procedure downloads a new checkpoint. If a package index is unreachable, stop. Do not substitute a different Madmom commit or a different Chord-CNN-LSTM weight file.

### Madmom license

Madmom's source files use a BSD-like license. The RNN weight files shipped inside that package, under `madmom/models/`, are Creative Commons Attribution-NonCommercial-ShareAlike 4.0. Read `madmom/models/LICENSE` inside the virtual environment after install. Those weights are not licensed for the Windows installer, for a public inference service, or for commercial hosting. Leave the notice in place.

### Chord-CNN-LSTM checkpoints

The five checkpoints already in the checkout are:

- `python_backend/models/Chord-CNN-LSTM/cache_data/joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s0.best.sdict`
- `python_backend/models/Chord-CNN-LSTM/cache_data/joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s1.best.sdict`
- `python_backend/models/Chord-CNN-LSTM/cache_data/joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s2.best.sdict`
- `python_backend/models/Chord-CNN-LSTM/cache_data/joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s3.best.sdict`
- `python_backend/models/Chord-CNN-LSTM/cache_data/joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s4.best.sdict`

Confirm those files exist before starting Flask. Do not fetch replacements. The model code in this repository is separate from the rights in the recordings that trained it.

## Start Flask on loopback

Leave `PORT` and `FLASK_ENV` unset. `app.py` reads `PORT` and binds `127.0.0.1`. If `PORT` is set, configuration selection treats the process as production and inference authentication becomes required. The installed desktop app cannot present that token.

From `python_backend`, in the same activated environment:

```bat
cd python_backend
set PORT=
set FLASK_ENV=
set CHORDMINI_INFERENCE_AUTH=
set CHORDMINI_INFERENCE_SECRET=
python app.py
```

In PowerShell, clear the same variables with `$env:PORT = $null` and the matching names, then run `python app.py`.

The process logs `Starting Flask app on 127.0.0.1:5001`. Readiness is a direct request, not a redirected one:

```bat
curl http://127.0.0.1:5001/health
```

A ready process returns JSON containing `"status": "healthy"`. `http://localhost:5001` is not the desktop contract. `localhost` can resolve to an address other than the IPv4 loopback socket Flask binds.

## Desktop environment

Launch the existing `ChordMini-Setup-0.6.5-x64.exe` only after that health check succeeds. Set this for the desktop process and leave it as the only analysis URL:

```bat
set PYTHON_API_URL=http://127.0.0.1:5001
```

Do not set `CHORDMINI_INFERENCE_AUTH`. Do not set `CHORDMINI_INFERENCE_SECRET`, `CHORDMINI_HOSTED_GATEWAY_URL`, or `CHORDMINI_HOSTED_STAGING_AUTH`.

The desktop process accepts only `http://127.0.0.1` with an optional port from 1 to 65535. It refuses, before any connection:

- an unset `PYTHON_API_URL`
- `localhost`
- any remote host
- `https`
- a username or password in the URL
- a path, query, or fragment on the base URL
- IPv6, shortened, octal, decimal, or lookalike spellings of loopback

A redirect, including a redirect to another host, is not followed. The analysis response does not include the refused address and does not invent chords or beats.

## Stop

Press Ctrl+C in the Flask window. Closing ChordMini does not stop Flask. Deactivate the virtual environment with `deactivate`. Removing `.venv-chordmini` removes the test install without changing the system Python.

## Failures that stop the setup

- `py -3.10` is missing, or `python` inside the virtual environment is not 3.10.
- Git is missing, so the pinned Madmom URL cannot be cloned.
- Microsoft C++ Build Tools are missing and Madmom's extension build fails.
- `pkg_resources` or setuptools is too new or too old for that Madmom commit. The command above pins setuptools 79.0.1, which matches the commit note in `requirements.txt`.
- `PORT` is still set in the shell, Flask selects production, and uploads fail closed with authentication required.
- The five `.sdict` files are absent. Stop. Do not download weights from another machine as part of this test.
- `curl http://127.0.0.1:5001/health` fails or returns a redirect. Do not point the desktop app at a different host to work around it.
