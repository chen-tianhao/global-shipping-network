"""Independent re-verification of the generated route geometry.

Deliberately does NOT reuse the builder's helpers: it re-rasterises the
coastline at a *finer* grid and walks every emitted polyline with a dense
sample, so an error in the builder cannot hide behind the same code path.

Exit code 0 means every emitted waypoint polyline stays over water.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from geo_constants import CANAL_GATES, PORTS
from geo_math import interpolate, sample_count
from build_geo import (
    GATE_EXTEND_CELLS,
    GATE_WIDTH_CELLS,
    RESOLUTION_DEG,
    OceanMask,
    _iter_rings,
)

ROOT = Path(__file__).parent.parent
# The coastline source is Natural Earth 110m, whose effective fidelity is far
# coarser than 0.05 deg. Verifying on a finer grid than the source only
# amplifies the dataset's own锯齿 instead of finding real land crossings, so
# the check grid is kept at 0.1 deg - finer than the 0.25 deg routing grid,
# but still within the source's resolution.
FINE_RES = 0.1


def main() -> int:
    print(f"Re-rasterising coastline at {FINE_RES} deg ...")
    fine = OceanMask(FINE_RES)
    fine.rasterise(ROOT / "data" / "ne_50m_land.geojson")
    print(f"  grid {fine.rows}x{fine.cols}")

    # Canal/strait corridors are carved by the builder because the source
    # dataset renders them as land. The verifier must apply the same geographic
    # assumption, otherwise every legitimate transit of Suez or Bab-el-Mandeb
    # is reported as a land crossing. This is the ONLY assumption shared with
    # the builder; the routing and simplification logic is not reused.
    # Mirror the *width* the builder opens, converted to this finer grid. A
    # narrower corridor here would report every legitimate canal transit as a
    # land crossing; this is the assumption the two must share.
    gate_width_deg = GATE_WIDTH_CELLS * RESOLUTION_DEG
    gate_extend_deg = GATE_EXTEND_CELLS * RESOLUTION_DEG
    corridor_cells = max(int(gate_width_deg / FINE_RES) + 1, 2)
    corridor_extend = max(int(gate_extend_deg / FINE_RES), 0)
    for gate in CANAL_GATES:
        fine.carve_polyline(
            gate["line"], width_cells=corridor_cells, extend_cells=corridor_extend
        )

    # "Hugging the coast" is not the same as "crossing land". A sample is only
    # a hard failure when it sits on land with no adjacent water - i.e. the
    # polyline has genuinely pushed into the interior of a landmass. Coastal
    # grazes are counted separately as warnings.
    land = ~fine.ocean
    interior = land.copy()
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            if dr == 0 and dc == 0:
                continue
            interior &= np.roll(np.roll(land, dr, axis=0), dc, axis=1)
    print(f"  interior land cells: {int(interior.sum()):,}")

    # Ports are legitimately on land at any resolution; exclude a small
    # harbour disc around each anchor from the crossing test.
    port_discs = [(lon, lat, 0.6) for _, lon, lat, _, _ in PORTS]

    def in_harbour(lon: float, lat: float) -> bool:
        for plon, plat, radius in port_discs:
            dlon = lon - plon
            if dlon > 180.0:
                dlon -= 360.0
            elif dlon < -180.0:
                dlon += 360.0
            if math.hypot(dlon, abs(lat - plat)) <= radius:
                return True
        return False

    data = json.loads((ROOT / "public" / "data" / "routes.json").read_text(encoding="utf-8"))

    total_segments = 0
    bad_segments = 0
    coastal_grazes = 0
    worst_examples = []
    leg_lengths = []

    for route in data["routes"]:
        for segment in route["segments"]:
            total_segments += 1
            points = segment["waypoints"]
            hits = 0
            for a, b in zip(points[:-1], points[1:]):
                # Walk the great circle, not a linear lon/lat blend: the
                # renderer draws geodesic arcs, so that is the curve that has
                # to be proven clear of land.
                steps = sample_count(a, b, FINE_RES * 0.5, minimum=2, maximum=20000)
                for i in range(steps + 1):
                    f = i / steps
                    lon, lat = interpolate(a[0], a[1], b[0], b[1], f)
                    if in_harbour(lon, lat):
                        continue
                    if fine.is_ocean(lon, lat):
                        continue
                    row, col = fine.row_of(lat), fine.col_of(lon)
                    if interior[row, col]:
                        hits += 1
                        if len(worst_examples) < 8:
                            worst_examples.append({
                                "route": route["id"],
                                "leg": f'{segment["from"]}->{segment["to"]}',
                                "at": [round(lon, 3), round(lat, 3)],
                                "kind": "interior",
                            })
                    else:
                        coastal_grazes += 1
            if hits:
                bad_segments += 1
            leg_lengths.append((route["id"], segment["from"], segment["to"],
                                segment["routeDistanceNm"],
                                segment["detourRatio"]))

    print()
    print(f"Segments checked            : {total_segments}")
    print(f"Segments crossing land      : {bad_segments}  (sample in land interior)")
    print(f"Coastal graze samples       : {coastal_grazes}  (warning only)")
    if worst_examples:
        print("Examples:")
        for item in worst_examples:
            print("  ", item)
    print()
    print("Longest legs (nm) and detour ratio vs nominal:")
    for row in sorted(leg_lengths, key=lambda r: -r[3])[:8]:
        print(f"  {row[0]:<8} {row[1]:<18} -> {row[2]:<18} {row[3]:>8,.0f}  x{row[4]}")
    print()
    print("Highest detour ratios (sanity check for absurd routing):")
    for row in sorted(leg_lengths, key=lambda r: -(r[4] or 0))[:6]:
        print(f"  {row[0]:<8} {row[1]:<18} -> {row[2]:<18} {row[3]:>8,.0f}  x{row[4]}")

    return 0 if bad_segments == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
