// Relay for watchface phone-script requests, for hosts that send no CORS headers.
//
// Unlike the public-resource endpoint this cannot allowlist hosts: a watchface
// may call any weather or transit API. The protection is therefore the address
// it ends up talking to, not the name it asks for. Every connection resolves
// through a lookup that refuses private, loopback, link-local, carrier and
// cloud-metadata space, so a hostname that resolves inward is refused at connect
// time rather than after a check that DNS could change underneath. Redirects are
// followed by hand so each hop is validated the same way.
//
// Node only: it needs connection-level control that the portable Fetch handler
// and edge runtimes do not offer.
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { isIPv4, isIPv6 } from 'node:net';

const MAX_REDIRECTS = 4;

/** Request headers a guest script may influence. Everything else is dropped. */
const FORWARDED_REQUEST_HEADERS = new Set(['accept', 'accept-language', 'content-type']);

/** Response headers worth returning. Set-Cookie and auth hints are never among them. */
const FORWARDED_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'etag',
  'last-modified',
  'date',
]);

const v4 = (address) => address.split('.').map(Number);

/** True when an IPv4 address is outside ordinary public routing. */
function blockedV4(address) {
  const [a, b, c] = v4(address);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, including cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  // The documentation and protocol-assignment ranges are /24s. Blocking their
  // enclosing /16 would refuse ordinary public hosts such as 192.0.66.0/24.
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved and broadcast
  return false;
}

/** True when an IPv6 address is outside ordinary public routing. */
function blockedV6(address) {
  const value = address.toLowerCase().split('%')[0];
  if (value === '::' || value === '::1') return true;
  // Addresses that carry an IPv4 address are judged on that address.
  const embedded = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value);
  if (embedded && (value.startsWith('::ffff:') || value.startsWith('64:ff9b:')))
    return blockedV4(embedded[1]);
  const head = Number.parseInt(value.split(':')[0] || '0', 16);
  if ((head & 0xfe00) === 0xfc00) return true; // unique local
  if ((head & 0xffc0) === 0xfe80) return true; // link-local
  if ((head & 0xff00) === 0xff00) return true; // multicast
  if (value.startsWith('2001:db8:')) return true; // documentation
  return false;
}

export function blockedAddress(address) {
  if (isIPv4(address)) return blockedV4(address);
  if (isIPv6(address)) return blockedV6(address);
  return true;
}

/**
 * A dns.lookup replacement that refuses to hand back an address the relay must
 * not reach. Used as the connection lookup so the decision happens per
 * connection, which a separate pre-flight resolution cannot guarantee.
 */
export function guardedLookup(resolver = dnsLookup) {
  return function lookup(hostname, options, callback) {
    const done = typeof options === 'function' ? options : callback;
    const settings = typeof options === 'function' ? {} : options;
    resolver(hostname, { ...settings, all: true }, (error, addresses) => {
      if (error) return done(error);
      const list = Array.isArray(addresses) ? addresses : [addresses];
      const usable = list.filter((entry) => !blockedAddress(entry.address));
      if (!usable.length)
        return done(
          Object.assign(new Error(`${hostname} resolves only to a non-public address.`), {
            code: 'EBLOCKED',
          }),
        );
      if (settings && settings.all) return done(null, usable);
      return done(null, usable[0].address, usable[0].family);
    });
  };
}

function targetUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Only HTTPS requests are relayed.');
  if (url.username || url.password) throw new Error('Embedded credentials are not relayed.');
  return url;
}

/**
 * Performs one hop and returns either the response or the next location.
 * Never sends cookies, authorization or a body it was not given.
 */
function hop(url, { method, headers, maxBytes, timeoutMs, lookup, agentOptions }) {
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest(
      url,
      {
        method,
        headers: { ...headers, host: url.host },
        lookup,
        timeout: timeoutMs,
        ...agentOptions,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          return resolve({ redirect: new URL(location, url).href });
        }
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          response.destroy();
          return reject(new Error('The response exceeds the relay size limit.'));
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy();
            reject(new Error('The response exceeds the relay size limit.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            status,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on('error', reject);
      },
    );
    outgoing.on('timeout', () => outgoing.destroy(new Error('The relayed request timed out.')));
    outgoing.on('error', reject);
    outgoing.end();
  });
}

/**
 * Relays one guest request. Resolves with a bounded, header-stripped result, or
 * rejects with the reason, which the caller reports rather than disguises.
 */
export async function relayRequest(
  rawUrl,
  {
    method = 'GET',
    headers = {},
    maxBytes = 1048576,
    timeoutMs = 20000,
    lookup = guardedLookup(),
    agentOptions,
  } = {},
) {
  if (!['GET', 'HEAD'].includes(method)) throw new Error('Only GET and HEAD are relayed.');
  const safeHeaders = {};
  for (const [name, value] of Object.entries(headers))
    if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) safeHeaders[name.toLowerCase()] = value;
  safeHeaders['accept-encoding'] = 'identity';
  let url = targetUrl(rawUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const result = await hop(url, {
      method,
      headers: safeHeaders,
      maxBytes,
      timeoutMs,
      lookup,
      agentOptions,
    });
    if (!result.redirect) {
      const out = {};
      for (const [name, value] of Object.entries(result.headers))
        if (FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase())) out[name.toLowerCase()] = value;
      return { status: result.status, headers: out, body: result.body, url: url.href };
    }
    // Each hop is validated exactly like the first, including its address.
    url = targetUrl(result.redirect);
  }
  throw new Error('The relayed request redirected too many times.');
}
