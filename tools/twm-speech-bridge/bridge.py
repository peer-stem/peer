#!/usr/bin/env python3
"""OpenAI-compatible speech endpoint over TWM's own voice functions.

LearnHarness speaks the common `/v1/audio/*` routes. TWM already integrates
local Whisper, Piper and the isolated Kokoro/Chatterbox/VoxCPM2 engines; this
exposes exactly those through that interface and reimplements none of them.
Loopback only: requests from a web page (any `Origin`, or a cross-site fetch)
and requests for any other host name are refused. Nothing loads until a request
asks for it, and one model job runs at a time.
"""
import argparse
import io
import json
import os
import sys
import tempfile
import threading
import traceback
import wave
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TEXT_LIMIT = 4096
BODY_LIMIT = 32 * 1024 * 1024
RATE = 16000
# TWM's recogniser accepts at most 15 s per call; longer audio is split here.
WINDOW_FRAMES = 14 * RATE
WHISPER_MODELS = ("tiny", "base", "small", "medium", "large")
# A client that stops sending is dropped instead of holding a thread forever.
SOCKET_TIMEOUT = 30
JOB = threading.Lock()
INPUT_ERRORS = (ValueError, KeyError, wave.Error, EOFError)
JSON = "application/json"
# The language the bridge was started with; a request without one gets this back.
LAUNCH_LANGUAGE = os.environ.get("TWM_SPEECH_LANGUAGE")


def whisper_cache():
    return Path(os.environ.get("TWM_WHISPER_CACHE", Path.home() / ".cache/whisper"))


def installed_whisper():
    return [name for name in WHISPER_MODELS if (whisper_cache() / (name + ".pt")).is_file()]


def voice_rows():
    from shell.inputs import voices
    rows = voices.catalog()["voices"]
    return [{"id": row["provider"] + "/" + row["voice"], "name": row["name"], "provider": row["provider"]}
            for row in rows if row.get("available")]


def choice_for(voice_id):
    from shell.inputs import voice_choices
    if not voice_id:
        rows = voice_rows()
        if not rows:
            raise ValueError("No local voice is available")
        voice_id = rows[0]["id"]
    provider, _, voice = voice_id.partition("/")
    return voice_choices.validate({"provider": provider, "voice": voice})


def synthesize(text, voice_id):
    from shell.inputs import isolated_runtime, voice
    if not isinstance(text, str) or not text.strip() or len(text.encode()) > TEXT_LIMIT or "\0" in text:
        raise ValueError("Speech text must be 1-4096 UTF-8 bytes")
    choice = choice_for(voice_id)
    with tempfile.TemporaryDirectory(prefix="twm-bridge-") as directory:
        destination = Path(directory) / "reply.wav"
        if choice["provider"] == "isolated":
            isolated_runtime.synthesize(choice["voice"], text, destination, lambda packet: None)
        else:
            voice.generate(text, choice, destination, lambda packet: None, None)
        return destination.read_bytes()


def select_whisper(model):
    from shell.inputs import local_speech
    name = model if model in installed_whisper() else os.environ.get("TWM_WHISPER_MODEL", "tiny")
    if name != os.environ.get("TWM_WHISPER_MODEL") or local_speech._model is None:
        os.environ["TWM_WHISPER_MODEL"] = name
        local_speech._model = None


def windows(audio):
    with wave.open(io.BytesIO(audio)) as recording:
        if recording.getnchannels() != 1 or recording.getsampwidth() != 2 or recording.getframerate() != RATE:
            raise ValueError("Expected 16 kHz mono PCM16 WAV audio")
        while True:
            frames = recording.readframes(WINDOW_FRAMES)
            if not frames:
                return
            yield frames


def apply_language(language):
    """Each transcription sets its own language; one request's never sticks to the next."""
    if isinstance(language, str) and language.isalpha() and len(language) in (2, 3):
        os.environ["TWM_SPEECH_LANGUAGE"] = language.lower()
    elif LAUNCH_LANGUAGE is None:
        os.environ.pop("TWM_SPEECH_LANGUAGE", None)
    else:
        os.environ["TWM_SPEECH_LANGUAGE"] = LAUNCH_LANGUAGE


def transcribe(audio, model, language):
    from shell.inputs import voice
    select_whisper(model)
    apply_language(language)
    parts = []
    with tempfile.TemporaryDirectory(prefix="twm-bridge-") as directory:
        source = Path(directory) / "speech.wav"
        for frames in windows(audio):
            with wave.open(str(source), "wb") as chunk:
                chunk.setnchannels(1)
                chunk.setsampwidth(2)
                chunk.setframerate(RATE)
                chunk.writeframes(frames)
            parts.append(voice.transcribe(source))
    return " ".join(part for part in parts if part)


