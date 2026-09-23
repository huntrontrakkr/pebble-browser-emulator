// The network probe's server (network-probe.js), on the browser run's own HTTP server.
// The probe reaches it through another origin (localhost instead of 127.0.0.1), so every
// request is cross-origin and the browser's CORS rules apply as they do to real services.
// `seen` records what arrived, so the run can show that requests really left the browser.
import { createHash } from 'node:crypto';

export const seen = [];
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
  'Access-Control-Expose-Headers': 'X-Probe-Server',
};

/** Handles /net/* requests; returns false for anything else. */
export function handleProbe(request, response) {
  const url = new URL(request.url, 'http://x');
  if (!url.pathname.startsWith('/net/')) return false;
  seen.push(`${request.method} ${url.pathname}`);
  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors).end();
    return true;
  }
  const reply = (status, type, body, extra = {}) =>
    response.writeHead(status, { ...cors, 'Content-Type': type, ...extra }).end(body);
  switch (url.pathname) {
    case '/net/text':
      reply(
        200,
        'text/plain; charset=utf-8',
        `hello ${url.searchParams.get('q')}, probe ${request.headers['x-probe'] ?? 'none'}`,
        {
          'X-Probe-Server': 'libpebble3-probe',
        },
      );
      break;
    case '/net/echo': {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () =>
        reply(
          200,
          'application/json',
          JSON.stringify({
            method: request.method,
            contentType: request.headers['content-type'],
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        ),
      );
      break;
    }
    case '/net/echo-bytes': {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () =>
        reply(
          200,
          'application/json',
          JSON.stringify({
            hex: Buffer.concat(chunks).toString('hex'),
            contentType: request.headers['content-type'] ?? null,
          }),
        ),
      );
      break;
    }
    case '/net/json':
      reply(200, 'application/json', JSON.stringify({ temperature: 21.5, conditions: 'Cloudy' }));
      break;
    case '/net/bytes':
      reply(200, 'application/octet-stream', Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
      break;
    case '/net/nocors':
      response.writeHead(200, { 'Content-Type': 'text/plain' }).end('not for browsers');
      break;
    case '/net/slow':
      setTimeout(() => reply(200, 'text/plain', 'late'), 5000);
      break;
    default:
      reply(404, 'text/plain', 'missing');
  }
  return true;
}

/**
 * WebSocket upgrades on /net/socket (RFC 6455, enough for the probe): picks the first
 * offered subprotocol, answers text with "echo <text>" and bytes reversed, and after
 * "bye" closes with 4001 "probe finished". Any other path is refused.
 */
export function handleUpgrade(request, socket) {
  const url = new URL(request.url, 'http://x');
  seen.push(`UPGRADE ${url.pathname}`);
  if (url.pathname !== '/net/socket') {
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const accept = createHash('sha1')
    .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  const protocol = String(request.headers['sec-websocket-protocol'] ?? '')
    .split(',')[0]
    .trim();
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : '') +
      '\r\n',
  );
  const send = (opcode, payload) => {
    const head =
      payload.length < 126
        ? Buffer.from([0x80 | opcode, payload.length])
        : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 255]);
    socket.write(Buffer.concat([head, payload]));
  };
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const opcode = pending[0] & 15;
      let length = pending[1] & 127;
      let offset = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      }
      if (pending.length < offset + 4 + length) return;
      const mask = pending.subarray(offset, offset + 4);
      const payload = Buffer.from(pending.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      pending = pending.subarray(offset + 4 + length);
      if (opcode === 1) {
        const text = payload.toString('utf8');
        seen.push(`WS text ${text}`);
        send(1, Buffer.from(`echo ${text}`));
        if (text === 'bye') {
          const reason = Buffer.from('probe finished');
          send(8, Buffer.concat([Buffer.from([4001 >> 8, 4001 & 255]), reason]));
        }
      } else if (opcode === 2) {
        seen.push(`WS bytes ${[...payload]}`);
        send(2, Buffer.from([...payload].reverse()));
      } else if (opcode === 8) {
        socket.end();
      }
    }
  });
  socket.on('error', () => {});
}
