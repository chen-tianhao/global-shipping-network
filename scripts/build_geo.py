"""Build geographic assets for the WSC 3D visualization.

Produces, under ``public/data/``:

* ``ports.json``       - port anchors with WGS84 coordinates.
* ``routes.json``      - every service route with **land-avoiding** geometry.
* ``geo_report.json``  - diagnostics: tunnelled ports, detour ratios, failures.

The key guarantee: no output waypoint polyline crosses land. This is achieved
by rasterising a coastline dataset into an ocean mask, carving canal/strait
gates, tunnelling river ports out to open water, then running A* on the grid
and simplifying the result *only* where the shortcut still passes a dense
ocean-mask sampling test.

Run:
    python scripts/build_geo.py --input <SimulationChallenge2026_Py/Input>
"""

from __future__ import annotations

import argparse
import heapq
import json
import math
from pathlib import Path

import numpy as np

from geo_math import (
    distance_nm,
    interpolate as great_circle_interpolate,
    polyline_length_nm as geo_polyline_length_nm,
    sample_count,
)
from geo_constants import (
    CANAL_GATES,
    OCEAN_LANDMARKS,
    PORT_ACCESS_MAX_CELLS,
    PORTS,
)

RESOLUTION_DEG = 0.25
# Land wins when the coastline is rasterised on a finer sub-grid (see
# OceanMask.rasterise). 4 seals genuine straits that the canal gates cannot
# re-open; 2 keeps small islands visible while leaving the gates effective.
RASTER_SUPERSAMPLE = 2
GATE_WIDTH_CELLS = 2
GATE_EXTEND_CELLS = 4
DETOUR_WARN_RATIO = 2.0   # a sea route this many times the nominal leg is suspect
EARTH_RADIUS_NM = 3440.065  # mean Earth radius in nautical miles


# ---------------------------------------------------------------------------
# 1. Land mask
# ---------------------------------------------------------------------------

def _iter_rings(geojson_path: Path):
    """Yield every linear ring in a GeoJSON FeatureCollection as np arrays."""
    with geojson_path.open(encoding="utf-8") as handle:
        collection = json.load(handle)

    def rings_of(geometry):
        kind = geometry.get("type")
        if kind == "Polygon":
            return geometry["coordinates"]
        if kind == "MultiPolygon":
            return [ring for poly in geometry["coordinates"] for ring in poly]
        if kind == "GeometryCollection":
            out = []
            for sub in geometry.get("geometries", []):
                out.extend(rings_of(sub))
            return out
        return []

    for feature in collection.get("features", []):
        for ring in rings_of(feature.get("geometry") or {}):
            array = np.asarray(ring, dtype=float)
            if array.shape[0] >= 4:
                yield array


class OceanMask:
    """Rasterised ocean/land grid with lon/lat <-> cell index helpers."""

    def __init__(self, resolution_deg: float = RESOLUTION_DEG):
        self.res = resolution_deg
        self.cols = int(round(360.0 / resolution_deg))
        self.rows = int(round(180.0 / resolution_deg))
        # True = ocean (passable)
        self.ocean = np.ones((self.rows, self.cols), dtype=bool)
        self._cos_lat = np.empty(self.rows, dtype=float)
        for row in range(self.rows):
            self._cos_lat[row] = math.cos(math.radians(self.lat_center(row)))

    # -- coordinate helpers -------------------------------------------------
    def col_of(self, lon: float) -> int:
        col = int((lon + 180.0) / self.res)
        return min(max(col, 0), self.cols - 1)

    def row_of(self, lat: float) -> int:
        row = int((90.0 - lat) / self.res)
        return min(max(row, 0), self.rows - 1)

    def lon_center(self, col: int) -> float:
        return -180.0 + (col + 0.5) * self.res

    def lat_center(self, row: int) -> float:
        return 90.0 - (row + 0.5) * self.res

    def is_ocean(self, lon: float, lat: float) -> bool:
        return bool(self.ocean[self.row_of(lat), self.col_of(lon)])

    def is_ocean_cell(self, row: int, col: int) -> bool:
        return bool(self.ocean[row, col])

    # -- rasterisation ------------------------------------------------------
    def rasterise(self, geojson_path: Path, supersample: int = RASTER_SUPERSAMPLE) -> None:
        """Fill land from the coastline polygons.

        A plain centre-sample rasterisation marks a cell as land only when the
        cell's centre falls inside a polygon, so anything smaller than a cell -
        islands like Oki or the Californian Channel Islands - disappears from
        the grid and ships sail straight over it. Rasterising on a finer
        sub-grid and letting land win on reduction fixes that, and also gives
        routes a safety margin off the coast.
        """
        if supersample <= 1:
            self._fill_scanline(geojson_path)
            return

        sub = OceanMask(self.res / supersample)
        sub._fill_scanline(geojson_path)
        # Land wins: a cell stays ocean only when every sub-cell is ocean.
        self.ocean = sub.ocean.reshape(
            self.rows, supersample, self.cols, supersample
        ).all(axis=(1, 3))

    def _fill_scanline(self, geojson_path: Path) -> None:
        edges_x1, edges_y1, edges_x2, edges_y2 = [], [], [], []
        for ring in _iter_rings(geojson_path):
            x1 = ring[:-1, 0]
            y1 = ring[:-1, 1]
            x2 = ring[1:, 0]
            y2 = ring[1:, 1]
            edges_x1.append(x1)
            edges_y1.append(y1)
            edges_x2.append(x2)
            edges_y2.append(y2)

        ex1 = np.concatenate(edges_x1)
        ey1 = np.concatenate(edges_y1)
        ex2 = np.concatenate(edges_x2)
        ey2 = np.concatenate(edges_y2)
        # Ignore zero-length edges.
        valid = (ey1 != ey2)
        ex1, ey1, ex2, ey2 = ex1[valid], ey1[valid], ex2[valid], ey2[valid]

        for row in range(self.rows):
            lat = self.lat_center(row)
            crosses = ((ey1 <= lat) & (lat < ey2)) | ((ey2 <= lat) & (lat < ey1))
            if not crosses.any():
                continue
            t = (lat - ey1[crosses]) / (ey2[crosses] - ey1[crosses])
            xs = np.sort(ex1[crosses] + t * (ex2[crosses] - ex1[crosses]))
            # Even-odd fill: pairs of crossings bound land spans. Holes in
            # polygons are handled automatically by the parity rule.
            for k in range(0, xs.size - 1, 2):
                c0 = self.col_of(xs[k])
                c1 = self.col_of(xs[k + 1] - 1e-9)
                self.ocean[row, c0:c1 + 1] = False

    # -- editing ------------------------------------------------------------
    def set_ocean_cell(self, row: int, col: int) -> None:
        if 0 <= row < self.rows and 0 <= col < self.cols:
            self.ocean[row, col] = True

    def carve_polyline(self, line, width_cells: int = 1, extend_cells: int = 0) -> None:
        """Force a channel along a lon/lat polyline (canals and narrow straits).

        The channel is kept 4-connected: whenever the carved cell jumps
        diagonally, an orthogonal neighbour is opened too. Without this, A*
        (which refuses diagonal moves that cut a land corner) cannot traverse
        the channel even though the cells are painted.

        `extend_cells` pushes both ends further along their own direction. When
        the coastline is rasterised conservatively the land around a strait
        grows outwards, and a gate whose endpoints stop at the old shoreline
        ends up buried in land - no longer reaching open water on either side.
        """
        line = list(line)
        if extend_cells > 0 and len(line) >= 2:
            def grow(p_from, p_to):
                dlon = p_to[0] - p_from[0]
                dlat = p_to[1] - p_from[1]
                span = max(abs(dlon), abs(dlat)) or 1.0
                step = extend_cells * self.res / span
                return [p_to[0] + dlon * step, p_to[1] + dlat * step]

            line = [grow(line[1], line[0])] + line + [grow(line[-2], line[-1])]

        half = max(width_cells - 1, 0)
        prev_row = prev_col = None
        for (lon_a, lat_a), (lon_b, lat_b) in zip(line[:-1], line[1:]):
            steps = int(max(abs(lon_b - lon_a), abs(lat_b - lat_a)) / (self.res * 0.25)) + 1
            for step in range(steps + 1):
                f = step / steps
                col = self.col_of(lon_a + (lon_b - lon_a) * f)
                row = self.row_of(lat_a + (lat_b - lat_a) * f)
                if prev_row is not None and (prev_row != row and prev_col != col):
                    self.set_ocean_cell(prev_row, col)  # keep the chain 4-connected
                for dr in range(-half, half + 1):
                    for dc in range(-half, half + 1):
                        self.set_ocean_cell(row + dr, col + dc)
                prev_row, prev_col = row, col


