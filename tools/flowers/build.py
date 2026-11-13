"""Steps 2-3 of the flower data: choose the species and compress.

    python tools/flowers/build.py candidates   # list species with no likeness yet
    python tools/flowers/traits_auto.py        # describe them automatically
    python tools/flowers/build.py              # write src/flowerdata.js

Species are chosen round robin across the cells (each cell's most-recorded
flower, then each cell's second, ...), so every region keeps its own common
flowers instead of the list filling up with the best-recorded places. Plants
that aren't wildflowers for the forest floor (trees, shrubs, grasses, plants
whose flowers don't show) are marked "skip" and passed over.

traits.auto.json (written by traits_auto.py) and traits.json (hand
corrections, which win) give each kept species an approximate likeness: petal and
centre colour, a head shape (see FLOWER_SHAPES in src/leafgen.js) and a
typical height in metres. Each cell keeps its 12 most-recorded chosen
species with a weight (1-9) and the quarters of the year they flower in
(bit 0 Dec-Feb, 1 Mar-May, 2 Jun-Aug, 3 Sep-Nov).

Data: iNaturalist (https://www.inaturalist.org), research-grade observations
annotated as flowering.
"""
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / 'cache'
TRAITS = HERE / 'traits.json'
AUTO = HERE / 'traits.auto.json'
OUT = HERE.parent.parent / 'src' / 'flowerdata.js'
CELL = 10
TOTAL = 300
PER_CELL = 12
SHAPES = {'daisy', 'cup', 'star', 'bell', 'spike', 'umbel', 'cluster', 'trumpet'}


def load_cells():
    cells = {}
    for f in CACHE.glob('*_q*.json'):
        lat, lng, q = f.stem.split('_')
        q = int(q[1:])
        data = json.loads(f.read_text())
        cell = cells.setdefault((int(lat), int(lng)), {})
        top = data['species'][0][0] if data['species'] else 1
        for count, tid, name, common in data['species']:
            s = cell.setdefault(name, {'count': 0, 'mask': 0, 'common': common, 'id': tid})
            s['count'] += count
            # A quarter counts if the species is reasonably common in it.
            if count >= max(2, top * 0.04):
                s['mask'] |= 1 << q
    return cells


def round_robin(cells, accept, limit):
    ranked = [sorted(c.items(), key=lambda kv: -kv[1]['count']) for c in cells.values()]
    chosen, seen = [], set()
    for depth in range(max(len(r) for r in ranked)):
        for r in ranked:
            if depth < len(r):
                name, s = r[depth]
                if name not in seen and accept(name):
                    seen.add(name)
                    chosen.append((name, s['common']))
                    if len(chosen) >= limit:
                        return chosen
    return chosen


def main():
    cells = load_cells()
    print(f'{len(cells)} cells')
    # Automatic likenesses (traits_auto.py) first, hand-written ones on top.
    traits = json.loads(AUTO.read_text('utf-8')) if AUTO.exists() else {}
    traits.update(json.loads(TRAITS.read_text('utf-8')) if TRAITS.exists() else {})

    if sys.argv[1:] == ['candidates']:
        # Everything that could be chosen, described or not, in round-robin order.
        todo = round_robin(cells, lambda n: traits.get(n) != 'skip', TOTAL)
        missing = [(n, c) for n, c in todo if n not in traits]
        print(f'{len(todo)} chosen so far, {len(missing)} need traits:')
        for n, c in missing:
            print(f'{n}\t{c}')
        return

    chosen = round_robin(cells, lambda n: isinstance(traits.get(n), list), TOTAL)
    index = {name: i for i, (name, _) in enumerate(chosen)}
    flowers = []
    for name, common in chosen:
        petal, centre, shape, height = traits[name]
        assert shape in SHAPES, (name, shape)
        flowers.append([name, common, petal, centre, shape, height])
    out_cells = {}
    for (lat, lng), cell in cells.items():
        kept = sorted(((s['count'], name, s['mask']) for name, s in cell.items() if name in index and s['mask']), reverse=True)[:PER_CELL]
        if not kept:
            continue
        top = kept[0][0]
        key = f'{(lat + 90) // CELL},{(lng + 180) // CELL}'
        out_cells[key] = [[index[name], max(1, round(9 * math.sqrt(count / top))), mask] for count, name, mask in kept]

    lines = ['// Wildflowers by region and season, from iNaturalist records of plants in',
             '// flower (research grade), compressed by tools/flowers/build.py. Each species',
             '// is [scientific name, common name, petal, centre, head shape, height m];',
             '// colours and shapes are an approximate likeness, not an exact match. Each',
             '// cell ("row,col" of a 10-degree grid from -90 lat, -180 lng) lists',
             '// [species, weight 1-9, quarters in flower as bits: Dec-Feb, Mar-May,',
             '// Jun-Aug, Sep-Nov]. Data: iNaturalist, https://www.inaturalist.org',
             f'export const CELL = {CELL};',
             'export const FLOWERS = [']
    lines += [f'  {json.dumps(f, ensure_ascii=False)},' for f in flowers]
    lines += ['];', 'export const CELLS = {']
    lines += [f'  "{k}": {json.dumps(v, separators=(",", ":"))},' for k, v in sorted(out_cells.items())]
    lines += ['};', '']
    OUT.write_text('\n'.join(lines), encoding='utf-8')
    print(f'{len(flowers)} species, {len(out_cells)} cells -> {OUT} ({OUT.stat().st_size / 1024:.1f} KB)')


if __name__ == '__main__':
    main()