def multipart_fields(content_type, body):
    message = BytesParser(policy=email_policy).parsebytes(
        b"Content-Type: " + content_type.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
    fields = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name:
            fields[name] = part.get_payload(decode=True)
    return fields


def speech_job(content_type, body):
    request = json.loads(body)
    text, voice_id = request.get("input"), request.get("voice")
    with JOB:
        audio = synthesize(text, voice_id)
    return 200, audio, "audio/wav"


def transcription_job(content_type, body):
    fields = multipart_fields(content_type, body)
    audio, model, language = fields["file"], (fields.get("model") or b"").decode(), (fields.get("language") or b"").decode()
    with JOB:
        text = transcribe(audio, model, language)
    return 200, {"text": text}, JSON


def voices_job():
    return 200, {"voices": voice_rows()}, JSON


def models_job():
    return 200, {"object": "list", "data": [{"id": name, "object": "model"} for name in installed_whisper()]}, JSON


# The voice list takes no lock: it must not wait behind a long synthesis.
GET_ROUTES = {
    "/health": lambda: (200, {"status": "ok"}, JSON),
    "/v1/audio/voices": voices_job,
    "/v1/models": models_job,
}
# Path -> (the only accepted media type, the job). The body is read and parsed
# before a job takes the lock.
POST_ROUTES = {
    "/v1/audio/speech": (JSON, speech_job),
    "/v1/audio/transcriptions": ("multipart/form-data", transcription_job),
}


def log(text):
    sys.stderr.write("[speech-bridge] " + text + "\n")


def error(message):
    return {"error": {"message": message}}


def refusal(headers, port, media_type=None):
    """(status, message) when a request may not proceed, else None. A browser's
    cross-site request carries Origin or Sec-Fetch-Site: cross-site; a rebinding
    DNS name fails the Host check."""
    host = (headers.get("Host") or "").lower()
    browser = "Origin" in headers or headers.get("Sec-Fetch-Site") == "cross-site"
    if browser or host not in ("127.0.0.1:%d" % port, "localhost:%d" % port):
        return 403, "Only local, non-browser clients may use this bridge"
    if media_type and headers.get_content_type() != media_type:
        return 415, "Expected " + media_type
    return None


def outcome(work):
    """work's (status, body, content type). Bad input is 400; any other failure
    is logged here and answered without its detail."""
    try:
        return work()
    except INPUT_ERRORS as failure:
        return 400, error(str(failure)[:300]), JSON
    except Exception:  # A model failure must reach the caller as an answer, not a hang.
        log("request failed\n" + traceback.format_exc())
        return 500, error("The speech engine failed; see the bridge log"), JSON


class Handler(BaseHTTPRequestHandler):
    server_version = "twm-speech-bridge/1"
    timeout = SOCKET_TIMEOUT

    def log_message(self, pattern, *args):
        log(pattern % args)

    def reply(self, status, body, content_type=JSON):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def refused(self, media_type=None):
        """Answers and returns True when the request may not proceed."""
        denied = refusal(self.headers, self.server.server_address[1], media_type)
        if denied:
            self.reply(denied[0], error(denied[1]))
        return denied is not None

    def body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > BODY_LIMIT:
            raise ValueError("Request body is missing or too large")
        return self.rfile.read(length)

    def do_GET(self):
        if self.refused():
            return
        job = GET_ROUTES.get(self.path)
        if job is None:
            return self.reply(404, error("Not found"))
        self.reply(*outcome(job))

    def do_POST(self):
        route = POST_ROUTES.get(self.path)
        if self.refused(route[0] if route else None):
            return
        if route is None:
            return self.reply(404, error("Not found"))
        try:
            body = self.body()  # A stalled sender times out here, holding no lock.
        except ValueError as failure:
            return self.reply(400, error(str(failure)))
        self.reply(*outcome(lambda: route[1](self.headers.get("Content-Type", ""), body)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--twm", type=Path, default=Path(os.environ.get("TWM_ROOT", Path.home() / "twm")))
    parser.add_argument("--port", type=int, default=3901)
    args = parser.parse_args()
    root = args.twm.resolve()
    if not (root / "shell/inputs/voice.py").is_file():
        sys.exit("TWM was not found at %s; pass --twm" % root)
    os.chdir(root)
    sys.path.insert(0, str(root))
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