# ---------------------------------------------------------------------------
# 2. Port access tunnelling
# ---------------------------------------------------------------------------

def ensure_port_access(mask: OceanMask, lon: float, lat: float, max_cells: int):
    """Tunnel a port out to open water when it lands on a land cell.

    River ports (Hamburg, Antwerp) and estuary ports legitimately fall on land
    cells at this grid resolution. Returns a report dict.
    """
    row, col = mask.row_of(lat), mask.col_of(lon)
    if mask.is_ocean_cell(row, col):
        return {"tunnelled": False, "cells": 0}

    # BFS outward to the nearest ocean cell.
    visited = {(row, col)}
    queue = [(row, col)]
    came_from = {}
    while queue:
        current_row, current_col = queue.pop(0)
        if mask.is_ocean_cell(current_row, current_col):
            # Walk back and carve.
            path = []
            node = (current_row, current_col)
            while node in came_from:
                path.append(node)
                node = came_from[node]
            for r, c in path:
                mask.set_ocean_cell(r, c)
            # The port's own cell must also become ocean, otherwise the router
            # rejects the start node outright.
            mask.set_ocean_cell(row, col)
            # The tunnel is real water as far as the router is concerned, so the
            # display needs it too - otherwise the last few dozen km into a
            # river port are drawn as land under the route.
            line = [[lon, lat]] + [
                [mask.lon_center(c), mask.lat_center(r)] for r, c in reversed(path)
            ]
            return {"tunnelled": True, "cells": len(path) + 1, "line": line}

        if len(visited) > (2 * max_cells + 1) ** 2:
            break

        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nr, nc = current_row + dr, current_col + dc
            if not (0 <= nr < mask.rows and 0 <= nc < mask.cols):
                continue
            if (nr, nc) in visited:
                continue
            # Longitude wraps; latitude does not.
            visited.add((nr, nc))
            came_from[(nr, nc)] = (current_row, current_col)
            queue.append((nr, nc))

    return {"tunnelled": False, "cells": 0, "failed": True}


# ---------------------------------------------------------------------------
# 3. A* routing on the ocean grid
# ---------------------------------------------------------------------------

def _cell_distance_nm(mask: OceanMask, r0, c0, r1, c1) -> float:
    lat0, lat1 = mask.lat_center(r0), mask.lat_center(r1)
    lon0, lon1 = mask.lon_center(c0), mask.lon_center(c1)
    dlon = lon1 - lon0
    if dlon > 180.0:
        dlon -= 360.0
    elif dlon < -180.0:
        dlon += 360.0
    mean_lat = math.radians((lat0 + lat1) * 0.5)
    dx = math.radians(dlon) * math.cos(mean_lat)
    dy = math.radians(lat1 - lat0)
    return math.hypot(dx, dy) * EARTH_RADIUS_NM


def find_sea_route(mask: OceanMask, start, goal, heuristic_weight: float = 1.15):
    """A* over ocean cells. Returns a list of (row, col) or None."""
    start_row, start_col = start
    goal_row, goal_col = goal
    if not (mask.is_ocean_cell(*start) and mask.is_ocean_cell(*goal)):
        return None

    goal_lat = mask.lat_center(goal_row)
    goal_lon = mask.lon_center(goal_col)

    def heuristic(row, col):
        lat = mask.lat_center(row)
        dlon = mask.lon_center(col) - goal_lon
        if dlon > 180.0:
            dlon -= 360.0
        elif dlon < -180.0:
            dlon += 360.0
        mean_lat = math.radians((lat + goal_lat) * 0.5)
        dx = math.radians(dlon) * math.cos(mean_lat)
        dy = math.radians(goal_lat - lat)
        return math.hypot(dx, dy) * EARTH_RADIUS_NM

    open_heap = [(heuristic(start_row, start_col), 0.0, start_row, start_col)]
    g_score = {(start_row, start_col): 0.0}
    came_from: dict = {}
    closed: set = set()

    neighbours = ((1, 0), (-1, 0), (0, 1), (0, -1),
                  (1, 1), (1, -1), (-1, 1), (-1, -1))

    while open_heap:
        _, g, row, col = heapq.heappop(open_heap)
        node = (row, col)
        if node in closed:
            continue
        closed.add(node)

        if node == (goal_row, goal_col):
            path = [node]
            while node in came_from:
                node = came_from[node]
                path.append(node)
            path.reverse()
            return path

        for dr, dc in neighbours:
            n_row, n_col = row + dr, col + dc
            if not (0 <= n_row < mask.rows):
                continue
            n_col_mod = n_col % mask.cols  # longitude wraps at the antimeridian
            if not mask.is_ocean_cell(n_row, n_col_mod):
                continue
            # Diagonal moves may not cut a land corner.
            if dr and dc:
                if not (mask.is_ocean_cell(row + dr, col) and mask.is_ocean_cell(row, n_col_mod)):
                    continue
            step = _cell_distance_nm(mask, row, col, n_row, n_col_mod)
            tentative = g + step
            neighbour = (n_row, n_col_mod)
            if neighbour in closed:
                continue
            if tentative < g_score.get(neighbour, math.inf):
                g_score[neighbour] = tentative
                came_from[neighbour] = node
                priority = tentative + heuristic_weight * heuristic(n_row, n_col_mod)
                heapq.heappush(open_heap, (priority, tentative, n_row, n_col_mod))

    return None


