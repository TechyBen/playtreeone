// Real-time sun position and a coarse location guess.
//
// sunPosition() is the low-precision solar algorithm from the Astronomical
// Almanac (good to ~0.1 deg, far more than a fogged forest needs).
// Azimuth is degrees clockwise from north, which matches the scene: -Z is
// north and +X is east.
//
// Location never leaves the machine. Without a setting it is guessed from the
// browser's time zone: a representative city for common zones, otherwise
// longitude from the UTC offset and a mid latitude.

const RAD = Math.PI / 180;

const days = date => date.getTime() / 86400000 - 10957.5; // days since J2000.0
const obliquity = d => (23.439 - 0.00000036 * d) * RAD;

// Right ascension / declination (radians) -> elevation / azimuth (degrees).
function horizontal(d, ra, dec, lat, lon) {
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24; // hours
  const H = (gmst * 15 + lon) * RAD - ra; // local hour angle
  const phi = lat * RAD;
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H) * Math.cos(dec), Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(H));
  return { elevation: el / RAD, azimuth: ((az / RAD) + 360) % 360 };
}

function sunLongitude(d) {
  const g = (357.529 + 0.98560028 * d) * RAD; // mean anomaly
  const q = 280.459 + 0.98564736 * d; // mean longitude (deg)
  return (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD; // ecliptic longitude
}

export function sunPosition(date, lat, lon) {
  const d = days(date), L = sunLongitude(d), e = obliquity(d);
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  return horizontal(d, ra, dec, lat, lon);
}

// Moon: the Almanac's low-precision series (~0.3 deg), plus parallax, which
// lowers the moon by up to ~1 deg as seen from the ground. `fraction` is the
// lit part of the disc (0 new .. 1 full).
export function moonPosition(date, lat, lon) {
  const d = days(date), e = obliquity(d);
  const L = 218.316 + 13.176396 * d; // mean longitude
  const M = (134.963 + 13.064993 * d) * RAD; // mean anomaly
  const F = (93.272 + 13.22935 * d) * RAD; // argument of latitude
  const lam = (L + 6.289 * Math.sin(M)) * RAD; // ecliptic longitude
  const beta = 5.128 * Math.sin(F) * RAD; // ecliptic latitude
  const ra = Math.atan2(Math.sin(lam) * Math.cos(e) - Math.tan(beta) * Math.sin(e), Math.cos(lam));
  const dec = Math.asin(Math.sin(beta) * Math.cos(e) + Math.cos(beta) * Math.sin(e) * Math.sin(lam));
  const pos = horizontal(d, ra, dec, lat, lon);
  pos.elevation -= 0.95 * Math.cos(pos.elevation * RAD);
  const elong = Math.acos(Math.cos(beta) * Math.cos(lam - sunLongitude(d)));
  pos.fraction = (1 - Math.cos(elong)) / 2;
  pos.waxing = Math.sin(lam - sunLongitude(d)) > 0;
  return pos;
}

// Local sidereal time in radians: which right ascension is due south right now.
export function siderealTime(date, lon) {
  const d = date.getTime() / 86400000 - 10957.5;
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  return (((gmst * 15 + lon) % 360) + 360) % 360 * RAD;
}

// Representative [lat, lon] for common IANA zones (rounded: city level at most).
const ZONES = {
  'Europe/London': [51.5, -0.1], 'Europe/Dublin': [53.3, -6.3], 'Europe/Lisbon': [38.7, -9.1],
  'Europe/Paris': [48.9, 2.4], 'Europe/Madrid': [40.4, -3.7], 'Europe/Berlin': [52.5, 13.4],
  'Europe/Amsterdam': [52.4, 4.9], 'Europe/Brussels': [50.8, 4.4], 'Europe/Rome': [41.9, 12.5],
  'Europe/Stockholm': [59.3, 18.1], 'Europe/Oslo': [59.9, 10.8], 'Europe/Copenhagen': [55.7, 12.6],
  'Europe/Helsinki': [60.2, 24.9], 'Europe/Warsaw': [52.2, 21.0], 'Europe/Athens': [38.0, 23.7],
  'Europe/Moscow': [55.8, 37.6], 'America/New_York': [40.7, -74.0], 'America/Chicago': [41.9, -87.6],
  'America/Denver': [39.7, -105.0], 'America/Los_Angeles': [34.1, -118.2], 'America/Toronto': [43.7, -79.4],
  'America/Vancouver': [49.3, -123.1], 'America/Sao_Paulo': [-23.6, -46.6], 'America/Mexico_City': [19.4, -99.1],
  'Asia/Tokyo': [35.7, 139.7], 'Asia/Shanghai': [31.2, 121.5], 'Asia/Kolkata': [22.6, 77.2],
  'Asia/Singapore': [1.3, 103.8], 'Asia/Dubai': [25.2, 55.3], 'Australia/Sydney': [-33.9, 151.2],
  'Australia/Melbourne': [-37.8, 145.0], 'Australia/Perth': [-31.95, 115.9], 'Pacific/Auckland': [-36.8, 174.8],
  'Africa/Johannesburg': [-26.2, 28.0], 'Africa/Cairo': [30.0, 31.2],
};

export function estimateLocation() {
  let zone = '';
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* ignore */ }
  if (ZONES[zone]) return { lat: ZONES[zone][0], lon: ZONES[zone][1], source: zone };
  // Standard (non-DST) offset: take the larger of January / July offsets west of UTC.
  const y = new Date().getFullYear();
  const std = Math.max(new Date(y, 0, 1).getTimezoneOffset(), new Date(y, 6, 1).getTimezoneOffset());
  return { lat: 45, lon: Math.round((-std / 60) * 15), source: zone ? zone + ' (offset)' : 'UTC offset' };
}

// How much daylight there is, 0 (night) .. 1 (day), from sun elevation in degrees.
export function daylight(elevation) {
  const t = Math.min(1, Math.max(0, (elevation + 8) / 12));
  return t * t * (3 - 2 * t);
}
