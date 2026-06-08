# Industrial Fire & Smoke Detection System

Real-time fire and smoke detection system using computer vision and YOLO for industrial safety monitoring.

## Overview

This system processes video streams to detect fire and smoke hazards, providing real-time alerts with a cinematic HUD overlay. It combines:
- Fire detection via HSV color segmentation
- Smoke detection via motion differencing and color masking
- Optional YOLOv8 scene detection for contextual awareness (people, vehicles)
- Risk classification (CLEAR, CAUTION, WARNING, CRITICAL)
- GPU acceleration with CPU fallback

## Docker Deployment

The system is containerized for easy deployment on Google Cloud Platform (GCP) or any Docker-compatible environment.

### Building the Docker Image

```bash
docker build -t fire-smoke-detection .
```

### Running the Container

#### From Webcam (requires privileged access and device forwarding)
```bash
docker run --rm -it --device /dev/video0 fire-smoke-detection 0
```

#### From Video File (mount local video)
```bash
docker run --rm -it -v $(pwd)/videos:/app/videos fire-smoke-detection /app/videos/input.mp4 --output /app/videos/output_detected.mp4
```

#### From RTSP Stream
```bash
docker run --rm -it fire-smoke-detection rtsp://example.com/stream
```

#### Skip YOLO for Faster Processing
```bash
docker run --rm -it fire-smoke-detection 0 --no-yolo
```

### Environment Variables

- `HEADLESS=1`: Run in headless mode (uses virtual display internally, no change needed)
- Other parameters are passed as command-line arguments to `app.py`

### Example GCP Deployment (Compute Engine)

1. Build and push image to Artifact Registry:
   ```bash
   docker build -t FIRE-SMOKE-DETECTION .
   docker tag FIRE-SMOKE-DETECTION LOCATION-docker.pkg.dev/PROJECT-ID/REPOSITORY/FIRE-SMOKE-DETECTION:TAG
   docker push LOCATION-docker.pkg.dev/PROJECT-ID/REPOSITORY/FIRE-SMOKE-DETECTION:TAG
   ```

2. Create VM instance with GPU (if needed) and pull the image.

3. Run with appropriate device flags for video access.

## Local Development

### Prerequisites
- Python 3.11+
- Webcam or video source for testing

### Installation
Please install dependencies manually using the provided requirements.txt:
```bash
pip install -r requirements.txt
```
Note: On Windows, if you encounter issues with PyTorch, you may need to install the CPU-only version explicitly:
```bash
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
```
```

### Usage
```bash
# Webcam
python app.py 0

# Video file
python app.py path/to/video.mp4 --output detected.mp4

# Skip YOLO (faster)
python app.py 0 --no-yolo

# RTSP stream
python app.py rtsp://example.com/stream
```

### Controls
- `Q`: Quit
- `P`: Pause/Resume
- `S`: Save screenshot

## Output

- Processed video saved to specified output file (default: `output_detected.mp4`)
- Screenshots saved as `screenshot_XXXXX.jpg` when pressing 'S'
- Console output shows FPS, latency, fire/smoke confidence, and risk level

## Model

Uses YOLOv8n pre-trained weights (`yolov8n.pt`) for scene detection. The file is included in the repository.

## License

This project is for educational and research purposes only.

## Credits

Developed by: tubakhxn