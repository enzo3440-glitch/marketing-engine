# Reel Engine worker (engine/server.py). Build from this folder:
#   docker build -t reel-engine services/reel-engine
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PYTHONPATH=/app PORT=8787
# Mount a Railway volume at /data so input/ and output/ survive restarts. REEL_TOKEN enables bearer auth.
CMD ["sh", "-c", "python -m engine.server --root /data/reels --host 0.0.0.0 --port ${PORT}"]
