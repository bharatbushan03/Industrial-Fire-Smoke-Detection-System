# ──────────────────────────────────────────────────────────────────────────────
#  Industrial Fire & Smoke Detection AI
#  Azure Functions — Python 3.11 custom container image
#
#  Build:   docker build -t fire-smoke-detection .
#  Run:     docker run -p 7071:80 fire-smoke-detection
# ──────────────────────────────────────────────────────────────────────────────

FROM mcr.microsoft.com/azure-functions/python:4-python3.11

# ── System deps for OpenCV (headless) + PyTorch ───────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
        libgl1-mesa-glx \
        libgomp1 \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# ── Python dependencies ────────────────────────────────────────────────────────
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# ── App code ───────────────────────────────────────────────────────────────────
ENV AzureWebJobsScriptRoot=/home/site/wwwroot \
    AzureFunctionsJobHost__Logging__Console__IsEnabled=true

WORKDIR /home/site/wwwroot

COPY function_app.py    .
COPY host.json          .
COPY app.py             .
COPY yolov8n.pt         .
COPY templates/         ./templates/
COPY static/            ./static/

# Azure Functions runtime listens on port 80 inside the container
EXPOSE 80
