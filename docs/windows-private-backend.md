# Private Windows backend for local guitar analysis

This procedure is for a private, non-commercial test on a Windows machine the operator controls. It starts the existing Flask process beside the INTEGRATION-04C test installer. It does not change that installer, install Python for all users, or download model weights.

This document was written from the repository and from an isolated Linux environment. It has not been executed on a Windows device. Installing Python packages on Windows is unverified. A successful reading of this page is not a Windows AI run.

## Backend source checkout

The installer does not contain Python or the Flask application. Clone the application repository and check out the exact commit named `sourceSha` in `acceptance-summary.json` from the `ChordMini-Windows-x64-Integration04C` artifact:

```bat
git clone https://github.com/camanh123/ChordMiniApp.git
cd ChordMiniApp
git checkout <sourceSha>
```

That commit is a descendant of `8b3abf94ff4a69ae84b7d06707af2e3fcef8d003`, the INTEGRATION-04B loopback guard. Do not use `main`. `main` does not contain this desktop shell. Do not copy `python_backend` out of the installer, because the installer is built to omit it.

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

Use the installer from artifact `ChordMini-Windows-x64-Integration04C`. Its file name is still `ChordMini-Setup-0.6.5-x64.exe` because the package version is 0.6.5. Compare it with `SHA256SUMS.txt` in that same artifact before installing. The earlier INTEGRATION-03 installer has the same file name and does not contain this loopback guard.

The installer is per-user and lets you change the directory. The default directory is `%LOCALAPPDATA%\Programs\ChordMini`. After `/health` succeeds, start the executable from a command prompt that has only this analysis variable set:

```bat
set PYTHON_API_URL=http://127.0.0.1:5001
"%LOCALAPPDATA%\Programs\ChordMini\ChordMini.exe"
```

If you chose another directory, start `ChordMini.exe` from that directory instead. Do not set `CHORDMINI_INFERENCE_AUTH`. Do not set `CHORDMINI_INFERENCE_SECRET`, `CHORDMINI_HOSTED_GATEWAY_URL`, or `CHORDMINI_HOSTED_STAGING_AUTH`. Do not expose Flask beyond `127.0.0.1`.

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

## When a native package fails to install

If `pip install` exits non-zero, the backend is not installed. Leave that virtual environment unused. Do not repeat the install against the Windows system Python. Do not change the Madmom commit, swap in another wheel, or download a checkpoint to get past the error.

Read the pip log. Then, only if that log says Git or the Microsoft C++ compiler is missing, install Git for Windows and the Visual Studio “Desktop development with C++” workload, delete `.venv-chordmini`, and run the same virtual-environment commands again. If the second attempt fails, stop. Do not start Flask from a partial environment.

Other stops:

- `py -3.10` is missing, or `python` inside the virtual environment is not 3.10.
- `pkg_resources` or setuptools does not match the pin above. The command pins setuptools 79.0.1, which matches the note in `requirements.txt`.
- `PORT` is still set in the shell, Flask selects production, and uploads fail closed with authentication required.
- The five `.sdict` files are absent. Stop. Do not download weights from another machine as part of this test.
- `curl http://127.0.0.1:5001/health` fails or returns a redirect. Do not point the desktop app at a different host to work around it.

## Private trial with a short recording

After `/health` returns `{"status":"healthy"}` and the new installer is running with `PYTHON_API_URL=http://127.0.0.1:5001`, choose a short WAV or MP3 that you are allowed to analyze. Use your own guitar recording. Do not use a GuitarSet locked or reserve file. This guide does not provide a sample and does not name an expected chord or beat sequence.

Select that file in ChordMini and request analysis. A reached local Flask process returns its own chord and beat JSON through the existing page. If the URL is refused or Flask is not listening, the page shows the translated not-configured or unavailable message and leaves the grid empty. Do not type chords in by hand and treat them as a model result.

## Diagnostics that omit secrets

Record only these facts:

- The HTTP status and JSON body of `http://127.0.0.1:5001/health`.
- The analysis message shown in the page, including `ANALYSIS_SERVICE_NOT_CONFIGURED` or `ANALYSIS_SERVICE_UNAVAILABLE` when one is present.
- Whether the Flask window is still on `127.0.0.1:5001` or has exited.

Startup failures are appended to `desktop.log` under the Electron user-data directory for ChordMini, normally `%APPDATA%\ChordMini\desktop.log`. The shell redacts `PYTHON_API_URL`, the inference secret, ready tokens, and the other values named in `src/desktop/diagnostics.ts`. Do not paste those values back in when you share the log. Do not add `CHORDMINI_INFERENCE_SECRET` to the environment in order to obtain a richer error.
