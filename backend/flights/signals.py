"""Model hooks for metadata cache invalidation."""

from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver

from .models import Aircraft
from .services.cache import invalidate_aircraft_metadata


@receiver([post_save, post_delete], sender=Aircraft)
def invalidate_aircraft_cache(sender, instance, **kwargs):
    invalidate_aircraft_metadata(instance.icao24)
