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
            return {"tunnelled": True, "cells": len(path) + 1}

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
                simplified = simplify_over_water(mask, raw)
                simplified = simplify_rdp_over_water(mask, simplified)
                crossings = verify_over_water(mask, simplified)
                if crossings:
                    # Shortcuts are a rendering optimisation only; correctness
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
                routes_out.append(_pack_route(current_route_id, route_rows, current_segments))
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
        routes_out.append(_pack_route(current_route_id, route_rows, current_segments))

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


def _pack_route(route_id, route_rows, segments):
    chained: list = []
    for segment in segments:
        if not chained:
            chained.extend(segment["waypoints"])
        else:
            chained.extend(segment["waypoints"][1:])
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
