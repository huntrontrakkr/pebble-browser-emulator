/**
 * Turns a position into a forecast the watch can store.
 *
 * Live readings come from Open-Meteo, which needs no key and sends CORS
 * headers, so this works from the static build with no service of ours behind
 * it. Off and manual mode need no network at all.
 *
 * Nothing here invents a reading. A field the forecast does not carry is
 * reported as UNKNOWN_TEMPERATURE or the Unknown condition, which the firmware
 * draws as "--°", and a failed request raises instead of falling back to a
 * plausible-looking number.
 */
import {
  UNKNOWN_TEMPERATURE,
  type WeatherCondition,
  type WeatherReading,
} from './weather-records.ts';

export type WeatherUnits = 'celsius' | 'fahrenheit';

export interface LiveForecast {
  currentTemperature: number;
  condition: WeatherCondition;
  shortPhrase: string;
  todayHigh: number;
  todayLow: number;
  tomorrowCondition: WeatherCondition;
  tomorrowHigh: number;
  tomorrowLow: number;
  /** When Open-Meteo says the reading was taken, in seconds. Shown to the
   * user; the record stores when the phone delivered it, which is what the
   * firmware's staleness check compares against the watch's own clock. */
  observedUtc: number | null;
}

/**
 * WMO 4677 present-weather codes, as Open-Meteo reports them, mapped onto the
 * ten WeatherTypes the firmware can draw. The wording is the phrase shown on
 * the watch and stays inside MAX_PHRASE_BYTES.
 */
const WMO_CODES = new Map<number, [WeatherCondition, string]>([
  [0, ['Sun', 'Clear']],
  [1, ['Sun', 'Mainly clear']],
  [2, ['PartlyCloudy', 'Partly cloudy']],
  [3, ['CloudyDay', 'Overcast']],
  [45, ['Generic', 'Fog']],
  [48, ['Generic', 'Freezing fog']],
  [51, ['LightRain', 'Light drizzle']],
  [53, ['LightRain', 'Drizzle']],
  [55, ['LightRain', 'Heavy drizzle']],
  [56, ['RainAndSnow', 'Freezing drizzle']],
  [57, ['RainAndSnow', 'Heavy freezing drizzle']],
  [61, ['LightRain', 'Light rain']],
  [63, ['LightRain', 'Rain']],
  [65, ['HeavyRain', 'Heavy rain']],
  [66, ['RainAndSnow', 'Freezing rain']],
  [67, ['RainAndSnow', 'Heavy freezing rain']],
  [71, ['LightSnow', 'Light snow']],
  [73, ['LightSnow', 'Snow']],
  [75, ['HeavySnow', 'Heavy snow']],
  [77, ['LightSnow', 'Snow grains']],
  [80, ['LightRain', 'Light showers']],
  [81, ['LightRain', 'Showers']],
  [82, ['HeavyRain', 'Violent showers']],
  [85, ['LightSnow', 'Light snow showers']],
  [86, ['HeavySnow', 'Snow showers']],
  [95, ['HeavyRain', 'Thunderstorm']],
  [96, ['HeavyRain', 'Thunderstorm, hail']],
  [99, ['HeavyRain', 'Thunderstorm, heavy hail']],
]);

/** A code outside the table is reported as unknown, not guessed at. */
export function describeWeatherCode(code: unknown): [WeatherCondition, string] {
  if (typeof code !== 'number' || !Number.isFinite(code)) return ['Unknown', ''];
  return WMO_CODES.get(code) ?? ['Unknown', `Weather code ${code}`];
}

/** A temperature Open-Meteo omitted stays unknown rather than becoming zero. */
function reading(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UNKNOWN_TEMPERATURE;
  const rounded = Math.round(value);
  if (rounded < -32768 || rounded >= UNKNOWN_TEMPERATURE) return UNKNOWN_TEMPERATURE;
  return rounded;
}

function day(list: unknown, index: number): unknown {
  return Array.isArray(list) ? list[index] : undefined;
}

