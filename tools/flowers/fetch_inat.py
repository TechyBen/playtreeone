"""Step 1 of the flower data: what's recorded in flower, where and when.

For every 10-degree land cell and each quarter of the year, asks iNaturalist
for the flowering plants (research-grade observations annotated "Flowering")
recorded there most often. Results are cached per request in cache/, so the
script can be stopped and rerun; it never needs to run again once the cache is
complete.

    python tools/flowers/fetch_inat.py

About 1 request per second, as iNaturalist asks. Data: iNaturalist
(https://www.inaturalist.org), counts of research-grade observations.
"""
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / 'cache'
API = 'https://api.inaturalist.org/v1/observations/species_counts'
UA = 'playtreeone-flower-build (https://github.com/TechyBen/playtreeone)'
CELL = 10
# Quarters by calendar month: Dec-Feb, Mar-May, Jun-Aug, Sep-Nov.
QUARTERS = ['12,1,2', '3,4,5', '6,7,8', '9,10,11']
BASE = {'taxon_id': 47125, 'quality_grade': 'research', 'term_id': 12, 'term_value_id': 13}


def get(params, path):
    if path.exists():
        return json.loads(path.read_text())
    url = API + '?' + urllib.parse.urlencode({**BASE, **params})
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.load(r)
            break
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503):
                time.sleep(10 * (attempt + 1))
                continue
            raise
        except urllib.error.URLError:
            time.sleep(10 * (attempt + 1))
    else:
        raise SystemExit(f'gave up on {url}')
    slim = {'total': data.get('total_results', 0),
            'species': [[r['count'], r['taxon']['id'], r['taxon']['name'], r['taxon'].get('preferred_common_name', '')]
                        for r in data.get('results', [])]}
    path.write_text(json.dumps(slim))
    time.sleep(1.1)
    return slim


def main():
    CACHE.mkdir(exist_ok=True)
    cells = [(lat, lng) for lat in range(-60, 80, CELL) for lng in range(-180, 180, CELL)]
    live = []
    for i, (lat, lng) in enumerate(cells):
        box = {'swlat': lat, 'swlng': lng, 'nelat': lat + CELL, 'nelng': lng + CELL}
        any_ = get({**box, 'per_page': 1}, CACHE / f'{lat}_{lng}_all.json')
        if any_['total']:
            live.append((lat, lng))
        if i % 50 == 0:
            print(f'scan {i}/{len(cells)}, {len(live)} cells with flowers', flush=True)
    print(f'{len(live)} cells with flowering records', flush=True)
    for i, (lat, lng) in enumerate(live):
        box = {'swlat': lat, 'swlng': lng, 'nelat': lat + CELL, 'nelng': lng + CELL}
        for q, months in enumerate(QUARTERS):
            get({**box, 'month': months, 'per_page': 40}, CACHE / f'{lat}_{lng}_q{q}.json')
        if i % 20 == 0:
            print(f'seasons {i}/{len(live)}', flush=True)
    print('done', flush=True)


if __name__ == '__main__':
    main()
