let trips = [];
let currentTripId = null;
let trip = null;
let activeDay = 1;
let activeCity = null;
let map = null;
let markers = [];
let polyline = null;
let cityOutlines = [];
let cityRegionToken = 0;

const CATEGORY_META = {
  attraction: { emoji: '🏯', color: '#2563eb', label: 'Attraction' },
  restaurant: { emoji: '🍜', color: '#f97316', label: 'Restaurant' },
  hotel: { emoji: '🏨', color: '#8b5cf6', label: 'Hotel' },
  shopping: { emoji: '🛍️', color: '#ec4899', label: 'Shopping' },
  bar: { emoji: '🍸', color: '#eab308', label: 'Bar' },
  transport: { emoji: '🚉', color: '#0d9488', label: 'Transport' },
  other: { emoji: '📍', color: '#6b7280', label: 'Other' },
};

const FILTER_KEY = 'chinaTripCategoryFilters';
const HISTORY_KEY = 'chinaTripSearchHistory';
const CURRENT_TRIP_KEY = 'chinaTripCurrentTripId';
const activeCityKey = () => `chinaTripActiveCity:${currentTripId}`;

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private window etc.) — preference just won't persist.
  }
}

function loadActiveFilters() {
  try {
    const saved = JSON.parse(storageGet(FILTER_KEY));
    if (Array.isArray(saved) && saved.length) return new Set(saved);
  } catch {
    // fall through to default
  }
  return new Set(Object.keys(CATEGORY_META));
}

let activeFilters = loadActiveFilters();

// Classifies Amap's raw POI category string (e.g. "餐饮服务;中餐厅;中餐厅") into our marker categories.
function mapAmapCategory(rawType) {
  if (!rawType) return 'other';
  if (rawType.includes('酒吧') || rawType.includes('夜店') || rawType.includes('迪厅')) return 'bar';
  if (rawType.includes('餐饮')) return 'restaurant';
  if (rawType.includes('住宿') || rawType.includes('宾馆') || rawType.includes('酒店')) return 'hotel';
  if (rawType.includes('购物')) return 'shopping';
  if (
    rawType.includes('交通设施服务') ||
    rawType.includes('机场') ||
    rawType.includes('火车站') ||
    rawType.includes('地铁站') ||
    rawType.includes('长途汽车站')
  )
    return 'transport';
  if (
    rawType.includes('风景名胜') ||
    rawType.includes('文物古迹') ||
    rawType.includes('旅游景点') ||
    rawType.includes('公园广场')
  )
    return 'attraction';
  return 'other';
}

function categoryOf(place) {
  return place.type && CATEGORY_META[place.type] ? place.type : 'other';
}

// ---------- Dates ----------

function parseIsoDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Computes the calendar Date for a 1-indexed trip day, based on trip.startDate.
function dayDate(dayNum) {
  if (!trip || !trip.startDate) return null;
  const date = parseIsoDate(trip.startDate);
  date.setDate(date.getDate() + (dayNum - 1));
  return date;
}

function isSameDate(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Falls back to "Day N" when no start date is set yet.
function formatDayLabel(dayNum, short) {
  const date = dayDate(dayNum);
  if (!date) return `Day ${dayNum}`;
  const opts = short
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
  let label = date.toLocaleDateString(undefined, opts);
  if (isSameDate(date, new Date())) label += ' · Today';
  return label;
}

function dayLabelShort(dayNum) {
  return dayNum === 0 ? 'Unscheduled' : formatDayLabel(dayNum, true);
}

// ---------- API ----------

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'request failed');
  }
  return res.json();
}

function tripApi(path, opts) {
  return api(`/api/trips/${encodeURIComponent(currentTripId)}${path}`, opts);
}

// Older trips may still hold plain-string city names until the server upgrades them.
function setTrip(t) {
  t.cities = (t.cities || []).filter((c) => c && typeof c === 'object');
  trip = t;
}

// ---------- Init ----------

