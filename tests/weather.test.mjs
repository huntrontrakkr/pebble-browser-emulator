import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LOCATION_BYTES,
  WATCH_APP_PREFS_DATABASE,
  WEATHER_DATABASE,
  MAX_PHRASE_BYTES,
  SIMULATED_LOCATION_KEY,
  UNKNOWN_TEMPERATURE,
  WEATHER_PREFERENCE_KEY,
  weatherLocationsPreference,
  weatherRecord,
} from '../src/app/weather-records.ts';
import {
  coordinateName,
  describeWeatherCode,
  fetchForecast,
  forecastUrl,
  parseForecast,
  weatherReading,
} from '../src/app/weather-source.ts';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const base = {
  locationName: 'Palo Alto',
  shortPhrase: 'Sunny',
  currentTemperature: 68,
  condition: 'Sun',
  todayHigh: 68,
  todayLow: 52,
  tomorrowCondition: 'CloudyDay',
  tomorrowHigh: 70,
  tomorrowLow: 60,
  updatedUtc: 1461765790,
  isCurrentLocation: true,
};

// Vectors packed independently from weather_db.h (WeatherDBEntry, version 3):
// uint8 version, int16 current, uint8 type, int16 high, int16 low, uint8 type,
// int16 high, int16 low, int32 time, uint8 flag, uint16 size, then the two
// PascalString16s. -fshort-enums makes WeatherType one byte.
test('a weather record matches the firmware WeatherDBEntry layout', () => {
  assert.equal(
    hex(weatherRecord(base)),
    '03440007440034000146003c009ec62057011200090050616c6f20416c746f050053756e6e79',
  );
});

test('negative temperatures and an empty phrase keep the packed layout', () => {
  assert.equal(
    hex(
      weatherRecord({
        ...base,
        locationName: 'Kitchener',
        shortPhrase: '',
        currentTemperature: -10,
        condition: 'PartlyCloudy',
        todayHigh: 0,
        todayLow: -11,
        tomorrowHigh: 2,
        tomorrowLow: -3,
        isCurrentLocation: false,
      }),
    ),
    '03f6ff000000f5ff010200fdff9ec62057000d0009004b69746368656e65720000',
  );
});

test('an entirely unknown forecast is stored as unknown, not as zero', () => {
  const record = weatherRecord({
    locationName: 'x',
    shortPhrase: '',
    currentTemperature: UNKNOWN_TEMPERATURE,
    condition: 'Unknown',
    todayHigh: UNKNOWN_TEMPERATURE,
    todayLow: UNKNOWN_TEMPERATURE,
    tomorrowCondition: 'Unknown',
    tomorrowHigh: UNKNOWN_TEMPERATURE,
    tomorrowLow: UNKNOWN_TEMPERATURE,
    updatedUtc: 1,
    isCurrentLocation: false,
  });
  assert.equal(hex(record), '03ff7fffff7fff7fffff7fff7f010000000005000100780000');
});

test('a record never exceeds the firmware MAX_ENTRY_SIZE', () => {
  const record = weatherRecord({
    ...base,
    locationName: 'L'.repeat(MAX_LOCATION_BYTES),
    shortPhrase: 'P'.repeat(MAX_PHRASE_BYTES),
  });
  assert.equal(record.length, 116);
});

test('oversized strings are refused rather than silently truncated', () => {
  assert.throws(
    () => weatherRecord({ ...base, locationName: 'L'.repeat(MAX_LOCATION_BYTES + 1) }),
    /location name is longer/,
  );
  assert.throws(
    () => weatherRecord({ ...base, shortPhrase: 'P'.repeat(MAX_PHRASE_BYTES + 1) }),
    /condition phrase is longer/,
  );
  // Multi-byte characters count as their encoded length, not their code points.
  assert.throws(
    () => weatherRecord({ ...base, shortPhrase: 'é'.repeat(MAX_PHRASE_BYTES) }),
    /condition phrase is longer/,
  );
});

