import net from 'node:net';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const BS = String.fromCharCode(92);
const mkPipe = (id) => BS + BS + '.' + BS + 'pipe' + BS + 'krypt-bench-' + id;
if (process.argv[2] === 'server') {
  const p = mkPipe(process.argv[3]);
  const srv = net.createServer((s) => { s.on('data', (b) => s.write(b)); });
  srv.listen(p, () => process.send('ready'));
} else {
  const PIPE = mkPipe(process.pid);
  const child = fork(fileURLToPath(import.meta.url), ['server', String(process.pid)]);
  await new Promise((r) => child.once('message', r));
  const sock = net.connect(PIPE);
  await new Promise((r) => sock.once('connect', r));
  for (const size of [64, 4096, 65536]) {
    const payload = Buffer.alloc(size, 7);
    const N = size > 10000 ? 2000 : 10000;
    const lat = [];
    let got = 0, resolve;
    sock.removeAllListeners('data');
    sock.on('data', (b) => { got += b.length; if (got >= size) { got -= size; resolve(); } });
    for (let i = 0; i < N; i++) {
      const t0 = process.hrtime.bigint();
      await new Promise((r) => { resolve = r; sock.write(payload); });
      lat.push(Number(process.hrtime.bigint() - t0) / 1000);
    }
    lat.sort((a, b) => a - b);
    const q = (p) => lat[Math.floor(p * (lat.length - 1))].toFixed(1);
    console.log(`size=${size}B n=${N} RTT us: p50=${q(0.5)} p90=${q(0.9)} p99=${q(0.99)} p99.9=${q(0.999)} max=${lat[lat.length - 1].toFixed(1)}`);
  }
  sock.end(); child.kill();
}
