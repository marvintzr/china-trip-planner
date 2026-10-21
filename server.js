require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');
const { pinyin } = require('pinyin-pro');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const TRIPS_DIR = path.join(DATA_DIR, 'trips');
const LEGACY_TRIP_FILE = path.join(DATA_DIR, 'trip.json');
const CITY_CACHE_FILE = path.join(DATA_DIR, 'cities.json');
const AMAP_KEY = process.env.AMAP_WEB_SERVICE_KEY;
const TRIP_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ADCODE_RE = /^\d{6}$/;

// ---------- Trip storage: one JSON file per trip ----------

function tripPath(id) {
  return path.join(TRIPS_DIR, `${id}.json`);
}

function listTripIds() {
  return fs
    .readdirSync(TRIPS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .filter((id) => TRIP_ID_RE.test(id));
}

function readTrip(id) {
  const trip = JSON.parse(fs.readFileSync(tripPath(id), 'utf8'));
  trip.id = id;
  return trip;
}

function saveTrip(trip) {
  fs.writeFileSync(tripPath(trip.id), JSON.stringify(trip, null, 2));
}

function createTrip({ title, startDate = null, days = 5 }) {
  const trip = {
    id: nanoid(10),
    title: title || 'My China Trip',
    cities: [],
    startDate,
    days,
    places: [],
    createdAt: Date.now(),
  };
  saveTrip(trip);
  return trip;
}

function initStorage() {
  fs.mkdirSync(TRIPS_DIR, { recursive: true });
  if (fs.existsSync(LEGACY_TRIP_FILE)) {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_TRIP_FILE, 'utf8'));
    legacy.id = nanoid(10);
    legacy.createdAt = legacy.createdAt || Date.now();
    saveTrip(legacy);
    // Keep the pre-migration file as a backup rather than deleting it.
    fs.renameSync(LEGACY_TRIP_FILE, `${LEGACY_TRIP_FILE}.migrated`);
  }
  if (!listTripIds().length) createTrip({});
}

initStorage();

// ---------- Amap ----------

async function amapGet(endpoint, params) {
  if (!AMAP_KEY) {
    throw new Error('AMAP_WEB_SERVICE_KEY is not set in .env');
  }
  const url = new URL(`https://restapi.amap.com/v3/${endpoint}`);
  url.searchParams.set('key', AMAP_KEY);
  url.searchParams.set('output', 'JSON');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== '1') {
    throw new Error(data.info || 'Amap request failed');
  }
  return data;
}

function mapPoi(p) {
  return {
    amapId: p.id,
    name: p.name,
    address: p.address,
    lng: parseFloat(p.location.split(',')[0]),
    lat: parseFloat(p.location.split(',')[1]),
    type: p.type,
    tel: p.tel,
    rating: p.biz_ext && p.biz_ext.rating ? p.biz_ext.rating : null,
  };
}

// ---------- China city directory (cached from Amap's district API) ----------

// Established English names that differ from plain pinyin.
const ENGLISH_NAMES = {
  香港特别行政区: 'Hong Kong',
  澳门特别行政区: 'Macau',
  哈尔滨市: 'Harbin',
  乌鲁木齐市: 'Urumqi',
  拉萨市: 'Lhasa',
  呼和浩特市: 'Hohhot',
  喀什地区: 'Kashgar',
  西藏自治区: 'Tibet',
  内蒙古自治区: 'Inner Mongolia',
};
const EXTRA_SEARCH_ALIASES = {
  广州市: ['canton'],
  澳门特别行政区: ['macao'],
};

const NAME_SUFFIX_RE = /(特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|省|市|地区|盟|县)$/;

// Ranked above equally-matching smaller places, e.g. "cheng" → 成都 before 澄迈县.
const POPULAR_DESTINATIONS = new Set([
  '北京市', '上海市', '广州市', '深圳市', '成都市', '重庆市', '西安市', '杭州市', '苏州市', '南京市',
  '桂林市', '厦门市', '昆明市', '丽江市', '大理白族自治州', '张家界市', '青岛市', '哈尔滨市', '拉萨市',
  '三亚市', '武汉市', '长沙市', '天津市', '香港特别行政区', '澳门特别行政区', '黄山市', '洛阳市',
  '乌鲁木齐市', '西宁市', '酒泉市', '大连市', '沈阳市', '济南市', '郑州市', '福州市', '贵阳市', '南宁市',
]);

function normalizeQuery(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s'’-]/g, '');
}

function toPinyin(s) {
  return pinyin(s, { toneType: 'none', type: 'array' }).join('').toLowerCase();
}

// Longer names first so 蒙古族 is stripped before 蒙古.
const ETHNIC_GROUPS = [
  '土家族', '布依族', '哈尼族', '景颇族', '傈僳族', '朝鲜族', '蒙古族', '柯尔克孜', '哈萨克',
  '白族', '藏族', '彝族', '苗族', '侗族', '傣族', '回族', '壮族', '羌族', '黎族', '蒙古',
];

