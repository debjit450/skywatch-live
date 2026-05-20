"""Live airspace restriction aggregation."""

import hashlib
import json
import logging
import math
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse
from xml.etree import ElementTree

import requests
from django.conf import settings
from django.utils.dateparse import parse_datetime

from .cache import _get_json, _set_json

logger = logging.getLogger(__name__)

AIRSPACE_CACHE_KEY = "airspace:restrictions:geojson"
AIRSPACE_TTL_SECONDS = 5 * 60
FAA_NOTAM_CACHE_KEY = "airspace:faa_notam"
FAA_NOTAM_TTL_SECONDS = 2 * 60 * 60
HTTP_TIMEOUT_SECONDS = 10

AWC_DOMESTIC_SIGMET_URL = "https://aviationweather.gov/api/data/airsigmet"
AWC_INTERNATIONAL_SIGMET_URL = "https://aviationweather.gov/api/data/isigmet"
FAA_TFR_GEOJSON_URL = (
    "https://tfr.faa.gov/geoserver/TFR/ows"
    "?service=WFS&version=1.1.0&request=GetFeature&typeName=V_TFR_LOC&outputFormat=application/json"
)
FAA_NOTAM_URL = "https://api.faa.gov/notamapi/v1/notams"
FAA_NOTAM_LOCATIONS = (
    "VIDP",
    "VOMM",
    "VECC",
    "VABB",
    "VIDP",
    "UKFV",
    "OIIX",
    "ORBB",
    "OYYE",
    "OSTT",
    "HLLL",
    "OAKB",
    "VYYY",
    "HKNA",
    "ZGZU",
    "RCAA",
    "DRRR",
    "ZKKP",
)

TIME_FIELD_NAMES = (
    "issued_at",
    "issuedAt",
    "issue_time",
    "issueTime",
    "issued",
    "start",
    "startTime",
    "start_time",
    "effective",
    "effectiveStart",
    "valid_from",
    "validFrom",
    "VALID_FROM",
    "BEGIN_DATE",
    "START_DATE",
)
EXPIRY_FIELD_NAMES = (
    "expires_at",
    "expiresAt",
    "expire_time",
    "expireTime",
    "expires",
    "end",
    "endTime",
    "end_time",
    "effectiveEnd",
    "valid_to",
    "validTo",
    "VALID_TO",
    "END_DATE",
    "END_DATE_TIME",
    "EXPIRE_DATE",
    "expirationDate",
)
NAME_FIELD_NAMES = (
    "name",
    "title",
    "designator",
    "identifier",
    "icaoId",
    "ICAOCode",
    "fir",
    "FIR",
    "notamNumber",
    "NOTAM",
)
REASON_FIELD_NAMES = (
    "reason",
    "description",
    "text",
    "message",
    "notamText",
    "NOTAM_TXT",
    "qualifier",
    "REASON",
    "hazard",
)
ALTITUDE_FIELD_NAMES = (
    "altitudeLimits",
    "altitude_limits",
    "altitude",
    "altitudeLow1",
    "altitudeHi1",
    "ALT_LMT_LO",
    "ALT_LMT_HI",
    "base",
    "top",
)
CRITICAL_TERMS = (
    "no-fly",
    "no fly",
    "closed",
    "closure",
    "prohibited",
    "conflict",
    "missile",
    "air defense",
    "air defence",
    "hostilities",
    "armed",
    "war",
)


def empty_feature_collection():
    return {
        "type": "FeatureCollection",
        "features": [],
        "generated_at": _utc_now_iso(),
        "cache_ttl_seconds": AIRSPACE_TTL_SECONDS,
        "sources": {},
    }


def get_airspace_restrictions():
    cached = _get_json(AIRSPACE_CACHE_KEY)
    if cached:
        return cached
    return refresh_airspace_restrictions()