async function init() {
  const cfg = await api('/api/config');
  if (!cfg.jsKey) {
    document.getElementById('map').innerHTML =
      '<div style="padding:24px;font-family:sans-serif;color:#6b7280">Set AMAP_JS_KEY in your .env file, then restart the server, to show the map.</div>';
  } else {
    window._AMapSecurityConfig = { securityJsCode: cfg.securityCode || '' };
    await loadScript(`https://webapi.amap.com/maps?v=2.0&key=${cfg.jsKey}`);
    map = new AMap.Map('map', {
      zoom: 5,
      center: [104.195397, 35.86166], // China
    });
    map.on('click', onMapClick);
  }
  await refreshTripList();
  const saved = storageGet(CURRENT_TRIP_KEY);
  await switchTrip(trips.some((t) => t.id === saved) ? saved : trips[0].id);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ---------- Trips ----------

async function refreshTripList() {
  ({ trips } = await api('/api/trips'));
  renderTripSelect();
}

function renderTripSelect() {
  const sel = document.getElementById('tripSelect');
  sel.innerHTML = trips
    .map((t) => {
      const date = t.startDate
        ? ' · ' + parseIsoDate(t.startDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
        : '';
      return `<option value="${escapeHtml(t.id)}" ${t.id === currentTripId ? 'selected' : ''}>${escapeHtml(t.title)}${escapeHtml(date)}</option>`;
    })
    .join('');
  document.getElementById('deleteTripBtn').disabled = trips.length <= 1;
}

async function switchTrip(id) {
  resetDeleteButton();
  currentTripId = id;
  storageSet(CURRENT_TRIP_KEY, id);
  activeDay = 1;
  activeCity = null;
  document.getElementById('searchResults').innerHTML = '';
  document.getElementById('nearbyResults').innerHTML = '';
  lastExploreLngLat = null;
  clearExploreOverlay();

  const visibleCount = await loadTrip({ fit: true });
  renderTripSelect();
  if (activeCity) {
    showCityRegion(activeCity, visibleCount === 0);
  } else {
    clearCityOutline();
  }
}

// Opens settings with the title selected so the new trip can be renamed right away.
async function createNewTrip() {
  const created = await api('/api/trips', { method: 'POST', body: JSON.stringify({ title: 'New trip' }) });
  await refreshTripList();
  await switchTrip(created.id);
  document.querySelector('.trip-settings details').open = true;
  const titleInput = document.getElementById('tripTitle');
  titleInput.focus();
  titleInput.select();
}

// Two-click delete instead of window.confirm(), which the in-app browser doesn't support.
let deleteArmTimer = null;

function resetDeleteButton() {
  clearTimeout(deleteArmTimer);
  deleteArmTimer = null;
  const btn = document.getElementById('deleteTripBtn');
  btn.textContent = 'Delete';
  btn.classList.remove('danger');
}

async function deleteCurrentTrip() {
  if (trips.length <= 1) return;
  const btn = document.getElementById('deleteTripBtn');
  if (!deleteArmTimer) {
    btn.textContent = 'Confirm delete?';
    btn.classList.add('danger');
    deleteArmTimer = setTimeout(resetDeleteButton, 4000);
    return;
  }
  resetDeleteButton();
  await tripApi('', { method: 'DELETE' });
  await refreshTripList();
  await switchTrip(trips[0].id);
}

// Returns how many places for the active day are visible on the map.
async function loadTrip({ fit = false } = {}) {
  setTrip(await tripApi(''));
  if (activeDay > trip.days) activeDay = 1;
  if (!activeCity || !trip.cities.some((c) => c.adcode === activeCity.adcode)) {
    const saved = storageGet(activeCityKey());
    activeCity = trip.cities.find((c) => c.adcode === saved) || trip.cities[0] || null;
  }

  document.getElementById('tripTitleDisplay').textContent = trip.title;
  document.getElementById('tripTitle').value = trip.title;
  document.getElementById('tripStartDate').value = trip.startDate || '';
  document.getElementById('tripDays').value = trip.days;

  renderCityChips();
  renderDayTabs();
  return renderDayView(fit);
}

async function saveTripSettings() {
  const title = document.getElementById('tripTitle').value;
  const startDate = document.getElementById('tripStartDate').value;
  const days = parseInt(document.getElementById('tripDays').value, 10) || 1;
  await tripApi('', {
    method: 'PUT',
    body: JSON.stringify({ title, startDate, days }),
  });
  await loadTrip();
  await refreshTripList();
}

// ---------- Cities ----------

function renderCityChips() {
  const el = document.getElementById('tripCityChips');
  if (!trip.cities.length) {
    el.innerHTML = '<p class="hint">No cities yet — search for one above.</p>';
  } else {
    el.innerHTML = trip.cities
      .map(
        (c) => `
      <span class="city-chip ${activeCity && activeCity.adcode === c.adcode ? 'active' : ''}">
        <button type="button" class="city-chip-name" data-adcode="${escapeHtml(c.adcode)}">${escapeHtml(c.name)}${c.en ? ' · ' + escapeHtml(c.en) : ''}</button>
        <button type="button" class="city-chip-remove" data-adcode="${escapeHtml(c.adcode)}" aria-label="Remove ${escapeHtml(c.name)}">✕</button>
      </span>`
      )
      .join('');
    el.querySelectorAll('.city-chip-name').forEach((btn) =>
      btn.addEventListener('click', () => {
        const c = trip.cities.find((x) => x.adcode === btn.dataset.adcode);
        if (c) selectCity(c);
      })
    );
    el.querySelectorAll('.city-chip-remove').forEach((btn) =>
      btn.addEventListener('click', () => removeCity(btn.dataset.adcode))
    );
  }
  document.getElementById('activeCityLabel').textContent = activeCity
    ? `Searching within ${activeCity.name}${activeCity.en ? ' (' + activeCity.en + ')' : ''}`
    : 'No city selected — searching all of China';
}

async function selectCity(city, { fly = true } = {}) {
  if (!trip.cities.some((c) => c.adcode === city.adcode)) {
    setTrip(await tripApi('', { method: 'PUT', body: JSON.stringify({ cities: [...trip.cities, city] }) }));
  }
  activeCity = trip.cities.find((c) => c.adcode === city.adcode) || null;
  storageSet(activeCityKey(), activeCity ? activeCity.adcode : '');
  renderCityChips();
  if (fly && activeCity) await showCityRegion(activeCity, true);
}

async function removeCity(adcode) {
  setTrip(
    await tripApi('', {
      method: 'PUT',
      body: JSON.stringify({ cities: trip.cities.filter((c) => c.adcode !== adcode) }),
    })
  );
  if (activeCity && activeCity.adcode === adcode) {
    activeCity = trip.cities[0] || null;
    storageSet(activeCityKey(), activeCity ? activeCity.adcode : '');
    if (activeCity) showCityRegion(activeCity, true);
    else clearCityOutline();
  }
  renderCityChips();
}

const boundaryCache = new Map();

function clearCityOutline() {
  cityRegionToken++;
  cityOutlines.forEach((p) => p.setMap(null));
  cityOutlines = [];
}

// Draws the city's administrative boundary and, if `fit`, zooms the map to it.
async function showCityRegion(city, fit) {
  if (!map) return;
  const token = ++cityRegionToken;
  let rings = boundaryCache.get(city.adcode);
  if (!rings) {
    try {
      ({ rings } = await api(`/api/cities/${encodeURIComponent(city.adcode)}/boundary`));
      boundaryCache.set(city.adcode, rings);
    } catch {
      rings = [];
    }
  }
  if (token !== cityRegionToken) return; // a newer city was picked while this one loaded

  cityOutlines.forEach((p) => p.setMap(null));
  // Each ring is a separate piece (e.g. islands), so draw them as separate polygons.
  cityOutlines = rings
    .filter((ring) => ring.length > 2)
    .map(
      (ring) =>
        new AMap.Polygon({
          path: ring,
          strokeColor: '#2563eb',
          strokeWeight: 2,
          strokeStyle: 'dashed',
          fillColor: '#2563eb',
          fillOpacity: 0.04,
          bubble: true, // let clicks fall through to the map for Explore nearby
          zIndex: 5,
        })
    );
  cityOutlines.forEach((p) => p.setMap(map));

  if (!fit) return;
  if (cityOutlines.length) {
    map.setFitView(cityOutlines);
  } else if (city.center) {
    map.setZoomAndCenter(city.level === 'province' ? 7 : 10, city.center);
  }
}

const cityInput = document.getElementById('cityInput');
const cityDropdown = document.getElementById('cityDropdown');
let citySuggestions = [];

function closeCityDropdown() {
  cityDropdown.classList.remove('open');
  cityDropdown.innerHTML = '';
  citySuggestions = [];
}

async function fetchCities(q) {
  const { cities } = await api(`/api/cities?q=${encodeURIComponent(q)}`);
  return cities;
}

const fetchCitySuggestions = debounce(async (q) => {
  if (!q) return closeCityDropdown();
  try {
    const cities = await fetchCities(q);
    if (cityInput.value.trim() !== q) return; // user kept typing; a newer request will render
    citySuggestions = cities;
    cityDropdown.innerHTML = cities.length
      ? cities
          .map(
            (c, idx) => `
        <li data-city-idx="${idx}">
          <span class="s-name">${escapeHtml(c.name)}${c.en ? ' · ' + escapeHtml(c.en) : ''}</span><br/>
          <span class="s-addr">${c.level === 'province' ? 'Province / region' : escapeHtml(c.province || 'Municipality')}</span>
        </li>`
          )
          .join('')
      : '<li class="history-label">No matching city</li>';
    cityDropdown.classList.add('open');
    cityDropdown.querySelectorAll('li[data-city-idx]').forEach((li) =>
      li.addEventListener('click', () => pickCity(citySuggestions[parseInt(li.dataset.cityIdx, 10)]))
    );
  } catch {
    closeCityDropdown();
  }
}, 150);

async function pickCity(city) {
  if (!city) return;
  cityInput.value = '';
  closeCityDropdown();
  await selectCity(city);
}

// ---------- Day tabs & list ----------

function renderDayTabs() {
  const el = document.getElementById('dayTabs');
  const buttons = [];
  for (let d = 1; d <= trip.days; d++) {
    buttons.push(
      `<button data-day="${d}" class="${d === activeDay ? 'active' : ''}">${escapeHtml(formatDayLabel(d, true))}</button>`
    );
  }
  buttons.push(
    `<button data-day="0" class="${activeDay === 0 ? 'active' : ''}">Unscheduled</button>`
  );
  el.innerHTML = buttons.join('');
  el.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeDay = parseInt(btn.dataset.day, 10);
      renderDayTabs();
      const visible = renderDayView(true);
      if (!visible && activeCity) showCityRegion(activeCity, true);
    });
  });
}

