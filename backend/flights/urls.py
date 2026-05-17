"""URL patterns for the flights API."""

from django.urls import path
from . import views

urlpatterns = [
    path("flights/", views.FlightListView.as_view(), name="flight-list"),
    path("flights/<str:icao24>/", views.FlightDetailView.as_view(), name="flight-detail"),
    path("flights/<str:icao24>/route/", views.FlightRouteView.as_view(), name="flight-route"),
    path("anomalies/", views.AnomalyListView.as_view(), name="anomaly-list"),
    path("anomalies/history/", views.AnomalyHistoryView.as_view(), name="anomaly-history"),
    path("analytics/", views.AnalyticsView.as_view(), name="analytics"),
    path("analytics/timeline/", views.AnalyticsTimelineView.as_view(), name="analytics-timeline"),
    path("predictions/<str:icao24>/", views.PredictionView.as_view(), name="prediction"),
    path("sources/", views.DataSourceStatsView.as_view(), name="data-source-stats"),
]