export function forecastUrl(latitude: number, longitude: number, units: WeatherUnits): string {
  if (
    !Number.isFinite(latitude) ||
    Math.abs(latitude) > 90 ||
    !Number.isFinite(longitude) ||
    Math.abs(longitude) > 180
  )
    throw new Error('Weather needs a valid latitude and longitude.');
  if (units !== 'celsius' && units !== 'fahrenheit') throw new Error('Unknown temperature unit.');
  const query = new URLSearchParams({
    latitude: latitude.toFixed(4),
    longitude: longitude.toFixed(4),
    current: 'temperature_2m,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min',
    forecast_days: '2',
    timezone: 'auto',
    temperature_unit: units,
  });
  return `https://api.open-meteo.com/v1/forecast?${query}`;
}

/** Parses a forecast response. Exported so the mapping is testable offline. */
export function parseForecast(body: unknown, receivedUtc: number): LiveForecast {
  if (!body || typeof body !== 'object') throw new Error('Weather service returned no forecast.');
  const payload = body as Record<string, unknown>;
  const current = (payload['current'] ?? {}) as Record<string, unknown>;
  const daily = (payload['daily'] ?? {}) as Record<string, unknown>;
  if (!payload['current'] && !payload['daily'])
    throw new Error('Weather service returned no current conditions or forecast.');

  const [condition, shortPhrase] = describeWeatherCode(current['weather_code']);
  const [tomorrowCondition] = describeWeatherCode(day(daily['weather_code'], 1));
  // Open-Meteo stamps the reading in the location's own zone; the seconds
  // since the epoch are what the record stores.
  const stamped = Date.parse(`${String(current['time'] ?? '')}Z`);
  return {
    currentTemperature: reading(current['temperature_2m']),
    condition,
    shortPhrase,
    todayHigh: reading(day(daily['temperature_2m_max'], 0)),
    todayLow: reading(day(daily['temperature_2m_min'], 0)),
    tomorrowCondition,
    tomorrowHigh: reading(day(daily['temperature_2m_max'], 1)),
    tomorrowLow: reading(day(daily['temperature_2m_min'], 1)),
    observedUtc: Number.isFinite(stamped) ? Math.floor(stamped / 1000) : receivedUtc,
  };
}

/** Formats coordinates as a location name when the user has not named one. */
export function coordinateName(latitude: number, longitude: number): string {
  const side = (value: number, positive: string, negative: string) =>
    `${Math.abs(value).toFixed(2)}°${value < 0 ? negative : positive}`;
  return `${side(latitude, 'N', 'S')} ${side(longitude, 'E', 'W')}`;
}

export interface FetchWeatherOptions {
  latitude: number;
  longitude: number;
  units: WeatherUnits;
  /** Injected so tests and the worker can supply their own transport. */
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  nowUtc?: number;
}

export async function fetchForecast(options: FetchWeatherOptions): Promise<LiveForecast> {
  const url = forecastUrl(options.latitude, options.longitude, options.units);
  const request = options.fetch ?? globalThis.fetch;
  if (!request) throw new Error('This browser cannot fetch live weather.');
  const response = await request(url, { signal: options.signal, mode: 'cors' });
  if (!response.ok)
    throw new Error(`Weather service refused the request: HTTP ${response.status}.`);
  const received = options.nowUtc ?? Math.floor(Date.now() / 1000);
  return parseForecast(await response.json(), received);
}

export interface ManualWeather {
  locationName: string;
  shortPhrase: string;
  condition: WeatherCondition;
  currentTemperature: number;
  todayHigh: number;
  todayLow: number;
  tomorrowCondition: WeatherCondition;
  tomorrowHigh: number;
  tomorrowLow: number;
}

/**
 * Completes a forecast into the record the watch stores, minus the time it was
 * delivered. Only the emulator knows the watch's own clock, and that is the
 * clock weather_service compares against when deciding an entry is stale, so
 * the stamp is applied there rather than from the browser's.
 */
export function weatherReading(
  source: LiveForecast | ManualWeather,
  locationName: string,
  isCurrentLocation: boolean,
): Omit<WeatherReading, 'updatedUtc'> {
  return {
    locationName,
    shortPhrase: source.shortPhrase,
    currentTemperature: source.currentTemperature,
    condition: source.condition,
    todayHigh: source.todayHigh,
    todayLow: source.todayLow,
    tomorrowCondition: source.tomorrowCondition,
    tomorrowHigh: source.tomorrowHigh,
    tomorrowLow: source.tomorrowLow,
    isCurrentLocation,
  };
}