# ---------------------------------------------------------------------------
# 4. Simplification with a hard land-crossing guard
# ---------------------------------------------------------------------------

def _segment_is_over_water(mask: OceanMask, a, b, min_samples: int = 400) -> bool:
    """Sample a segment densely enough to catch every land cell it crosses.

    The sample budget must be at least as dense as verify_over_water, otherwise
    a shortcut can pass here and fail there, and the whole leg falls back to the
    raw 28 km grid path - which is exactly what used to make every route dense.

    The walk MUST follow the great circle, because that is the curve the
    renderer draws (Cesium polylines are geodesic). Linear lon/lat
    interpolation diverges from it by hundreds of kilometres on long legs -
    enough for a Taiwan -> Los Angeles shortcut to test clean while the drawn
    arc crosses Honshu.
    """
    samples = sample_count(a, b, mask.res * 0.25, minimum=min_samples)
    for i in range(samples + 1):
        f = i / samples
        lon, lat = great_circle_interpolate(a[0], a[1], b[0], b[1], f)
        if not mask.is_ocean(lon, lat):
            return False
    return True


def simplify_over_water(mask: OceanMask, points):
    """Greedily drop intermediate points, but only when the shortcut is water."""
    if len(points) <= 2:
        return list(points)
    out = [points[0]]
    index = 0
    last = len(points) - 1
    while index < last:
        best = index + 1
        for candidate in range(last, index + 1, -1):
            if _segment_is_over_water(mask, points[index], points[candidate]):
                best = candidate
                break
        out.append(points[best])
        index = best
    return out


# Douglas-Peucker tolerance. 1.5 km is below the 0.25 deg (~28 km) grid the
# route was searched on, so it can only remove vertices that add no shape.
RDP_TOLERANCE_KM = 1.5


def _perpendicular_deg(point, start, end, cos_lat: float) -> float:
    """Distance from point to the chord, in degrees of latitude.

    A local equirectangular projection is enough at 1-2 km tolerances and
    keeps this dependency-free.
    """
    px, py = point[0] * cos_lat, point[1]
    ax, ay = start[0] * cos_lat, start[1]
    bx, by = end[0] * cos_lat, end[1]
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _rdp_indices(points, tolerance_deg: float):
    """Indices kept by Douglas-Peucker, closed rings handled explicitly."""
    count = len(points)
    if count < 3:
        return list(range(count))

    cos_lat = math.cos(math.radians(sum(point[1] for point in points) / count))
    keep = [False] * count
    keep[0] = keep[-1] = True

    if distance_nm(points[0], points[-1]) < 1e-3:
        # A closed ring first/last chord is degenerate; split at the vertex
        # farthest from the start so both halves are ordinary polylines.
        far = max(range(1, count), key=lambda i: distance_nm(points[0], points[i]))
        stack = [(0, far), (far, count - 1)]
    else:
        stack = [(0, count - 1)]

    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        worst = -1.0
        index = -1
        for i in range(a + 1, b):
            distance = _perpendicular_deg(points[i], points[a], points[b], cos_lat)
            if distance > worst:
                worst, index = distance, i
        if worst > tolerance_deg and index > 0:
            keep[index] = True
            stack.append((a, index))
            stack.append((index, b))

    return [i for i, flagged in enumerate(keep) if flagged]


