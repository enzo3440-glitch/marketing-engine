"""
Local narration with a Piper voice model (bring your own).

Runs locally, CPU only, no server and no API key. Set NARRATION_VOICE to the path of a Piper .onnx voice model
(its .onnx.json config must sit beside it). An optional pronunciations.json in the same folder maps words to IPA.
No voice model ships with this repo. Text handling: pronunciation dictionary, long sentences split at commas,
pauses between clauses (0.15 s), sentences (0.56 s) and paragraphs (0.92 s), peak-limited. Defaults: speed 0.69, noise_w 0.4.

  # a whole script (blank lines = paragraphs, like knowledge/story-docs/*.txt)
  python -m engine.narrate --script knowledge/story-docs/my-story.txt --out narration.wav

  # a new hook on an existing recording: the new first paragraph in the model voice, then the recording from where
  # its second paragraph starts (the paragraph starts a story-doc render wrote to <render>.timing.json)
  python -m engine.narrate --hook "Your new opening line." --audio narration.wav       --timing renders/my-story-....timing.json --out narration-hook.wav
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent.parent
VOICE_PATH = os.environ.get("NARRATION_VOICE", "").strip()  # path to a Piper .onnx voice model
SPEED, NOISE_W = 0.69, 0.4
CHUNK_MAX = 110
ABBR = re.compile(r"\b(?:[ap]\.m\.|(?:[A-Za-z]\.){2,}|(?:Mr|Mrs|Ms|Dr|St|Mt|Ft|Jr|Sr|vs|etc|approx|Ave|Blvd|Rd|No)\.)", re.I)
GAP_CLAUSE, GAP_SENTENCE, GAP_PARA = 0.15, 0.56, 0.922
PEAK = 0.89

_voice = None
_pron = None


def voice():
    global _voice
    if _voice is None:
        from piper import PiperVoice
        model = Path(VOICE_PATH) if VOICE_PATH else None
        if not model or not model.is_file():
            raise SystemExit("Set NARRATION_VOICE to the path of a Piper .onnx voice model "
                             "(none ships with this repo; see https://github.com/OHF-Voice/piper1-gpl).")
        _voice = PiperVoice.load(str(model))
    return _voice


def pron():
    global _pron
    if _pron is None:
        f = (Path(VOICE_PATH).parent if VOICE_PATH else HERE) / "pronunciations.json"
        d = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
        _pron = [(re.compile(rf"(?<![\wʻ']){re.escape(k)}(?P<pos>'s)?(?![\w])(?P<p>[,.;:!?]?)", re.I), v)
                 for k, v in sorted(d.items(), key=lambda kv: -len(kv[0]))]
    return _pron


def clean(t: str) -> str:
    t = t.replace("‘", "'").replace("’", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", t).strip()


def apply_pron(piece: str) -> str:
    for rx, v in pron():
        def f(m, v=v):
            pos, punct = m.group("pos") or "", m.group("p") or ""
            if v.startswith("/") and v.endswith("/") and len(v) > 2:
                ipa = v[1:-1] + ("z" if pos else "")
                return f"[[ {ipa} {punct} ]]" if punct else f"[[ {ipa} ]]"
            return v + pos + punct
        piece = rx.sub(f, piece)
    piece = re.sub(r"(?<=\w)-(?=\w)", " ", piece)
    return piece.replace("ʻ", "").replace("`", "")


def split_para(text: str):
    out = []
    t = ABBR.sub(lambda m: m.group(0).replace(".", "\x00"), clean(text))
    for s in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])", t):
        s = s.replace("\x00", ".").strip()
        while len(s) > CHUNK_MAX:
            cuts = [m.end() for m in re.finditer(r"[,:;—]\s+|\s+-\s+", s) if 25 < m.end() < len(s) - 15]
            if not cuts:
                cuts = [m.start() for m in re.finditer(r"\s+(?:and|but|while|because|which|so)\s+", s) if 40 < m.start() < len(s) - 20]
            if not cuts:
                break
            c = min(cuts, key=lambda x: abs(x - len(s) / 2))
            out.append((s[:c].strip(" ,;:—-"), GAP_CLAUSE))
            s = s[c:].strip()
        if s:
            out.append((s, GAP_SENTENCE))
    return out


def split_text(text: str):
    paras = [p for p in re.split(r"\n\s*\n", text) if p.strip()]
    out = []
    for i, p in enumerate(paras):
        pieces = split_para(p)
        if pieces and i < len(paras) - 1:
            pieces[-1] = (pieces[-1][0], GAP_PARA)
        out.extend(pieces)
    return out


def render_piece(piece: str, speed: float, noise_w: float) -> np.ndarray:
    from piper import SynthesisConfig
    cfg = SynthesisConfig(length_scale=1.0 / max(speed, 0.3), noise_w_scale=noise_w, normalize_audio=False)
    parts = [c.audio_float_array for c in voice().synthesize(apply_pron(piece), syn_config=cfg)]
    a = np.concatenate(parts) if parts else np.zeros(0, np.float32)
    pk = float(np.abs(a).max()) if a.size else 0.0
    if pk > 0 and (pk > PEAK or pk < 0.3):
        a = a * (PEAK / pk)
    return a.astype(np.float32)


def synth(text: str, speed: float = SPEED, noise_w: float = NOISE_W, tail: float = 0.0) -> tuple[np.ndarray, int]:
    sr = voice().config.sample_rate
    chunks = []
    pieces = split_text(text)
    for i, (p, gap) in enumerate(pieces):
        chunks.append(render_piece(p, speed, noise_w))
        g = gap if i < len(pieces) - 1 else tail
        chunks.append(np.zeros(int(sr * g), np.float32))
    return (np.concatenate(chunks) if chunks else np.zeros(0, np.float32)), sr


def write_wav(path: Path, a: np.ndarray, sr: int):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(a, -1, 1) * 32767).astype("<i2").tobytes())


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)


def with_new_hook(hook: str, audio: Path, keep_from: float, out: Path, speed: float, noise_w: float):
    """New first paragraph in the model voice, then the recording from keep_from seconds; both brought to the same
    loudness and format so the join doesn't jump."""
    a, sr = synth(hook, speed, noise_w, tail=GAP_PARA)
    with tempfile.TemporaryDirectory() as td:
        h = Path(td) / "hook.wav"
        write_wav(h, a, sr)
        norm = "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=mono"
        ffmpeg("-i", str(h), "-i", str(audio), "-filter_complex",
               f"[0:a]{norm}[a0];[1:a]atrim=start={keep_from:.3f},asetpts=PTS-STARTPTS,afade=t=in:d=0.04,{norm}[a1];"
               f"[a0][a1]concat=n=2:v=0:a=1[o]", "-map", "[o]", "-c:a", "pcm_s16le", str(out))


