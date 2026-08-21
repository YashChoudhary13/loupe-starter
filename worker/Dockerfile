# CPU fallback (a 4 GB VPS): answers identify jobs when the laptop is offline.
# docker build -t loupe-worker worker/ && docker run --env-file worker/.env -v loupe-weights:/app/weights loupe-worker
FROM python:3.12-slim
ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 LOUPE_LOCAL_ROOT=/data
WORKDIR /app
RUN pip install torch --index-url https://download.pytorch.org/whl/cpu
COPY pyproject.toml ./
COPY loupe_worker ./loupe_worker
COPY get-weights.py ./
RUN pip install . && mkdir -p /data /app/weights
# First start downloads the 1.72 GB vision tower into the weights volume, then serves identify jobs on CPU.
CMD ["sh", "-c", "python get-weights.py && loupe-worker run --kinds identify --daemon --device cpu --claim-delay 5 --poll 5"]
