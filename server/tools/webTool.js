'use strict';

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toFiniteCoordinate(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const STATE_NAME_TO_ABBR = Object.freeze({
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
  'district of columbia': 'DC',
});

function toTitleWord(token) {
  const raw = String(token || '').trim();
  if (!raw) return '';
  if (/^[a-z]{2}$/i.test(raw)) return raw.toUpperCase();
  return raw
    .toLowerCase()
    .split(/([-'’])/)
    .map((part) => {
      if (!part || /[-'’]/.test(part)) return part;
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join('');
}

function toTitleCity(cityText) {
  return String(cityText || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(toTitleWord)
    .join(' ');
}

function normalizeState(stateText) {
  const value = normalizeText(stateText).toLowerCase();
  if (!value) return null;
  const compact = value.replace(/[.\s]+/g, ' ').trim();
  if (/^[a-z]{2}$/i.test(compact)) return compact.toUpperCase();
  return STATE_NAME_TO_ABBR[compact] || null;
}

function stripLeadingLocationFiller(text) {
  return normalizeText(text)
    .replace(/^(?:you\s+can\s+use|use|in|near|around|my city is)\s+/i, '')
    .trim();
}

function normalizeCountry(countryText, region = null) {
  const c = normalizeText(countryText).toUpperCase();
  if (c) {
    if (c === 'USA' || c === 'UNITED STATES' || c === 'UNITED STATES OF AMERICA') return 'US';
    return c;
  }
  return region ? 'US' : null;
}

function normalizeLocation(value) {
  if (!value || typeof value !== 'object') return null;
  const lat = toFiniteCoordinate(value.lat);
  const lon = toFiniteCoordinate(value.lon);
  let city = stripLeadingLocationFiller(value.city);
  let region = normalizeState(value.region);
  let country = normalizeCountry(value.country, region);

  const commaParts = city.split(',').map((part) => normalizeText(part)).filter(Boolean);
  if (commaParts.length >= 2) {
    const trailingState = normalizeState(commaParts[commaParts.length - 1]);
    if (trailingState) {
      if (!region) region = trailingState;
      city = commaParts.slice(0, -1).join(', ');
    } else {
      city = commaParts.join(', ');
    }
  }
  const tokens = city.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    const maybeTwo = `${tokens[tokens.length - 2]} ${tokens[tokens.length - 1]}`;
    const stateTwo = normalizeState(maybeTwo);
    if (stateTwo) {
      if (!region) region = stateTwo;
      city = tokens.slice(0, -2).join(' ');
    }
  }
  const oneTokens = city.split(/\s+/).filter(Boolean);
  if (oneTokens.length >= 1) {
    const maybeOne = oneTokens[oneTokens.length - 1];
    const stateOne = normalizeState(maybeOne);
    if (stateOne) {
      if (!region) region = stateOne;
      city = oneTokens.slice(0, -1).join(' ');
    }
  }
  city = toTitleCity(city);
  if (city && region) city = `${city}, ${region}`;
  country = normalizeCountry(country, region);

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return {
      lat,
      lon,
      city: city || null,
      region: region || null,
      country: country || null,
    };
  }
  if (city) {
    return {
      lat: null,
      lon: null,
      city,
      region: region || null,
      country: country || null,
    };
  }
  return null;
}

function buildDisplayLocation(location) {
  const loc = normalizeLocation(location);
  if (!loc) return '';
  const segments = [];
  const seen = new Set();
  const addSegment = (value) => {
    const raw = normalizeText(value);
    if (!raw) return;
    const key = raw.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    segments.push(raw);
  };
  if (loc.city) {
    for (const part of String(loc.city).split(',').map((p) => normalizeText(p)).filter(Boolean)) {
      addSegment(part);
    }
  }
  addSegment(loc.region);
  addSegment(loc.country);
  if (segments.length > 0) return segments.join(', ');
  if (Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
    return `${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}`;
  }
  return '';
}

function normalizeSources(input, maxSources = 5) {
  const rows = Array.isArray(input) ? input : [];
  return rows
    .map((s) => ({
      title: normalizeText(s?.title || s?.name || s?.source || 'Source'),
      url: normalizeText(s?.url || s?.link || ''),
      snippet: normalizeText(s?.snippet || s?.summary || s?.text || ''),
      distanceKm: Number.isFinite(Number(s?.distanceKm)) ? Number(s.distanceKm) : null,
      address: normalizeText(s?.address || ''),
      rating: s?.rating == null ? null : Number(s.rating),
    }))
    .filter((s) => s.url || s.snippet || s.title)
    .slice(0, Math.max(1, Number(maxSources || 5)));
}

function buildStubAnswer(queryUsed, locationUsed) {
  const q = normalizeText(queryUsed);
  const loc = buildDisplayLocation(locationUsed);
  if (loc) {
    return `Web search is in stub mode; I can't fetch live results. I did not run a real lookup. I would search for "${q}" near ${loc}.`;
  }
  return `Web search is in stub mode; I can't fetch live results. I did not run a real lookup. I would search for "${q}" now.`;
}

function isPlaceIntent(query) {
  const t = normalizeText(query).toLowerCase();
  return /\b(nearest|nearby|near me|closest|coffee|restaurant|hotel|pharmacy|gas|atm|bank|hospital|gym|airport|station|barber|grocery)\b/.test(t);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * (Math.sin(dLon / 2) ** 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
}

function buildViewbox(lat, lon, radiusKm = 5) {
  const latDelta = radiusKm / 111;
  const lonDelta = radiusKm / Math.max(1e-6, (111 * Math.cos((lat * Math.PI) / 180)));
  const left = lon - lonDelta;
  const right = lon + lonDelta;
  const top = lat + latDelta;
  const bottom = lat - latDelta;
  return `${left},${top},${right},${bottom}`;
}

function inferPlaceLabel(query) {
  const t = normalizeText(query).toLowerCase();
  if (/coffee/.test(t)) return 'coffee shop';
  if (/restaurant|food|eat/.test(t)) return 'restaurant';
  if (/pharmacy/.test(t)) return 'pharmacy';
  if (/hotel/.test(t)) return 'hotel';
  if (/gas/.test(t)) return 'gas station';
  return t || 'nearby places';
}

function formatPlaceSummary(results = [], queryUsed = '', locationUsed = null) {
  const label = inferPlaceLabel(queryUsed);
  const displayLocation = buildDisplayLocation(locationUsed) || 'your area';
  if (!results.length) {
    return `I couldn't find strong matches for "${label}" near ${displayLocation}.`;
  }
  const rows = results.slice(0, 5).map((r, i) => {
    const dist = Number.isFinite(r.distanceKm) ? `${r.distanceKm.toFixed(1)} km` : 'distance unavailable';
    const locationPart = normalizeText(r.address || r.snippet || '');
    return locationPart
      ? `${i + 1}) ${r.title} — ${dist} — ${locationPart}`
      : `${i + 1}) ${r.title} — ${dist}`;
  });
  return `Here are the closest options:\n${rows.join('\n')}\n\nWant directions to one of these?`;
}

function formatWebSummary(results = [], queryUsed = '') {
  if (!results.length) {
    return `I ran a live web search for "${queryUsed}" but didn't get usable results.`;
  }
  const top = results[0];
  const snippet = normalizeText(top.snippet || '');
  if (snippet) return snippet;
  return `I ran a live web search for "${queryUsed}" and found ${results.length} sources.`;
}

function buildTestFixturePlaceResults(queryUsed = 'Nearby Places', locationUsed = null, max = 5) {
  const queryLabel = normalizeText(queryUsed) || 'Nearby Place';
  const displayLocation = buildDisplayLocation(locationUsed) || 'Newark, NJ, US';
  const seeds = [
    { title: `${queryLabel} Hub`, distanceKm: 0.3, address: `${displayLocation} (Downtown)` },
    { title: `${queryLabel} Express`, distanceKm: 0.7, address: `${displayLocation} (Market St)` },
    { title: `${queryLabel} Central`, distanceKm: 1.1, address: `${displayLocation} (University Ave)` },
    { title: `${queryLabel} North`, distanceKm: 1.9, address: `${displayLocation} (North Ward)` },
    { title: `${queryLabel} East`, distanceKm: 2.4, address: `${displayLocation} (Ironbound)` },
  ];
  return seeds.slice(0, Math.max(1, Math.min(5, Number(max || 5))));
}

async function searchPlacesOpenStreetMap(input = {}) {
  const query = normalizeText(input.query || '');
  const lat = Number(input.lat);
  const lon = Number(input.lon);
  const limit = Math.max(1, Math.min(10, Number(input.limit || 5)));
  const radiusKm = Math.max(1, Math.min(25, Number(input.radiusKm || 6)));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ok: false, error: 'location_required', results: [] };
  }

  const runQuery = async (searchQuery) => {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('q', searchQuery);
    url.searchParams.set('limit', String(limit * 2));
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('namedetails', '1');
    url.searchParams.set('bounded', '1');
    url.searchParams.set('viewbox', buildViewbox(lat, lon, radiusKm));

    const resp = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'User-Agent': '3130-Jarvis/1.0 (mcnair-mindset local assistant)',
      },
      signal: AbortSignal.timeout(9000),
    });
    if (!resp.ok) return { ok: false, status: resp.status, rows: [] };
    const json = await resp.json().catch(() => []);
    const rows = Array.isArray(json) ? json : [];
    return { ok: true, rows };
  };

  const normalizedQuery = query
    .replace(/\b(nearest|nearby|near me|closest|around me|in my area)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const fallbackLabel = inferPlaceLabel(query || 'coffee shop');
  const primaryQuery = normalizedQuery || fallbackLabel || 'coffee shop';
  const secondaryQuery = /\bcoffee|cafe\b/i.test(primaryQuery) ? 'cafe' : '';

  const first = await runQuery(primaryQuery);
  if (!first.ok) return { ok: false, error: `osm_http_${first.status}`, results: [] };
  let rawRows = first.rows;
  if ((!Array.isArray(rawRows) || rawRows.length === 0) && secondaryQuery && secondaryQuery !== primaryQuery) {
    const second = await runQuery(secondaryQuery);
    if (second.ok && Array.isArray(second.rows) && second.rows.length > 0) {
      rawRows = second.rows;
    }
  }

  const rows = rawRows
    .map((r) => {
      const rLat = Number(r?.lat);
      const rLon = Number(r?.lon);
      const distanceKm = (Number.isFinite(rLat) && Number.isFinite(rLon))
        ? haversineKm(lat, lon, rLat, rLon)
        : null;
      const display = normalizeText(r?.display_name || '');
      const name = normalizeText(r?.namedetails?.name || display.split(',')[0] || 'Place');
      const address = display;
      const urlLink = normalizeText(r?.osm_type && r?.osm_id
        ? `https://www.openstreetmap.org/${r.osm_type}/${r.osm_id}`
        : '');
      return {
        title: name || 'Place',
        url: urlLink,
        snippet: display,
        address,
        distanceKm,
        rating: null,
      };
    })
    .filter((r) => r.title || r.snippet)
    .sort((a, b) => {
      const da = Number.isFinite(a.distanceKm) ? a.distanceKm : Number.POSITIVE_INFINITY;
      const db = Number.isFinite(b.distanceKm) ? b.distanceKm : Number.POSITIVE_INFINITY;
      return da - db;
    })
    .slice(0, limit);

  return {
    ok: true,
    results: rows,
    provider: 'osm_nominatim',
  };
}

async function geocodeCityOpenStreetMap(input = {}) {
  const rawCity = normalizeText(input.city || '');
  if (!rawCity) return { ok: false, error: 'city_required' };
  const query = buildDisplayLocation({
    city: rawCity,
    region: input.region || null,
    country: input.country || null,
  }) || rawCity;
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '1');
  url.searchParams.set('addressdetails', '1');

  const resp = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'User-Agent': '3130-Jarvis/1.0 (mcnair-mindset local assistant)',
    },
    signal: AbortSignal.timeout(9000),
  });
  if (!resp.ok) {
    return { ok: false, error: `geocode_http_${resp.status}` };
  }
  const rows = await resp.json().catch(() => []);
  if (!Array.isArray(rows) || rows.length <= 0) {
    return { ok: false, error: 'city_geocode_no_results' };
  }
  const row = rows[0] || {};
  const lat = Number(row?.lat);
  const lon = Number(row?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ok: false, error: 'city_geocode_invalid_coordinates' };
  }
  const address = (row?.address && typeof row.address === 'object') ? row.address : {};
  const cityName = normalizeText(
    address.city
      || address.town
      || address.village
      || address.hamlet
      || rawCity.split(',')[0]
  );
  const region = normalizeState(address.state || input.region || null);
  const country = normalizeCountry(address.country_code || address.country || input.country || null, region);
  const normalized = normalizeLocation({
    lat,
    lon,
    city: cityName || rawCity,
    region,
    country,
  });
  if (!normalized) return { ok: false, error: 'city_geocode_normalization_failed' };
  return {
    ok: true,
    location: normalized,
    provider: 'osm_nominatim_geocode',
    queryUsed: query,
  };
}

