"""Build a lightweight coastline asset for the `none` base map.

With no imagery layer the globe is a plain sphere and geography is unreadable.
This script derives simplified coastline polylines from Natural Earth land
polygons so the bare-globe mode still shows continents.

Output: ``public/data/coastline.json`` -> ``{"lines": [[[lon, lat], ...], ...]}``

Simplification uses Douglas-Peucker; tiny islands are dropped to keep the file
small enough to ship with the app.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

# Tolerance in degrees. 0.12 keeps continental shapes readable while cutting
# the 50m source down by roughly an order of magnitude.
TOLERANCE_DEG = 0.12
# Rings whose bounding-box diagonal is below this are skipped (micro islands).
MIN_BBOX_DIAGONAL_DEG = 0.9


def perpendicular_distance(point, start, end):
    (px, py) = point
    (ax, ay) = start
    (bx, by) = end
    dx = bx - ax
    dy = by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def simplify(points, tolerance):
    """Iterative Douglas-Peucker."""
    if len(points) < 3:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        max_dist = 0.0
        index = -1
        for i in range(first + 1, last):
            dist = perpendicular_distance(points[i], points[first], points[last])
            if dist > max_dist:
                max_dist = dist
                index = i
        if max_dist > tolerance and index > 0:
            keep[index] = True
            stack.append((first, index))
            stack.append((index, last))
    return [p for p, k in zip(points, keep) if k]


def iter_rings(geometry):
    kind = geometry.get("type")
    coords = geometry.get("coordinates") or []
    if kind == "Polygon":
        for ring in coords:
            yield ring
    elif kind == "MultiPolygon":
        for polygon in coords:
            for ring in polygon:
                yield ring
    elif kind == "GeometryCollection":
        for child in geometry.get("geometries") or []:
            yield from iter_rings(child)


def bbox_diagonal(ring):
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return math.hypot(max(xs) - min(xs), max(ys) - min(ys))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--land",
        default=str(Path(__file__).parent.parent / "data" / "ne_50m_land.geojson"),
    )
    parser.add_argument(
        "--out",
        default=str(Path(__file__).parent.parent / "public" / "data" / "coastline.json"),
    )
    parser.add_argument("--tolerance", type=float, default=TOLERANCE_DEG)
    args = parser.parse_args()

    source = json.loads(Path(args.land).read_text(encoding="utf-8"))
    features = source.get("features") or []

    lines = []
    raw_points = 0
    for feature in features:
        geometry = feature.get("geometry") or {}
        for ring in iter_rings(geometry):
            if len(ring) < 4:
                continue
            raw_points += len(ring)
            if bbox_diagonal(ring) < MIN_BBOX_DIAGONAL_DEG:
                continue
            simplified = simplify([(float(p[0]), float(p[1])) for p in ring], args.tolerance)
            if len(simplified) < 3:
                continue
            # Close the ring so continents render as outlines, not open arcs.
            if simplified[0] != simplified[-1]:
                simplified.append(simplified[0])
            lines.append([[round(x, 3), round(y, 3)] for x, y in simplified])

    payload = {
        "source": Path(args.land).name,
        "toleranceDeg": args.tolerance,
        "lineCount": len(lines),
        "pointCount": sum(len(line) for line in lines),
        "lines": lines,
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    print(f"features: {len(features)}, raw points: {raw_points:,}")
    print(f"coastline: {payload['lineCount']} rings, {payload['pointCount']:,} points")
    print(f"output -> {out_path} ({out_path.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