def refresh_airspace_restrictions():
    features = []
    sources = {}

    for source_key, fetcher in (
        ("awc_sigmet", _fetch_awc_sigmets),
        ("faa_tfr", _fetch_faa_tfrs),
    ):
        try:
            source_features, meta = fetcher()
        except Exception as exc:  # pragma: no cover - final guard for flaky public feeds
            logger.warning("%s restriction fetch failed: %s", source_key, exc)
            source_features = []
            meta = _source_meta("error", 0, error=str(exc))
        features.extend(source_features)
        sources[source_key] = meta

    features = _dedupe_features([feature for feature in features if not _feature_is_expired(feature)])
    payload = {
        "type": "FeatureCollection",
        "features": features,
        "generated_at": _utc_now_iso(),
        "cache_ttl_seconds": AIRSPACE_TTL_SECONDS,
        "count": len(features),
        "live_count": sum(1 for feature in features if _source_type(feature) == "live"),
        "sources": sources,
    }
    _set_json(AIRSPACE_CACHE_KEY, payload, AIRSPACE_TTL_SECONDS)
    return payload


def _fetch_awc_sigmets():
    features = []
    source_details = {}
    for key, url, params, name in (
        (
            "domestic",
            AWC_DOMESTIC_SIGMET_URL,
            {"format": "geojson", "type": "sigmet"},
            "Aviation Weather Center SIGMET",
        ),
        (
            "international",
            AWC_INTERNATIONAL_SIGMET_URL,
            {"format": "geojson"},
            "Aviation Weather Center International SIGMET",
        ),
    ):
        try:
            payload = _request_payload(url, params=params)
            normalized = _normalize_payload(payload, name, "weather", default_kind="SIGMET")
            features.extend(normalized)
            source_details[key] = {"status": "ok", "features": len(normalized)}
        except Exception as exc:
            logger.warning("AWC %s restriction fetch failed: %s", key, exc)
            source_details[key] = {"status": "error", "features": 0, "error": str(exc)}
    status = "ok" if any(item["features"] for item in source_details.values()) else "empty"
    return features, _source_meta(status, len(features), feeds=source_details)


def _fetch_faa_tfrs():
    url = getattr(settings, "TFR_GEOJSON_URL", "") or FAA_TFR_GEOJSON_URL
    try:
        payload = _request_payload(url)
        features = _normalize_payload(payload, "FAA TFR", "faa_tfr", default_kind="TFR")
        return features, _source_meta("ok" if features else "empty", len(features), url=_safe_url(url))
    except Exception as exc:
        logger.warning("FAA TFR fetch failed: %s", exc)
        return [], _source_meta("error", 0, url=_safe_url(url), error=str(exc))


def _fetch_faa_notams():
    cached = _get_json(FAA_NOTAM_CACHE_KEY)
    if isinstance(cached, dict) and isinstance(cached.get("features"), list):
        features = cached["features"]
        return features, _source_meta(
            "ok" if features else "empty",
            len(features),
            url=_safe_url(FAA_NOTAM_URL),
            requested_locations=list(FAA_NOTAM_LOCATIONS),
            cache="hit",
            cache_key=FAA_NOTAM_CACHE_KEY,
            cache_ttl_seconds=FAA_NOTAM_TTL_SECONDS,
        )

    features = []
    results = []

    def fetch_location(location):
        payload = _request_payload(FAA_NOTAM_URL, params={"icaoLocation": location})
        if _looks_like_html_document(payload):
            raise ValueError("FAA NOTAM API returned HTML instead of NOTAM text")
        return location, payload

    with ThreadPoolExecutor(max_workers=len(FAA_NOTAM_LOCATIONS)) as executor:
        future_map = {executor.submit(fetch_location, location): location for location in FAA_NOTAM_LOCATIONS}
        for future in as_completed(future_map):
            location = future_map[future]
            try:
                _, payload = future.result()
                parsed = _features_from_faa_notam_payload(payload, location)
                features.extend(parsed)
                results.append({"location": location, "status": "ok", "features": len(parsed)})
            except Exception as exc:
                logger.warning("FAA NOTAM fetch failed for %s: %s", location, exc)
                results.append({"location": location, "status": "error", "features": 0, "error": str(exc)})

    features = _dedupe_features(features)
    errors = [item for item in results if item["status"] == "error"]
    status = "ok" if features else "empty"
    if errors and not features:
        status = "error"

    meta = _source_meta(
        status,
        len(features),
        url=_safe_url(FAA_NOTAM_URL),
        requested_locations=list(FAA_NOTAM_LOCATIONS),
        location_results=results,
        cache="miss",
        cache_key=FAA_NOTAM_CACHE_KEY,
        cache_ttl_seconds=FAA_NOTAM_TTL_SECONDS,
    )
    if status != "error":
        _set_json(
            FAA_NOTAM_CACHE_KEY,
            {"features": features, "meta": meta, "generated_at": _utc_now_iso()},
            FAA_NOTAM_TTL_SECONDS,
        )
    return features, meta


