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

The server reads each upload within its limit as it arrives (4 MiB of dictation audio, one speak request's text) and reads the endpoint's JSON replies within 1 MiB. It relays a spoken reply only when the endpoint labels it `audio/*`, at most 32 MiB, with `X-Content-Type-Options: nosniff`. A request the browser abandons is cancelled at the endpoint too.

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

- It answers only local programs such as the LearnHarness server: a request with an `Origin` header or `Sec-Fetch-Site: cross-site` (a web page) gets 403, as does any `Host` other than `127.0.0.1:<port>` or `localhost:<port>`.
- `/v1/audio/speech` takes only `application/json`; `/v1/audio/transcriptions` takes only `multipart/form-data` (otherwise 415).
- A request body is read before the job queue is joined, and a client that stops sending for 30 s is dropped. The voice list does not wait for a running job.
- An unexpected failure answers "The speech engine failed; see the bridge log" and writes the detail to the bridge's own stderr.
- A request without a language uses the one the bridge was started with (`TWM_SPEECH_LANGUAGE`), never the previous request's. `/health` reports only `{"status": "ok"}`.

Verification: `tests/speech.test.ts`, `tests/speech-bounds.test.ts`, `tests/speech-bridge.test.ts` (against a stub TWM checkout; skipped without `python3`) and `tests/speech-settings-access.test.ts`.
