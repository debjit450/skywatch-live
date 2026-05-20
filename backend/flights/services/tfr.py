"""Compatibility wrappers for airspace restriction fetch/cache helpers."""

from .airspace_restrictions import (
    empty_feature_collection,
    get_airspace_restrictions,
    refresh_airspace_restrictions,
)


def get_cached_tfrs():
    return get_airspace_restrictions()


def refresh_tfrs():
    return refresh_airspace_restrictions()