def simplify_rdp_over_water(mask, points, tolerance_km: float = RDP_TOLERANCE_KM):
    """Drop redundant vertices, but never at the cost of a land crossing.

    simplify_over_water aborts a merge as soon as one cell near the chord is
    land, so it leaves long collinear runs behind: one vertex per 28 km grid
    cell even in open ocean. RDP removes those. Every accepted shortcut is
    then re-tested with the same ocean-mask sampler; if it fails, the span is
    halved and retried with the original vertex, so the final line is
    water-clear by exactly the same test that accepted the input.
    """
    if len(points) <= 3:
        return list(points)

    keep = _rdp_indices(points, tolerance_km / 111.32)
    if len(keep) < 2:
        return list(points)

    kept = [keep[0]]
    pending = keep[1:]
    while pending:
        candidate = pending[0]
        current = kept[-1]
        if candidate - current <= 1 or _segment_is_over_water(
            mask, points[current], points[candidate]
        ):
            kept.append(candidate)
            pending.pop(0)
        else:
            pending.insert(0, (current + candidate) // 2)

    return [points[i] for i in kept]


# ---------------------------------------------------------------------------
# Narrow-water handling
#
# The routing grid is 0.25 deg (~28 km), which cannot represent Suez, Malacca
# or the Elbe. Those passages are therefore *carved* open in the mask: a
# corridor of two cells is punched along a hand-drawn centreline. A* is then
# free to wander anywhere inside that ~55 km box, and it does - up to 30 km off
# the real channel, which puts the polyline over land on the display.
#
# The helpers below fix the last step: after the coarse route is found, the
# stretch that sits near a gate is replaced by the gate centreline itself, the
# remaining corners are rounded, and duplicates are removed. Everything is
# re-validated against the same ocean mask that accepted the input.
# ---------------------------------------------------------------------------

# How close a sample must be to a gate line to count as "inside the gate".
GATE_SNAP_KM = 45.0
# Land shortcuts (the grid cutting an isthmus corner) are folded in out to here.
GATE_FAR_KM = 120.0
# Channel sampling step along the centreline.
GATE_STEP_KM = 4.0
# The replaced span is trimmed to samples this close to the centreline, so the
# insertion does not leave a perpendicular hop from the approach onto the line.
GATE_TRIM_KM = 30.0
# Points this close to the line are projected onto it, which keeps the drawn
# path inside the water that build_landmask carves.
CORRIDOR_HALF_KM = RESOLUTION_DEG * 111.32 * 2.0
# Width of the channel as drawn (build_landmask carves the same number).
WATERWAY_DISPLAY_WIDTH_KM = 18.0
# Corner rounding: 35 % of the shorter adjacent leg, capped here.
FILLET_MAX_RADIUS_KM = 400.0
FILLET_CHANNEL_RADIUS_KM = 15.0
# A vertex whose course change exceeds this is a candidate for removal.
KINK_TURN_DEG = 8.0

KM_PER_NM = 1.852


def _km(a, b) -> float:
    return distance_nm(a, b) * KM_PER_NM


def _offset(point, origin):
    """Small local (dlon, dlat), unwrapped across the antimeridian."""
    dlon = point[0] - origin[0]
    if dlon > 180.0:
        dlon -= 360.0
    elif dlon < -180.0:
        dlon += 360.0
    return dlon, point[1] - origin[1]


def _unoffset(offset, origin):
    lon = origin[0] + offset[0]
    if lon > 180.0:
        lon -= 360.0
    elif lon < -180.0:
        lon += 360.0
    return lon, origin[1] + offset[1]


def _line_cumulative(line):
    """Cumulative distance in km along a polyline."""
    cum = [0.0]
    for a, b in zip(line[:-1], line[1:]):
        cum.append(cum[-1] + _km(a, b))
    return cum


def _project_on_line(point, line, cum):
    """(along_km, distance_km) of the closest point on a polyline."""
    best_along, best_dist = 0.0, float("inf")
    for i in range(len(line) - 1):
        a, b = line[i], line[i + 1]
        if cum[i + 1] - cum[i] <= 1e-9:
            continue
        cos_lat = math.cos(math.radians(a[1])) or 1e-9
        bx, by = _offset(b, a)
        px, py = _offset(point, a)
        bxk, byk = bx * cos_lat * 111.32, by * 111.32
        pxk, pyk = px * cos_lat * 111.32, py * 111.32
        seg = math.hypot(bxk, byk) or 1e-9
        t = (pxk * bxk + pyk * byk) / (seg * seg)
        t = max(0.0, min(1.0, t))
        dist = math.hypot(pxk - t * bxk, pyk - t * byk)
        if dist < best_dist:
            best_dist = dist
            best_along = cum[i] + t * seg
    return best_along, best_dist


def _point_at(along_km: float, line, cum):
    """Point at a given distance along a polyline."""
    if along_km <= 0.0:
        return tuple(line[0])
    if along_km >= cum[-1]:
        return tuple(line[-1])
    for i in range(len(cum) - 1):
        if cum[i + 1] >= along_km:
            span = cum[i + 1] - cum[i]
            f = 0.0 if span <= 1e-9 else (along_km - cum[i]) / span
            lon, lat = great_circle_interpolate(
                line[i][0], line[i][1], line[i + 1][0], line[i + 1][1], f
            )
            return lon, lat
    return tuple(line[-1])


def _subpath(line, cum, start_km: float, end_km: float, step_km: float):
    """Sample the polyline between two distances (order preserved)."""
    if end_km < start_km:
        return list(reversed(_subpath(line, cum, end_km, start_km, step_km)))
    span = end_km - start_km
    steps = max(1, int(math.ceil(span / step_km)))
    return [_point_at(start_km + span * k / steps, line, cum) for k in range(steps + 1)]


def _rdp_open(points, tolerance_km: float):
    if len(points) < 3:
        return [tuple(p) for p in points]
    return [tuple(points[i]) for i in _rdp_indices(points, tolerance_km / 111.32)]


def _bbox(points, pad_deg: float):
    lons = [p[0] for p in points]
    lats = [p[1] for p in points]
    return (
        min(lons) - pad_deg,
        min(lats) - pad_deg,
        max(lons) + pad_deg,
        max(lats) + pad_deg,
    )


def _bbox_overlap(a, b) -> bool:
    return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])


def dedupe(points, min_km: float = 0.4):
    """Drop consecutive points closer than ``min_km``.

    A zero-length segment has no bearing, so the renderer turns it into a
    degenerate join and the next vertex looks like an arbitrary spike.
    """
    if not points:
        return []
    out = [tuple(points[0])]
    for point in points[1:]:
        if _km(out[-1], point) >= min_km:
            out.append(tuple(point))
        else:
            out[-1] = tuple(point)
    return out


def collapse_retraces(points, tol_km: float = 1.5, lookback: int = 30):
    """Remove out-and-back spikes where the path retraces its own steps.

    When a route visits a port off the main track and both the approach and
    the departure reuse the same access corridor, concatenating leg waypoints
    produces a hairpin: the path goes out to the port and comes back along
    exactly the same points.  This walks the chain, detects such retraces and
    deletes them so the drawn route passes through the corridor once.

    * ``tol_km`` is 1.5 km rather than point-exact because snap_to_gates
      re-projects arrival and departure vertices onto the port gate
      centreline independently, so the two "same" endpoints can land up to
      ~1 km apart.  A tighter tolerance (0.5 km) misses these and the
      hairpin survives into the output (Jebel Ali 177 km spike).
    * ``lookback`` is deliberately small: it must catch a local spike (a port
      detour is ~10-20 vertices) but never a round-trip route whose last
      vertex legitimately coincides with its first.
    * Matching is refused at ``j == 0`` for the same reason: a closed loop
      (Singapore → … → Singapore) would otherwise be collapsed to a single
      point.
    """
    if len(points) < 3:
        return [tuple(p) for p in points]
    out: list = [tuple(points[0])]
    for p in points[1:]:
        pt = tuple(p)
        for j in range(len(out) - 1, max(0, len(out) - lookback - 1), -1):
            if j > 0 and _km(out[j], pt) < tol_km:
                del out[j + 1:]
                break
        else:
            out.append(pt)
    return out


