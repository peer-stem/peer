# Local dictation and spoken replies

Dictation uses hosted Deepgram by default. **Settings → Providers → Dictation** also offers a **local speech endpoint**: any server with the common OpenAI-style audio routes. The same endpoint can read the teacher's replies aloud. LearnHarness installs and starts no speech backend.

| Setting | Meaning |
| --- | --- |
| Dictation engine | `Deepgram (hosted)` or `Local speech endpoint` |
| Speech endpoint | Base URL including any version prefix, e.g. `http://127.0.0.1:3901/v1` |
| Dictation model | Sent as `model` to `/audio/transcriptions` |
| Read aloud | `Off`, a play button on each reply, or every reply read automatically |
| Voice | From the endpoint's `/audio/voices`; empty uses its default |

These are stored in `settings.json` under `speech`. Requests go through the LearnHarness server (`/api/stt/transcribe`, `/api/tts/speak`, `/api/tts/voices`), so the endpoint needs no CORS configuration and private addresses work.

## How it behaves

- **Dictation** records 16 kHz mono audio, cuts it at pauses (at most 14 s per piece) and transcribes each piece while recording continues. The text reaches the input when you stop, as with Deepgram. Silence is not sent. If one piece fails, the others are kept and the failure is shown.
- **Reading aloud** strips code, markup and link targets, splits the reply into sentence-sized requests and fetches the next piece while one plays. Starting dictation stops playback.
- A voice that is not loaded yet can take minutes to answer the first time; the wait is shown as "Preparing voice…".

## Serving models you already have

`tools/twm-speech-bridge/bridge.py` exposes an existing TWM checkout's own speech functions (local Whisper, Piper, and its isolated Kokoro, Chatterbox and VoxCPM2 engines) through this interface, without reimplementing them:

```sh
python3 tools/twm-speech-bridge/bridge.py --twm ~/twm --port 3901
```

It listens on loopback only, loads nothing until asked, and runs one model job at a time. Use `tiny`, `base` or `small` as the dictation model, according to the Whisper checkpoints installed.

Verification: `tests/speech.test.ts`.
