// The wildflowers for where you are and the time of year, from flowerdata.js:
// iNaturalist records of plants in flower, compressed to a few common species
// per 10-degree cell and quarter of the year (see tools/flowers/). Location is
// the rough one already used for the sun, and nothing is looked up online.
import { CELL, FLOWERS, CELLS } from './flowerdata.js';

const COLS = 360 / CELL;
const quarter = m => (m === 12 || m <= 2 ? 0 : m <= 5 ? 1 : m <= 8 ? 2 : 3);

// The cell's list, or the nearest cell that has one (spiralling out).
function cellList(lat, lon) {
  const ci = Math.floor((lat + 90) / CELL);
  const cj = Math.floor(((((lon + 180) % 360) + 360) % 360) / CELL);
  for (let r = 0; r <= 6; r++) {
    let best = null;
    for (let di = -r; di <= r; di++) {
      for (let dj = -r; dj <= r; dj++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const list = CELLS[`${ci + di},${(cj + dj + COLS) % COLS}`];
        if (list && (!best || list.length > best.length)) best = list;
      }
    }
    if (best) return best;
  }
  return [];
}

// Up to `max` species in flower now, with relative weights. If fewer than
// three flower this quarter, some from the neighbouring quarters join in at
// half weight, so the forest floor is rarely bare.
export function localFlowers(lat, lon, month, max = 8) {
  const q = quarter(month), bit = 1 << q, near = (1 << ((q + 1) % 4)) | (1 << ((q + 3) % 4));
  const list = cellList(lat, lon);
  let pick = list.filter(([, , m]) => m & bit).map(([i, w]) => ({ i, w }));
  if (pick.length < 3) {
    pick = pick.concat(list.filter(([, , m]) => !(m & bit) && (m & near)).map(([i, w]) => ({ i, w: w * 0.5 })));
  }
  pick.sort((a, b) => b.w - a.w);
  return pick.slice(0, max).map(({ i, w }) => {
    const [name, common, petal, centre, shape, height] = FLOWERS[i];
    return { name, common, petal, centre, shape, height, weight: w };
  });
}
