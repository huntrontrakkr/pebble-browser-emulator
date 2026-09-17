/** PebbleOS v4.37.0 ActivitySettings/ActivityHRMSettings packed preference formats.
 * These configure a synthetic watch user through BlobDB, not a firmware memory patch. */
export function healthPreferences(
  enabled: boolean,
  heartRate: boolean,
): { key: Uint8Array; value: Uint8Array }[] {
  if (typeof enabled !== 'boolean' || typeof heartRate !== 'boolean')
    throw new Error('Health preferences must be booleans.');
  const activity = new Uint8Array(9),
    view = new DataView(activity.buffer);
  view.setInt16(0, 1700, true);
  view.setInt16(2, 7000, true);
  activity[4] = Number(enabled);
  activity[7] = 30;
  activity[8] = 2;
  const encode = new TextEncoder();
  return [
    { key: encode.encode('activityPreferences'), value: activity },
    {
      key: encode.encode('hrmPreferences'),
      value: Uint8Array.of(Number(heartRate), 0, Number(heartRate)),
    },
  ];
}
