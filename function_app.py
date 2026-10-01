"""
Industrial Fire & Smoke Detection System
Azure Functions v2 Python app — HTTP trigger entry point.

Routes:
  GET  /api/health             — liveness / model status
  GET  /api/ui                 — serves index.html
  GET  /api/static/{path}      — serves CSS / JS assets
  POST /api/detect/image       — single image detection
  POST /api/detect/video       — video file, returns per-frame JSON array
  GET  /api/stats              — latest detection stats (polling)
"""

import os
import io
import cv2
import json
import base64
import logging
import tempfile
import threading
import numpy as np
import warnings
from datetime import datetime
from pathlib import Path

import azure.functions as func

warnings.filterwarnings("ignore")

# ──────────────────────────────────────────────────────────────────────────────
#  Bootstrap – import core detectors from app.py (lives in the same package)
# ──────────────────────────────────────────────────────────────────────────────
from app import (
    FireDetector, SmokeDetector, SceneDetector,
    classify_risk, CFG, USE_GPU, USE_FP16,
)

logger = logging.getLogger("fire-smoke-fn")

# ──────────────────────────────────────────────────────────────────────────────
#  Lazy-loaded singletons (models are heavy; load once on first warm request)
# ──────────────────────────────────────────────────────────────────────────────
_lock        = threading.Lock()
_fire_det:  FireDetector  = None
_smoke_det: SmokeDetector = None
_scene_det: SceneDetector = None
_ready = False

# Shared rolling stats (updated by each detection call)
_stats = {
    "fire_conf":     0.0,
    "smoke_conf":    0.0,
    "risk":          "CLEAR",
    "fire_zones":    0,
    "smoke_zones":   0,
    "scene_objects": 0,
    "frame_idx":     0,
    "gpu_mode":      "GPU FP16" if USE_FP16 else ("GPU" if USE_GPU else "CPU"),
    "timestamp":     "",
}


def _ensure_models():
    global _fire_det, _smoke_det, _scene_det, _ready
    if _ready:
        return
    with _lock:
        if _ready:
            return
        logger.info("Loading detection models …")
        _fire_det  = FireDetector()
        _smoke_det = SmokeDetector()
        try:
            _scene_det = SceneDetector()
        except Exception as exc:
            logger.warning("YOLO scene detector unavailable: %s", exc)
            _scene_det = None
        _ready = True
        logger.info("Models ready.")


# ──────────────────────────────────────────────────────────────────────────────
#  Detection helpers
# ──────────────────────────────────────────────────────────────────────────────

def _detect(frame: np.ndarray) -> dict:
    """Run all detectors on one BGR frame; return stats + annotated frame."""
    fire_blobs,  fire_conf,  _ = _fire_det.run(frame)
    smoke_blobs, smoke_conf, _ = _smoke_det.run(frame)
    scene_dets = _scene_det.run(frame) if _scene_det else []
    risk       = classify_risk(fire_conf, smoke_conf)
    annotated  = _annotate(frame.copy(), fire_blobs, smoke_blobs,
                           scene_dets, fire_conf, smoke_conf, risk)
    return {
        "fire_conf":     round(float(fire_conf),  4),
        "smoke_conf":    round(float(smoke_conf), 4),
        "risk":          risk,
        "fire_zones":    len(fire_blobs),
        "smoke_zones":   len(smoke_blobs),
        "scene_objects": len(scene_dets),
        "timestamp":     datetime.utcnow().isoformat() + "Z",
        "annotated":     annotated,
    }


