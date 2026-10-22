const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const host = process.env.HOSTNAME;
if (host !== '127.0.0.1') {
  process.stderr.write(`refusing non-loopback host ${host}\n`);
  process.exit(1);
}

if (process.env.CHORDMINI_TEST_FAIL === 'EADDRINUSE') {
  process.stderr.write('listen EADDRINUSE\n');
  process.exit(1);
}

if (process.env.CHORDMINI_TEST_LEAK === '1') {
  process.stderr.write(
    `CHORDMINI_READY_TOKEN=${process.env.CHORDMINI_READY_TOKEN} PYTHON_API_URL=${process.env.PYTHON_API_URL}\n`,
  );
  process.exit(1);
}

if (process.env.CHORDMINI_TEST_GRANDCHILD === '1' && process.env.CHORDMINI_TEST_PIDFILE) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: false,
  });
  fs.writeFileSync(process.env.CHORDMINI_TEST_PIDFILE, String(grandchild.pid));
}

if (process.env.CHORDMINI_TEST_ENVFILE) {
  fs.writeFileSync(process.env.CHORDMINI_TEST_ENVFILE, JSON.stringify({
    hostname: process.env.HOSTNAME,
    runtime: process.env.NEXT_PUBLIC_APP_RUNTIME,
    desktopMode: process.env.CHORDMINI_DESKTOP_MODE,
    electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE || '',
    hasPythonUrl: Boolean(process.env.PYTHON_API_URL),
  }));
}

const token = process.env.CHORDMINI_READY_TOKEN;
const port = Number(process.env.PORT);
const server = http.createServer((request, response) => {
  const nonceHeader = request.headers['x-chordmini-nonce'];
  const nonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader;
  if (!token || !nonce || request.url !== '/api/desktop/ready') {
    response.writeHead(401, { 'cache-control': 'no-store' });
    response.end(JSON.stringify({ ok: false }));
    return;
  }

  const proof = process.env.CHORDMINI_TEST_BAD_PROOF === '1'
    ? 'forged'
    : crypto.createHash('sha256').update(`${token}:${nonce}`).digest('hex');
  response.writeHead(200, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-chordmini-proof': proof,
  });
  response.end(JSON.stringify({ ok: true, role: 'next-standalone' }));
});

server.listen(port, host);