def main():
    ap = argparse.ArgumentParser(description="Narrate with a local Piper voice model")
    ap.add_argument("--script", help="text file; blank lines = paragraphs")
    ap.add_argument("--text", help="text to read")
    ap.add_argument("--hook", help="new first paragraph to put on an existing recording")
    ap.add_argument("--audio", help="the existing recording (with --hook)")
    ap.add_argument("--timing", help="a story-doc render's .timing.json: the recording is kept from paragraph 2's start")
    ap.add_argument("--keep-from", type=float, help="or: keep the recording from this many seconds")
    ap.add_argument("--speed", type=float, default=SPEED)
    ap.add_argument("--noise-w", type=float, default=NOISE_W)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    out = Path(a.out)
    if a.hook:
        if not a.audio:
            raise SystemExit("--hook needs --audio (the recording it goes on)")
        k = a.keep_from
        if k is None:
            if not a.timing:
                raise SystemExit("--hook needs --timing or --keep-from (where the second paragraph starts)")
            k = float(json.loads(Path(a.timing).read_text(encoding="utf-8"))["starts"][1])
        with_new_hook(a.hook, Path(a.audio), k, out, a.speed, a.noise_w)
    else:
        text = Path(a.script).read_text(encoding="utf-8") if a.script else a.text
        if not text:
            raise SystemExit("give --script or --text")
        # story-doc scripts end with the CTA paragraph; it's read like any other
        audio, sr = synth(text.replace("\r", ""), a.speed, a.noise_w, tail=0.4)
        write_wav(out, audio, sr)
    print(out)


if __name__ == "__main__":
    main()
