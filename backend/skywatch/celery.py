import os
import logging
from celery import Celery
from celery.signals import before_task_publish, task_prerun, task_postrun

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "skywatch.settings")
logger = logging.getLogger(__name__)

app = Celery("skywatch")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()


@app.task(bind=True, ignore_result=True)
def debug_task(self):
    logger.debug("celery_debug_task", extra={"task_id": self.request.id})


@task_prerun.connect
def bind_task_context(task_id=None, task=None, **kwargs):
    try:
        import structlog

        request_id = getattr(getattr(task, "request", None), "headers", {}).get("request_id")
        structlog.contextvars.bind_contextvars(task_id=task_id, request_id=request_id)
    except Exception:
        pass


@task_postrun.connect
def clear_task_context(**kwargs):
    try:
        import structlog

        structlog.contextvars.clear_contextvars()
    except Exception:
        pass


@before_task_publish.connect
def propagate_request_id(headers=None, **kwargs):
    if headers is None:
        return
    try:
        from skywatch.middleware import request_id_var

        request_id = request_id_var.get()
        if request_id:
            headers["request_id"] = request_id
    except Exception:
        pass