function placesForActiveDay() {
  const dayKey = activeDay === 0 ? null : activeDay;
  return trip.places
    .filter((p) => (p.day ?? null) === dayKey)
    .sort((a, b) => a.order - b.order);
}

// Returns how many of the day's places are visible on the map after filtering.
function renderDayView(fit = false) {
  document.getElementById('dayViewTitle').textContent =
    activeDay === 0 ? 'Unscheduled' : formatDayLabel(activeDay, false);
  const list = placesForActiveDay();
  renderCategoryFilters();

  const ul = document.getElementById('placeList');
  ul.innerHTML = list
    .map((p, idx) => {
      const cat = categoryOf(p);
      return `
    <li draggable="true" data-id="${p.id}" class="${activeFilters.has(cat) ? '' : 'filtered-out'}">
      <span class="order-badge">${idx + 1}</span>
      <div class="meta">
        <div class="name"><span class="cat-emoji">${CATEGORY_META[cat].emoji}</span>${escapeHtml(p.name)} ${p.rating ? `⭐${escapeHtml(p.rating)}` : ''}</div>
        <div class="addr">${escapeHtml(p.address || '')}</div>
        <select data-id="${p.id}" class="dayMoveSelect">
          ${dayOptions(p.day)}
        </select>
        <select data-id="${p.id}" class="typeSelect">
          ${Object.entries(CATEGORY_META)
            .map(
              ([t, meta]) =>
                `<option value="${t}" ${t === cat ? 'selected' : ''}>${meta.emoji} ${meta.label}</option>`
            )
            .join('')}
        </select>
      </div>
      <button class="remove-btn" data-id="${p.id}">✕</button>
    </li>`;
    })
    .join('');

  ul.querySelectorAll('.remove-btn').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await tripApi(`/places/${btn.dataset.id}`, { method: 'DELETE' });
      await loadTrip();
    })
  );
  ul.querySelectorAll('.dayMoveSelect').forEach((sel) =>
    sel.addEventListener('change', async () => {
      const day = sel.value === '0' ? null : parseInt(sel.value, 10);
      await tripApi(`/places/${sel.dataset.id}`, {
        method: 'PUT',
        body: JSON.stringify({ day }),
      });
      await loadTrip();
    })
  );
  ul.querySelectorAll('.typeSelect').forEach((sel) =>
    sel.addEventListener('change', async () => {
      await tripApi(`/places/${sel.dataset.id}`, {
        method: 'PUT',
        body: JSON.stringify({ type: sel.value }),
      });
      await loadTrip();
    })
  );

  setupDragReorder(ul);
  const visibleList = list.filter((p) => activeFilters.has(categoryOf(p)));
  renderMapMarkers(visibleList, fit);
  document.getElementById('legList').innerHTML = '';
  return visibleList.length;
}

