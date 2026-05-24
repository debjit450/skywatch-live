"""API helpers for consistent DRF error responses."""

from rest_framework.views import exception_handler as drf_exception_handler


def exception_handler(exc, context):
    response = drf_exception_handler(exc, context)
    if response is None:
        return None

    request = context.get("request") if context else None
    detail = response.data
    if isinstance(detail, dict) and "detail" in detail and len(detail) == 1:
        message = detail["detail"]
        errors = None
    else:
        message = "Request validation failed" if response.status_code == 400 else "Request failed"
        errors = detail

    response.data = {
        "error": {
            "code": getattr(exc, "default_code", "error"),
            "message": str(message),
            "status": response.status_code,
            "request_id": getattr(request, "request_id", None),
            "details": errors,
        }
    }
    return response
