"""Static geographic reference data for the WSC 3D visualization.

Two tables live here:

1. ``PORTS``  - WGS84 anchor coordinates for the 22 ports in the model.
   These are approximate berth-area anchors for *visualization only*; they are
   not survey-grade nautical positions. Each entry carries a ``verified`` flag
   so the UI can mark anchors that have not been cross-checked.

2. ``CANAL_GATES`` - man-made or narrow passages that do not survive
   rasterisation at the working grid resolution (Suez, Panama, Malacca, ...).
   The router carves a channel along each gate line so vessels can pass.

Coordinate convention: WGS84, decimal degrees, longitude in [-180, 180].
"""

# ---------------------------------------------------------------------------
# Port anchor coordinates
# ---------------------------------------------------------------------------
# name must match ``ports.csv`` / the OD matrix header exactly.
# ``verified`` marks anchors that were cross-checked against public sources.

PORTS = [
    # name,              lon,        lat,      verified, note
    ("Shanghai",         121.60,     31.20,    True,  "外高桥港区/长江口"),
    ("Singapore",        103.80,      1.26,    True,  "PSA 丹戎巴葛-巴西班让"),
    ("Shenzhen",         114.27,     22.57,    True,  "盐田港区"),
    ("Qingdao",          120.19,     36.02,    True,  "前湾港区"),
    ("Busan",            128.83,     35.06,    True,  "釜山新港"),
    ("Tianjin",          117.72,     38.96,    True,  "北疆港区"),
    ("Xiamen",           118.02,     24.48,    True,  "海沧港区"),
    ("Kaohsiung",        120.28,     22.61,    True,  "中国台湾高雄港"),
    ("Laem Chabang",     100.88,     13.08,    True,  "泰国林查班港"),
    ("Ho Chi Minh City", 106.75,     10.75,    True,  "越南盖梅-莱拉港区"),
    ("Jakarta",          106.88,     -6.10,    True,  "丹戎不碌港"),
    ("Colombo",           79.84,      6.95,    True,  "斯里兰卡科伦坡港"),
    ("Jebel Ali",         55.06,     25.01,    True,  "阿联酋杰贝阿里港"),
    ("Rotterdam",          4.08,     51.95,    True,  "马斯夫拉克特港区"),
    ("Hamburg",            9.98,     53.54,    True,  "易北河沿岸港区"),
    ("Piraeus",           23.65,     37.94,    True,  "希腊比雷埃夫斯港"),
    ("Los Angeles",     -118.26,     33.74,    True,  "圣佩德罗湾区"),
    ("New Jersey",       -74.08,     40.67,    True,  "纽约-新泽西港区"),
    ("Tanger Med",        -5.50,     35.88,    True,  "摩洛哥丹吉尔地中海港"),
    ("Cartagena",        -75.51,     10.40,    True,  "哥伦比亚卡塔赫纳港"),
    ("Port Klang",       101.39,      3.00,    True,  "马来西亚巴生港"),
    ("Antwerp",            4.40,     51.26,    True,  "斯海尔德河沿岸港区"),
]

# ---------------------------------------------------------------------------
# Canal / strait gates
# ---------------------------------------------------------------------------
# Each gate is a polyline (list of [lon, lat]) that the router carves into the
# land mask, because the passage is narrower than one grid cell or is absent
# from the source dataset (canals are not natural coastline).