// 大理白族自治州 → 大理, 湘西土家族苗族自治州 → 湘西, 广州市 → 广州
function shortCityName(name) {
  if (/自治[州县]$/.test(name)) {
    let s = name.slice(0, -3);
    let stripped = true;
    while (stripped) {
      stripped = false;
      for (const g of ETHNIC_GROUPS) {
        if (s.endsWith(g) && s.length > g.length) {
          s = s.slice(0, -g.length);
          stripped = true;
        }
      }
    }
    return s;
  }
  return name.replace(NAME_SUFFIX_RE, '') || name;
}

function makeCityEntry(district, level, province) {
  const [lng, lat] = district.center.split(',').map(Number);
  const short = shortCityName(district.name);
  const shortPinyin = toPinyin(short);
  const en = ENGLISH_NAMES[district.name] || shortPinyin.charAt(0).toUpperCase() + shortPinyin.slice(1);
  return {
    name: district.name,
    short,
    adcode: district.adcode,
    center: [lng, lat],
    level,
    province,
    en,
    keys: [
      ...new Set([
        shortPinyin,
        toPinyin(district.name),
        normalizeQuery(en),
        ...(EXTRA_SEARCH_ALIASES[district.name] || []),
      ]),
    ],
  };
}

async function fetchCityList() {
  if (fs.existsSync(CITY_CACHE_FILE)) {
    return JSON.parse(fs.readFileSync(CITY_CACHE_FILE, 'utf8'));
  }
  const data = await amapGet('config/district', { keywords: '中国', subdistrict: 2, extensions: 'base' });
  const list = [];
  for (const prov of data.districts[0].districts) {
    // Municipalities (北京市…) and SARs behave like cities; their children are districts.
    const isCityLevel = /(市|特别行政区)$/.test(prov.name);
    list.push(makeCityEntry(prov, isCityLevel ? 'city' : 'province', null));
    if (isCityLevel) continue;
    for (const c of prov.districts || []) {
      if (c.level !== 'city' || c.name.includes('直辖')) continue;
      list.push(makeCityEntry(c, 'city', prov.name));
    }
  }
  fs.writeFileSync(CITY_CACHE_FILE, JSON.stringify(list));
  return list;
}

let cityListPromise = null;
function getCityList() {
  if (!cityListPromise) {
    cityListPromise = fetchCityList().catch((err) => {
      cityListPromise = null;
      throw err;
    });
  }
  return cityListPromise;
}

function publicCity(c) {
  return { name: c.name, adcode: c.adcode, center: c.center, level: c.level, province: c.province, en: c.en };
}

function searchCities(list, rawQuery, limit = 8) {
  const raw = String(rawQuery || '').trim();
  const q = normalizeQuery(raw);
  if (!q) return [];
  const scored = [];
  for (const c of list) {
    let score = -1;
    if (c.name === raw || c.short === raw) score = 100;
    else if (c.name.startsWith(raw)) score = Math.max(score, 80);
    else if (c.name.includes(raw)) score = Math.max(score, 60);
    if (c.keys.includes(q)) score = Math.max(score, 90);
    else if (c.keys.some((k) => k.startsWith(q))) score = Math.max(score, 70);
    if (score < 0) continue;
    if (c.level === 'city') score += 5;
    if (POPULAR_DESTINATIONS.has(c.name)) score += 3;
    scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score || a.c.name.length - b.c.name.length);
  return scored.slice(0, limit).map(({ c }) => publicCity(c));
}

function sanitizeCity(c) {
  if (!c || typeof c !== 'object' || !ADCODE_RE.test(c.adcode) || typeof c.name !== 'string') return null;
  const center =
    Array.isArray(c.center) && c.center.length === 2 && c.center.every(Number.isFinite) ? c.center : null;
  return {
    name: c.name.slice(0, 50),
    adcode: c.adcode,
    center,
    level: c.level === 'province' ? 'province' : 'city',
    province: typeof c.province === 'string' ? c.province.slice(0, 50) : null,
    en: typeof c.en === 'string' ? c.en.slice(0, 50) : '',
  };
}

function dedupeCities(cities) {
  const seen = new Set();
  return cities.filter((c) => c && !seen.has(c.adcode) && seen.add(c.adcode));
}

