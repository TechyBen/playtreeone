// Type a place instead of coordinates: "Paris", "Portland, US", "51.5, -0.1".
// Towns come from the built-in table in citydata.js (loaded only when a town
// is looked up), so nothing is searched online.

import { round1 } from './weather.js';

// Lower case, accents and punctuation dropped, so "Koln", "köln" and
// "Köln" all match, and "Saint" / "St" (or "Mount" / "Mt") are the same.
const plain = s => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[’'`.]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  .replace(/(^| )saint( |$)/g, '$1st$2').replace(/(^| )mount( |$)/g, '$1mt$2');

let table = null;
async function towns() {
  if (!table) {
    const { CITIES } = await import('./citydata.js');
    table = CITIES.split('\n').map(line => {
      const [name, cc, lat, lon, alt] = line.split('|');
      return { name, cc, lat: +lat, lon: +lon, keys: [plain(name), ...(alt ? [plain(alt)] : [])] };
    });
  }
  return table;
}

// "lat, lon" -> {lat, lon} rounded to 0.1 degrees, or null.
export function parseLatLon(text) {
  const m = String(text || '').trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat: round1(lat), lon: round1(lon), label: `${round1(lat)}, ${round1(lon)}` };
}

// A typed place -> {label, lat, lon}, or null if nothing matches. A
// trailing two-letter country code ("Portland, US") narrows it down; an
// exact name beats a name that only starts with what was typed, and the
// bigger town wins a tie (the table is biggest first).
export async function findPlace(text) {
  const at = parseLatLon(text);
  if (at) return at;
  let q = String(text || '').trim();
  let cc = '';
  const m = q.match(/^(.*?)[,\s]+([A-Za-z]{2})$/);
  if (m && m[1].trim()) { q = m[1]; cc = m[2].toUpperCase(); }
  const key = plain(q);
  if (!key) return null;
  const list = await towns();
  const pick = test => list.find(t => (!cc || t.cc === cc) && t.keys.some(test));
  let hit = pick(k => k === key) || pick(k => k.startsWith(key + ' ')) || pick(k => k.startsWith(key));
  // "Paris FR" with a country that doesn't match: try the whole text as a name.
  if (!hit && cc) {
    const whole = plain(String(text));
    hit = list.find(t => t.keys.some(k => k === whole));
  }
  return hit ? { label: `${hit.name}, ${hit.cc}`, lat: hit.lat, lon: hit.lon } : null;
}