def remove_micro_spikes(points, max_seg_km: float = 5.0,
                        min_turn_deg: float = 150.0):
    """Drop spike tips left by a failed fillet at a near-reversal.

    When both U-turn sides fail the water check the corner survives the
    fillet as-is.  On short legs (a port gate hop, a centreline jog) that
    leaves a visible hairpin.  A turn over ``min_turn_deg`` where either
    adjacent leg is sub-``max_seg_km`` is geometrically indistinguishable
    from a doubled-back spike, so the tip is simply removed.
    """
    if len(points) < 3:
        return [tuple(p) for p in points]
    out: list = [tuple(points[0])]
    removed = 0
    for i in range(1, len(points) - 1):
        a, b, c = out[-1], tuple(points[i]), tuple(points[i + 1])
        l1, l2 = _km(a, b), _km(b, c)
        if min(l1, l2) < max_seg_km and turn_deg(a, b, c) > min_turn_deg:
            removed += 1
            continue
        out.append(b)
    out.append(tuple(points[-1]))
    if removed:
        print(f"  remove_micro_spikes: dropped {removed} spike tip(s)")
    return out


def _bearing_deg(a, b) -> float:
    lat1, lat2 = math.radians(a[1]), math.radians(b[1])
    dlon = math.radians(((b[0] - a[0] + 540.0) % 360.0) - 180.0)
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return math.degrees(math.atan2(y, x))


def turn_deg(a, b, c) -> float:
    """Course change at b, in degrees (0 = straight on)."""
    t = _bearing_deg(b, c) - _bearing_deg(a, b)
    while t > 180.0:
        t -= 360.0
    while t < -180.0:
        t += 360.0
    return abs(t)


def _distance_to_line_km(point, line) -> float:
    """Shortest distance from a point to a polyline, in km."""
    best = float("inf")
    for a, b in zip(line[:-1], line[1:]):
        length = _km(a, b)
        if length <= 0.0:
            continue
        steps = max(2, int(math.ceil(length / 5.0)))
        for k in range(steps + 1):
            f = k / steps
            lon, lat = great_circle_interpolate(a[0], a[1], b[0], b[1], f)
            best = min(best, _km(point, (lon, lat)))
    return best


def simplify_kinks(mask, points, turn_threshold_deg: float = KINK_TURN_DEG,
                   max_passes: int = 4, gates=None, protect_km: float = 0.0):
    """Straighten out corners that only exist because of the routing grid.

    A* walks an 8-neighbour lattice, so a long ocean leg comes back as a few
    45-degree runs: two straight stretches joined by one hard corner somewhere
    mid-ocean. Douglas-Peucker then keeps exactly that corner, and the renderer
    draws two geodesic arcs meeting at 30-40 degrees - a visible kink.

    Removing the corner is safe whenever the shortcut is all water: the leg
    then becomes a single great circle, which is both shorter and smooth.
    Corners that are there for a reason fail the water test and stay.

    Vertices within ``protect_km`` of a gate line are left alone (apart from a
    near-reversal): the routing mask calls the whole ~55 km corridor water, so
    a shortcut across a channel bend looks legal there while the display still
    draws land next to the centreline.
    """
    pts = [tuple(p) for p in points]
    for _ in range(max_passes):
        if len(pts) < 3:
            break
        out = [pts[0]]
        changed = False
        for i in range(1, len(pts) - 1):
            a, b, c = out[-1], pts[i], pts[i + 1]
            turn = turn_deg(a, b, c)
            if turn <= turn_threshold_deg:
                out.append(b)
                continue
            if gates and protect_km > 0.0 and turn < 150.0:
                if min(_distance_to_line_km(b, g["line"]) for g in gates) < protect_km:
                    out.append(b)
                    continue
            if _segment_is_over_water(mask, a, c):
                changed = True
                continue
            out.append(b)
        out.append(pts[-1])
        pts = out
        if not changed:
            break
    return pts


def snap_to_gates(
    points,
    gates,
    mask=None,
    tolerance_km: float = GATE_SNAP_KM,
    far_km: float = GATE_FAR_KM,
    probe_step_km: float = 3.0,
    channel_step_km: float = GATE_STEP_KM,
    simplify_km: float = 1.5,
):
    """Replace every gate transit with the gate centreline.

    Proximity has to be evaluated on a *densified* copy: the simplified path has
    one vertex per ~190 km, so a leg can cut straight across a strait without a
    single vertex landing near the centreline. The path is sampled every 3 km,
    the contiguous stretch inside the corridor is replaced by the channel, and
    only the untouched head/tail are re-simplified - the channel points are kept
    verbatim so the line follows the waterway exactly.
    """
    if len(points) < 2:
        return [tuple(p) for p in points]

    current = [tuple(p) for p in points]
    pad = tolerance_km / 111.32 + 0.5
    current_box = _bbox(current, pad)

    for gate in gates:
        line = [tuple(p) for p in gate["line"]]
        if len(line) < 2:
            continue
        if not _bbox_overlap(current_box, _bbox(line, pad)):
            continue
        cum = _line_cumulative(line)
        if cum[-1] <= 0.0:
            continue

        dense = _densify(current, probe_step_km)
        projections = [_project_on_line(p, line, cum) for p in dense]

        best_start, best_end = -1, -1
        run_start = -1
        for i, (_, dist) in enumerate(projections):
            # Inside the corridor is a transit by definition. Outside it, a
            # point that the mask calls land is a shortcut across the isthmus,
            # so it belongs to the transit too - out to a wider limit.
            near = dist <= tolerance_km
            if not near and mask is not None and dist <= far_km:
                near = not mask.is_ocean(dense[i][0], dense[i][1])
            if near:
                if run_start < 0:
                    run_start = i
                if run_start >= 0 and (best_end < 0 or i - run_start > best_end - best_start):
                    best_start, best_end = run_start, i
            else:
                run_start = -1

        if best_start < 0 or best_end - best_start < 1:
            continue

        # Trim to samples that actually hug the centreline. Cutting at the
        # corridor edge would leave a ~40 km perpendicular hop onto the channel,
        # which renders as a hard 90 degree corner at the strait mouth.
        while best_start < best_end and projections[best_start][1] > GATE_TRIM_KM:
            best_start += 1
        while best_end > best_start and projections[best_end][1] > GATE_TRIM_KM:
            best_end -= 1
        if best_end - best_start < 1:
            continue

        start_km = projections[best_start][0]
        end_km = projections[best_end][0]
        if abs(end_km - start_km) < 2.0:
            continue

        channel = _subpath(line, cum, start_km, end_km, channel_step_km)

        # Keep the entry and exit samples and insert the channel *between* them,
        # so the merged polyline cannot open a gap larger than the corridor.
        merged = dense[: best_start + 1] + channel + dense[best_end:]
        merged[0] = current[0]
        merged[-1] = current[-1]

        flattened = []
        for point in merged:
            along, dist = _project_on_line(point, line, cum)
            flattened.append(
                _point_at(along, line, cum) if dist <= CORRIDOR_HALF_KM else point
            )

        current = _rdp_open(flattened, simplify_km)
        current_box = _bbox(current, pad)

    return current