def _annotate(frame, fire_blobs, smoke_blobs, scene_dets,
              fire_conf, smoke_conf, risk) -> np.ndarray:
    font = cv2.FONT_HERSHEY_SIMPLEX
    risk_col = {"CRITICAL": (0,30,255), "WARNING": (0,130,255),
                "CAUTION": (0,215,255), "CLEAR": (40,220,40)}.get(risk, (200,200,200))

    for b in fire_blobs:
        x1,y1,x2,y2 = b["box"]
        cv2.rectangle(frame, (x1,y1), (x2,y2), (0,30,255), 2)
        cv2.rectangle(frame, (x1,y1-22), (x1+130,y1), (0,0,0), -1)
        cv2.putText(frame, f"FIRE {fire_conf:.0%}", (x1+4,y1-6),
                    font, 0.50, (0,30,255), 1, cv2.LINE_AA)

    for b in smoke_blobs:
        x1,y1,x2,y2 = b["box"]
        cv2.rectangle(frame, (x1,y1), (x2,y2), (160,160,180), 2)
        cv2.rectangle(frame, (x1,y1-22), (x1+130,y1), (0,0,0), -1)
        cv2.putText(frame, f"SMOKE {smoke_conf:.0%}", (x1+4,y1-6),
                    font, 0.50, (160,160,180), 1, cv2.LINE_AA)

    _LABELS = {0:"PERSON",2:"CAR",5:"BUS",7:"TRUCK"}
    _COLORS = {0:(220,0,200),2:(230,220,0),5:(0,130,255),7:(200,220,40)}
    for d in scene_dets:
        x1,y1,x2,y2 = d["box"]
        col = _COLORS.get(d["cls"],(200,200,200))
        cv2.rectangle(frame, (x1,y1), (x2,y2), col, 1)
        cv2.putText(frame, f"{_LABELS.get(d['cls'],'OBJ')} {d['conf']:.0%}",
                    (x1+2,y1-5), font, 0.38, col, 1, cv2.LINE_AA)

    # Status bar
    cv2.rectangle(frame, (0,0), (frame.shape[1],30), (8,10,14), -1)
    ts = datetime.utcnow().strftime("%H:%M:%S UTC")
    cv2.putText(frame,
                f"FIRE:{fire_conf:.0%}  SMOKE:{smoke_conf:.0%}  RISK:{risk}  {ts}",
                (8,20), font, 0.48, risk_col, 1, cv2.LINE_AA)
    return frame


def _to_jpeg_b64(frame: np.ndarray) -> str:
    _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 82])
    return base64.b64encode(buf.tobytes()).decode()


def _update_stats(result: dict, frame_idx: int = 0):
    global _stats
    _stats.update({
        "fire_conf":     result["fire_conf"],
        "smoke_conf":    result["smoke_conf"],
        "risk":          result["risk"],
        "fire_zones":    result["fire_zones"],
        "smoke_zones":   result["smoke_zones"],
        "scene_objects": result["scene_objects"],
        "frame_idx":     frame_idx,
        "timestamp":     result["timestamp"],
    })


def _json_resp(data: dict, status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(
        body=json.dumps(data),
        status_code=status,
        mimetype="application/json",
        headers={"Access-Control-Allow-Origin": "*"},
    )


def _error(msg: str, status: int = 400) -> func.HttpResponse:
    return _json_resp({"error": msg}, status)


# ──────────────────────────────────────────────────────────────────────────────
#  Static file helpers
# ──────────────────────────────────────────────────────────────────────────────
_BASE = Path(__file__).parent

_MIME = {
    ".html": "text/html",
    ".css":  "text/css",
    ".js":   "application/javascript",
    ".png":  "image/png",
    ".ico":  "image/x-icon",
    ".svg":  "image/svg+xml",
}


def _serve_file(rel_path: str) -> func.HttpResponse:
    full = _BASE / rel_path
    if not full.exists() or not full.is_file():
        return func.HttpResponse("Not found", status_code=404)
    mime = _MIME.get(full.suffix, "application/octet-stream")
    return func.HttpResponse(
        body=full.read_bytes(),
        status_code=200,
        mimetype=mime,
        headers={"Cache-Control": "public, max-age=3600",
                 "Access-Control-Allow-Origin": "*"},
    )


# ──────────────────────────────────────────────────────────────────────────────
#  Azure Functions v2 app
# ──────────────────────────────────────────────────────────────────────────────
fnapp = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)