function renderCategoryFilters() {
  const el = document.getElementById('categoryFilters');
  el.innerHTML = Object.entries(CATEGORY_META)
    .map(
      ([key, meta]) => `
    <button type="button" class="filter-chip ${activeFilters.has(key) ? 'active' : ''}" data-cat="${key}" style="--chip-color:${meta.color}">
      ${meta.emoji} ${meta.label}
    </button>`
    )
    .join('');
  el.querySelectorAll('.filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cat = btn.dataset.cat;
      if (activeFilters.has(cat)) {
        activeFilters.delete(cat);
      } else {
        activeFilters.add(cat);
      }
      storageSet(FILTER_KEY, JSON.stringify([...activeFilters]));
      renderDayView();
    });
  });
}

function dayOptions(currentDay) {
  const opts = [`<option value="0" ${currentDay == null ? 'selected' : ''}>Unscheduled</option>`];
  for (let d = 1; d <= trip.days; d++) {
    opts.push(`<option value="${d}" ${d === currentDay ? 'selected' : ''}>${escapeHtml(formatDayLabel(d, true))}</option>`);
  }
  return opts.join('');
}

function setupDragReorder(ul) {
  let dragId = null;
  ul.querySelectorAll('li').forEach((li) => {
    li.addEventListener('dragstart', () => {
      dragId = li.dataset.id;
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => e.preventDefault());
    li.addEventListener('drop', async (e) => {
      e.preventDefault();
      const targetId = li.dataset.id;
      if (targetId === dragId) return;
      const ids = Array.from(ul.querySelectorAll('li')).map((el) => el.dataset.id);
      const fromIdx = ids.indexOf(dragId);
      const toIdx = ids.indexOf(targetId);
      ids.splice(fromIdx, 1);
      ids.splice(toIdx, 0, dragId);
      await tripApi('/reorder', {
        method: 'POST',
        body: JSON.stringify({ day: activeDay === 0 ? null : activeDay, orderedIds: ids }),
      });
      await loadTrip();
    });
  });
}

function renderMapMarkers(list, fit) {
  if (!map) return;
  markers.forEach((m) => m.setMap(null));
  markers = [];
  if (polyline) polyline.setMap(null);
  polyline = null;

  if (!list.length) return;

  const path = [];
  list.forEach((p, idx) => {
    const meta = CATEGORY_META[categoryOf(p)];
    const marker = new AMap.Marker({
      position: [p.lng, p.lat],
      content: `<div class="map-pin" style="background:${meta.color}"><span>${meta.emoji}</span></div>`,
      offset: new AMap.Pixel(-15, -30),
      label: { content: `${idx + 1}`, direction: 'top', offset: new AMap.Pixel(0, -4) },
      title: p.name,
    });
    marker.setMap(map);
    markers.push(marker);
    path.push([p.lng, p.lat]);
  });

  if (path.length > 1) {
    polyline = new AMap.Polyline({
      path,
      strokeColor: '#2563eb',
      strokeWeight: 3,
      strokeStyle: 'dashed',
    });
    polyline.setMap(map);
  }
  if (fit) map.setFitView(markers);
}

// ---------- Adding places ----------

function addPlaceFromPoi(p) {
  return tripApi('/places', {
    method: 'POST',
    body: JSON.stringify({
      name: p.name,
      address: p.address,
      lng: p.lng,
      lat: p.lat,
      day: activeDay === 0 ? null : activeDay,
      type: mapAmapCategory(p.type),
      source: 'amap',
      rating: p.rating,
      tel: p.tel,
    }),
  });
}

function renderPoiResults(el, pois, extraInfo) {
  el.innerHTML = pois
    .map((p, idx) => {
      const cat = mapAmapCategory(p.type);
      const extra = extraInfo ? extraInfo(p) : '';
      return `
      <li>
        <div class="name"><span class="cat-emoji">${CATEGORY_META[cat].emoji}</span>${escapeHtml(p.name)} ${p.rating ? `⭐${escapeHtml(p.rating)}` : ''}</div>
        <div class="addr">${escapeHtml(p.address || '')}${extra ? ' · ' + escapeHtml(extra) : ''}</div>
        <button data-idx="${idx}">Add to ${escapeHtml(dayLabelShort(activeDay))}</button>
      </li>`;
    })
    .join('');
}

// `cityOverride` lets a history entry search the city it was recorded in.
async function searchPlaces(cityOverride) {
  const keywords = searchKeywordsInput.value.trim();
  if (!keywords) return;
  const city = cityOverride !== undefined ? cityOverride : activeCity;
  closeSuggestDropdown();
  recordSearchHistory(keywords, city);
  const resultsEl = document.getElementById('searchResults');
  resultsEl.innerHTML = '<li>Searching…</li>';
  try {
    const { pois } = await api(
      `/api/search?keywords=${encodeURIComponent(keywords)}&city=${encodeURIComponent(city ? city.adcode : '')}`
    );
    if (!pois.length) {
      resultsEl.innerHTML = '<li>No matches found on Amap. Try a shorter or different name.</li>';
      return;
    }
    renderPoiResults(resultsEl, pois);
    resultsEl.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await addPlaceFromPoi(pois[parseInt(btn.dataset.idx, 10)]);
        resultsEl.innerHTML = '';
        searchKeywordsInput.value = '';
        await loadTrip();
      });
    });
  } catch (err) {
    resultsEl.innerHTML = `<li>Error: ${escapeHtml(err.message)}</li>`;
  }
}