app.get('/api/cities', async (req, res) => {
  try {
    const list = await getCityList();
    res.json({ cities: searchCities(list, req.query.q) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const boundaryCache = new Map();

app.get('/api/cities/:adcode/boundary', async (req, res) => {
  const { adcode } = req.params;
  if (!ADCODE_RE.test(adcode)) return res.status(400).json({ error: 'invalid adcode' });
  try {
    if (!boundaryCache.has(adcode)) {
      const data = await amapGet('config/district', { keywords: adcode, subdistrict: 0, extensions: 'all' });
      const polyline = data.districts?.[0]?.polyline || '';
      const rings = polyline
        ? polyline.split('|').map((ring) => ring.split(';').map((pt) => pt.split(',').map(Number)))
        : [];
      boundaryCache.set(adcode, rings);
    }
    res.json({ rings: boundaryCache.get(adcode) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------- Place search (not trip-specific) ----------

// Frontend map config (JS key is safe to expose to browser; web service key is not)
app.get('/api/config', (req, res) => {
  res.json({
    jsKey: process.env.AMAP_JS_KEY || '',
    securityCode: process.env.AMAP_JS_SECURITY_CODE || '',
  });
});

// Live autocomplete suggestions while typing (Amap input-tips API)
app.get('/api/suggest', async (req, res) => {
  const { keywords, city } = req.query;
  if (!keywords) return res.json({ tips: [] });
  try {
    const data = await amapGet('assistant/inputtips', {
      keywords,
      city,
      citylimit: city ? 'true' : 'false',
    });
    const tips = (data.tips || [])
      .filter((t) => t.name)
      .map((t) => ({
        id: t.id,
        name: t.name,
        district: t.district,
        address: t.address,
      }));
    res.json({ tips });
  } catch (err) {
    // Don't surface transient autocomplete errors to the user, just show no suggestions.
    res.json({ tips: [] });
  }
});

// Search Amap POIs by keyword (used to resolve a Dianping place name to real coordinates)
app.get('/api/search', async (req, res) => {
  const { keywords, city } = req.query;
  if (!keywords) return res.status(400).json({ error: 'keywords is required' });
  try {
    const data = await amapGet('place/text', {
      keywords,
      city,
      citylimit: city ? 'true' : 'false',
      offset: 10,
      page: 1,
      extensions: 'all',
    });
    res.json({ pois: (data.pois || []).map(mapPoi) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Nearby-places search around a clicked map point (Amap around-search API)
app.get('/api/nearby', async (req, res) => {
  const { lng, lat, radius, keywords } = req.query;
  if (!lng || !lat) return res.status(400).json({ error: 'lng and lat are required' });
  try {
    const data = await amapGet('place/around', {
      location: `${lng},${lat}`,
      radius: radius || 1000,
      keywords: keywords || undefined,
      offset: 20,
      page: 1,
      extensions: 'all',
    });
    const pois = (data.pois || []).map((p) => ({
      ...mapPoi(p),
      distanceMeters: p.distance ? parseInt(p.distance, 10) : null,
    }));
    res.json({ pois });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------- Trips ----------

app.get('/api/trips', (req, res) => {
  const trips = listTripIds()
    .map((id) => {
      const t = readTrip(id);
      return {
        id: t.id,
        title: t.title,
        startDate: t.startDate,
        days: t.days,
        placeCount: t.places.length,
        createdAt: t.createdAt || 0,
      };
    })
    .sort((a, b) => a.createdAt - b.createdAt);
  res.json({ trips });
});

app.post('/api/trips', (req, res) => {
  const { title } = req.body || {};
  const trip = createTrip({
    title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 100) : 'New trip',
  });
  res.json(trip);
});

app.param('tripId', (req, res, next, id) => {
  if (!TRIP_ID_RE.test(id) || !fs.existsSync(tripPath(id))) {
    return res.status(404).json({ error: 'trip not found' });
  }
  req.trip = readTrip(id);
  next();
});

app.get('/api/trips/:tripId', async (req, res) => {
  const trip = req.trip;
  // Older trips stored cities as plain names ("Beijing"); upgrade them to Amap city records.
  if (trip.cities.some((c) => typeof c === 'string')) {
    try {
      const list = await getCityList();
      trip.cities = dedupeCities(
        trip.cities.map((c) => (typeof c === 'string' ? searchCities(list, c, 1)[0] || null : c))
      );
      saveTrip(trip);
    } catch {
      // Amap unreachable — leave the legacy names until next load.
    }
  }
  res.json(trip);
});

app.put('/api/trips/:tripId', (req, res) => {
  const trip = req.trip;
  const { title, cities, startDate, days } = req.body;
  if (typeof title === 'string') trip.title = title.trim().slice(0, 100) || trip.title;
  if (Array.isArray(cities)) trip.cities = dedupeCities(cities.map(sanitizeCity));
  if (startDate !== undefined) trip.startDate = startDate || null;
  if (days !== undefined) {
    const n = parseInt(days, 10);
    if (n >= 1 && n <= 60) trip.days = n;
  }
  saveTrip(trip);
  res.json(trip);
});

app.delete('/api/trips/:tripId', (req, res) => {
  if (listTripIds().length <= 1) {
    return res.status(400).json({ error: "You can't delete your only trip." });
  }
  fs.unlinkSync(tripPath(req.trip.id));
  res.json({ ok: true });
});

app.post('/api/trips/:tripId/places', (req, res) => {
  const trip = req.trip;
  const { name, address, lng, lat, day, type, source, rating, tel, notes } = req.body;
  if (!name || !Number.isFinite(lng) || !Number.isFinite(lat)) {
    return res.status(400).json({ error: 'name, lng, lat are required' });
  }
  const dayKey = Number.isInteger(day) ? day : null;
  const place = {
    id: nanoid(8),
    name,
    address: address || '',
    lng,
    lat,
    day: dayKey,
    order: trip.places.filter((p) => p.day === dayKey).length,
    type: type || 'attraction',
    source: source || 'manual',
    rating: rating ?? null,
    tel: tel || '',
    notes: notes || '',
  };
  trip.places.push(place);
  saveTrip(trip);
  res.json(place);
});

const EDITABLE_PLACE_FIELDS = ['day', 'order', 'type', 'notes'];

app.put('/api/trips/:tripId/places/:id', (req, res) => {
  const trip = req.trip;
  const place = trip.places.find((p) => p.id === req.params.id);
  if (!place) return res.status(404).json({ error: 'not found' });
  for (const field of EDITABLE_PLACE_FIELDS) {
    if (field in req.body) place[field] = req.body[field];
  }
  saveTrip(trip);
  res.json(place);
});

app.delete('/api/trips/:tripId/places/:id', (req, res) => {
  const trip = req.trip;
  trip.places = trip.places.filter((p) => p.id !== req.params.id);
  saveTrip(trip);
  res.json({ ok: true });
});

// Reassign the full ordered list of place ids for a given day (drag-and-drop reorder)
app.post('/api/trips/:tripId/reorder', (req, res) => {
  const trip = req.trip;
  const { day, orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds must be an array' });
  orderedIds.forEach((id, idx) => {
    const place = trip.places.find((p) => p.id === id);
    if (place) {
      place.day = day;
      place.order = idx;
    }
  });
  saveTrip(trip);
  res.json(trip);
});

function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Nearest-neighbor reorder of a day's places using straight-line distance (no API calls)
app.post('/api/trips/:tripId/optimize/:day', (req, res) => {
  const trip = req.trip;
  const day = parseInt(req.params.day, 10);
  const dayPlaces = trip.places.filter((p) => p.day === day).sort((a, b) => a.order - b.order);
  if (dayPlaces.length < 2) return res.json(trip);

  const remaining = [...dayPlaces];
  const ordered = [remaining.shift()];
  while (remaining.length) {
    const last = ordered[ordered.length - 1];
    let bestIdx = 0;
    let bestDist = Infinity;
    remaining.forEach((p, idx) => {
      const d = haversine(last, p);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = idx;
      }
    });
    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }
  ordered.forEach((p, idx) => {
    p.order = idx;
  });
  saveTrip(trip);
  res.json(trip);
});

// Routing between consecutive places of a day via Amap directions
app.get('/api/trips/:tripId/route', async (req, res) => {
  const trip = req.trip;
  const { day, mode, city } = req.query;
  const dayPlaces = trip.places
    .filter((p) => p.day === parseInt(day, 10))
    .sort((a, b) => a.order - b.order);

  if (dayPlaces.length < 2) return res.json({ legs: [] });

  const endpointByMode = {
    driving: 'direction/driving',
    walking: 'direction/walking',
    transit: 'direction/transit/integrated',
  };
  const endpoint = endpointByMode[mode] || endpointByMode.driving;
  const transitCity = city || trip.cities.find((c) => typeof c === 'object')?.adcode || '';

  try {
    const legs = [];
    for (let i = 0; i < dayPlaces.length - 1; i++) {
      const o = dayPlaces[i];
      const d = dayPlaces[i + 1];
      const params = {
        origin: `${o.lng},${o.lat}`,
        destination: `${d.lng},${d.lat}`,
      };
      if (mode === 'transit') params.city = transitCity;
      const data = await amapGet(endpoint, params);
      let distance, duration;
      if (mode === 'transit') {
        const plan = data.route?.transits?.[0];
        distance = plan ? parseInt(plan.distance, 10) : null;
        duration = plan ? parseInt(plan.duration, 10) : null;
      } else {
        const p = data.route?.paths?.[0];
        distance = p ? parseInt(p.distance, 10) : null;
        duration = p ? parseInt(p.duration, 10) : null;
      }
      legs.push({
        from: o.name,
        to: d.name,
        distanceMeters: distance,
        durationSeconds: duration,
      });
    }
    res.json({ legs });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3300;
app.listen(PORT, () => {
  console.log(`China trip planner running at http://localhost:${PORT}`);
});