async function searchWebDuckDuckGo(input = {}) {
  const query = normalizeText(input.query || '');
  const limit = Math.max(1, Math.min(10, Number(input.limit || 5)));
  const url = new URL('https://api.duckduckgo.com/');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_html', '1');
  url.searchParams.set('skip_disambig', '1');

  const resp = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'User-Agent': '3130-Jarvis/1.0 (mcnair-mindset local assistant)',
    },
    signal: AbortSignal.timeout(9000),
  });

  if (!resp.ok) {
    return { ok: false, error: `ddg_http_${resp.status}`, results: [] };
  }

  const json = await resp.json().catch(() => ({}));
  const rows = [];

  if (normalizeText(json?.AbstractText)) {
    rows.push({
      title: normalizeText(json?.Heading || 'DuckDuckGo Result'),
      url: normalizeText(json?.AbstractURL || ''),
      snippet: normalizeText(json?.AbstractText),
    });
  }

  const related = Array.isArray(json?.RelatedTopics) ? json.RelatedTopics : [];
  for (const item of related) {
    if (rows.length >= limit) break;
    if (Array.isArray(item?.Topics)) {
      for (const sub of item.Topics) {
        if (rows.length >= limit) break;
        const text = normalizeText(sub?.Text || '');
        const firstDash = text.indexOf(' - ');
        rows.push({
          title: firstDash > 0 ? text.slice(0, firstDash) : (normalizeText(sub?.FirstURL || '') || 'Related'),
          url: normalizeText(sub?.FirstURL || ''),
          snippet: text,
        });
      }
      continue;
    }
    const text = normalizeText(item?.Text || '');
    if (!text) continue;
    const firstDash = text.indexOf(' - ');
    rows.push({
      title: firstDash > 0 ? text.slice(0, firstDash) : (normalizeText(item?.FirstURL || '') || 'Related'),
      url: normalizeText(item?.FirstURL || ''),
      snippet: text,
    });
  }

  return {
    ok: true,
    results: rows.slice(0, limit),
    provider: 'duckduckgo',
  };
}