test('an update time the firmware treats as no data is refused', () => {
  assert.throws(() => weatherRecord({ ...base, updatedUtc: 0 }), /positive whole number/);
  assert.throws(() => weatherRecord({ ...base, updatedUtc: 2 ** 31 }), /outside the firmware/);
});

test('a nameless location and a fractional temperature are refused', () => {
  assert.throws(() => weatherRecord({ ...base, locationName: '' }), /needs a location name/);
  assert.throws(() => weatherRecord({ ...base, currentTemperature: 12.5 }), /whole number/);
  assert.throws(() => weatherRecord({ ...base, condition: 'Drizzle' }), /Unknown weather/);
});

test('the records go to the databases BlobDBId names', () => {
  assert.equal(WEATHER_DATABASE, 5);
  // BlobDBIdWatchAppPrefs, not BlobDBIdPrefs (7), which refuses this key.
  assert.equal(WATCH_APP_PREFS_DATABASE, 9);
});

test('the location preference carries the count the firmware validates against', () => {
  assert.equal(Buffer.from(WEATHER_PREFERENCE_KEY).toString(), 'weatherApp');
  // watch_app_prefs_db.c: (val_len % sizeof(Uuid)) must equal the 1-byte header
  // and val_len must cover every listed location.
  assert.equal(weatherLocationsPreference([SIMULATED_LOCATION_KEY]).length % 16, 1);
  assert.equal(weatherLocationsPreference([]).length % 16, 1);
  const value = weatherLocationsPreference([SIMULATED_LOCATION_KEY]);
  assert.equal(value.length, 1 + 16);
  assert.equal(value[0], 1);
  assert.equal(hex(value.subarray(1)), hex(SIMULATED_LOCATION_KEY));
  assert.equal(weatherLocationsPreference([]).length, 1);
  assert.throws(() => weatherLocationsPreference([new Uint8Array(15)]), /16-byte UUID/);
});

test('WMO codes map onto the ten weather types the firmware can draw', () => {
  assert.deepEqual(describeWeatherCode(0), ['Sun', 'Clear']);
  assert.deepEqual(describeWeatherCode(3), ['CloudyDay', 'Overcast']);
  assert.deepEqual(describeWeatherCode(75), ['HeavySnow', 'Heavy snow']);
  assert.deepEqual(describeWeatherCode(99), ['HeavyRain', 'Thunderstorm, heavy hail']);
  // An unmapped or missing code is reported as unknown rather than guessed.
  assert.deepEqual(describeWeatherCode(4), ['Unknown', 'Weather code 4']);
  assert.deepEqual(describeWeatherCode(undefined), ['Unknown', '']);
  assert.deepEqual(describeWeatherCode('3'), ['Unknown', '']);
});

test('every mapped phrase fits the record', () => {
  for (let code = 0; code <= 99; code++) {
    const [condition, phrase] = describeWeatherCode(code);
    if (condition === 'Unknown') continue;
    assert.ok(Buffer.byteLength(phrase) <= MAX_PHRASE_BYTES, `code ${code}: ${phrase}`);
  }
});

test('the forecast request asks for the fields the record needs', () => {
  const url = new URL(forecastUrl(37.7749, -122.4194, 'fahrenheit'));
  assert.equal(url.origin, 'https://api.open-meteo.com');
  assert.equal(url.pathname, '/v1/forecast');
  assert.equal(url.searchParams.get('latitude'), '37.7749');
  assert.equal(url.searchParams.get('longitude'), '-122.4194');
  assert.equal(url.searchParams.get('temperature_unit'), 'fahrenheit');
  assert.equal(url.searchParams.get('forecast_days'), '2');
  assert.match(url.searchParams.get('daily'), /temperature_2m_max/);
  // No key, no account, nothing of ours in the URL.
  assert.equal(url.username, '');
  assert.equal(url.searchParams.get('apikey'), null);
});

test('an invalid position or unit is refused before any request', () => {
  assert.throws(() => forecastUrl(91, 0, 'celsius'), /valid latitude/);
  assert.throws(() => forecastUrl(0, 181, 'celsius'), /valid latitude/);
  assert.throws(() => forecastUrl(0, 0, 'kelvin'), /temperature unit/);
});

