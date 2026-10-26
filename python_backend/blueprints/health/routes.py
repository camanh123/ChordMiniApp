"""
Health check routes for ChordMini Flask application.

This module provides endpoints for health monitoring and basic API status.
"""

import hashlib
import hmac
import os
import re

from flask import Blueprint, jsonify, request
from extensions import limiter
from config import get_config

# Create blueprint
health_bp = Blueprint('health', __name__)

# Get configuration for rate limits
config = get_config()

# 16 random bytes, lowercase hex. The nonce never travels in this value.
_CHALLENGE_RE = re.compile(r"^[0-9a-f]{32}$")


def _identity_proof(challenge: str):
    """HMAC-SHA256(CHORDMINI_BACKEND_NONCE, challenge), or None.

    A response that omits this field is not an identity proof. Replaying an
    older proof fails because the checker sends a new challenge each time.
    """
    nonce = os.environ.get("CHORDMINI_BACKEND_NONCE", "").strip()
    if not nonce or not _CHALLENGE_RE.fullmatch(challenge or ""):
        return None
    return hmac.new(
        nonce.encode("utf-8"),
        challenge.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


@health_bp.route('/')
@limiter.limit(config.get_rate_limit('health'))
def index():
    """Root endpoint - basic health check."""
    return jsonify({
        "status": "healthy",
        "message": "Audio analysis API is running"
    })


@health_bp.route('/health')
def health():
    """Simple health check endpoint for Cloud Run and load balancers.

    ``service`` names this process. ``instance`` is present only when the
    caller supplied a fresh challenge and this process knows the session
    nonce. The nonce itself is never returned. Load balancers can keep
    calling /health with no query string.
    """
    body = {
        "status": "healthy",
        "service": "chordmini-flask",
    }
    proof = _identity_proof(request.args.get("challenge", ""))
    if proof:
        body["instance"] = proof
    return jsonify(body), 200


@health_bp.route('/api/desktop/readiness')
@limiter.limit(config.get_rate_limit('health'))
def desktop_readiness():
    """Report detector availability without running inference.

    Chord-CNN-LSTM is available only when its five weight files exist and the
    recognition module imports. Beat-Transformer is available when PyTorch
    imports, the checkpoint file exists, and DilatedTransformer imports. The
    checkpoint is not loaded into the detector here. Madmom is available when
    the package imports. A true value does not mean a recording was analyzed.
    """
    if request.remote_addr not in ("127.0.0.1", "::1"):
        return jsonify({"success": False, "code": "LOOPBACK_ONLY"}), 403

    proof = _identity_proof(request.args.get("challenge", ""))
    if os.environ.get("CHORDMINI_BACKEND_NONCE", "").strip() and not proof:
        return jsonify({"success": False, "code": "CHALLENGE_REQUIRED"}), 401

    chord_available = False
    beat_transformer = False
    madmom_available = False
    try:
        from services.detectors.chord_cnn_lstm_detector import ChordCNNLSTMDetectorService
        from utils.paths import CHORD_CNN_LSTM_DIR
        chord_available = bool(ChordCNNLSTMDetectorService(str(CHORD_CNN_LSTM_DIR)).is_available())
    except Exception:
        chord_available = False
    try:
        from models.beat_transformer import is_beat_transformer_available
        beat_transformer = bool(is_beat_transformer_available())
    except Exception:
        beat_transformer = False
    try:
        from services.detectors.madmom_detector import MadmomDetectorService
        madmom_available = bool(MadmomDetectorService().is_available())
    except Exception:
        madmom_available = False

    body = {
        "service": "chordmini-flask",
        "status": "healthy",
        "chordCnnLstm": chord_available,
        "beatTransformer": beat_transformer,
        "madmom": madmom_available,
        "proves": "weight-files-and-imports",
    }
    if proof:
        body["instance"] = proof
    return jsonify(body)