function escapeRegexLiteral(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mergePlaceRows(rows = [], maxResults = 5) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const name = normalizeText(row?.name || row?.title || 'Place');
    if (!name) continue;
    const lat = toFiniteCoordinate(row?.lat);
    const lon = toFiniteCoordinate(row?.lon);
    const key = `${name.toLowerCase()}|${Number.isFinite(lat) ? lat.toFixed(5) : 'na'}|${Number.isFinite(lon) ? lon.toFixed(5) : 'na'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      distanceMeters: Number.isFinite(Number(row?.distanceMeters)) ? Number(row.distanceMeters) : null,
      address: normalizeText(row?.address || ''),
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
      provider: normalizeText(row?.provider || 'unknown'),
      url: normalizeText(row?.url || ''),
    });
    if (out.length >= maxResults) break;
  }
  return out;
}

function summarizeProviderAttempts(attempts = []) {
  const providerAttempts = (Array.isArray(attempts) ? attempts : [])
    .map((row) => ({
      name: normalizeText(row?.name || row?.provider || 'provider_attempt'),
      provider: normalizeText(row?.provider || row?.name || 'provider_attempt'),
      ok: row?.ok === true,
      resultCount: Number.isFinite(Number(row?.resultCount)) ? Number(row.resultCount) : 0,
      warning: row?.warning ? String(row.warning) : null,
    }));
  const providerSucceeded = providerAttempts
    .filter((row) => row.ok === true)
    .map((row) => row.provider || row.name)
    .filter(Boolean);
  const providerFailed = providerAttempts
    .filter((row) => row.ok !== true)
    .map((row) => row.provider || row.name)
    .filter(Boolean);
  return {
    providerAttempts,
    providerSucceeded,
    providerFailed,
  };
}

function withProviderAttemptSummary(metrics = {}) {
  const summary = summarizeProviderAttempts(metrics.attempts || []);
  return {
    ...metrics,
    ...summary,
  };
}

function buildPlaceAddress(tags = {}) {
  const street = normalizeText(tags['addr:street'] || '');
  const houseNumber = normalizeText(tags['addr:housenumber'] || '');
  const city = normalizeText(tags['addr:city'] || tags['addr:town'] || tags['addr:village'] || '');
  const suburb = normalizeText(tags['addr:suburb'] || tags['addr:neighbourhood'] || '');
  const parts = [];
  const streetLine = normalizeText(`${houseNumber} ${street}`);
  if (streetLine) parts.push(streetLine);
  if (suburb) parts.push(suburb);
  if (city) parts.push(city);
  return parts.join(', ');
}

function toPlaceResultFromSource(source = {}) {
  const title = normalizeText(source?.title || source?.name || 'Place');
  return {
    name: title || 'Place',
    distanceMeters: Number.isFinite(Number(source?.distanceKm)) ? Number(source.distanceKm) * 1000 : null,
    address: normalizeText(source?.address || source?.snippet || ''),
    lat: null,
    lon: null,
    provider: normalizeText(source?.provider || 'web_fallback'),
    url: normalizeText(source?.url || ''),
  };
}

async function searchPlacesOverpass(input = {}) {
  const query = normalizeText(input.query || '');
  const lat = Number(input.lat);
  const lon = Number(input.lon);
  const radiusMeters = Math.max(300, Math.min(30000, Number(input.radiusMeters || 8000)));
  const limit = Math.max(1, Math.min(10, Number(input.limit || 5)));
  if (!query || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ok: false, error: 'overpass_invalid_input', results: [] };
  }

  const escapedQuery = escapeRegexLiteral(query);
  const overpass = [
    '[out:json][timeout:20];',
    '(',
    `node(around:${radiusMeters},${lat},${lon})["name"~"${escapedQuery}",i];`,
    `way(around:${radiusMeters},${lat},${lon})["name"~"${escapedQuery}",i];`,
    `relation(around:${radiusMeters},${lat},${lon})["name"~"${escapedQuery}",i];`,
    ');',
    `out center ${Math.max(limit * 3, 15)};`,
  ].join('\n');

  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Accept': 'application/json',
      'User-Agent': '3130-Jarvis/1.0 (mcnair-mindset local assistant)',
    },
    body: overpass,
    signal: AbortSignal.timeout(9000),
  });
  if (!resp.ok) return { ok: false, error: `overpass_http_${resp.status}`, results: [] };
  const json = await resp.json().catch(() => ({}));
  const elements = Array.isArray(json?.elements) ? json.elements : [];
  const rows = elements.map((el) => {
    const tags = (el && typeof el.tags === 'object') ? el.tags : {};
    const rLat = Number(el?.lat ?? el?.center?.lat);
    const rLon = Number(el?.lon ?? el?.center?.lon);
    const distanceKm = (Number.isFinite(rLat) && Number.isFinite(rLon))
      ? haversineKm(lat, lon, rLat, rLon)
      : null;
    const name = normalizeText(tags.name || tags.brand || `Place ${el?.id || ''}`) || 'Place';
    const address = buildPlaceAddress(tags);
    const type = normalizeText(el?.type || 'node');
    const osmId = Number(el?.id);
    const url = Number.isFinite(osmId) ? `https://www.openstreetmap.org/${type}/${osmId}` : '';
    return {
      name,
      distanceMeters: Number.isFinite(distanceKm) ? distanceKm * 1000 : null,
      address,
      lat: Number.isFinite(rLat) ? rLat : null,
      lon: Number.isFinite(rLon) ? rLon : null,
      provider: 'osm_overpass',
      url,
    };
  }).filter((row) => row.name);

  return {
    ok: true,
    provider: 'osm_overpass',
    results: mergePlaceRows(rows, limit),
  };
}

