// scorer.js — microScore con OSM (Nominatim + Overpass) robusto
// Cambios: saco mirror FR (403), rate-limit global Overpass, más retries & fallback.
// Devuelve: { lat, lon, dSubte, dParque, dViaRapida, dFerrocarril, microScore }

const OVERPASS_ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  // "https://overpass.openstreetmap.fr/api/interpreter", // removido por 403 frecuentes
];

// Curva por tramos: a=100m (excelente), b=500m (súper bien), c=1000m (casi no aporta)
function proximityScore(d, a = 100, b = 500, c = 1000) {
  if (d == null) return 0;
  if (d <= a) return 1; // excelente
  if (d <= b) {
    // de 100 a 500m: baja suave de 1 -> 0.85
    return 1 - 0.15 * ((d - a) / (b - a));
  }
  if (d <= c) {
    // de 500 a 1000m: baja de 0.85 -> 0
    return 0.85 * (1 - (d - b) / (c - b));
  }
  return 0;
}



const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms, j = 0.25) => ms + Math.round(ms * j * Math.random());
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const haversine = (a, b) => {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x)); // metros
};

// ===== Caches en memoria =====
const geoCache = new Map();
const opCache = new Map();

// ===== Rate limit global para Overpass =====
let lastOverpassCall = 0;
async function overpassRateLimit() {
  const now = Date.now();
  const since = now - lastOverpassCall;
  const minGap = jitter(1200, 0.3); // ~1.2s entre llamadas
  if (since < minGap) await sleep(minGap - since);
  lastOverpassCall = Date.now();
}

// ===== Limpieza + variantes de dirección =====
function normalizeAddress(raw) {
  if (!raw) return null;
  let s = String(raw)
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim();

  s = s
    .replace(/\bC?\d{4}[A-Z]{0,3}\b/gi, "") // CP
    .replace(/\bCdad\.?\s+Aut[oó]noma\s+de\s+Buenos\s+Aires\b/gi, "CABA")
    .replace(/\bCapital\s+Federal\b/gi, "CABA")
    .replace(/\bCiudad\s+Aut[oó]noma\s+de\s+Buenos\s+Aires\b/gi, "CABA")
    .replace(/\bProvincia\s+de\s+Buenos\s+Aires\b/gi, "Buenos Aires")
    .replace(/\b,?\s*Argentina\b/gi, "")
    .replace(/\s*,\s*,/g, ",")
    .replace(/^\s*,\s*|\s*,\s*$/g, "")
    .trim();

  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  const seen = new Set();
  const dedup = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      dedup.push(p);
    }
  }
  return dedup.join(", ");
}

function buildAddressVariants(raw) {
  const clean = normalizeAddress(raw);
  if (!clean) return [];
  const v = new Set();
  v.add(`${clean}, CABA, Argentina`);
  v.add(`${clean}, Buenos Aires, Argentina`);
  if (/caba\b|buenos aires\b/i.test(clean)) v.add(`${clean}, Argentina`);
  if (!/caba|buenos aires/i.test(clean)) v.add(`${clean}, CABA, Argentina`);
  return Array.from(v);
}

// ===== Geocoding (Nominatim) con variantes + rate limit =====
async function geocode(rawAddress) {
  const variants = buildAddressVariants(rawAddress);
  if (!variants.length) return null;

  for (let i = 0; i < variants.length; i++) {
    const q = variants[i];
    const key = `geo:${q.toLowerCase()}`;
    if (geoCache.has(key)) {
      const cached = geoCache.get(key);
      if (cached) return cached;
      continue;
    }
    if (i > 0) await sleep(jitter(900, 0.3)); // ~1 req/s
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { headers: { "User-Agent": "fede-scraper/1.0 (personal use)" } });
      if (!res.ok) { geoCache.set(key, null); continue; }
      const js = await res.json();
      const out = js[0] ? { lat: +js[0].lat, lon: +js[0].lon } : null;
      geoCache.set(key, out);
      if (out) return out;
    } catch { geoCache.set(key, null); }
  }
  return null;
}

// ===== Overpass con endpoints + retries + rate limit =====
let printedOverpassWarn = false;
async function overpassQL(query, { retries = 4 } = {}) {
  const cacheKey = query.slice(0, 500);
  if (opCache.has(cacheKey)) return opCache.get(cacheKey);

  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    for (const base of OVERPASS_ENDPOINTS) {
      try {
        await overpassRateLimit();
        const res = await fetch(base, { method: "POST", body: query });
        if (!res.ok) {
          lastErr = new Error(`Overpass ${base} HTTP ${res.status}`);
          // 403/429/502 → saltar al próximo endpoint inmediatamente
          if ([403, 429, 502].includes(res.status)) continue;
          continue;
        }
        const js = await res.json();
        const out = js.elements || [];
        if (!Array.isArray(out) || out.length === 0) {
          lastErr = new Error(`Overpass ${base} vacío`);
          continue;
        }
        opCache.set(cacheKey, out);
        return out;
      } catch (e) {
        lastErr = e;
        continue;
      }
    }
    await sleep(jitter(700 * (attempt + 1), 0.4)); // backoff 0.7s, 1.4s, 2.1s, 2.8s (+jitter)
  }
  if (lastErr && !printedOverpassWarn) {
    console.log(`(warn) Overpass agotado tras retries: ${lastErr.message}`);
    printedOverpassWarn = true;
  }
  return [];
}