def fillet(points, mask=None, max_radius_km: float = FILLET_MAX_RADIUS_KM,
           gates=None, channel_max_radius_km: float = FILLET_CHANNEL_RADIUS_KM):
    """Round interior corners with a quadratic Bezier.

    The radius is 35 % of the shorter adjacent leg, capped at ``max_radius_km``:
    a short hop is left untouched, while a corner between two ocean legs is
    spread over hundreds of kilometres instead of staying a visible kink. Inside
    a channel the radius is much smaller, because the drawn water is only
    WATERWAY_DISPLAY_WIDTH_KM wide and a big arc would run over land on screen.

    Each arc is validated on its own and the radius is halved until it clears
    land, so one blocked corner cannot cost the whole leg its smoothing.
    """
    if len(points) < 3:
        return [tuple(p) for p in points]

    out = [tuple(points[0])]
    for i in range(1, len(points) - 1):
        a, b, c = points[i - 1], points[i], points[i + 1]
        l1, l2 = _km(a, b), _km(b, c)
        turn = turn_deg(a, b, c)
        if turn < 2.0 or l1 < 1e-6 or l2 < 1e-6:
            out.append(tuple(b))
            continue

        radius = min(max_radius_km, 0.35 * l1, 0.35 * l2)
        if gates:
            if min(_distance_to_line_km(b, g["line"]) for g in gates) < GATE_TRIM_KM:
                radius = min(radius, channel_max_radius_km)

        # Work in offsets from the corner so the antimeridian is a non-issue.
        oa, oc = _offset(a, b), _offset(c, b)
        cos_lat = math.cos(math.radians(b[1]))
        la = math.hypot(oa[0] * cos_lat, oa[1]) or 1e-9
        lc = math.hypot(oc[0] * cos_lat, oc[1]) or 1e-9
        arc_km_factor = 2.0 * math.sin(math.radians(turn) / 2.0)

        arc = None
        while radius >= 1.0:
            t_a = min(1.0, radius / (la * 111.32))
            t_c = min(1.0, radius / (lc * 111.32))
            # t_a is the fraction of the way from the corner TOWARDS a; using
            # (1 - t_a) here flings the start of the arc back to the far end of
            # the leg, which turns every corner into a sweep and leaves a hook
            # where the next arc begins.
            p_start = (oa[0] * t_a, oa[1] * t_a)
            p_end = (oc[0] * t_c, oc[1] * t_c)

            # Sample by turn angle AND arc length: angle alone over-samples a
            # tight corner, length alone under-samples a long shallow sweep.
            arc_km = radius * arc_km_factor
            steps = max(2, min(24, int(math.ceil(turn / 3.0)),
                               int(math.ceil(arc_km / 3.0))))

            # For near-reversals the standard quadratic Bezier (control point
            # at the corner) degenerates to a straight line because p_start and
            # p_end are nearly opposite.  Offset the control point perpendicular
            # to the incoming direction so the curve bows sideways into a real
            # U-turn; try both sides and keep whichever clears land.
            if turn > 150.0:
                px, py = p_start
                plen = math.hypot(px, py) or 1e-9
                perp_dist = radius
                sides = [
                    (-py / plen * perp_dist, px / plen * perp_dist),
                    (py / plen * perp_dist, -px / plen * perp_dist),
                ]
            else:
                sides = [(0.0, 0.0)]

            for ctrl in sides:
                candidate = []
                for k in range(steps + 1):
                    t = k / steps
                    u = 1 - t
                    if turn > 150.0:
                        bx = (u * u * p_start[0] + 2 * u * t * ctrl[0]
                              + t * t * p_end[0])
                        by = (u * u * p_start[1] + 2 * u * t * ctrl[1]
                              + t * t * p_end[1])
                    else:
                        bx = u * u * p_start[0] + t * t * p_end[0]
                        by = u * u * p_start[1] + t * t * p_end[1]
                    candidate.append(_unoffset((bx, by), b))

                # Same sampling density as the leg-level verification. A coarser
                # probe here lets an arc through that the final check then rejects,
                # and the whole leg silently loses its smoothing.
                if mask is None or not verify_over_water(
                    mask, [out[-1]] + candidate + [c]
                ):
                    arc = candidate
                    break
            if arc is not None:
                break
            radius *= 0.5

        if arc is None:
            out.append(tuple(b))
            continue

        out.extend(arc)

    out.append(tuple(points[-1]))
    return out


def _densify(points, step_km: float):
    """Sample a polyline every ``step_km`` along the geodesic between vertices."""
    if len(points) < 2:
        return [tuple(p) for p in points]
    out = [tuple(points[0])]
    for a, b in zip(points[:-1], points[1:]):
        length = _km(a, b)
        steps = max(1, int(math.ceil(length / step_km)))
        for k in range(1, steps + 1):
            lon, lat = great_circle_interpolate(a[0], a[1], b[0], b[1], k / steps)
            out.append((lon, lat))
    return out


def smooth_leg(mask, points, gates=None):
    """Full narrow-water pipeline for one leg.

    1. drop redundant vertices, but only where the shortcut stays in water;
    2. remove grid-quantisation corners;
    3. follow the gate centrelines through every canal/strait;
    4. clean the joints the insertion creates;
    5. round the corners that are left.

    The first candidate that still passes the ocean test wins, so smoothing can
    never introduce a land crossing.
    """
    simplified = simplify_rdp_over_water(mask, simplify_over_water(mask, points))
    gates = gates or CANAL_GATES
    simplified = simplify_kinks(mask, simplified)

    snapped = dedupe(snap_to_gates(simplified, gates, mask))
    snapped = dedupe(
        simplify_kinks(
            mask,
            snapped,
            turn_threshold_deg=60.0,
            max_passes=2,
            gates=gates,
            protect_km=GATE_TRIM_KM,
        )
    )
    # Corners are rounded once, after the packed route is re-snapped (see
    # _pack_route). Doing it here as well doubles the vertex count for nothing:
    # the pack snap projects the arcs straight back onto the centreline.
    for candidate in (snapped, simplified):
        if not verify_over_water(mask, candidate):
            return candidate, 0

    crossings = verify_over_water(mask, points)
    return points, crossings


def polyline_length_nm(points) -> float:
    """Great-circle length in nautical miles (see geo_math)."""
    return geo_polyline_length_nm(points)