def _features_from_faa_notam_payload(payload, requested_location):
    features = []
    for index, item in enumerate(_iter_faa_notam_items(payload)):
        feature = _feature_from_faa_notam_item(item, requested_location, index)
        if feature:
            features.append(feature)
    return _dedupe_features(features)


def _looks_like_html_document(payload):
    if not isinstance(payload, str):
        return False
    prefix = payload.lstrip()[:80].lower()
    return prefix.startswith("<!doctype html") or prefix.startswith("<html")


def _iter_faa_notam_items(payload):
    if isinstance(payload, str):
        yield from _split_faa_notam_text(payload)
        return
    for record in _iter_records(payload):
        yield record


def _split_faa_notam_text(text):
    normalized = str(text).replace("\r\n", "\n").replace("\r", "\n")
    starts = [
        match.start()
        for match in re.finditer(
            r"(?im)(?=^\s*(?:[A-Z]\d{4}/\d{2}|FDC\s+\d/\d{4})\b.*(?:NOTAM|Q\)))",
            normalized,
        )
    ]
    if len(starts) <= 1:
        starts = [match.start() for match in re.finditer(r"(?im)(?=^\s*(?:[A-Z]\d{4}/\d{2}\s+)?Q\))", normalized)]
    if len(starts) <= 1:
        return [normalized]
    blocks = []
    for idx, start in enumerate(starts):
        end = starts[idx + 1] if idx + 1 < len(starts) else len(normalized)
        block = normalized[start:end].strip()
        if block:
            blocks.append(block)
    return blocks


def _feature_from_faa_notam_item(item, requested_location, index):
    record = item if isinstance(item, dict) else {}
    raw_text = item if isinstance(item, str) else _faa_notam_text_from_record(record)
    q_line = _faa_q_line(raw_text) or _faa_record_line(record, FAA_Q_LINE_FIELD_NAMES, "Q")
    q_data = _parse_faa_q_line(q_line)
    if not q_data:
        return None

    e_text = _faa_e_line_text(raw_text) or _faa_record_section_text(record, FAA_E_LINE_FIELD_NAMES, "E")
    if not e_text:
        e_text = _compact_text(raw_text) or "FAA NOTAM airspace restriction"

    notam_id = _faa_notam_id(record, raw_text, requested_location, q_data["type_code"], index)
    return {
        "type": "Feature",
        "geometry": q_data["geometry"],
        "properties": {
            "id": str(notam_id),
            "name": f"{q_data['location']} {q_data['type_code']}",
            "reason": e_text,
            "altitudeLimits": q_data["altitude_limits"],
            "riskLevel": q_data["risk_level"],
            "source": "FAA NOTAM API",
            "source_group": "faa_notam",
            "source_type": "live",
            "restriction_kind": "NOTAM",
            "notam_location": q_data["location"],
            "requested_location": requested_location,
            "type_code": q_data["type_code"],
        },
    }


