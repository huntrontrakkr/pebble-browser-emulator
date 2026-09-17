// SPDX-License-Identifier: GPL-3.0-only
export const CONFIGURATION_LIMIT = 512 * 1024;
const utf8 = new TextEncoder();
const bounded = (value) => {
  if (typeof value !== 'string' || utf8.encode(value).length > CONFIGURATION_LIMIT)
    throw new Error('Configuration exceeds 512 KiB.');
  return value;
};
export function configurationPage(input, callback, session, storage = {}) {
  bounded(input);
  const url = new URL(input);
  if (/^https?:$/.test(url.protocol)) {
    url.searchParams.set('return_to', callback + '#');
    return { url: url.href, external: true };
  }
  if (!/^data:text\/html(?:[;,])/i.test(input))
    throw new Error('This configuration URL is unsupported.');
  const comma = input.indexOf(',');
  const header = input.slice(0, comma);
  const payload = input.slice(comma + 1).split('#')[0];
  let html;
  if (/;base64$/i.test(header)) {
    const bytes = Uint8Array.from(atob(decodeURIComponent(payload)), (c) => c.charCodeAt(0));
    html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } else html = decodeURIComponent(payload);
  bounded(html);
  // Native WebViews intercept this scheme before navigation. An opaque browser frame cannot;
  // translate literal close targets to our callback, preserving the entire suffix verbatim.
  html = html.replace(/pebblejs:(?:\\?\/){2}close/g, callback);
  const seed = JSON.stringify({ session, storage }).replaceAll('<', '\\u003c');
  const bootstrap = `<script>(${embeddedBridge.toString()})(${seed})<\/script>`;
  // Preserve standards mode; putting a script before the doctype switches pages to quirks mode.
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  const doctype = /<!doctype\s[^>]*>/i.exec(html);
  const insertion = head
    ? head.index + head[0].length
    : doctype
      ? doctype.index + doctype[0].length
      : 0;
  return { html: html.slice(0, insertion) + bootstrap + html.slice(insertion), external: false };
}
function embeddedBridge({ session, storage }) {
  const send = (kind, extra) => parent.postMessage({ kind, session, ...extra }, '*');
  const data = Object.assign(Object.create(null), storage);
  const persist = () => send('pebble-config-storage', { storage: { ...data } });
  const api = {
    getItem(key) {
      return Object.hasOwn(data, String(key)) ? data[String(key)] : null;
    },
    setItem(key, value) {
      key = String(key);
      value = String(value);
      const next = { ...data, [key]: value };
      if (new TextEncoder().encode(JSON.stringify(next)).length > 1048576)
        throw new DOMException('Configuration storage is full.', 'QuotaExceededError');
      data[key] = value;
      persist();
    },
    removeItem(key) {
      delete data[String(key)];
      persist();
    },
    clear() {
      for (const key of Object.keys(data)) delete data[key];
      persist();
    },
    key(index) {
      return Object.keys(data)[index] ?? null;
    },
    get length() {
      return Object.keys(data).length;
    },
  };
  Object.defineProperty(window, 'localStorage', {
    value: new Proxy(api, {
      get(target, key) {
        return key in target ? Reflect.get(target, key) : data[key];
      },
      set(_target, key, value) {
        api.setItem(key, value);
        return true;
      },
      deleteProperty(_target, key) {
        api.removeItem(key);
        return true;
      },
      ownKeys() {
        return Object.keys(data);
      },
      getOwnPropertyDescriptor(_target, key) {
        return Object.hasOwn(data, key)
          ? { configurable: true, enumerable: true, writable: true, value: data[key] }
          : undefined;
      },
    }),
  });
  addEventListener(
    'click',
    (event) => {
      const link = event.target.closest?.('a[href]');
      if (link?.getAttribute('href')?.startsWith('pebblejs://close')) {
        event.preventDefault();
        send('pebble-config-navigation', { url: link.getAttribute('href') });
      }
    },
    true,
  );
  addEventListener('error', () =>
    send('pebble-config-error', { message: 'The configuration page reported an error.' }),
  );
  addEventListener('DOMContentLoaded', () => send('pebble-config-loaded', {}));
}
export function validStorage(value) {
  try {
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.values(value).every((v) => typeof v === 'string') &&
      utf8.encode(JSON.stringify(value)).length <= 1048576
    );
  } catch {
    return false;
  }
}
export function navigationResult(data, session) {
  if (data?.kind !== 'pebble-config-navigation' || data.session !== session) return null;
  const url = bounded(data.url);
  if (!url.startsWith('pebblejs://close')) throw new Error('Unexpected configuration return URL.');
  return url;
}