// ---------- Explore nearby ----------

let exploreMode = false;
let exploreCircle = null;
let exploreCenterMarker = null;
let lastExploreLngLat = null;

function toggleExploreMode() {
  exploreMode = !exploreMode;
  const btn = document.getElementById('exploreToggleBtn');
  btn.classList.toggle('active', exploreMode);
  btn.textContent = exploreMode
    ? '📍 Explore mode on — click the map'
    : '📍 Click map to explore nearby';
  if (!exploreMode) clearExploreOverlay();
}

function clearExploreOverlay() {
  if (exploreCircle) {
    exploreCircle.setMap(null);
    exploreCircle = null;
  }
  if (exploreCenterMarker) {
    exploreCenterMarker.setMap(null);
    exploreCenterMarker = null;
  }
}

function showExploreOverlay(lng, lat) {
  clearExploreOverlay();
  const radius = parseInt(document.getElementById('exploreRadius').value, 10);
  exploreCenterMarker = new AMap.Marker({
    position: [lng, lat],
    content: '<div class="explore-pin"></div>',
    offset: new AMap.Pixel(-7, -7),
  });
  exploreCenterMarker.setMap(map);
  exploreCircle = new AMap.Circle({
    center: [lng, lat],
    radius,
    strokeColor: '#059669',
    strokeWeight: 2,
    fillColor: '#059669',
    fillOpacity: 0.12,
  });
  exploreCircle.setMap(map);
  map.setFitView([exploreCircle]);
}

