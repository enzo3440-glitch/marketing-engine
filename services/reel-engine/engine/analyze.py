"""Shot analysis: score every moment of every clip so the editor can pick the best shots.

Per sample (6 fps, 320px wide):
  sharp   - Laplacian variance (focus / detail)
  bright  - mean luma (exposure)
  sat     - mean saturation (colour pop)
  motion  - mean abs frame diff (subject/camera energy)
  shake   - jerk of the global translation (handheld wobble = bad)
  faces   - frontal faces (talking / people moments)
  cx      - saliency centroid x in 0..1 (where to put a 9:16 crop)
Scene cuts inside a clip split it into shots; windows never straddle a cut.
"""
import subprocess
import numpy as np
import cv2

from .common import FFMPEG, probe

SR = 6.0          # analysis samples per second
AW = 320          # analysis width

_face = None


def _faces(gray):
    global _face
    if _face is None:
        try:  # OpenCV 4.x ships Haar cascades; 5.x moved them out — degrade to "no faces"
            _face = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
            if _face.empty():
                _face = False
        except Exception:
            _face = False
    if _face is False:
        return 0, None
    f = _face.detectMultiScale(gray, 1.15, 5, minSize=(18, 18))
    return len(f), (f[:, 0] + f[:, 2] / 2).mean() / gray.shape[1] if len(f) else None


