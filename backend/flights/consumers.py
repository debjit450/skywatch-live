"""
WebSocket consumer for real-time flight updates.

Clients connect to ws://host/ws/flights/ and receive push updates
whenever new flight data is ingested.
"""

import json
import logging
from channels.generic.websocket import AsyncWebsocketConsumer

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
        logger.info("WebSocket client connected: %s", self.channel_name)

    async def disconnect(self, close_code):
        await self.channel_layer.group_discard(self.group_name, self.channel_name)
        logger.info("WebSocket client disconnected: %s (code=%s)", self.channel_name, close_code)

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
                await self.send(text_data=json.dumps({"type": "pong"}))
        except (json.JSONDecodeError, TypeError):
            logger.debug("Ignored malformed WebSocket message from %s", self.channel_name)

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