function onMapClick(e) {
  if (!exploreMode) return;
  const lng = e.lnglat.getLng();
  const lat = e.lnglat.getLat();
  lastExploreLngLat = { lng, lat };
  showExploreOverlay(lng, lat);
  fetchNearby(lng, lat);
}

async function fetchNearby(lng, lat) {
  const radius = document.getElementById('exploreRadius').value;
  const keywords = document.getElementById('exploreKeyword').value.trim();
  const nearbyResultsEl = document.getElementById('nearbyResults');
  nearbyResultsEl.innerHTML = '<li>Searching nearby…</li>';
  try {
    const { pois } = await api(
      `/api/nearby?lng=${lng}&lat=${lat}&radius=${radius}&keywords=${encodeURIComponent(keywords)}`
    );
    if (!pois.length) {
      nearbyResultsEl.innerHTML = '<li>No places found in this radius.</li>';
      return;
    }
    renderPoiResults(nearbyResultsEl, pois, (p) =>
      p.distanceMeters != null ? `${p.distanceMeters} m away` : ''
    );
    nearbyResultsEl.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await addPlaceFromPoi(pois[parseInt(btn.dataset.idx, 10)]);
        await loadTrip();
      });
    });
  } catch (err) {
    nearbyResultsEl.innerHTML = `<li>Error: ${escapeHtml(err.message)}</li>`;
  }
}

