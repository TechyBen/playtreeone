// Live weather from Open-Meteo (free, no key, non-commercial use):
// https://open-meteo.com/en/docs
//
// Privacy: requests carry only latitude/longitude rounded to 0.1 deg
// (about 10 km). Town lookups go to Open-Meteo's geocoder once, when asked.
// The last reading is cached in localStorage so offline starts still have
// weather.

const CACHE_KEY = 'treeps1.weather';
const FIELDS = 'temperature_2m,precipitation,rain,showers,snowfall,cloud_cover,visibility,wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code';

// WMO weather codes -> short labels.
const CODES = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'heavy showers', 85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm, hail', 99: 'thunderstorm, hail',
};

export const round1 = v => Math.round(v * 10) / 10;

export async function lookupTown(name) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(name)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`town lookup failed (${r.status})`);
  const hit = (await r.json()).results?.[0];
  if (!hit) throw new Error(`no place called "${name}"`);
  return {
    label: [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(', '),
    lat: round1(hit.latitude), lon: round1(hit.longitude),
  };
}

export async function fetchWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${round1(lat)}&longitude=${round1(lon)}` +
    `&current=${FIELDS}&wind_speed_unit=ms&timezone=auto`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`weather request failed (${r.status})`);
  const c = (await r.json()).current;
  const w = {
    at: Date.now(), lat: round1(lat), lon: round1(lon),
    temp: c.temperature_2m, cloud: c.cloud_cover / 100, visibility: c.visibility,
    rain: (c.rain || 0) + (c.showers || 0), snow: c.snowfall || 0, precip: c.precipitation || 0,
    wind: c.wind_speed_10m, gusts: c.wind_gusts_10m, windFrom: c.wind_direction_10m, code: c.weather_code,
  };
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(w)); } catch { /* storage may be blocked */ }
  return w;
}

export function cachedWeather(maxAgeHours = 6) {
  try {
    const w = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (w && Date.now() - w.at < maxAgeHours * 3600e3) return w;
  } catch { /* ignore */ }
  return null;
}

// Meteorological "wind from" (degrees clockwise from north) -> unit [x, z]
// the wind blows toward, in scene axes (-Z north, +X east).
export function windVector(fromDeg) {
  const a = (fromDeg * Math.PI) / 180;
  return [-Math.sin(a), Math.cos(a)];
}

// Reading -> scene effects, all 0..1 except fog (a density, or null = preset).
export function toScene(w) {
  const code = w.code ?? 0;
  const freezing = w.temp !== undefined && w.temp < 1;
  let rain = Math.min(1, w.rain / 4); // 4 mm/h is heavy
  let snow = Math.min(1, w.snow / 1); // 1 cm/h is heavy
  let sleet = 0, hail = 0;
  if (code >= 51 && code <= 55) rain = Math.max(rain, 0.15); // drizzle
  if (freezing && w.precip > 0 && snow === 0) { snow = Math.min(1, w.precip / 2); rain = 0; }
  // Rain and snow together near freezing is sleet; so are freezing rain/drizzle and snow grains.
  if (rain > 0 && snow > 0) { sleet = Math.min(1, (rain + snow) / 2); rain *= 0.3; snow *= 0.5; }
  if ([56, 57, 66, 67, 77].includes(code)) sleet = Math.max(sleet, 0.35);
  if (code === 96 || code === 99) hail = 0.6;
  // Koschmieder: extinction ~ 3.9 / visibility.
  let fog = w.visibility ? Math.min(0.1, Math.max(0.003, 3.9 / w.visibility)) : null;
  if (code === 45 || code === 48) fog = Math.max(fog ?? 0, 0.07);
  return {
    cloud: Math.min(1, Math.max(0, w.cloud ?? 0)),
    fog, rain, snow, sleet, hail,
    wind: Math.min(1, Math.max(0.05, (w.gusts ?? w.wind ?? 5) / 18)),
    dir: windVector(w.windFrom ?? 245),
    label: `${CODES[code] ?? 'weather'}, ${Math.round(w.temp)}°C, wind ${Math.round(w.wind)} m/s`,
  };
}