def _frames(path, w, h):
    ah = int(round(AW * h / w / 2) * 2)
    cmd = [FFMPEG, "-v", "error", "-i", str(path), "-vf", f"fps={SR},scale={AW}:{ah}",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    n = AW * ah * 3
    while True:
        b = p.stdout.read(n)
        if len(b) < n:
            break
        yield np.frombuffer(b, np.uint8).reshape(ah, AW, 3)
    p.wait()


def look_sig(path, t):
    """Tiny Lab picture of one moment (6x4 cells): enough to tell two takes of the same scene apart from new ones."""
    cmd = [FFMPEG, "-v", "error", "-ss", f"{max(t, 0):.2f}", "-i", str(path), "-frames:v", "1",
           "-vf", "scale=4:6:flags=area", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    b = subprocess.run(cmd, stdout=subprocess.PIPE).stdout
    if len(b) < 72:
        return look_sig(path, 0) if t else None
    lab = cv2.cvtColor(np.frombuffer(b[:72], np.uint8).reshape(6, 4, 3), cv2.COLOR_BGR2LAB)
    return [int(v) for v in lab.reshape(-1)]


def contact_sheet(path, n=8, w=270, h=480):
    """n evenly spaced moments of a clip, numbered 1..n with their time, tiled 4 across (one JPEG)."""
    meta = probe(path)
    dur = float(meta.get("duration") or 0)
    times = [round((i + 0.5) * dur / n, 2) for i in range(n)]
    tiles = []
    for t in times:
        cmd = [FFMPEG, "-v", "error", "-ss", f"{t:.2f}", "-i", str(path), "-frames:v", "1", "-vf",
               f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2",
               "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
        b = subprocess.run(cmd, stdout=subprocess.PIPE).stdout
        img = np.frombuffer(b[:w * h * 3], np.uint8).reshape(h, w, 3).copy() if len(b) >= w * h * 3 else np.zeros((h, w, 3), np.uint8)
        label = f"{len(tiles) + 1}  {t:.1f}s"
        cv2.rectangle(img, (0, 0), (118, 34), (0, 0, 0), -1)
        cv2.putText(img, label, (6, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (10, 214, 255), 2, cv2.LINE_AA)
        tiles.append(img)
    rows = [np.hstack(tiles[i:i + 4]) for i in range(0, n, 4)]
    ok, jpg = cv2.imencode(".jpg", np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 82])
    return jpg.tobytes(), times, round(dur, 2)


def sig_dist(a, b):
    return float(np.abs(np.asarray(a, float) - np.asarray(b, float)).mean()) if a and b else 99.0


def _robust01(x):
    x = np.asarray(x, float)
    if len(x) == 0:
        return x
    lo, hi = np.percentile(x, 5), np.percentile(x, 95)
    return np.clip((x - lo) / (hi - lo + 1e-9), 0, 1)


def analyze_clip(path):
    meta = probe(path)
    if not meta.get("has_video"):
        raise ValueError(f"no video stream: {path}")
    rows, prev, prev_shift = [], None, np.zeros(2)
    hists = []
    for i, fr in enumerate(_frames(path, meta["width"], meta["height"])):
        g = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
        hsv = cv2.cvtColor(fr, cv2.COLOR_BGR2HSV)
        sharp = float(cv2.Laplacian(g, cv2.CV_64F).var())
        bright = float(g.mean())
        sat = float(hsv[..., 1].mean())
        motion, shake = 0.0, 0.0
        if prev is not None:
            motion = float(cv2.absdiff(g, prev).mean())
            (dx, dy), _ = cv2.phaseCorrelate(np.float32(prev), np.float32(g))
            shift = np.array([dx, dy])
            shake = float(np.linalg.norm(shift - prev_shift))
            prev_shift = shift
        gx = cv2.Sobel(g, cv2.CV_32F, 1, 0)
        gy = cv2.Sobel(g, cv2.CV_32F, 0, 1)
        mag = cv2.magnitude(gx, gy)
        col = mag.sum(0) + 1e-6
        cx = float((col * np.arange(len(col))).sum() / col.sum() / len(col))
        nf, fcx = _faces(g)
        if fcx is not None:
            cx = 0.35 * cx + 0.65 * fcx
        h = cv2.calcHist([hsv], [0, 1], None, [16, 8], [0, 180, 0, 256])
        hists.append(cv2.normalize(h, h).flatten())
        rows.append(dict(t=i / SR, sharp=sharp, bright=bright, sat=sat, motion=motion,
                         shake=shake, faces=nf, cx=cx))
        prev = g
    if not rows:
        raise ValueError(f"could not decode frames: {path}")

    # scene cuts
    cuts = [0.0]
    for i in range(1, len(hists)):
        d = cv2.compareHist(hists[i - 1], hists[i], cv2.HISTCMP_BHATTACHARYYA)
        if d > 0.45 and rows[i]["t"] - cuts[-1] > 0.6:
            cuts.append(rows[i]["t"])
    cuts.append(meta["duration"])

    sharp = _robust01([np.log1p(r["sharp"]) for r in rows])
    expo = np.array([1 - min(abs(r["bright"] - 125) / 110, 1) for r in rows])
    sat = _robust01([r["sat"] for r in rows])
    mot = np.array([r["motion"] for r in rows])
    # pleasant motion: some movement is good, chaos is not
    mot_n = np.clip(mot / 12.0, 0, 2)
    motion_q = np.where(mot_n < 1, mot_n, 2 - mot_n)
    shake = np.clip(np.array([r["shake"] for r in rows]) / 6.0, 0, 1)
    faces = np.array([min(r["faces"], 2) / 2 for r in rows])
    score = 0.34 * sharp + 0.16 * expo + 0.14 * sat + 0.18 * motion_q - 0.22 * shake + 0.10 * faces
    for r, s in zip(rows, score):
        r["score"] = round(float(s), 4)

    meta.update(samples=rows, shots=[[round(a, 3), round(b, 3)] for a, b in zip(cuts[:-1], cuts[1:])],
                quality=round(float(np.percentile(score, 80)), 4),
                face_ratio=round(float((faces > 0).mean()), 3),
                talking_likely=bool((faces > 0).mean() > 0.5 and meta["has_audio"]))
    return meta


def best_windows(meta, length=2.0, n=6, min_gap=0.3):
    """Greedy pick of the n best non-overlapping windows of `length` seconds inside shots."""
    rows = meta["samples"]
    t = np.array([r["t"] for r in rows])
    s = np.array([r["score"] for r in rows])
    cx = np.array([r["cx"] for r in rows])
    cands = []
    for a, b in meta["shots"]:
        b = min(b, meta["duration"] - 0.05)
        L = min(length, b - a - 0.1)
        if L < 0.5:
            continue
        st = a + 0.05
        while st + L <= b:
            m = (t >= st) & (t < st + L)
            if m.any():
                cands.append(dict(start=round(st, 3), dur=round(L, 3), score=float(s[m].mean()),
                                  cx=float(np.median(cx[m]))))
            st += 0.25
    cands.sort(key=lambda c: -c["score"])
    picked = []
    for c in cands:
        if all(c["start"] + c["dur"] + min_gap <= p["start"] or p["start"] + p["dur"] + min_gap <= c["start"]
               for p in picked):
            picked.append(c)
        if len(picked) >= n:
            break
    return picked


def strip(meta):
    """Compact form for manifests / the artifact (no per-sample rows)."""
    return {k: v for k, v in meta.items() if k != "samples"}