// ---------- Day actions ----------

async function optimizeDay() {
  if (activeDay === 0) return;
  setTrip(await tripApi(`/optimize/${activeDay}`, { method: 'POST' }));
  renderDayView();
}

async function showRoute() {
  if (activeDay === 0) return;
  const mode = document.getElementById('routeMode').value;
  const legList = document.getElementById('legList');
  legList.innerHTML = '<li>Loading route…</li>';
  try {
    const city = activeCity ? activeCity.adcode : '';
    const { legs } = await tripApi(`/route?day=${activeDay}&mode=${mode}&city=${encodeURIComponent(city)}`);
    if (!legs.length) {
      legList.innerHTML = '<li>Add at least two places to this day first.</li>';
      return;
    }
    legList.innerHTML = legs
      .map(
        (leg) =>
          `<li>${escapeHtml(leg.from)} → ${escapeHtml(leg.to)}: ${
            leg.distanceMeters != null ? (leg.distanceMeters / 1000).toFixed(1) + ' km' : '?'
          }, ${leg.durationSeconds != null ? Math.round(leg.durationSeconds / 60) + ' min' : '?'}</li>`
      )
      .join('');
  } catch (err) {
    legList.innerHTML = `<li>Error: ${escapeHtml(err.message)}</li>`;
  }
}

// ---------- Search history & keyword autocomplete ----------

function getHistory() {
  try {
    const history = JSON.parse(storageGet(HISTORY_KEY)) || [];
    // Older entries stored the city as a plain string; those can't be re-scoped.
    return history.map((h) => ({ ...h, city: h.city && typeof h.city === 'object' ? h.city : null }));
  } catch {
    return [];
  }
}