async function searchPlaces(input = {}) {
  const normalizedQuery = normalizeText(input.normalizedQuery || input.query || '');
  const originalQuery = normalizeText(input.originalQuery || input.query || normalizedQuery);
  const locationUsed = normalizeLocation(input.locationUsed || input.location || {});
  const maxResults = Math.max(1, Math.min(5, Number(input.maxResults || input.limit || 5)));
  const radiusMeters = Math.max(300, Math.min(30000, Number(input.radiusMeters || 8000)));
  const attempts = [];
  const warnings = [];

  if (!locationUsed || !Number.isFinite(locationUsed.lat) || !Number.isFinite(locationUsed.lon)) {
    return {
      ok: false,
      provider: 'none',
      results: [],
      attempts,
      warnings: ['location_required'],
      normalizedQuery,
      originalQuery,
      locationUsed,
    };
  }

  const lat = Number(locationUsed.lat);
  const lon = Number(locationUsed.lon);
  const merged = [];
  const providerChain = (input.providerChain && typeof input.providerChain === 'object')
    ? input.providerChain
    : {};
  const runNominatim = typeof providerChain.nominatimText === 'function'
    ? providerChain.nominatimText
    : searchPlacesOpenStreetMap;
  const runStructured = typeof providerChain.nominatimStructured === 'function'
    ? providerChain.nominatimStructured
    : searchPlacesOpenStreetMap;
  const runOverpass = typeof providerChain.overpass === 'function'
    ? providerChain.overpass
    : searchPlacesOverpass;
  const runWebFallback = typeof providerChain.webFallback === 'function'
    ? providerChain.webFallback
    : searchWebDuckDuckGo;
  const pushAttempt = (name, provider, ok, resultCount, warning = null) => {
    attempts.push({
      name,
      provider,
      ok: ok === true,
      resultCount: Number(resultCount || 0),
      warning: warning ? String(warning) : null,
    });
  };

  const primaryQuery = normalizedQuery || inferPlaceLabel(originalQuery || normalizedQuery || 'place');
  const attempt1 = await runNominatim({
    query: primaryQuery,
    lat,
    lon,
    limit: maxResults,
    radiusKm: radiusMeters / 1000,
  });
  if (attempt1?.ok) {
    const rows = (Array.isArray(attempt1.results) ? attempt1.results : []).map((row) => ({
      name: normalizeText(row?.title || row?.name || ''),
      distanceMeters: Number.isFinite(Number(row?.distanceKm)) ? Number(row.distanceKm) * 1000 : null,
      address: normalizeText(row?.address || row?.snippet || ''),
      lat: null,
      lon: null,
      provider: 'osm_nominatim_text',
      url: normalizeText(row?.url || ''),
    }));
    merged.push(...rows);
    pushAttempt('nominatim_text', 'osm_nominatim_text', true, rows.length);
  } else {
    pushAttempt('nominatim_text', 'osm_nominatim_text', false, 0, attempt1?.error || 'nominatim_text_failed');
    warnings.push(String(attempt1?.error || 'nominatim_text_failed'));
  }

  const structuredCity = normalizeText(locationUsed.city || '').replace(/,\s*[A-Z]{2}$/i, '');
  const structuredQuery = normalizeText(`${primaryQuery} ${structuredCity}`).trim();
  if (structuredQuery && structuredQuery.toLowerCase() !== primaryQuery.toLowerCase()) {
    const attempt2 = await runStructured({
      query: structuredQuery,
      lat,
      lon,
      limit: maxResults,
      radiusKm: radiusMeters / 1000,
    });
    if (attempt2?.ok) {
      const rows = (Array.isArray(attempt2.results) ? attempt2.results : []).map((row) => ({
        name: normalizeText(row?.title || row?.name || ''),
        distanceMeters: Number.isFinite(Number(row?.distanceKm)) ? Number(row.distanceKm) * 1000 : null,
        address: normalizeText(row?.address || row?.snippet || ''),
        lat: null,
        lon: null,
        provider: 'osm_nominatim_structured',
        url: normalizeText(row?.url || ''),
      }));
      merged.push(...rows);
      pushAttempt('nominatim_structured', 'osm_nominatim_structured', true, rows.length);
    } else {
      pushAttempt('nominatim_structured', 'osm_nominatim_structured', false, 0, attempt2?.error || 'nominatim_structured_failed');
      warnings.push(String(attempt2?.error || 'nominatim_structured_failed'));
    }
  }

  const attempt3 = await runOverpass({
    query: primaryQuery,
    lat,
    lon,
    radiusMeters,
    limit: maxResults,
  });
  if (attempt3?.ok) {
    const rows = Array.isArray(attempt3.results) ? attempt3.results : [];
    merged.push(...rows);
    pushAttempt('overpass_brand_name', 'osm_overpass', true, rows.length);
  } else {
    pushAttempt('overpass_brand_name', 'osm_overpass', false, 0, attempt3?.error || 'overpass_failed');
    warnings.push(String(attempt3?.error || 'overpass_failed'));
  }

  if (merged.length <= 0 && input.enableWebFallback === true) {
    const attempt4 = await runWebFallback({ query: primaryQuery, limit: maxResults });
    if (attempt4?.ok) {
      const rows = (Array.isArray(attempt4.results) ? attempt4.results : []).map((row) => ({
        ...toPlaceResultFromSource({
          ...row,
          provider: 'duckduckgo_fallback',
        }),
      }));
      merged.push(...rows);
      pushAttempt('web_fallback', 'duckduckgo_fallback', true, rows.length);
    } else {
      pushAttempt('web_fallback', 'duckduckgo_fallback', false, 0, attempt4?.error || 'web_fallback_failed');
      warnings.push(String(attempt4?.error || 'web_fallback_failed'));
    }
  }

  const results = mergePlaceRows(
    merged.sort((a, b) => {
      const da = Number.isFinite(Number(a?.distanceMeters)) ? Number(a.distanceMeters) : Number.POSITIVE_INFINITY;
      const db = Number.isFinite(Number(b?.distanceMeters)) ? Number(b.distanceMeters) : Number.POSITIVE_INFINITY;
      return da - db;
    }),
    maxResults
  );

  return {
    ok: true,
    provider: results[0]?.provider || 'mixed',
    results,
    attempts,
    warnings,
    normalizedQuery: primaryQuery,
    originalQuery: originalQuery || primaryQuery,
    locationUsed,
  };
}

