"""
Chord recognition routes for ChordMini Flask application.

This module provides all chord recognition endpoints including model testing
and information endpoints.
"""

import traceback
import requests
from flask import Blueprint, jsonify, current_app
from config import get_config
from extensions import limiter
from utils.logging import log_info, log_error, log_debug
from security.inference_guard import handle_chord_upload
from security.offload_audio import OffloadRejected, execute_offload


def _requests_client_for_security_tests():
    """Kept so localhost security tests can patch this module's requests client."""
    return requests
from .validators import (
    validate_firebase_chord_recognition_request,
    get_detector_display_name
)

# Create blueprint
chords_bp = Blueprint('chords', __name__)

# Get configuration
config = get_config()


@chords_bp.route('/api/recognize-chords', methods=['POST'])
@limiter.limit(config.get_rate_limit('heavy_processing'))
def recognize_chords():
    """
    Recognize chords in an uploaded audio file.

    Parameters:
    - file: The audio file to analyze (multipart/form-data)
    - detector: Model to use ('chord-cnn-lstm', 'btc-sl', 'btc-pl', 'auto')
    - chord_dict: Optional chord dictionary to use
    - force: Set to 'true' to force using the requested detector
    - use_spleeter: Use Spleeter for audio separation

    Caller-supplied server paths are rejected. When inference authentication
    is required, send the server-side token in X-ChordMini-Inference-Token.
    """
    return handle_chord_upload()


@chords_bp.route('/api/recognize-chords-firebase', methods=['POST'])
@limiter.limit(config.get_rate_limit('heavy_processing'))
def recognize_chords_firebase():
    """
    Recognize chords in an audio file from Firebase Storage URL.

    Parameters:
    - firebase_url: Firebase Storage URL of the audio file
    - detector: Chord recognition model to use
    - chord_dict: Optional chord dictionary to use

    Returns:
    - JSON with chord recognition results
    """
    try:
        is_valid, _error_msg, params = validate_firebase_chord_recognition_request()
        if not is_valid:
            return jsonify({
                "success": False,
                "error": "The offload request was rejected.",
                "code": "BAD_REQUEST",
            }), 400

        chord_service = current_app.extensions['services']['chord_recognition']
        try:
            available = chord_service.get_available_detectors()
        except Exception:
            log_error("Offload chord detectors could not be listed")
            return jsonify({
                "success": False,
                "error": "No detector can accept this audio.",
                "code": "NO_ELIGIBLE_DETECTOR",
            }), 503

        chord_dict = params['chord_dict']

        def infer(path: str, detector: str):
            return chord_service.recognize_chords(
                file_path=path,
                detector=detector,
                chord_dict=chord_dict,
                force=False,
                use_spleeter=False,
            )

        result = execute_offload(
            params["firebase_url"],
            family="chord",
            requested=params["detector"],
            available=available,
            infer=infer,
        )
        log_info("Offload chord recognition finished")
        if result.get("success"):
            return jsonify(result)
        return jsonify(result), 500
    except OffloadRejected as rejected:
        log_info(f"Offload chord recognition rejected code={rejected.code}")
        return jsonify(rejected.body()), rejected.status
    except Exception:
        log_error("Unexpected error in recognize_chords_firebase")
        return jsonify({
            "success": False,
            "error": "Internal server error",
            "code": "OFFLOAD_FAILED",
        }), 500


@chords_bp.route('/api/chord-model-info', methods=['GET'])
@limiter.limit(config.get_rate_limit('light_processing'))
def chord_model_info():
    """Return information about available chord recognition models"""
    try:
        # Get chord recognition service
        chord_service = current_app.extensions['services']['chord_recognition']

        # Get detector information
        detector_info = chord_service.get_detector_info()

        return jsonify({
            "success": True,
            "available_chord_models": detector_info["available_detectors"],
            "chord_model_info": {
                name: {
                    "name": info["name"],
                    "description": info["description"],
                    "available": info["available"],
                    "supported_chord_dicts": info["supported_chord_dicts"],
                    "default_chord_dict": info["default_chord_dict"],
                    "size_limit_mb": info["size_limit_mb"]
                }
                for name, info in detector_info["detectors"].items()
            },
            "spleeter_available": detector_info["spleeter_available"],
            "default_chord_model": detector_info["available_detectors"][0] if detector_info["available_detectors"] else None
        })

    except Exception as e:
        error_msg = f"Error getting chord model info: {str(e)}"
        log_error(error_msg)
        return jsonify({
            "success": False,
            "error": error_msg
        }), 500