def verify_over_water(mask: OceanMask, points, samples: int = 400) -> int:
    """Return the number of land crossings found in a polyline (0 = clean)."""
    crossings = 0
    for a, b in zip(points[:-1], points[1:]):
        if not _segment_is_over_water(mask, a, b, samples):
            crossings += 1
    return crossings


# ---------------------------------------------------------------------------
# 5. Build pipeline
# ---------------------------------------------------------------------------

def check_global_connectivity(mask: OceanMask):
    """Assert every open-water landmark shares one connected ocean component.

    Returns ``(ok, components)`` where components maps a representative
    landmark to the list of landmarks reachable from it. A split means a canal
    gate is incomplete and vessels will take absurd detours.
    """
    def flood(start_row, start_col):
        seen = {(start_row, start_col)}
        queue = [(start_row, start_col)]
        while queue:
            row, col = queue.pop()
            for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nr = row + dr
                nc = (col + dc) % mask.cols
                if not (0 <= nr < mask.rows):
                    continue
                if (nr, nc) in seen or not mask.is_ocean_cell(nr, nc):
                    continue
                seen.add((nr, nc))
                queue.append((nr, nc))
        return seen

    components = {}
    for name, lon, lat in OCEAN_LANDMARKS:
        found = None
        for representative, cells in components.items():
            if (mask.row_of(lat), mask.col_of(lon)) in cells:
                found = representative
                break
        if found is None:
            cells = flood(mask.row_of(lat), mask.col_of(lon))
            components[name] = cells
        else:
            components[found] = components[found]

    reachable = {name: None for name, _, _ in OCEAN_LANDMARKS}
    for representative, cells in components.items():
        for name, lon, lat in OCEAN_LANDMARKS:
            if (mask.row_of(lat), mask.col_of(lon)) in cells:
                reachable[name] = representative

    groups: dict = {}
    for name, representative in reachable.items():
        groups.setdefault(representative or name, []).append(name)

    ok = len(groups) == 1
    return ok, groups


