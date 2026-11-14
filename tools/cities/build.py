"""The town table: type a town, get its rough coordinates, with no online search.

    python tools/cities/build.py

Downloads GeoNames' list of places with 15,000 or more people once (cached
in tools/cities/cache/, git-ignored) and writes src/citydata.js: every
town's name, country code and position rounded to 0.1 degrees (about
10 km, the same rounding the weather requests use), biggest first, so a
plain name finds the best-known place of that name.

Data: GeoNames (https://www.geonames.org), CC BY 4.0.
"""
import io
import unicodedata
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / 'cache'
ZIP = CACHE / 'cities15000.zip'
URL = 'https://download.geonames.org/export/dump/cities15000.zip'
OUT = HERE.parent.parent / 'src' / 'citydata.js'
UA = 'playtreeone-city-build (https://github.com/TechyBen/playtreeone)'


def plain(s):
    """Lower case, accents dropped: what typed names are matched against."""
    s = unicodedata.normalize('NFKD', s)
    return ''.join(c for c in s if not unicodedata.combining(c)).lower()


def main():
    CACHE.mkdir(exist_ok=True)
    if not ZIP.exists():
        req = urllib.request.Request(URL, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=120) as r:
            ZIP.write_bytes(r.read())
    with zipfile.ZipFile(ZIP) as z:
        text = z.read('cities15000.txt').decode('utf-8')
    rows = []
    for line in text.splitlines():
        f = line.split('\t')
        name, ascii_, lat, lon, cc, pop = f[1], f[2], float(f[4]), float(f[5]), f[8], int(f[14] or 0)
        if not name or '|' in name or '\n' in name:
            continue
        rows.append((pop, name, ascii_, cc, lat, lon))
    rows.sort(key=lambda r: -r[0])
    seen, lines = set(), []
    for pop, name, ascii_, cc, lat, lon in rows:
        key = (plain(name), cc, round(lat), round(lon))
        if key in seen:  # the same town listed twice (a city and its district)
            continue
        seen.add(key)
        # name|country|lat|lon, plus the plain spelling when it differs
        alt = plain(ascii_) if plain(ascii_) != plain(name) else ''
        lines.append(f'{name}|{cc}|{lat:.1f}|{lon:.1f}' + (f'|{alt}' if alt else ''))
    body = '\n'.join(lines).replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${')
    OUT.write_text(
        '// Towns of 15,000 people or more, biggest first, for typing a place instead\n'
        '// of coordinates (see cities.js). Each line: name|country|lat|lon[|plain\n'
        '// spelling], positions rounded to 0.1 degrees. Written by\n'
        '// tools/cities/build.py. Data: GeoNames (https://www.geonames.org), CC BY 4.0.\n'
        f'export const CITIES = `{body}`;\n', 'utf-8', newline='\n')
    print(f'{len(lines)} towns -> {OUT} ({OUT.stat().st_size / 1024:.0f} KB)')


if __name__ == '__main__':
    main()