FAA_Q_LINE_FIELD_NAMES = ("q", "qLine", "q_line", "qualifier")
FAA_E_LINE_FIELD_NAMES = ("e", "eLine", "e_line", "description", "freeText", "free_text")
FAA_NOTAM_ID_FIELD_NAMES = (
    "id",
    "notamId",
    "notam_id",
    "notamNumber",
    "notam_number",
    "number",
    "notamAccountId",
)
FAA_NOTAM_TEXT_FIELD_NAMES = (
    "rawNotam",
    "raw_notam",
    "notamText",
    "notam_text",
    "traditionalMessage",
    "traditional_message",
    "message",
    "text",
    "body",
)


def _faa_notam_text_from_record(record):
    for key in FAA_NOTAM_TEXT_FIELD_NAMES:
        value = _deep_first_string(record, (key,))
        if value and (_faa_q_line(value) or "Q)" in value.upper()):
            return value
    q_line = _faa_record_line(record, FAA_Q_LINE_FIELD_NAMES, "Q")
    e_text = _faa_record_section_text(record, FAA_E_LINE_FIELD_NAMES, "E")
    e_line = f"E) {e_text}" if e_text else ""
    if q_line:
        return "\n".join(line for line in (q_line, e_line) if line)
    for value in _deep_string_values(record):
        if _faa_q_line(value):
            return value
    return ""


def _faa_record_line(record, keys, marker):
    value = _deep_first_string(record, keys)
    if not value:
        return ""
    text = str(value).strip()
    return text if text.upper().startswith(f"{marker})") else f"{marker}) {text}"


def _faa_record_section_text(record, keys, marker):
    value = _deep_first_string(record, keys)
    if not value:
        return ""
    text = str(value).strip()
    if text.upper().startswith(f"{marker})"):
        text = text[2:].strip()
    return _compact_text(text)


def _faa_q_line(text):
    if not text:
        return ""
    match = re.search(
        r"\bQ\)\s*[A-Z0-9]{4}\s*/\s*[A-Z0-9]{5}\s*/\s*[^/\s]+\s*/\s*[^/\s]+\s*/\s*[^/\s]+"
        r"\s*/\s*\d{3}\s*/\s*\d{3}\s*/\s*\d{4}[NS]\d{5}[EW]\d{3}",
        str(text),
        re.IGNORECASE,
    )
    return match.group(0) if match else ""


def _parse_faa_q_line(q_line):
    if not q_line:
        return None
    match = re.search(
        r"\bQ\)\s*([A-Z0-9]{4})\s*/\s*([A-Z0-9]{5})\s*/\s*([^/\s]+)\s*/\s*([^/\s]+)\s*/\s*([^/\s]+)"
        r"\s*/\s*(\d{3})\s*/\s*(\d{3})\s*/\s*(\d{4}[NS]\d{5}[EW]\d{3})",
        str(q_line),
        re.IGNORECASE,
    )
    if not match:
        return None

    circle = _decode_faa_q_circle(match.group(8))
    if not circle:
        return None

    location = match.group(1).upper()
    type_code = match.group(2).upper()
    low = match.group(6)
    high = match.group(7)
    lon, lat, radius_nm = circle
    return {
        "location": location,
        "type_code": type_code,
        "altitude_limits": f"{_faa_altitude_limit(low)} - {_faa_altitude_limit(high)}",
        "risk_level": _faa_notam_risk_level(type_code),
        "geometry": {"type": "Polygon", "coordinates": [_circle_ring_degrees(lon, lat, radius_nm, steps=36)]},
    }


def _decode_faa_q_circle(value):
    match = re.fullmatch(r"(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])(\d{3})", str(value).upper())
    if not match:
        return None
    lat = int(match.group(1)) + int(match.group(2)) / 60.0
    lon = int(match.group(4)) + int(match.group(5)) / 60.0
    if match.group(3) == "S":
        lat = -lat
    if match.group(6) == "W":
        lon = -lon
    radius_nm = int(match.group(7))
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return lon, lat, radius_nm


def _circle_ring_degrees(lon, lat, radius_nm, steps=36):
    radius_deg = float(radius_nm) / 60.0
    ring = []
    for idx in range(steps):
        angle = 2 * math.pi * idx / steps
        ring.append([lon + radius_deg * math.cos(angle), lat + radius_deg * math.sin(angle)])
    return _close_ring(ring)