def load_csv_rows(path: Path):
    import csv
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="SimulationChallenge2026_Py/Input")
    parser.add_argument("--land", default=str(Path(__file__).parent.parent / "data" / "ne_50m_land.geojson"))
    parser.add_argument("--out", default=str(Path(__file__).parent.parent / "public" / "data"))
    args = parser.parse_args()

    input_dir = Path(args.input)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Rasterising coastline ...")
    mask = OceanMask(RESOLUTION_DEG)
    mask.rasterise(Path(args.land))
    ocean_fraction = float(mask.ocean.mean())
    print(f"  grid {mask.rows}x{mask.cols}, ocean fraction {ocean_fraction:.3f}")

    for gate in CANAL_GATES:
        mask.carve_polyline(gate["line"], width_cells=GATE_WIDTH_CELLS,
                            extend_cells=GATE_EXTEND_CELLS)
        print(f"  carved gate: {gate['name']}")

    port_lookup = {name: (lon, lat, verified, note) for name, lon, lat, verified, note in PORTS}

    print("Ensuring port sea access ...")
    port_reports = []
    for name, lon, lat, verified, note in PORTS:
        report = ensure_port_access(mask, lon, lat, PORT_ACCESS_MAX_CELLS)
        report.update({"name": name, "lon": lon, "lat": lat,
                       "verified": verified, "note": note})
        if report.get("failed"):
            print(f"  !! {name}: no ocean cell within {PORT_ACCESS_MAX_CELLS} cells")
        elif report["tunnelled"]:
            print(f"  ~  {name}: tunnelled {report['cells']} cells to open water")
        port_reports.append(report)

    ok, groups = check_global_connectivity(mask)
    if ok:
        print("  ocean landmarks: all connected")
    else:
        print(f"  !! ocean landmarks split into {len(groups)} components:")
        for members in groups.values():
            print(f"     {members}")

    print("Routing legs ...")
    segment_rows = load_csv_rows(input_dir / "route_segments.csv")
    route_rows = {r["RouteId"]: r for r in load_csv_rows(input_dir / "service_routes.csv")}

    leg_cache: dict = {}
    routes_out = []
    failures = []
    detour_warnings = []
    current_route_id = None
    current_segments = []

    def route_leg(from_port: str, to_port: str):
        key = (from_port, to_port)
        if key in leg_cache:
            return leg_cache[key]
        if from_port not in port_lookup or to_port not in port_lookup:
            result = None
        else:
            start = (mask.row_of(port_lookup[from_port][1]), mask.col_of(port_lookup[from_port][0]))
            goal = (mask.row_of(port_lookup[to_port][1]), mask.col_of(port_lookup[to_port][0]))
            cell_path = find_sea_route(mask, start, goal)
            if cell_path is None:
                result = None
            else:
                raw = [[mask.lon_center(c), mask.lat_center(r)] for r, c in cell_path]
                raw[0] = [port_lookup[from_port][0], port_lookup[from_port][1]]
                raw[-1] = [port_lookup[to_port][0], port_lookup[to_port][1]]
                simplified, crossings = smooth_leg(mask, raw, CANAL_GATES)
                if crossings:
                    # Smoothing is a rendering optimisation only; correctness
                    # wins, so fall back to the unsimplified grid path.
                    simplified = raw
                    crossings = verify_over_water(mask, simplified)
                result = {
                    "waypoints": [[round(x, 4), round(y, 4)] for x, y in simplified],
                    "lengthNm": round(polyline_length_nm(simplified), 1),
                    "landCrossings": crossings,
                    "rawPoints": len(raw),
                }
        leg_cache[key] = result
        return result

    for row in segment_rows:
        route_id = row["RouteId"]
        if route_id != current_route_id:
            if current_route_id is not None:
                routes_out.append(
                _pack_route(current_route_id, route_rows, current_segments, mask)
            )
            current_route_id = route_id
            current_segments = []

        from_port = row["FromPort"]
        to_port = row["ToPort"]
        nominal = float(row["SailingDistanceNm"])
        geometry = route_leg(from_port, to_port)
        if geometry is None:
            failures.append({"route": route_id, "from": from_port, "to": to_port})
            print(f"  !! no route {from_port} -> {to_port}")
            continue
        if geometry["landCrossings"]:
            failures.append({"route": route_id, "from": from_port, "to": to_port,
                             "reason": "land crossing after simplification"})
            print(f"  !! land crossing {from_port} -> {to_port}")

        current_segments.append({
            "sequence": int(row["Sequence"]),
            "from": from_port,
            "to": to_port,
            "nominalDistanceNm": nominal,
            "routeDistanceNm": geometry["lengthNm"],
            "detourRatio": round(geometry["lengthNm"] / nominal, 3) if nominal else None,
            "waypoints": geometry["waypoints"],
            "simplifiedFrom": geometry["rawPoints"],
        })
        ratio = geometry["lengthNm"] / nominal if nominal else 0.0
        flag = ""
        if ratio > DETOUR_WARN_RATIO and nominal >= 300:
            flag = "  <== DETOUR"
            detour_warnings.append({
                "route": route_id, "from": from_port, "to": to_port,
                "routeNm": geometry["lengthNm"], "nominalNm": nominal,
                "ratio": round(ratio, 2),
            })
        print(f"  {route_id} {row['Sequence']:>2} {from_port} -> {to_port}: "
              f"{geometry['lengthNm']:,.0f} nm (nominal {nominal:,.0f}, x{ratio:.2f}), "
              f"{len(geometry['waypoints'])} pts{flag}")

    if current_route_id is not None:
        routes_out.append(
                _pack_route(current_route_id, route_rows, current_segments, mask)
            )

    berth_by_port = {
        row["PortName"]: int(float(row["BerthCount"]))
        for row in load_csv_rows(input_dir / "ports.csv")
    }

    ports_out = [
        {
            "id": _slug(name),
            "name": name,
            "lon": lon,
            "lat": lat,
            "berthCount": berth_by_port.get(name, 0),
            "coordsVerified": verified,
            "note": note,
            "tunnelledToSea": next((r["tunnelled"] for r in port_reports if r["name"] == name), False),
        }
        for name, lon, lat, verified, note in PORTS
    ]

    # The display layers need the same channels the router carves open, so the
    # land tint can show water where the route actually goes.
    (out_dir / "waterways.json").write_text(
        json.dumps({
            "widthKm": WATERWAY_DISPLAY_WIDTH_KM,
            "lines": (
                [{"id": gate["id"], "points": gate["line"]} for gate in CANAL_GATES]
                + [
                    {"id": f"port-{_slug(report['name'])}", "points": report["line"]}
                    for report in port_reports
                    if report.get("line")
                ]
            ),
        }, ensure_ascii=False, indent=2), encoding="utf-8")

    (out_dir / "ports.json").write_text(
        json.dumps({"ports": ports_out}, ensure_ascii=False, indent=2), encoding="utf-8")

    (out_dir / "routes.json").write_text(
        json.dumps({
            "grid": {"resolutionDeg": RESOLUTION_DEG, "rows": mask.rows, "cols": mask.cols},
            "routes": routes_out,
        }, ensure_ascii=False, indent=2), encoding="utf-8")

    total_legs = sum(len(r["segments"]) for r in routes_out)
    report = {
        "grid": {"resolutionDeg": RESOLUTION_DEG, "rows": mask.rows, "cols": mask.cols,
                 "oceanFraction": round(ocean_fraction, 4)},
        "ports": port_reports,
        "routeCount": len(routes_out),
        "legCount": total_legs,
        "legCacheSize": len(leg_cache),
        "failures": failures,
        "detourWarnings": detour_warnings,
    }
    (out_dir / "geo_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print()
    print(f"Routes: {len(routes_out)}, legs resolved: {total_legs}, failures: {len(failures)}")
    print(f"Output -> {out_dir}")
    return 0 if not failures else 1


def _slug(name: str) -> str:
    return "".join(ch if ch.isalnum() else "-" for ch in name.strip().lower())


def _pack_route(route_id, route_rows, segments, mask=None):
    # Second snap, and it is load-bearing: each leg is water-clear against the
    # routing mask, whose carved corridor is ~55 km wide, but the drawn channel
    # is only WATERWAY_DISPLAY_WIDTH_KM, so a leg that runs near the corridor
    # edge is still on visible land. Re-projecting the finished geometry onto
    # the centreline fixes that (Suez regresses by 400 km without it). The
    # joints it reintroduces are cleaned right after.
    if mask is not None:
        for segment in segments:
            snapped = dedupe(snap_to_gates(segment["waypoints"], CANAL_GATES, mask))
            snapped = dedupe(
                simplify_kinks(
                    mask,
                    snapped,
                    turn_threshold_deg=60.0,
                    max_passes=2,
                    gates=CANAL_GATES,
                    protect_km=GATE_TRIM_KM,
                )
            )
            # Snapping projects the path back onto the centreline, which
            # flattens any arc the per-leg pass had already rounded, so the
            # corners have to be rounded again here. Without this the whole
            # leg-level smoothing is invisible in the output.
            snapped = dedupe(fillet(snapped, mask=mask, gates=CANAL_GATES))
            segment["waypoints"] = [[round(x, 4), round(y, 4)] for x, y in snapped]

    chained: list = []
    for segment in segments:
        if not chained:
            chained.extend(segment["waypoints"])
        else:
            chained.extend(segment["waypoints"][1:])
    # The junction between two legs can retrace the same corridor (port-call
    # turnaround: the ship enters the access channel, stops, and leaves the way
    # it came).  Concatenation turns that into a hairpin spike, so collapse
    # exact retraces first, then round whatever corners remain at the seams.
    chained = collapse_retraces(chained)
    chained = dedupe(chained)
    if mask is not None:
        chained = dedupe(fillet(chained, mask=mask, gates=CANAL_GATES))
        chained = collapse_retraces(chained)
        chained = dedupe(chained)
        # Must run last: the fillet's U-turn can fail the water check and leave
        # a hairpin tip, and collapse_retraces alone only catches exact
        # retraces.  Short-leg + large-turn tips are removed here.
        chained = remove_micro_spikes(chained)
        chained = dedupe(chained)
    meta = route_rows.get(route_id, {})
    total_nm = round(sum(float(s["routeDistanceNm"]) for s in segments), 1)
    nominal_nm = round(sum(float(s["nominalDistanceNm"]) for s in segments), 1)
    return {
        "id": route_id,
        "name": meta.get("RouteName", route_id),
        "startDayOfWeek": float(meta["StartDayOfWeek"]) if meta.get("StartDayOfWeek") else None,
        "segments": segments,
        "waypoints": [[round(x, 4), round(y, 4)] for x, y in chained],
        "isAlternative": "-ALT-" in route_id,
        "totalDistanceNm": total_nm,
        "nominalDistanceNm": nominal_nm,
    }


if __name__ == "__main__":
    raise SystemExit(main())
