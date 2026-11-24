"""The asset library a request can build from (reel-data/input/library/library.json):
  footage  real clips from the iPhone folder, with what's in them and where they were shot
  phone    ready-made shots of our phone springing up over a real shot, showing a real app screen
  screen   app screen recordings, to put in our phone over any clip (phone.ride)
Paths are absolute or relative to the library folder.
"""
import base64
from pathlib import Path

import cv2
import numpy as np

from .common import jload

KNOWLEDGE = Path(__file__).resolve().parent.parent / "knowledge"


def knowledge():
    """What we've learned about making our brand's content (knowledge/*.md), for whoever writes the next piece."""
    return [dict(name=p.name, text=p.read_text(encoding="utf-8")) for p in sorted(KNOWLEDGE.glob("*.md"))]


def folder(root):
    return Path(root) / "input" / "library"


def items(root):
    p = folder(root) / "library.json"
    if not p.exists():
        return []
    out = []
    for it in jload(p)["items"]:
        path = Path(it["path"])
        out.append({**it, "path": str(path if path.is_absolute() else folder(root) / path)})
    return out


def resolve(root, cid):
    """A library id -> its file, or None."""
    return next((it["path"] for it in items(root) if it["id"] == cid), None)


def sheet(root, w=180, h=320, per_row=8):
    """One labelled frame of every library item (cached as library/sheet.jpg), base64."""
    its = items(root)
    out = folder(root) / "sheet.jpg"
    newest = max([Path(it["path"]).stat().st_mtime for it in its if Path(it["path"]).exists()] + [(folder(root) / "library.json").stat().st_mtime])
    if not out.exists() or out.stat().st_mtime < newest:
        tiles = []
        for it in its:
            cap = cv2.VideoCapture(it["path"])
            n = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 1
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(n * (0.35 if it["kind"] != "footage" else 0.5)))
            ok, fr = cap.read()
            cap.release()
            tile = np.zeros((h + 26, w, 3), np.uint8)
            if ok:
                fh, fw = fr.shape[:2]
                s = max(w / fw, h / fh)
                fr = cv2.resize(fr, (int(fw * s) + 1, int(fh * s) + 1))
                y, x = (fr.shape[0] - h) // 2, (fr.shape[1] - w) // 2
                tile[:h] = fr[y:y + h, x:x + w]
            cv2.putText(tile, it["id"][:22], (4, h + 19), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (255, 255, 255), 1, cv2.LINE_AA)
            tiles.append(tile)
        rows = [tiles[i:i + per_row] for i in range(0, len(tiles), per_row)]
        rows[-1] += [np.zeros_like(tiles[0])] * (per_row - len(rows[-1]))
        cv2.imwrite(str(out), np.vstack([np.hstack(r) for r in rows]), [cv2.IMWRITE_JPEG_QUALITY, 80])
    return base64.b64encode(out.read_bytes()).decode()