def _faa_notam_risk_level(type_code):
    code = str(type_code).upper()
    if any(term in code for term in ("RT", "RD", "RP")):
        return "Critical (No-Fly)"
    return "High Risk (Advisory)"


def _faa_altitude_limit(value):
    code = str(value).strip()
    if code == "000":
        return "SFC"
    if code == "999":
        return "UNL"
    try:
        return f"{int(code) * 100} ft"
    except ValueError:
        return code


def _faa_e_line_text(text):
    if not text:
        return ""
    normalized = str(text).replace("\r\n", "\n").replace("\r", "\n")
    match = re.search(r"(?is)\bE\)\s*(.*?)(?=\n\s*[A-Z]\)|\Z)", normalized)
    return _compact_text(match.group(1)) if match else ""


def _faa_notam_id(record, raw_text, requested_location, type_code, index):
    if isinstance(record, dict):
        value = _deep_first_scalar(record, FAA_NOTAM_ID_FIELD_NAMES)
        if value not in (None, ""):
            return value
    match = re.search(r"\b[A-Z]\d{4}/\d{2}\b", str(raw_text or ""))
    if match:
        return match.group(0)
    return _stable_id("faa_notam", requested_location, type_code, raw_text, index)


def _deep_first_string(value, keys):
    wanted = {str(key).lower() for key in keys}
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).lower() in wanted and isinstance(item, str) and item.strip():
                return item.strip()
        for item in value.values():
            found = _deep_first_string(item, keys)
            if found:
                return found
    elif isinstance(value, list):
        for item in value:
            found = _deep_first_string(item, keys)
            if found:
                return found
    return ""


def _deep_first_scalar(value, keys):
    wanted = {str(key).lower() for key in keys}
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).lower() in wanted and not isinstance(item, (dict, list)):
                return item
        for item in value.values():
            found = _deep_first_scalar(item, keys)
            if found not in (None, ""):
                return found
    elif isinstance(value, list):
        for item in value:
            found = _deep_first_scalar(item, keys)
            if found not in (None, ""):
                return found
    return None