@chords_bp.route('/api/test-chord-cnn-lstm', methods=['GET'])
@limiter.limit(config.get_rate_limit('test'))
def test_chord_cnn_lstm():
    """Test Chord-CNN-LSTM model availability"""
    try:
        # Get chord recognition service
        chord_service = current_app.extensions['services']['chord_recognition']

        # Get detector
        detector = chord_service.detectors['chord-cnn-lstm']

        if detector.is_available():
            model_info = detector.get_model_info()
            return jsonify({
                "success": True,
                "model": "Chord-CNN-LSTM",
                "status": "available",
                "message": "Chord-CNN-LSTM model is ready for use",
                "model_info": model_info
            })
        else:
            return jsonify({
                "success": False,
                "model": "Chord-CNN-LSTM",
                "status": "unavailable",
                "error": "Chord-CNN-LSTM model is not available"
            })

    except Exception as e:
        error_msg = f"Error testing Chord-CNN-LSTM: {str(e)}"
        log_error(error_msg)
        return jsonify({
            "success": False,
            "model": "Chord-CNN-LSTM",
            "status": "error",
            "error": error_msg
        }), 500


@chords_bp.route('/api/test-btc-sl', methods=['GET'])
@limiter.limit(config.get_rate_limit('test'))
def test_btc_sl():
    """Test BTC-SL (Self-Label) model availability"""
    try:
        # Get chord recognition service
        chord_service = current_app.extensions['services']['chord_recognition']

        # Get detector
        detector = chord_service.detectors['btc-sl']

        if detector.is_available():
            model_info = detector.get_model_info()
            return jsonify({
                "success": True,
                "model": "BTC-SL",
                "status": "available",
                "message": "BTC-SL model is ready for use",
                "model_info": model_info
            })
        else:
            return jsonify({
                "success": False,
                "model": "BTC-SL",
                "status": "unavailable",
                "error": "BTC-SL model is not available"
            })

    except Exception as e:
        error_msg = f"Error testing BTC-SL: {str(e)}"
        log_error(error_msg)
        return jsonify({
            "success": False,
            "model": "BTC-SL",
            "status": "error",
            "error": error_msg
        }), 500


@chords_bp.route('/api/test-btc-pl', methods=['GET'])
@limiter.limit(config.get_rate_limit('test'))
def test_btc_pl():
    """Test BTC-PL (Pseudo-Label) model availability"""
    try:
        # Get chord recognition service
        chord_service = current_app.extensions['services']['chord_recognition']

        # Get detector
        detector = chord_service.detectors['btc-pl']

        if detector.is_available():
            model_info = detector.get_model_info()
            return jsonify({
                "success": True,
                "model": "BTC-PL",
                "status": "available",
                "message": "BTC-PL model is ready for use",
                "model_info": model_info
            })
        else:
            return jsonify({
                "success": False,
                "model": "BTC-PL",
                "status": "unavailable",
                "error": "BTC-PL model is not available"
            })

    except Exception as e:
        error_msg = f"Error testing BTC-PL: {str(e)}"
        log_error(error_msg)
        return jsonify({
            "success": False,
            "model": "BTC-PL",
            "status": "error",
            "error": error_msg
        }), 500


@chords_bp.route('/api/test-all-chord-models', methods=['GET'])
@limiter.limit(config.get_rate_limit('test'))
def test_all_chord_models():
    """Test all available chord recognition models"""
    try:
        # Get chord recognition service
        chord_service = current_app.extensions['services']['chord_recognition']

        results = {
            "success": True,
            "models_tested": [],
            "available_models": [],
            "unavailable_models": []
        }

        # Test each detector
        for detector_name in ['chord-cnn-lstm', 'btc-sl', 'btc-pl']:
            detector = chord_service.detectors[detector_name]

            test_result = {
                "name": detector_name,
                "display_name": get_detector_display_name(detector_name),
                "available": detector.is_available()
            }

            if detector.is_available():
                results["available_models"].append(detector_name)
                test_result["status"] = "available"

                # Add model info
                try:
                    model_info = detector.get_model_info()
                    test_result["model_info"] = model_info
                except Exception as e:
                    test_result["info_error"] = str(e)

            else:
                results["unavailable_models"].append(detector_name)
                test_result["status"] = "unavailable"
                test_result["error"] = f"{detector_name} not available"

            results["models_tested"].append(test_result)

        # Add summary
        results["summary"] = {
            "total_models": len(results["models_tested"]),
            "available_count": len(results["available_models"]),
            "unavailable_count": len(results["unavailable_models"]),
            "default_model": results["available_models"][0] if results["available_models"] else "none"
        }

        # Add Spleeter info
        results["spleeter_available"] = chord_service.spleeter_service.is_available()

        return jsonify(results)

    except Exception as e:
        error_msg = f"Error testing chord models: {str(e)}"
        log_error(error_msg)
        return jsonify({
            "success": False,
            "error": error_msg,
            "traceback": traceback.format_exc() if not config.PRODUCTION_MODE else None
        }), 500