CANAL_GATES = [
    {
        "id": "suez",
        "name": "苏伊士运河",
        # Runs from the Red Sea main body through the Gulf of Suez to the
        # Mediterranean. Both ends must sit in open water, otherwise traffic
        # silently detours around the Cape of Good Hope.
        "line": [[36.60, 24.00], [35.20, 26.20], [34.10, 27.70], [33.30, 28.70],
                 [32.75, 29.60], [32.45, 30.40], [32.35, 31.25], [32.30, 31.70]],
    },
    {
        "id": "panama",
        "name": "巴拿马运河",
        # Pacific side -> Gatun Lake -> Caribbean side
        "line": [[-79.55, 8.93], [-79.68, 9.10], [-79.85, 9.30], [-79.92, 9.37]],
    },
    {
        "id": "malacca",
        "name": "马六甲海峡",
        # Andaman Sea -> north-west along Malacca Strait -> its south-east mouth.
        "line": [[98.50, 5.50], [100.20, 3.20], [101.60, 2.40], [102.60, 1.70]],
    },
    {
        "id": "singapore-strait",
        "name": "新加坡海峡（马六甲↔南海）",
        # The navigable link between the Malacca Strait and the South China
        # Sea passes SOUTH of Singapore island. Without this gate the South
        # China Sea is sealed off and traffic detours all the way around
        # Indonesia (Shenzhen->Singapore ballooned to 3,470 nm).
        "line": [[102.60, 1.70], [103.60, 1.20], [104.60, 1.60],
                 [105.20, 3.20], [105.90, 5.20]],
    },
    {
        "id": "bab-el-mandeb",
        "name": "曼德海峡",
        # Southern Red Sea -> Bab-el-Mandeb -> Gulf of Aden.
        "line": [[42.60, 15.20], [43.10, 13.80], [43.35, 12.70], [44.30, 12.10]],
    },
    {
        "id": "gibraltar",
        "name": "直布罗陀海峡",
        "line": [[-5.60, 35.95], [-5.55, 36.05]],
    },
    {
        "id": "bosporus",
        "name": "博斯普鲁斯-达达尼尔海峡",
        "line": [[26.20, 40.20], [28.00, 40.90], [29.05, 41.10], [29.30, 41.25]],
    },
    {
        "id": "taiwan-strait",
        "name": "台湾海峡",
        "line": [[119.00, 24.00], [119.60, 24.80], [120.00, 25.30]],
    },
    {
        "id": "sunda",
        "name": "巽他海峡",
        "line": [[105.30, -6.30], [105.85, -6.00]],
    },
    {
        "id": "elbe",
        "name": "易北河口航道（汉堡）",
        "line": [[8.60, 54.00], [9.00, 53.85], [9.55, 53.70], [9.98, 53.54]],
    },
    {
        "id": "scheldt",
        "name": "西斯海尔德水道（安特卫普）",
        "line": [[3.40, 51.45], [3.90, 51.38], [4.30, 51.28], [4.40, 51.26]],
    },
    {
        "id": "yangtze",
        "name": "长江口航道（上海）",
        "line": [[122.30, 31.10], [121.95, 31.20], [121.60, 31.20]],
    },
    {
        "id": "bohai",
        "name": "渤海湾航道（天津）",
        "line": [[118.30, 38.60], [118.00, 38.80], [117.72, 38.96]],
    },
    {
        "id": "hudson",
        "name": "纽约湾航道（新泽西）",
        "line": [[-74.00, 40.50], [-74.05, 40.60], [-74.08, 40.67]],
    },
    {
        "id": "karimata",
        "name": "卡里马塔海峡（南海↔爪哇海）",
        # Between Sumatra and Borneo; keeps South China Sea <-> Java Sea traffic
        # from having to round the outside of the archipelago.
        "line": [[106.50, -1.50], [108.00, -2.60], [109.50, -3.60]],
    },
]

# Maximum number of grid cells a port may be tunnelled through to reach open
# water. Ports sited up-river (Hamburg, Antwerp) legitimately sit on land cells
# at this resolution; larger values mean the anchor is probably wrong.
PORT_ACCESS_MAX_CELLS = 24

# ---------------------------------------------------------------------------
# Open-water landmarks used for the global connectivity assertion
# ---------------------------------------------------------------------------
# After carving, every landmark must belong to the same connected ocean
# component. If two landmarks are separated, a canal gate is incomplete (its
# ends do not actually reach open water) and vessels would be forced onto an
# absurd detour - e.g. Asia-Europe traffic rounding the Cape of Good Hope
# because the Suez channel stops short of the Red Sea.

OCEAN_LANDMARKS = [
    ("东海", 125.0, 30.0),
    ("南海", 114.0, 15.0),
    ("马六甲海峡", 101.0, 3.0),
    ("孟加拉湾", 88.0, 14.0),
    ("阿拉伯海", 65.0, 15.0),
    ("波斯湾", 52.0, 27.0),
    ("红海", 38.0, 20.0),
    ("地中海", 18.0, 35.0),
    ("北海", 3.0, 56.0),
    ("北大西洋", -30.0, 40.0),
    ("加勒比海", -75.0, 15.0),
    ("东太平洋", -130.0, 20.0),
    ("中太平洋", -170.0, 10.0),
    ("西太平洋", 150.0, 20.0),
    ("南印度洋", 75.0, -20.0),
    ("好望角外海", 20.0, -36.0),
    ("渤海", 119.5, 38.5),
]