def _deep_string_values(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _deep_string_values(item)
    elif isinstance(value, list):
        for item in value:
            yield from _deep_string_values(item)


def _compact_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _request_payload(url, params=None, headers=None, auth=None, method="GET", data=None):
    response = requests.request(
        method,
        url,
        params=params,
        headers=headers,
        auth=auth,
        data=data,
        timeout=HTTP_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    content_type = response.headers.get("content-type", "").lower()
    text = response.text
    if "json" in content_type or text.lstrip().startswith(("{", "[")):
        return response.json()
    return text


def _normalize_payload(payload, source_name, source_group, default_kind):
    if isinstance(payload, str):
        stripped = payload.lstrip()
        if stripped.startswith("<"):
            return _features_from_xml(payload, source_name, source_group, default_kind)
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            return []

    features = []
    if isinstance(payload, dict) and payload.get("type") == "FeatureCollection":
        for index, feature in enumerate(payload.get("features") or []):
            normalized = _normalize_feature(feature, source_name, source_group, default_kind, index)
            if normalized:
                features.append(normalized)
        return features

    for index, record in enumerate(_iter_records(payload)):
        geometry = _extract_geometry(record)
        if not geometry:
            continue
        props = record.get("properties") if isinstance(record.get("properties"), dict) else record
        features.append(
            {
                "type": "Feature",
                "geometry": geometry,
                "properties": _canonical_properties(dict(props), source_name, source_group, default_kind, index),
            }
        )
    return features


def _normalize_feature(feature, source_name, source_group, default_kind, index):
    if not isinstance(feature, dict):
        return None
    geometry = _normalize_geometry(feature.get("geometry"))
    if not geometry:
        return None
    props = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
    return {
        "type": "Feature",
        "geometry": geometry,
        "properties": _canonical_properties(dict(props), source_name, source_group, default_kind, index),
    }


def _canonical_properties(props, source_name, source_group, default_kind, index):
    name = _first_value(props, NAME_FIELD_NAMES) or default_kind
    reason = _first_value(props, REASON_FIELD_NAMES) or default_kind
    issued_at = _extract_datetime(props, TIME_FIELD_NAMES)
    expires_at = _extract_datetime(props, EXPIRY_FIELD_NAMES)
    altitude_limits = _altitude_limits(props)
    risk_level = _risk_level(props, reason, default_kind)
    canonical_id = _first_value(props, ("id", "identifier", "notamNumber", "NOTAM", "notam_id"))
    if not canonical_id:
        canonical_id = _stable_id(source_group, name, reason, index)

    props.update(
        {
            "id": str(canonical_id),
            "name": str(name),
            "reason": str(reason),
            "altitudeLimits": altitude_limits,
            "riskLevel": risk_level,
            "source": source_name,
            "source_group": source_group,
            "source_type": "live",
            "restriction_kind": default_kind,
        }
    )
    if issued_at:
        props["issued_at"] = issued_at
    if expires_at:
        props["expires_at"] = expires_at
    return props


def _features_from_xml(xml_text, source_name, source_group, default_kind):
    try:
        root = ElementTree.fromstring(xml_text.encode("utf-8"))
    except ElementTree.ParseError:
        return []

    features = []

    def walk(element, ancestors):
        next_ancestors = ancestors + [element]
        if _local_name(element.tag) == "poslist" and element.text:
            ring = _parse_pos_list(element.text)
            if ring:
                context = next_ancestors[-5:]
                context_text = " ".join(_element_text(item) for item in context)
                times = [_to_iso8601(item) for item in _ISO_TIME_RE.findall(context_text)]
                times = [item for item in times if item]
                props = {
                    "name": _xml_first_text(context, ("designator", "name", "identifier")) or default_kind,
                    "reason": _xml_first_text(context, ("annotation", "note", "purpose", "type")) or default_kind,
                    "issued_at": times[0] if times else None,
                    "expires_at": times[-1] if len(times) > 1 else None,
                }
                features.append(
                    {
                        "type": "Feature",
                        "geometry": {"type": "Polygon", "coordinates": [_close_ring(ring)]},
                        "properties": _canonical_properties(props, source_name, source_group, default_kind, len(features)),
                    }
                )
        for child in list(element):
            walk(child, next_ancestors)

    walk(root, [])
    return _dedupe_features(features)


_ISO_TIME_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?")


def _parse_pos_list(text):
    try:
        values = [float(item) for item in re.split(r"[\s,]+", text.strip()) if item]
    except ValueError:
        return []
    if len(values) < 6:
        return []
    coords = []
    for idx in range(0, len(values) - 1, 2):
        lat = values[idx]
        lon = values[idx + 1]
        if -90 <= lat <= 90 and -180 <= lon <= 180:
            coords.append([lon, lat])
    return _close_ring(coords) if len(coords) >= 3 else []


def _iter_records(payload):
    if isinstance(payload, list):
        for item in payload:
            if isinstance(item, dict):
                yield item
        return
    if not isinstance(payload, dict):
        return
    for key in ("features", "data", "results", "items", "records", "notams", "notam", "restrictions"):
        value = payload.get(key)
        if isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    yield item
            return
        if isinstance(value, dict):
            yield from _iter_records(value)
            return
    yield payload


def _extract_geometry(record):
    if not isinstance(record, dict):
        return None

    for key in ("geometry", "geojson", "geoJson", "shape"):
        value = record.get(key)
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                value = None
        geometry = _normalize_geometry(value)
        if geometry:
            return geometry

    for key in ("coordinates", "polygon", "boundary", "points"):
        value = record.get(key)
        geometry = _geometry_from_coordinate_value(value)
        if geometry:
            return geometry

    lat = _number_from_record(record, ("latitude", "lat", "center_latitude", "centerLat"))
    lon = _number_from_record(record, ("longitude", "lon", "lng", "center_longitude", "centerLon"))
    radius_nm = _number_from_record(record, ("radius_nm", "radiusNm", "radius", "RADIUS_NM"))
    if lat is not None and lon is not None and radius_nm is not None:
        return {"type": "Polygon", "coordinates": [_circle_ring(lon, lat, radius_nm)]}

    return None


def _normalize_geometry(geometry):
    if not isinstance(geometry, dict):
        return None
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if geometry_type == "Polygon" and isinstance(coordinates, list):
        rings = [_normalize_lonlat_ring(ring) for ring in coordinates if isinstance(ring, list)]
        rings = [ring for ring in rings if ring]
        if rings:
            return {"type": "Polygon", "coordinates": rings}
    if geometry_type == "MultiPolygon" and isinstance(coordinates, list):
        polygons = []
        for polygon in coordinates:
            if not isinstance(polygon, list):
                continue
            rings = [_normalize_lonlat_ring(ring) for ring in polygon if isinstance(ring, list)]
            rings = [ring for ring in rings if ring]
            if rings:
                polygons.append(rings)
        if polygons:
            return {"type": "MultiPolygon", "coordinates": polygons}
    return None


def _geometry_from_coordinate_value(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return None
    if not isinstance(value, list):
        return None
    if value and all(_is_pair(item) for item in value):
        ring = _normalize_latlon_or_lonlat_ring(value)
        return {"type": "Polygon", "coordinates": [ring]} if ring else None
    if value and all(isinstance(item, list) for item in value):
        rings = [_normalize_latlon_or_lonlat_ring(ring) for ring in value if all(_is_pair(item) for item in ring)]
        rings = [ring for ring in rings if ring]
        return {"type": "Polygon", "coordinates": rings} if rings else None
    return None


def _normalize_lonlat_ring(ring):
    coords = []
    for point in ring:
        if not _is_pair(point):
            continue
        lon = _as_float(point[0])
        lat = _as_float(point[1])
        if lon is None or lat is None:
            continue
        if -180 <= lon <= 180 and -90 <= lat <= 90:
            coords.append([lon, lat])
    return _close_ring(coords) if len(coords) >= 3 else []


def _normalize_latlon_or_lonlat_ring(ring):
    coords = []
    for point in ring:
        first = _as_float(point[0])
        second = _as_float(point[1])
        if first is None or second is None:
            continue
        if abs(first) <= 90 and abs(second) <= 180 and abs(second) > 60:
            lat, lon = first, second
        elif abs(first) <= 180 and abs(second) <= 90:
            lon, lat = first, second
        else:
            lat, lon = first, second
        if -90 <= lat <= 90 and -180 <= lon <= 180:
            coords.append([lon, lat])
    return _close_ring(coords) if len(coords) >= 3 else []


def _circle_ring(lon, lat, radius_nm, steps=48):
    radius_km = float(radius_nm) * 1.852
    lat_rad = math.radians(lat)
    earth_radius_km = 6371.0
    ring = []
    for idx in range(steps):
        bearing = 2 * math.pi * idx / steps
        d = radius_km / earth_radius_km
        point_lat = math.asin(
            math.sin(lat_rad) * math.cos(d)
            + math.cos(lat_rad) * math.sin(d) * math.cos(bearing)
        )
        point_lon = math.radians(lon) + math.atan2(
            math.sin(bearing) * math.sin(d) * math.cos(lat_rad),
            math.cos(d) - math.sin(lat_rad) * math.sin(point_lat),
        )
        ring.append([math.degrees(point_lon), math.degrees(point_lat)])
    return _close_ring(ring)


def _dedupe_features(features):
    seen = set()
    deduped = []
    for feature in features:
        props = feature.get("properties") or {}
        feature_id = props.get("id") or _stable_id(
            props.get("source_group", "unknown"),
            props.get("name", ""),
            props.get("reason", ""),
            len(deduped),
        )
        key = str(feature_id)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(feature)
    return deduped


def _feature_is_expired(feature):
    props = feature.get("properties") if isinstance(feature, dict) else {}
    expires_at = props.get("expires_at") if isinstance(props, dict) else None
    parsed = _parse_datetime_value(expires_at)
    if not parsed:
        return False
    return parsed.timestamp() < time.time() - 60


def _source_type(feature):
    props = feature.get("properties") if isinstance(feature, dict) else {}
    return props.get("source_type") if isinstance(props, dict) else None


def _risk_level(props, reason, default_kind):
    existing = _first_value(props, ("riskLevel", "risk_level", "severity"))
    if existing:
        text = str(existing)
        if "critical" in text.lower() or "no-fly" in text.lower():
            return "Critical (No-Fly)"
        return "High Risk (Advisory)" if "high" in text.lower() else text
    text = f"{reason} {default_kind}".lower()
    if any(term in text for term in CRITICAL_TERMS):
        return "Critical (No-Fly)"
    return "High Risk (Advisory)"


def _altitude_limits(props):
    existing = _first_value(props, ("altitudeLimits", "altitude_limits", "altitude"))
    if existing:
        return str(existing)
    low = _first_value(props, ("base", "altitudeLow1", "ALT_LMT_LO", "lowerLimit", "lower_limit")) or "SFC"
    high = _first_value(props, ("top", "altitudeHi1", "ALT_LMT_HI", "upperLimit", "upper_limit")) or "UNL"
    if low != "SFC" or high != "UNL":
        return f"{low} - {high}"
    return "SFC - UNL"


def _first_value(props, keys):
    lower_map = {str(key).lower(): value for key, value in props.items()}
    for key in keys:
        value = lower_map.get(str(key).lower())
        if value not in (None, ""):
            return value
    return None


def _extract_datetime(props, keys):
    value = _first_value(props, keys)
    parsed = _to_iso8601(value)
    if parsed:
        return parsed
    for key in ALTITUDE_FIELD_NAMES + REASON_FIELD_NAMES:
        text = _first_value(props, (key,))
        if not text:
            continue
        match = _ISO_TIME_RE.search(str(text))
        if match:
            parsed = _to_iso8601(match.group(0))
            if parsed:
                return parsed
    return None


def _to_iso8601(value):
    parsed = _parse_datetime_value(value)
    if not parsed:
        return None
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_datetime_value(value):
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        timestamp = value / 1000 if value > 10_000_000_000 else value
        return datetime.fromtimestamp(timestamp, tz=timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    parsed = parse_datetime(text)
    if parsed is None:
        try:
            parsed = parsedate_to_datetime(text)
        except (TypeError, ValueError, IndexError, OverflowError):
            parsed = None
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _xml_first_text(elements, local_names):
    names = {name.lower() for name in local_names}
    for element in reversed(elements):
        for child in element.iter():
            if _local_name(child.tag) in names and child.text and child.text.strip():
                return child.text.strip()
    return None


def _element_text(element):
    return " ".join(text.strip() for text in element.itertext() if text and text.strip())


def _local_name(tag):
    return str(tag).rsplit("}", 1)[-1].lower()


def _stable_id(*parts):
    digest = hashlib.sha1("|".join(str(part) for part in parts).encode("utf-8")).hexdigest()[:12]
    return f"restriction-{digest}"


def _source_meta(status, features, **extra):
    meta = {"status": status, "features": features}
    for key, value in extra.items():
        if value not in (None, "", [], {}):
            meta[key] = value
    return meta


def _safe_url(url):
    try:
        parsed = urlparse(url)
        return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
    except Exception:
        return ""


def _utc_now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _is_pair(value):
    return isinstance(value, (list, tuple)) and len(value) >= 2


def _as_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _number_from_record(record, keys):
    value = _first_value(record, keys)
    return _as_float(value)


def _close_ring(ring):
    if not ring:
        return ring
    return ring if ring[0] == ring[-1] else ring + [ring[0]]
