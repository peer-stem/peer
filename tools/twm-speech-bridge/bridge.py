#!/usr/bin/env python3
"""OpenAI-compatible speech endpoint over TWM's own voice functions.

LearnHarness speaks the common `/v1/audio/*` routes. TWM already integrates
local Whisper, Piper and the isolated Kokoro/Chatterbox/VoxCPM2 engines; this
exposes exactly those through that interface and reimplements none of them.
Loopback only. Nothing loads until a request asks for it, and one model job
runs at a time.
"""
import argparse
import io
import json
import os
import sys
import tempfile
import threading
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
JOB = threading.Lock()


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


def transcribe(audio, model, language):
    from shell.inputs import voice
    select_whisper(model)
    if isinstance(language, str) and language.isalpha() and len(language) in (2, 3):
        os.environ["TWM_SPEECH_LANGUAGE"] = language.lower()
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


class Handler(BaseHTTPRequestHandler):
    server_version = "twm-speech-bridge/1"

    def log_message(self, pattern, *args):
        sys.stderr.write("[speech-bridge] " + pattern % args + "\n")

    def reply(self, status, body, content_type="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > BODY_LIMIT:
            raise ValueError("Request body is missing or too large")
        return self.rfile.read(length)

    def guarded(self, work):
        try:
            with JOB:
                work()
        except (ValueError, KeyError, wave.Error, EOFError) as failure:
            self.reply(400, {"error": {"message": str(failure)[:300]}})
        except Exception as failure:  # A model failure must reach the caller as text, not a hang.
            self.reply(500, {"error": {"message": type(failure).__name__ + ": " + str(failure)[:300]}})

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"status": "ok", "device": "cpu"})
        elif self.path == "/v1/audio/voices":
            self.guarded(lambda: self.reply(200, {"voices": voice_rows()}))
        elif self.path == "/v1/models":
            self.reply(200, {"object": "list", "data": [{"id": name, "object": "model"} for name in installed_whisper()]})
        else:
            self.reply(404, {"error": {"message": "Not found"}})

    def do_POST(self):
        if self.path == "/v1/audio/speech":
            self.guarded(self.speech)
        elif self.path == "/v1/audio/transcriptions":
            self.guarded(self.transcription)
        else:
            self.reply(404, {"error": {"message": "Not found"}})

    def speech(self):
        request = json.loads(self.body())
        self.reply(200, synthesize(request.get("input"), request.get("voice")), "audio/wav")

    def transcription(self):
        fields = multipart_fields(self.headers.get("Content-Type", ""), self.body())
        text = transcribe(fields["file"], (fields.get("model") or b"").decode(), (fields.get("language") or b"").decode())
        self.reply(200, {"text": text})


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