function recordSearchHistory(keywords, city) {
  const entryCity = city ? { name: city.name, adcode: city.adcode } : null;
  const cityKey = entryCity ? entryCity.adcode : '';
  let history = getHistory().filter(
    (h) => !(h.keywords === keywords && (h.city ? h.city.adcode : '') === cityKey)
  );
  history.unshift({ keywords, city: entryCity });
  history = history.slice(0, 8);
  storageSet(HISTORY_KEY, JSON.stringify(history));
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

const searchKeywordsInput = document.getElementById('searchKeywords');
const suggestDropdown = document.getElementById('suggestDropdown');

function closeSuggestDropdown() {
  suggestDropdown.classList.remove('open');
  suggestDropdown.innerHTML = '';
}

function showHistoryDropdown() {
  const history = getHistory();
  if (!history.length) {
    closeSuggestDropdown();
    return;
  }
  suggestDropdown.innerHTML =
    '<li class="history-label">Recent searches</li>' +
    history
      .map(
        (h, idx) =>
          `<li data-history-idx="${idx}"><span class="s-name">${escapeHtml(h.keywords)}</span>${
            h.city ? ` <span class="s-addr">(${escapeHtml(h.city.name)})</span>` : ''
          }</li>`
      )
      .join('');
  suggestDropdown.classList.add('open');
  suggestDropdown.querySelectorAll('li[data-history-idx]').forEach((li) => {
    li.addEventListener('click', () => {
      const h = history[parseInt(li.dataset.historyIdx, 10)];
      searchKeywordsInput.value = h.keywords;
      const tripCity = h.city && trip.cities.find((c) => c.adcode === h.city.adcode);
      if (tripCity && (!activeCity || activeCity.adcode !== tripCity.adcode)) selectCity(tripCity);
      searchPlaces(h.city);
    });
  });
}

const fetchSuggestions = debounce(async (keywords) => {
  if (!keywords) {
    showHistoryDropdown();
    return;
  }
  try {
    const { tips } = await api(
      `/api/suggest?keywords=${encodeURIComponent(keywords)}&city=${encodeURIComponent(activeCity ? activeCity.adcode : '')}`
    );
    if (!tips.length) {
      closeSuggestDropdown();
      return;
    }
    suggestDropdown.innerHTML = tips
      .map(
        (t, idx) =>
          `<li data-tip-idx="${idx}"><span class="s-name">${escapeHtml(t.name)}</span><br/><span class="s-addr">${escapeHtml(
            t.district || t.address || ''
          )}</span></li>`
      )
      .join('');
    suggestDropdown.classList.add('open');
    suggestDropdown.querySelectorAll('li[data-tip-idx]').forEach((li) => {
      li.addEventListener('click', () => {
        searchKeywordsInput.value = tips[parseInt(li.dataset.tipIdx, 10)].name;
        searchPlaces();
      });
    });
  } catch {
    closeSuggestDropdown();
  }
}, 250);

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

// ---------- Wiring ----------

document.getElementById('tripSelect').addEventListener('change', (e) => switchTrip(e.target.value));
document.getElementById('newTripBtn').addEventListener('click', createNewTrip);
document.getElementById('deleteTripBtn').addEventListener('click', deleteCurrentTrip);
document.getElementById('saveTripBtn').addEventListener('click', saveTripSettings);
document.getElementById('searchBtn').addEventListener('click', () => searchPlaces());
document.getElementById('optimizeBtn').addEventListener('click', optimizeDay);
document.getElementById('routeBtn').addEventListener('click', showRoute);
document.getElementById('exploreToggleBtn').addEventListener('click', toggleExploreMode);
document.getElementById('exploreRadius').addEventListener('change', () => {
  if (lastExploreLngLat) {
    showExploreOverlay(lastExploreLngLat.lng, lastExploreLngLat.lat);
    fetchNearby(lastExploreLngLat.lng, lastExploreLngLat.lat);
  }
});

cityInput.addEventListener('input', () => fetchCitySuggestions(cityInput.value.trim()));
cityInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') closeCityDropdown();
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const q = cityInput.value.trim();
  if (!q) return;
  const list = citySuggestions.length ? citySuggestions : await fetchCities(q);
  pickCity(list[0]);
});

searchKeywordsInput.addEventListener('input', (e) => fetchSuggestions(e.target.value.trim()));
searchKeywordsInput.addEventListener('focus', () => {
  if (!searchKeywordsInput.value.trim()) showHistoryDropdown();
});
searchKeywordsInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchPlaces();
  if (e.key === 'Escape') closeSuggestDropdown();
});

document.addEventListener('click', (e) => {
  if (e.target !== searchKeywordsInput && !suggestDropdown.contains(e.target)) closeSuggestDropdown();
  if (e.target !== cityInput && !cityDropdown.contains(e.target)) closeCityDropdown();
});

init();
