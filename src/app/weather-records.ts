/**
 * Original encoder for the PebbleOS weather BlobDB record and the weather
 * app's location preference. Reference layouts, pinned revisions and
 * independent vectors: docs/WEATHER.md.
 *
 * The firmware prints the stored integers verbatim next to a degree sign and
 * converts nothing, so the unit is the phone's decision, made where the
 * reading is produced rather than here.
 */

/**
 * BlobDB IDs the firmware assigns these two records, from BlobDBId in
 * blob_db/api.h. The location list belongs to BlobDBIdWatchAppPrefs, which is
 * a different database from BlobDBIdPrefs (7) that the health preferences use;
 * sending it to 7 is refused with BLOB_DB_INVALID_DATA.
 */
export const WEATHER_DATABASE = 5;
export const WATCH_APP_PREFS_DATABASE = 9;

/** WEATHER_DB_CURRENT_VERSION. weather_db.c rejects every other value. */
export const WEATHER_RECORD_VERSION = 3;

/** WeatherType numeric IDs, from weather_type_tuples.def. */
export const WEATHER_CONDITIONS = {
  PartlyCloudy: 0,
  CloudyDay: 1,
  LightSnow: 2,
  LightRain: 3,
  HeavyRain: 4,
  HeavySnow: 5,
  Generic: 6,
  Sun: 7,
  RainAndSnow: 8,
  Unknown: 255,
} as const;
export type WeatherCondition = keyof typeof WEATHER_CONDITIONS;

/**
 * WEATHER_SERVICE_LOCATION_FORECAST_UNKNOWN_TEMP. The firmware draws this as
 * "--°", which is what a reading we do not have should look like. Substituting
 * zero would put a real-looking freezing point on the watch instead.
 */
export const UNKNOWN_TEMPERATURE = 32767;

/**
 * Largest strings that survive the round trip. MAX_ENTRY_SIZE allows the
 * record plus WEATHER_SERVICE_MAX_WEATHER_LOCATION_BUFFER_SIZE (64) and
 * WEATHER_SERVICE_MAX_SHORT_PHRASE_BUFFER_SIZE (32); each serialized string
 * spends two of its bytes on its own length.
 */
export const MAX_LOCATION_BYTES = 62;
export const MAX_PHRASE_BYTES = 30;

/** Bytes of a WeatherDBEntry before the serialized strings: MIN_ENTRY_SIZE. */
const HEADER_BYTES = 20;

export interface WeatherReading {
  /** Shown as the forecast's title. */
  locationName: string;
  /** Short condition wording, e.g. "Light rain". May be empty. */
  shortPhrase: string;
  currentTemperature: number;
  condition: WeatherCondition;
  todayHigh: number;
  todayLow: number;
  tomorrowCondition: WeatherCondition;
  tomorrowHigh: number;
  tomorrowLow: number;
  /** Seconds since the epoch. Zero is the firmware's "no data" marker. */
  updatedUtc: number;
  /** Marks the entry as following the phone's position. */
  isCurrentLocation: boolean;
}

const encode = new TextEncoder();

function temperature(value: number, field: string): number {
  if (!Number.isInteger(value) || value < -32768 || value > 32767)
    throw new Error(`Weather ${field} must be a whole number the watch can store.`);
  return value;
}

function condition(value: WeatherCondition, field: string): number {
  const id = WEATHER_CONDITIONS[value];
  if (id === undefined) throw new Error(`Unknown weather ${field}: ${String(value)}.`);
  return id;
}

function pascalString(text: string, limit: number, field: string): Uint8Array {
  const content = encode.encode(text);
  if (content.length > limit)
    throw new Error(`Weather ${field} is longer than the watch accepts (${limit} bytes).`);
  const bytes = new Uint8Array(content.length + 2);
  new DataView(bytes.buffer).setUint16(0, content.length, true);
  bytes.set(content, 2);
  return bytes;
}

/**
 * Serializes one WeatherDBEntry. The firmware reads the packed struct
 * directly, so every field is little-endian and nothing is aligned.
 */
export function weatherRecord(reading: WeatherReading): Uint8Array {
  if (!reading.locationName) throw new Error('A weather entry needs a location name.');
  // time_t is a signed 32-bit value on the watch, and weather_service treats
  // zero as WEATHER_SERVICE_INVALID_DATA_LAST_UPDATE_TIME.
  if (!Number.isInteger(reading.updatedUtc) || reading.updatedUtc <= 0)
    throw new Error('Weather update time must be a positive whole number of seconds.');
  if (reading.updatedUtc > 0x7fffffff)
    throw new Error('Weather update time is outside the firmware range.');
  if (typeof reading.isCurrentLocation !== 'boolean')
    throw new Error('Weather current-location flag must be a boolean.');

  const name = pascalString(reading.locationName, MAX_LOCATION_BYTES, 'location name'),
    phrase = pascalString(reading.shortPhrase, MAX_PHRASE_BYTES, 'condition phrase'),
    strings = name.length + phrase.length,
    record = new Uint8Array(HEADER_BYTES + strings),
    view = new DataView(record.buffer);

  record[0] = WEATHER_RECORD_VERSION;
  view.setInt16(1, temperature(reading.currentTemperature, 'temperature'), true);
  record[3] = condition(reading.condition, 'condition');
  view.setInt16(4, temperature(reading.todayHigh, "today's high"), true);
  view.setInt16(6, temperature(reading.todayLow, "today's low"), true);
  record[8] = condition(reading.tomorrowCondition, 'forecast condition');
  view.setInt16(9, temperature(reading.tomorrowHigh, "tomorrow's high"), true);
  view.setInt16(11, temperature(reading.tomorrowLow, "tomorrow's low"), true);
  view.setInt32(13, reading.updatedUtc, true);
  record[17] = Number(reading.isCurrentLocation);
  // SerializedArray: a byte count followed by the two PascalString16s.
  view.setUint16(18, strings, true);
  record.set(name, HEADER_BYTES);
  record.set(phrase, HEADER_BYTES + name.length);
  return record;
}

/**
 * The location list the weather app and weather service read. An entry whose
 * key is missing from this list is skipped even when it is in the database,
 * so the two records are only useful written together.
 */
export const WEATHER_PREFERENCE_KEY = encode.encode('weatherApp');

export function weatherLocationsPreference(keys: Uint8Array[]): Uint8Array {
  if (keys.length > 255) throw new Error('Too many weather locations for the watch.');
  const value = new Uint8Array(1 + keys.length * 16);
  value[0] = keys.length;
  keys.forEach((key, index) => {
    if (key.length !== 16) throw new Error('A weather location key must be a 16-byte UUID.');
    value.set(key, 1 + index * 16);
  });
  return value;
}

/**
 * The single location this emulator owns. Keeping one stable key means an
 * update replaces the previous reading instead of accumulating stale
 * forecasts, and lets the entry be withdrawn again by key alone.
 */
export const SIMULATED_LOCATION_KEY = Uint8Array.from(
  '63cb75b2397e4ad09c50d538fdef0500'.match(/../g)!,
  (byte) => parseInt(byte, 16),
);