# ── GET /api/health ───────────────────────────────────────────────────────────
@fnapp.route(route="health", methods=["GET"])
def health(req: func.HttpRequest) -> func.HttpResponse:
    return _json_resp({
        "status":         "ready" if _ready else "loading",
        "gpu":            USE_GPU,
        "fp16":           USE_FP16,
        "yolo_available": _scene_det is not None,
        "timestamp":      datetime.utcnow().isoformat() + "Z",
    })


# ── GET /api/ui  (index page) ─────────────────────────────────────────────────
@fnapp.route(route="ui", methods=["GET"])
def ui(req: func.HttpRequest) -> func.HttpResponse:
    return _serve_file("templates/index.html")


# ── GET /api/static/{asset} ───────────────────────────────────────────────────
@fnapp.route(route="static/{asset_path}", methods=["GET"])
def static_assets(req: func.HttpRequest) -> func.HttpResponse:
    asset_path = req.route_params.get("asset_path", "")
    return _serve_file(f"static/{asset_path}")


# ── POST /api/detect/image ────────────────────────────────────────────────────
@fnapp.route(route="detect/image", methods=["POST"])
def detect_image(req: func.HttpRequest) -> func.HttpResponse:
    _ensure_models()

    body = req.get_body()
    if not body:
        return _error("Request body is empty. Send a raw image as the body "
                      "with Content-Type: image/jpeg or image/png.")

    arr   = np.frombuffer(body, np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None:
        return _error("Could not decode image. Send JPEG or PNG.")

    frame  = cv2.resize(frame, (CFG["display_w"], CFG["display_h"]))
    result = _detect(frame)
    _update_stats(result)

    annotated_b64 = _to_jpeg_b64(result.pop("annotated"))
    return _json_resp({
        **result,
        "annotated_image": f"data:image/jpeg;base64,{annotated_b64}",
    })


# ── POST /api/detect/video ────────────────────────────────────────────────────
@fnapp.route(route="detect/video", methods=["POST"])
def detect_video(req: func.HttpRequest) -> func.HttpResponse:
    """
    Accepts a video file body; returns JSON array of per-frame detection results
    (thumbnails base64-encoded) for the first MAX_FRAMES frames.
    Azure Functions has a 230 s execution limit on Consumption plan;
    use Premium/Dedicated for long videos.
    """
    _ensure_models()

    MAX_FRAMES = int(req.params.get("max_frames", 120))

    body = req.get_body()
    if not body:
        return _error("Send a video file as the raw request body.")

    suffix = ".mp4"
    ct = req.headers.get("Content-Type", "")
    if "webm" in ct:
        suffix = ".webm"
    elif "avi" in ct:
        suffix = ".avi"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(body)
        tmp_path = tmp.name

    try:
        cap = cv2.VideoCapture(tmp_path)
        if not cap.isOpened():
            return _error("Could not open video. Ensure it is a valid MP4/AVI/WebM.")

        frames_out = []
        idx = 0
        while idx < MAX_FRAMES:
            ret, raw = cap.read()
            if not ret:
                break
            idx += 1
            frame  = cv2.resize(raw, (CFG["display_w"], CFG["display_h"]))
            result = _detect(frame)
            _update_stats(result, idx)
            thumb  = _to_jpeg_b64(result.pop("annotated"))
            frames_out.append({**result, "frame": idx,
                                "thumbnail": f"data:image/jpeg;base64,{thumb}"})
        cap.release()
    finally:
        os.unlink(tmp_path)

    return _json_resp({"frame_count": len(frames_out), "frames": frames_out})


# ── GET /api/stats ────────────────────────────────────────────────────────────
@fnapp.route(route="stats", methods=["GET"])
def stats(req: func.HttpRequest) -> func.HttpResponse:
    return _json_resp(_stats.copy())
