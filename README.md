# China Trip Planner

A trip itinerary planner built specifically for travelling in mainland China, where Google Maps and most Western travel apps (Wanderlog, TripIt) work poorly.

It's built on **Amap (高德地图)**, the map platform people in China actually use. You can look up restaurants and sights found on **Dianping (大众点评)**, the main review app in China, then arrange them into a day-by-day plan with real travel times between stops.

## Features

- **Multiple trips**, each with its own cities, dates and places
- **City search in any script:** type `广州`, `guangzhou` or `canton` and get Guangzhou; the map jumps to the city and outlines its boundary
- **Place lookup:** paste a place name from Dianping and get Amap's real location, address and rating, with suggestions as you type and your recent searches
- **Explore nearby:** click anywhere on the map to list places within 500 m–5 km, nearest first
- **Day planning:**
  - day tabs show real dates
  - drag to reorder stops
  - one-click route optimisation
  - driving / walking / transit time between stops
- **Categorised map:** places are tagged as restaurant, hotel, attraction, bar, shopping or transport, using Amap's own category data; map pins are colour-coded and can be filtered

## Tech stack

- **Backend:** Node.js, Express
- **Frontend:** vanilla JavaScript, HTML, CSS (no build step)
- **APIs:** Amap Web Service API (place search, input tips, around-search, district boundaries, directions) and Amap JS API 2.0 (interactive map)
- **Libraries:** `pinyin-pro` (pinyin conversion), `nanoid` (IDs), `dotenv` (config)

## How it works

```
Browser (public/)                         Server (server.js)                  Amap
─────────────────                         ──────────────────                  ────
Map rendering ── Amap JS API key ──────────────────────────────────────────►  JS API
Search, trips ── /api/* ───────────────►  Express routes ─ secret key ─────►  Web Service API
                                          Trips: data/trips/<id>.json
                                          City index: cached data/cities.json
```

- **The secret key stays on the server.** All search, routing and boundary requests go through Express, so Amap's web-service key never reaches the browser. The browser only gets the separate map-display key, which Amap is designed to expose.
- **Pinyin and English city search.** The server downloads the full Chinese city list once from Amap's district API and caches it. It then turns each name into pinyin, removing endings like 市 (city), 省 (province), and the long names of autonomous prefectures (大理白族自治州 → Dali). That lets it match Latin-letter input against Chinese names. Results are scored so exact matches and popular destinations come first: `cheng` gives 成都 (Chengdu) before 澄迈县, a small county.
- **Working around Dianping.** Dianping has no public API, and scraping it would break its terms of service. So you find places on Dianping yourself, and the app looks them up on Amap to get coordinates and data.
- **Search actually stays inside the city.** Searches are limited by Amap's numeric city codes rather than city names, because Amap silently ignores English city names.
- **Route optimisation.** Each day is re-ordered so every stop is followed by the nearest remaining one, using straight-line distance. This costs no API calls. Real distances and travel times are then fetched only for the stops in their final order.

## Running locally

**Requirements:** Node.js 18+ and a free [Amap developer account](https://lbs.amap.com).

1. **Get your keys.** In the Amap console, go to 应用管理 (Application management), create an app, and add two keys:
   - **Web服务 (Web service)**
   - **Web端 (JS API)**, which also gives you a 安全密钥 (security code)
2. **Add them to the app.** Copy `.env.example` to `.env` and fill in the three values.
3. **Install and start:**

   ```
   npm install
   npm start
   ```

4. Open http://localhost:3300.

## Roadmap

- [ ] User accounts and a database, so each person's trips sync across their devices
- [ ] Hosted live demo with guest access and rate limiting
- [ ] Automated end-to-end tests
- [ ] Offline copy of the itinerary on mobile for patchy connections in China