const around = (m, lat, lon) => `around:${m},${lat},${lon}`;

// ===== Distancia mínima genérica =====
async function minDistance(lat, lon, ql) {
  const elements = await overpassQL(ql, { retries: 4 });
  let best = Infinity;
  for (const e of elements) {
    const p = e.type === "node" ? { lat: e.lat, lon: e.lon } : e.center || e;
    if (p && p.lat && p.lon) {
      const d = haversine({ lat, lon }, { lat: p.lat, lon: p.lon });
      if (d < best) best = d;
    }
  }
  return Number.isFinite(best) ? best : null;
}

// ===== Distancia a SUBTE: query amplia + radios crecientes =====
async function minDistanceSubte(lat, lon, baseRadius = 1500) {
  const radii = [baseRadius, 2500, 4000];
  for (const R of radii) {
    const A = around(R, lat, lon);
    const qSubteWide = `
      [out:json][timeout:25];
      (
        node(${A})["railway"="subway_entrance"];
        node(${A})["station"="subway"];
        node(${A})["railway"="station"]["station"="subway"];
        node(${A})["railway"="stop"]["subway"="yes"];
        node(${A})["public_transport"="station"]["subway"="yes"];
        way(${A})["railway"="station"]["station"="subway"];
        relation(${A})["railway"="station"]["station"="subway"];
        // líneas mapeadas como 'railway=subway' (no solo estaciones)
        way(${A})["railway"="subway"];
        relation(${A})["railway"="subway"];
        // Apoyo por network/operator (Subte/SBASE)
        node(${A})["railway"="station"]["network"~"Subte|Buenos Aires|SBASE",i];
        way(${A})["railway"="station"]["network"~"Subte|Buenos Aires|SBASE",i];
        relation(${A})["railway"="station"]["network"~"Subte|Buenos Aires|SBASE",i];
      );
      out center;`;
    const d = await minDistance(lat, lon, qSubteWide);
    if (d != null) return d;
  }
  return null;
}

// ===== Puntaje =====
function scoreFromDistances({ dSubte, dParque, dViaRapida, dFerrocarril }) {
  // Nueva normalización: misma forma para subte y parques
  const parque = proximityScore(dParque, 100, 500, 1000);
  const subte  = proximityScore(dSubte,  100, 500, 1000);

  // Penalizaciones iguales que antes
  const via   = dViaRapida   == null ? 0 : (dViaRapida   < 80 ? -0.25 : dViaRapida   < 150 ? -0.10 : 0);
  const ferro = dFerrocarril == null ? 0 : (dFerrocarril < 80 ? -0.15 : dFerrocarril < 150 ? -0.05 : 0);

  // Pesos: parques > subte (similar forma, distinto peso)
  const wParque = 0.60;
  const wSubte  = 0.30;
  const bias    = 0.10;

  let base = wParque * parque + wSubte * subte + bias;
  base += via + ferro;

  // 0..100
  return Math.round(Math.max(0, Math.min(1, base)) * 100);
}


// ===== API principal =====
async function scoreAddress(rawAddress) {
  const p = await geocode(rawAddress);
  if (!p) {
    console.log(`(geo) No geocodificó: ${rawAddress}`);
    return { lat: null, lon: null, dSubte: null, dParque: null, dViaRapida: null, dFerrocarril: null, microScore: null };
  }

  // Respetar Nominatim (~1 req/s) con jitter
  await sleep(jitter(900, 0.3));

  const A = around(1500, p.lat, p.lon);

  const qParque = `
    [out:json][timeout:25];
    (
      way(${A})["leisure"~"park|garden"];
      relation(${A})["leisure"~"park|garden"];
      way(${A})["landuse"="recreation_ground"];
    );
    out center;`;

  const qVias = `
    [out:json][timeout:25];
    (
      way(${A})["highway"~"motorway|trunk|primary"];
    );
    out center;`;

  const qRail = `
    [out:json][timeout:25];
    (
      way(${A})["railway"="rail"];
    );
    out center;`;

  const [dSubte, dParque, dViaRapida, dFerrocarril] = await Promise.all([
    minDistanceSubte(p.lat, p.lon, 1500),
    minDistance(p.lat, p.lon, qParque),
    minDistance(p.lat, p.lon, qVias),
    minDistance(p.lat, p.lon, qRail),
  ]);

  // Log compact cuando algo queda vacío (1 cada tanto)
  if ([dSubte, dParque, dViaRapida, dFerrocarril].some(v => v == null)) {
    console.log(`(debug) ${rawAddress} → lat=${p.lat.toFixed(6)} lon=${p.lon.toFixed(6)} | subte=${dSubte} parque=${dParque} via=${dViaRapida} rail=${dFerrocarril}`);
  }

  const microScore = scoreFromDistances({ dSubte, dParque, dViaRapida, dFerrocarril });

  return { lat: p.lat, lon: p.lon, dSubte, dParque, dViaRapida, dFerrocarril, microScore };
}

module.exports = { scoreAddress };
