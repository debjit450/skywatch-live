"""
WebSocket consumer for real-time flight updates.

Clients connect to ws://host/ws/flights/ and receive push updates
whenever new flight data is ingested.
"""

import json
import logging
from channels.generic.websocket import AsyncWebsocketConsumer
from .metrics import websocket_connections

logger = logging.getLogger(__name__)
MAX_CLIENT_MESSAGE_BYTES = 1024


class FlightConsumer(AsyncWebsocketConsumer):
    """
    WebSocket consumer that joins the 'flights' group
    and forwards flight state updates to connected clients.
    """

    async def connect(self):
        self.group_name = "flights"
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()
        websocket_connections.inc()
        await self._increment_connection_count(1)
        await self._send_initial_snapshot()
        logger.info(
            "ws_connect",
            extra={"client_ip": self.scope.get("client", ["unknown"])[0]},
        )

    async def disconnect(self, close_code):
        await self.channel_layer.group_discard(self.group_name, self.channel_name)
        websocket_connections.dec()
        await self._increment_connection_count(-1)
        logger.info(
            "ws_disconnect",
            extra={"client_ip": self.scope.get("client", ["unknown"])[0], "close_code": close_code},
        )

    async def _increment_connection_count(self, delta):
        try:
            from asgiref.sync import sync_to_async
            from .services.cache import _get_redis

            redis = await sync_to_async(_get_redis)()
            if redis:
                await sync_to_async(redis.incrby)("metrics:ws:connections", delta)
        except Exception:
            pass

    async def receive(self, text_data):
        # Clients can send ping messages
        if text_data is None:
            return
        if text_data and len(text_data) > MAX_CLIENT_MESSAGE_BYTES:
            logger.warning("Closing WebSocket with oversized client message: %s", self.channel_name)
            await self.close(code=1009)
            return

        try:
            data = json.loads(text_data)
            if data.get("type") == "ping":
                await self.send(text_data=json.dumps({"type": "pong", "time": data.get("time")}))
            elif data.get("type") == "resume":
                await self._send_initial_snapshot(resume_sequence=data.get("last_sequence"))
        except (json.JSONDecodeError, TypeError):
            logger.debug("Ignored malformed WebSocket message from %s", self.channel_name)

    async def _send_initial_snapshot(self, resume_sequence=None):
        try:
            from asgiref.sync import sync_to_async
            from .services.cache import get_current_flights

            payload = await sync_to_async(get_current_flights)()
            if not payload:
                await self.send(text_data=json.dumps({
                    "type": "degraded",
                    "data": {
                        "reason": "no_cached_snapshot",
                        "resume_sequence": resume_sequence,
                    },
                }))
                return
            await self.send(text_data=json.dumps({
                "type": "initial_snapshot",
                "data": {
                    "time": payload.get("time"),
                    "flights": payload.get("states", []),
                    "authenticated": payload.get("authenticated", False),
                    "source": "backend",
                    "count": len(payload.get("states", [])),
                    "source_counts": payload.get("source_counts", {}),
                    "source_health": payload.get("source_health", {}),
                    "source_conflict_count": payload.get("source_conflict_count", 0),
                    "degraded": payload.get("degraded", False),
                    "resume_sequence": resume_sequence,
                },
            }))
        except Exception as exc:
            logger.warning("Failed to send initial WebSocket snapshot: %s", exc)

    async def flight_update(self, event):
        """Handle flight update messages from the group."""
        await self.send(text_data=json.dumps({
            "type": "flight_update",
            "data": event.get("data", {}),
        }))

    async def anomaly_alert(self, event):
        """Handle anomaly alert messages."""
        await self.send(text_data=json.dumps({
            "type": "anomaly_alert",
            "data": event.get("data", {}),
        }))
