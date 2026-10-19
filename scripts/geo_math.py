"""Pure great-circle geometry shared by the builder and the verifier.

WHY THIS EXISTS
---------------
Cesium draws primitive polylines as GEODESIC arcs, i.e. great circles. An
earlier version of the builder tested "is this shortcut over water?" by
interpolating longitude and latitude linearly; over a long segment the two
curves diverge by hundreds of kilometres, which is exactly enough for a
Taiwan -> Los Angeles shortcut to be accepted while the rendered great circle
runs straight over Honshu.

Both the builder and the verifier must therefore sample the same curve the
renderer draws. These helpers are pure maths (no grid, no routing), so sharing
them does not weaken the verifier's independence.
"""

from __future__ import annotations

import math

EARTH_RADIUS_NM = 3440.065


def central_angle_rad(lon_a: float, lat_a: float, lon_b: float, lat_b: float) -> float:
    """Angle between two geographic points, in radians."""
    lon1, lat1 = math.radians(lon_a), math.radians(lat_a)
    lon2, lat2 = math.radians(lon_b), math.radians(lat_b)
    sin_dlat = math.sin((lat2 - lat1) * 0.5)
    sin_dlon = math.sin((lon2 - lon1) * 0.5)
    h = sin_dlat * sin_dlat + math.cos(lat1) * math.cos(lat2) * sin_dlon * sin_dlon
    # Clamp: floating point can push h marginally above 1 for identical points.
    return 2.0 * math.asin(math.sqrt(min(1.0, max(0.0, h))))


def distance_nm(a, b) -> float:
    """Great-circle distance in nautical miles. `a` and `b` are (lon, lat)."""
    return central_angle_rad(a[0], a[1], b[0], b[1]) * EARTH_RADIUS_NM


def interpolate(lon_a: float, lat_a: float, lon_b: float, lat_b: float, f: float):
    """Point at fraction `f` along the great circle from a to b -> (lon, lat).

    Uses spherical linear interpolation, which automatically follows the
    shorter arc, so an antimeridian crossing is handled correctly.
    """
    angle = central_angle_rad(lon_a, lat_a, lon_b, lat_b)
    if angle <= 0.0 or not math.isfinite(angle):
        return (lon_a, lat_a)

    lon1, lat1 = math.radians(lon_a), math.radians(lat_a)
    lon2, lat2 = math.radians(lon_b), math.radians(lat_b)

    sin_angle = math.sin(angle)
    wa = math.sin((1.0 - f) * angle) / sin_angle
    wb = math.sin(f * angle) / sin_angle

    x = wa * math.cos(lat1) * math.cos(lon1) + wb * math.cos(lat2) * math.cos(lon2)
    y = wa * math.cos(lat1) * math.sin(lon1) + wb * math.cos(lat2) * math.sin(lon2)
    z = wa * math.sin(lat1) + wb * math.sin(lat2)

    lat = math.atan2(z, math.hypot(x, y))
    lon = math.atan2(y, x)
    return (math.degrees(lon), math.degrees(lat))


def sample_count(a, b, step_deg: float, minimum: int = 64, maximum: int = 6000) -> int:
    """How many probes a segment needs so no grid cell can be stepped over."""
    angle = math.degrees(central_angle_rad(a[0], a[1], b[0], b[1]))
    return min(max(int(angle / step_deg) + 1, minimum), maximum)


def polyline_length_nm(points) -> float:
    total = 0.0
    for a, b in zip(points[:-1], points[1:]):
        total += distance_nm(a, b)
    return total