async function runWebTool(ctx = {}) {
  const message = normalizeText(ctx.message);
  const originalQuery = normalizeText(ctx.originalQuery || ctx.queryUsed || message);
  const normalizedQuery = normalizeText(ctx.normalizedQuery || ctx.queryUsed || message);
  const queryUsed = normalizeText(ctx.queryUsed || message);
  const webEnabled = ctx.webEnabled !== false;
  const allowNetwork = ctx.allowNetwork !== false;
  const mode = String(ctx.webMode || 'stub').trim().toLowerCase() === 'real' ? 'real' : 'stub';
  const maxSources = Math.max(1, Math.min(10, Number(ctx.maxSources || 5)));
  const maxPlaces = Math.max(1, Math.min(5, Number(ctx.maxResults || maxSources || 5)));
  const radiusMeters = Math.max(300, Math.min(30000, Number(ctx.radiusMeters || 8000)));
  const locationRequired = ctx.locationRequired === true;
  let locationUsed = normalizeLocation(ctx.userLocationHint || ctx.locationHint);
  const webToolUrl = normalizeText(ctx.webToolUrl);
  const forceProxy = ctx.forceProxy === true;
  const provider = String(ctx.webProvider || '').trim().toLowerCase() || (webToolUrl ? 'proxy' : 'duckduckgo');
  const placeIntent = String(ctx.intent || '').trim().toLowerCase() === 'local_search'
    || isPlaceIntent(normalizedQuery || queryUsed)
    || locationRequired;
  const fixtureMode = String(
    ctx.testPlaceFixtureMode
    || process.env.JARVIS_TEST_PLACE_FIXTURE_MODE
    || ''
  ).trim().toLowerCase();

  if (!webEnabled) {
    return {
      ok: false,
      toolName: 'WebTool',
      data: {
        answer: '',
        sources: [],
        queryUsed,
        normalizedQuery,
        originalQuery,
        locationUsed,
      },
      narrative: {
        stance: 'Web search is currently disabled in configuration.',
        details: ['Enable JARVIS_WEB_ENABLED=true to allow web lookups.'],
      },
      warnings: ['web_disabled'],
      metrics: withProviderAttemptSummary({
        mode,
        provider,
        executed: false,
        usedLocation: locationUsed != null,
        resultCount: 0,
        attempts: [],
      }),
    };
  }

  if (locationRequired && !locationUsed) {
    return {
      ok: false,
      toolName: 'WebTool',
      data: {
        answer: '',
        sources: [],
        queryUsed,
        normalizedQuery,
        originalQuery,
        locationUsed: null,
      },
      narrative: {
        stance: 'Location is required for this lookup.',
        details: ['Provide a city or enable location sharing from your phone.'],
      },
      warnings: ['location_required'],
      metrics: withProviderAttemptSummary({
        mode,
        provider,
        executed: false,
        usedLocation: false,
        resultCount: 0,
        attempts: [],
      }),
    };
  }

  if (mode === 'real' && allowNetwork) {
    try {
      const warnings = [];
      let attempts = [];
      let answer = '';
      let sources = [];
      let providerUsed = provider;

      if (placeIntent && fixtureMode) {
        if (fixtureMode === 'error') {
          return {
            ok: false,
            toolName: 'WebTool',
            data: {
              answer: '',
              sources: [],
              queryUsed,
              normalizedQuery,
              originalQuery,
              locationUsed,
            },
            narrative: {
              stance: 'Web provider request failed.',
              details: ['test_fixture_error'],
            },
            warnings: ['web_request_failed'],
            metrics: withProviderAttemptSummary({
              mode: 'real',
              provider: 'test_fixture',
              executed: false,
              usedLocation: locationUsed != null,
              resultCount: 0,
              displayLocation: buildDisplayLocation(locationUsed),
              attempts: [{ name: 'test_fixture', provider: 'test_fixture', ok: false, resultCount: 0, warning: 'test_fixture_error' }],
            }),
          };
        }
        if (fixtureMode === 'zero') {
          const fixtureRows = [];
          return {
            ok: true,
            toolName: 'WebTool',
            data: {
              answer: formatPlaceSummary(fixtureRows, normalizedQuery || queryUsed, locationUsed),
              sources: fixtureRows,
              queryUsed,
              normalizedQuery: normalizedQuery || queryUsed,
              originalQuery: originalQuery || queryUsed,
              locationUsed,
            },
            narrative: {
              stance: formatPlaceSummary(fixtureRows, normalizedQuery || queryUsed, locationUsed),
              details: [],
            },
            warnings: ['provider_returned_zero_results'],
            metrics: withProviderAttemptSummary({
              mode: 'real',
              provider: 'test_fixture',
              executed: true,
              usedLocation: locationUsed != null,
              resultCount: 0,
              displayLocation: buildDisplayLocation(locationUsed),
              attempts: [{ name: 'test_fixture', provider: 'test_fixture', ok: true, resultCount: 0, warning: 'provider_returned_zero_results' }],
            }),
          };
        }
        const fixtureRows = buildTestFixturePlaceResults(normalizedQuery || queryUsed, locationUsed, maxPlaces);
        const fixtureSources = fixtureRows.map((row) => ({
          title: normalizeText(row?.title || ''),
          url: '',
          snippet: normalizeText(row?.address || ''),
          distanceKm: Number.isFinite(Number(row?.distanceKm)) ? Number(row.distanceKm) : null,
          address: normalizeText(row?.address || ''),
          rating: null,
          provider: 'test_fixture',
        }));
        return {
          ok: true,
          toolName: 'WebTool',
          data: {
            answer: formatPlaceSummary(fixtureSources, normalizedQuery || queryUsed, locationUsed),
            sources: fixtureSources,
            queryUsed,
            normalizedQuery: normalizedQuery || queryUsed,
            originalQuery: originalQuery || queryUsed,
            locationUsed,
          },
          narrative: {
            stance: formatPlaceSummary(fixtureSources, normalizedQuery || queryUsed, locationUsed),
            details: fixtureSources.map((s, idx) => `${idx + 1}. ${s.title}`),
          },
          warnings: [],
          metrics: withProviderAttemptSummary({
            mode: 'real',
            provider: 'test_fixture',
            executed: true,
            usedLocation: locationUsed != null,
            resultCount: fixtureSources.length,
            displayLocation: buildDisplayLocation(locationUsed),
            attempts: [{ name: 'test_fixture', provider: 'test_fixture', ok: true, resultCount: fixtureSources.length, warning: null }],
          }),
        };
      }

      if (placeIntent && locationUsed?.city && (!Number.isFinite(locationUsed?.lat) || !Number.isFinite(locationUsed?.lon))) {
        const geocodeOut = await geocodeCityOpenStreetMap({
          city: locationUsed.city,
          region: locationUsed.region,
          country: locationUsed.country,
        });
        if (geocodeOut?.ok && geocodeOut.location) {
          locationUsed = geocodeOut.location;
        } else {
          warnings.push(String(geocodeOut?.error || 'city_geocode_failed'));
        }
      }

      if (webToolUrl && forceProxy) {
        const resp = await fetch(webToolUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: queryUsed,
            sessionId: ctx.sessionId || ctx.clientId || null,
            traceId: ctx.traceId || null,
            maxSources,
            location: locationUsed,
          }),
          signal: AbortSignal.timeout(9000),
        });
        const json = await resp.json().catch(() => ({}));
        answer = normalizeText(json?.answer || json?.reply || json?.text || '');
        sources = normalizeSources(json?.sources || json?.results || [], maxSources);
        providerUsed = 'proxy';
        attempts = [{ name: 'proxy_web_tool', provider: 'proxy', ok: resp.ok, resultCount: sources.length, warning: resp.ok ? null : `proxy_http_${resp.status}` }];
        if (placeIntent) {
          for (let i = 0; i < sources.length; i += 1) {
            const addr = normalizeText(sources[i]?.address || '');
            if (!addr) {
              const title = normalizeText(sources[i]?.title || `result_${i + 1}`);
              warnings.push(`missing_address:${i + 1}:${title || `result_${i + 1}`}`);
            }
          }
        }
      } else if (placeIntent) {
        const placeOut = await searchPlaces({
          normalizedQuery: normalizedQuery || queryUsed,
          originalQuery: originalQuery || queryUsed,
          locationUsed,
          radiusMeters,
          maxResults: maxPlaces,
          enableWebFallback: ctx.enableWebFallback === true,
          providerChain: (ctx.providerChain && typeof ctx.providerChain === 'object') ? ctx.providerChain : null,
        });
        attempts = Array.isArray(placeOut?.attempts) ? placeOut.attempts : [];
        if (Array.isArray(placeOut?.warnings)) warnings.push(...placeOut.warnings);
        if (placeOut?.locationUsed) locationUsed = placeOut.locationUsed;
        providerUsed = String(placeOut?.provider || provider || 'mixed');
        const placeRows = Array.isArray(placeOut?.results) ? placeOut.results : [];
        sources = placeRows.map((row) => ({
          title: normalizeText(row?.name || 'Place'),
          url: normalizeText(row?.url || ''),
          snippet: normalizeText(row?.address || ''),
          distanceKm: Number.isFinite(Number(row?.distanceMeters)) ? Number(row.distanceMeters) / 1000 : null,
          address: normalizeText(row?.address || ''),
          rating: null,
          provider: normalizeText(row?.provider || providerUsed),
        })).slice(0, maxPlaces);
        for (let i = 0; i < sources.length; i += 1) {
          const addr = normalizeText(sources[i]?.address || '');
          if (!addr) {
            const title = normalizeText(sources[i]?.title || `result_${i + 1}`);
            warnings.push(`missing_address:${i + 1}:${title || `result_${i + 1}`}`);
          }
        }
        if (sources.length <= 0) warnings.push('provider_returned_zero_results');
        answer = formatPlaceSummary(sources, normalizedQuery || queryUsed, locationUsed);
      } else if (webToolUrl) {
        const resp = await fetch(webToolUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: queryUsed,
            sessionId: ctx.sessionId || ctx.clientId || null,
            traceId: ctx.traceId || null,
            maxSources,
            location: locationUsed,
          }),
          signal: AbortSignal.timeout(9000),
        });
        const json = await resp.json().catch(() => ({}));
        answer = normalizeText(json?.answer || json?.reply || json?.text || '');
        sources = normalizeSources(json?.sources || json?.results || [], maxSources);
        providerUsed = 'proxy';
        attempts = [{ name: 'proxy_web_tool', provider: 'proxy', ok: resp.ok, resultCount: sources.length, warning: resp.ok ? null : `proxy_http_${resp.status}` }];
      } else {
        const providerOut = await searchWebDuckDuckGo({ query: queryUsed, limit: maxSources });
        if (providerOut?.ok) {
          sources = normalizeSources(providerOut.results || [], maxSources);
          answer = formatWebSummary(sources, queryUsed);
          providerUsed = providerOut.provider || provider || 'duckduckgo';
          attempts = [{ name: 'duckduckgo_text', provider: providerUsed, ok: true, resultCount: sources.length, warning: null }];
        } else {
          attempts = [{ name: 'duckduckgo_text', provider: 'duckduckgo', ok: false, resultCount: 0, warning: String(providerOut?.error || 'web_provider_failed') }];
          return {
            ok: false,
            toolName: 'WebTool',
            data: {
              answer: '',
              sources: [],
              queryUsed,
              normalizedQuery,
              originalQuery,
              locationUsed,
            },
            narrative: {
              stance: 'Live web lookup failed for this request.',
              details: [String(providerOut?.error || 'web_provider_failed')],
            },
            warnings: ['web_request_failed'],
            metrics: withProviderAttemptSummary({
              mode: 'real',
              provider: providerOut?.provider || provider,
              executed: false,
              usedLocation: locationUsed != null,
              resultCount: 0,
              displayLocation: buildDisplayLocation(locationUsed),
              attempts,
            }),
          };
        }
      }

      if (answer) {
        return {
          ok: true,
          toolName: 'WebTool',
          data: {
            answer,
            sources,
            queryUsed,
            normalizedQuery: normalizedQuery || queryUsed,
            originalQuery: originalQuery || queryUsed,
            locationUsed,
          },
          narrative: {
            stance: answer,
            details: sources.map((s, idx) => `${idx + 1}. ${s.title}${s.url ? ` — ${s.url}` : ''}`),
          },
          warnings,
          metrics: withProviderAttemptSummary({
            mode: 'real',
            provider: providerUsed || provider || 'unknown',
            executed: true,
            usedLocation: locationUsed != null,
            resultCount: sources.length,
            displayLocation: buildDisplayLocation(locationUsed),
            attempts,
          }),
        };
      }

      return {
        ok: false,
        toolName: 'WebTool',
        data: {
          answer: '',
          sources: [],
          queryUsed,
          normalizedQuery,
          originalQuery,
          locationUsed,
        },
        narrative: {
          stance: 'Live web lookup failed for this request.',
          details: ['web_provider_failed'],
        },
        warnings: ['web_request_failed'],
        metrics: withProviderAttemptSummary({
          mode: 'real',
          provider: provider,
          executed: false,
          usedLocation: locationUsed != null,
          resultCount: 0,
          displayLocation: buildDisplayLocation(locationUsed),
          attempts,
        }),
      };
    } catch (err) {
      return {
        ok: false,
        toolName: 'WebTool',
        data: {
          answer: '',
          sources: [],
          queryUsed,
          normalizedQuery,
          originalQuery,
          locationUsed,
        },
        narrative: {
          stance: 'Web provider request failed.',
          details: [String(err?.message || 'web_request_failed')],
        },
        warnings: ['web_request_failed'],
        metrics: withProviderAttemptSummary({
          mode: 'real',
          provider,
          executed: false,
          usedLocation: locationUsed != null,
          resultCount: 0,
          displayLocation: buildDisplayLocation(locationUsed),
          attempts: [],
        }),
      };
    }
  }

  const answer = buildStubAnswer(queryUsed, locationUsed);
  const stubSources = [
    {
      title: 'WebTool Stub',
      url: '',
      snippet: 'Live web provider is not configured yet.',
      distanceKm: null,
      address: '',
      rating: null,
    },
  ];
  return {
    ok: true,
    toolName: 'WebTool',
    data: {
      answer,
      sources: stubSources.slice(0, maxSources),
      queryUsed,
      normalizedQuery,
      originalQuery,
      locationUsed,
    },
    narrative: {
      stance: answer,
      details: ['Set JARVIS_WEB_TOOL_MODE=real to enable live web results.'],
    },
    warnings: mode === 'real' && !allowNetwork ? ['web_network_disabled'] : ['web_stub_mode'],
    metrics: withProviderAttemptSummary({
      mode: 'stub',
      provider,
      executed: false,
      usedLocation: locationUsed != null,
      resultCount: 1,
      displayLocation: buildDisplayLocation(locationUsed),
      attempts: [],
    }),
  };
}

module.exports = {
  buildDisplayLocation,
  geocodeCityOpenStreetMap,
  runWebTool,
  searchPlaces,
  searchPlacesOverpass,
  searchPlacesOpenStreetMap,
  searchWebDuckDuckGo,
};