const RESPONSE = {
  current: { time: '2026-09-21T14:00', temperature_2m: 13.4, weather_code: 61 },
  daily: {
    time: ['2026-09-21', '2026-09-22'],
    weather_code: [61, 3],
    temperature_2m_max: [18.2, 16.6],
    temperature_2m_min: [9.1, 8.4],
  },
};

test('a forecast response becomes a record the watch accepts', () => {
  const forecast = parseForecast(RESPONSE, 1789947294);
  assert.equal(forecast.currentTemperature, 13);
  assert.equal(forecast.condition, 'LightRain');
  assert.equal(forecast.shortPhrase, 'Light rain');
  assert.equal(forecast.todayHigh, 18);
  assert.equal(forecast.todayLow, 9);
  assert.equal(forecast.tomorrowCondition, 'CloudyDay');
  assert.equal(forecast.tomorrowHigh, 17);
  assert.equal(forecast.tomorrowLow, 8);
  assert.equal(forecast.observedUtc, Date.parse('2026-09-21T14:00Z') / 1000);
  // The delivery stamp is the emulator's to apply from the watch clock, so the
  // reading deliberately arrives without one.
  const reading = weatherReading(forecast, 'Test City', true);
  assert.equal(reading.updatedUtc, undefined);
  assert.throws(() => weatherRecord(reading), /positive whole number/);
  assert.equal(
    weatherRecord({ ...reading, updatedUtc: 1789947300 }).length,
    20 + 2 + 9 + 2 + 10,
  );
});

test('missing fields stay unknown instead of becoming a plausible number', () => {
  const forecast = parseForecast(
    { current: { time: '2026-09-21T14:00' }, daily: { temperature_2m_max: [null] } },
    1789947294,
  );
  assert.equal(forecast.currentTemperature, UNKNOWN_TEMPERATURE);
  assert.equal(forecast.todayHigh, UNKNOWN_TEMPERATURE);
  assert.equal(forecast.todayLow, UNKNOWN_TEMPERATURE);
  assert.equal(forecast.tomorrowHigh, UNKNOWN_TEMPERATURE);
  assert.equal(forecast.condition, 'Unknown');
  // A day with no forecast is unknown, and the record still serializes.
  assert.equal(forecast.tomorrowCondition, 'Unknown');
  assert.ok(weatherRecord({ ...weatherReading(forecast, 'Nowhere', false), updatedUtc: 42 }).length > 0);
});

test('an empty or malformed body is an error, not an empty forecast', () => {
  assert.throws(() => parseForecast(null, 1), /no forecast/);
  assert.throws(() => parseForecast('{}', 1), /no forecast/);
  assert.throws(() => parseForecast({}, 1), /no current conditions/);
  assert.throws(() => parseForecast({ error: true, reason: 'bad' }, 1), /no current conditions/);
});

test('a refused request raises instead of reporting weather', async () => {
  await assert.rejects(
    fetchForecast({
      latitude: 1,
      longitude: 2,
      units: 'celsius',
      fetch: async () => ({ ok: false, status: 429 }),
    }),
    /HTTP 429/,
  );
});

test('a successful request is parsed through the same path', async () => {
  const seen = [];
  const forecast = await fetchForecast({
    latitude: 37.7749,
    longitude: -122.4194,
    units: 'celsius',
    nowUtc: 1789947294,
    fetch: async (url, init) => {
      seen.push([url, init?.mode]);
      return { ok: true, status: 200, json: async () => RESPONSE };
    },
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0][0], /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
  assert.equal(seen[0][1], 'cors');
  assert.equal(forecast.condition, 'LightRain');
});

test('coordinates make a readable location name in both hemispheres', () => {
  assert.equal(coordinateName(37.7749, -122.4194), '37.77°N 122.42°W');
  assert.equal(coordinateName(-33.8688, 151.2093), '33.87°S 151.21°E');
});
