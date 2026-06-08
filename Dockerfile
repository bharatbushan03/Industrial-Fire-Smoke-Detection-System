# Use Python 3.11 slim image as base
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies for OpenCV, GTK, and video handling
RUN apt-get update && apt-get install -y \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements file
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code and model
COPY app.py .
COPY yolov8n.pt .

# Create non-root user for security
RUN useradd --create-home --shell /bin/bash appuser
USER appuser

# Set environment variables
ENV PYTHONUNBUFFERED=1

# Expose port if needed (not used in this app, but kept for extensibility)
# EXPOSE 8080

# Run the application
CMD ["python", "app.py"]