"""Minimal ffprobe stand-in (JSON streams/format) built on `ffmpeg -i`, for the fields engine/common.py:probe reads."""
import json, os, re, subprocess, sys
FFMPEG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ffmpeg.exe")
path = sys.argv[-1]
err = subprocess.run([FFMPEG, "-hide_banner", "-i", path], capture_output=True, text=True, errors="ignore").stderr
dur = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
streams = []
for line in err.splitlines():
    m = re.search(r"Stream #\d+:\d+.*?: (Video|Audio): (.*)", line)
    if not m:
        continue
    if m.group(1) == "Video":
        wh = re.search(r", (\d{2,5})x(\d{2,5})", m.group(2))
        fps = re.search(r"([\d.]+) fps", m.group(2))
        if not wh or "attached pic" in line:
            continue
        streams.append({"codec_type": "video", "width": int(wh.group(1)), "height": int(wh.group(2)),
                        "avg_frame_rate": f"{float(fps.group(1)) if fps else 30.0}/1", "side_data_list": []})
    else:
        streams.append({"codec_type": "audio"})
rot = re.search(r"rotation of (-?[\d.]+) degrees", err)
for s in streams:
    if s["codec_type"] == "video" and rot:
        s["side_data_list"].append({"rotation": float(rot.group(1))})
d = (int(dur.group(1)) * 3600 + int(dur.group(2)) * 60 + float(dur.group(3))) if dur else 0
print(json.dumps({"streams": streams, "format": {"duration": str(d)}}))
