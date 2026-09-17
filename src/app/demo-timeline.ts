import type { DemoSettings } from './demo-settings.ts';

// Original encoder for PebbleOS SerializedTimelineItemHeader and AttributeHeader.
// Protocol references, pinned revisions and independent vectors: docs/DEMO.md.
const encode = new TextEncoder();
const uuid = (s: string) =>
  Uint8Array.from(s.replaceAll('-', '').match(/../g)!, (n) => parseInt(n, 16));
const calendarSource = uuid('6c6c6fc2-1912-4d25-8396-3547d1dfac5b');
const demoSource = uuid('63cb75b2-397e-4ad0-9c50-d538fdeffe00');
export function demoKey(database: 1 | 4, id: number): Uint8Array {
  if (!Number.isInteger(id) || id < 0 || id > 7) throw new Error('Invalid sample item ID.');
  const key = demoSource.slice();
  key[14] = database;
  key[15] = id;
  return key;
}
function item(
  key: Uint8Array,
  parent: Uint8Array,
  timestamp: number,
  duration: number,
  type: number,
  layout: number,
  fields: [number, string][],
  status = 0,
) {
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffff)
    throw new Error('Timeline time is outside the firmware range.');
  const attributes = fields.map(([id, text]) => {
    const content = encode.encode(text),
      bytes = new Uint8Array(content.length + 3);
    bytes[0] = id;
    new DataView(bytes.buffer).setUint16(1, content.length, true);
    bytes.set(content, 3);
    return bytes;
  });
  const length = attributes.reduce((n, a) => n + a.length, 0),
    result = new Uint8Array(46 + length),
    view = new DataView(result.buffer);
  result.set(key);
  result.set(parent, 16);
  view.setUint32(32, timestamp, true);
  view.setUint16(36, duration, true);
  result[38] = type;
  result[39] = 1;
  result[40] = status;
  result[41] = layout;
  view.setUint16(42, length, true);
  result[44] = attributes.length;
  result[45] = 0;
  let offset = 46;
  for (const a of attributes) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}
export interface DemoRecord {
  database: 1 | 4;
  key: Uint8Array;
  value: Uint8Array;
  dismissed?: Uint8Array;
}
export function demoRecords(
  settings: DemoSettings,
  epochMs: number,
  popupId?: number,
): DemoRecord[] {
  if (!settings.enabled) return [];
  const now = Math.floor(epochMs / 1000),
    records: DemoRecord[] = [];
  for (const n of settings.notifications.filter(
    (n) => n.enabled && (popupId === undefined || n.id === popupId),
  )) {
    const key = demoKey(4, n.id),
      fields: [number, string][] = [
        [1, n.title],
        [3, n.body],
        [30, 'Demo messages'],
      ];
    records.push({
      database: 4,
      key,
      value: item(key, demoSource, now, 0, 1, 4, fields),
      // Mark archived samples dismissed through the real notification update protocol.
      ...(popupId === undefined
        ? { dismissed: item(key, demoSource, now, 0, 1, 4, fields, 16) }
        : {}),
    });
  }
  if (popupId === undefined)
    for (const e of settings.calendar.filter((e) => e.enabled)) {
      const key = demoKey(1, e.id),
        fields: [number, string][] = [
          [1, e.title],
          [3, 'Sample calendar event'],
        ];
      if (e.location) fields.push([11, e.location]);
      records.push({
        database: 1,
        key,
        value: item(key, calendarSource, now + e.startMinutes * 60, e.duration, 2, 2, fields),
      });
    }
  return records;
}
