"""URL patterns for the flights API."""

from django.urls import path
from . import views

urlpatterns = [
    path("flights/", views.FlightListView.as_view(), name="flight-list"),
    path("flights/<str:icao24>/", views.FlightDetailView.as_view(), name="flight-detail"),
    path("flights/<str:icao24>/route/", views.FlightRouteView.as_view(), name="flight-route"),
    path("anomalies/", views.AnomalyListView.as_view(), name="anomaly-list"),
    path("anomalies/history/", views.AnomalyHistoryView.as_view(), name="anomaly-history"),
    path("anomalies/<int:pk>/explanation/", views.AnomalyExplanationView.as_view(), name="anomaly-explanation"),
    path("anomalies/<int:pk>/feedback/", views.AnomalyFeedbackView.as_view(), name="anomaly-feedback"),
    path("analytics/", views.AnalyticsView.as_view(), name="analytics"),
    path("analytics/timeline/", views.AnalyticsTimelineView.as_view(), name="analytics-timeline"),
    path("analytics/traffic/", views.TrafficAnalyticsView.as_view(), name="analytics-traffic"),
    path("analytics/routes/", views.RouteAnalyticsView.as_view(), name="analytics-routes"),
    path("analytics/anomaly-rate/", views.AnomalyRateAnalyticsView.as_view(), name="analytics-anomaly-rate"),
    path("analytics/aircraft-types/", views.AircraftTypeAnalyticsView.as_view(), name="analytics-aircraft-types"),
    path("predictions/<str:icao24>/", views.PredictionView.as_view(), name="prediction"),
    path("weather/metar/", views.MetarWeatherView.as_view(), name="weather-metar"),
    path("airspace/tfr/", views.TfrAirspaceView.as_view(), name="airspace-tfr"),
    path("airspace/restrictions/", views.AirspaceRestrictionsView.as_view(), name="airspace-restrictions"),
    path("playback/", views.PlaybackView.as_view(), name="playback"),
    path("alert-rules/", views.AlertRuleListView.as_view(), name="alert-rule-list"),
    path("alert-rules/<int:pk>/", views.AlertRuleDetailView.as_view(), name="alert-rule-detail"),
    path("sources/", views.DataSourceStatsView.as_view(), name="data-source-stats"),
    path("source-health/", views.SourceHealthView.as_view(), name="source-health"),
    path("ingestion-audits/", views.IngestionAuditView.as_view(), name="ingestion-audits"),
    path("model-status/", views.ModelStatusView.as_view(), name="model-status"),
    path("satellites/", views.SatelliteCatalogView.as_view(), name="satellite-catalog"),
]
