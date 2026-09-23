import { createServer } from 'node:http';
import { handleProbe, handleUpgrade, seen } from './probe-server.mjs';
const server = createServer((q, r) => handleProbe(q, r) || r.writeHead(500).end());
server.on('upgrade', handleUpgrade);
await new Promise((ok) => server.listen(0, ok));
const base = `http://localhost:${server.address().port}`;
console.log(await (await fetch(base + '/net/text?q=x', { headers: { 'X-Probe': 'yes' } })).text());
console.log((await (await fetch(base + '/net/bytes')).arrayBuffer()).byteLength);
const events = [];
await new Promise((done) => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/net/socket', ['probe.v1', 'other']);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { events.push('open ' + ws.protocol); ws.send('ping'); };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') { events.push('text ' + e.data); if (e.data === 'echo ping') ws.send(Uint8Array.of(1, 2, 250)); }
    else { events.push('bytes ' + [...new Uint8Array(e.data)]); ws.send('bye'); }
  };
  ws.onclose = (e) => { events.push(`close ${e.code} ${e.reason}`); done(); };
});
await new Promise((done) => { const ws = new WebSocket(base.replace('http', 'ws') + '/net/no-socket'); ws.onerror = () => events.push('error'); ws.onclose = (e) => { events.push('close ' + e.code); done(); }; });
console.log(events, seen);
server.close(); process.exit(0);
