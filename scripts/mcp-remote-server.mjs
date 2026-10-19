import http from 'node:http';
import { realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { createRemoteMcpBridge, remoteSettings } from './mcp-remote-bridge.mjs';
import { loadPairingAuthority } from './mcp-pairing-store.mjs';

function incomingBody(incoming) {
  let done = false;
  let onData;
  return new ReadableStream({
    start(controller) {
      onData = (chunk) => {
        if (done) return;
        controller.enqueue(chunk);
        if (controller.desiredSize <= 0) incoming.pause();
      };
      incoming.on('data', onData);
      incoming.once('end', () => {
        if (!done) { done = true; controller.close(); }
      });
      incoming.once('error', (error) => {
        if (!done) { done = true; controller.error(error); }
      });
    },
    pull() { incoming.resume(); },
    cancel() {
      // Draining a rejected body lets the HTTP error reach the client. Destroying
      // IncomingMessage here resets the socket before its 413 can be delivered.
      done = true;
      incoming.off('data', onData);
      incoming.resume();
    }
  });
}

async function drainRejectedBody(incoming, deadline) {
  if (incoming.complete || incoming.destroyed) return;
  await new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      incoming.off('end', finish);
      incoming.off('close', finish);
      incoming.off('error', finish);
      resolve();
    };
    const timer = setTimeout(() => {
      incoming.destroy();
      finish();
    }, Math.max(1, deadline - Date.now()));
    timer.unref();
    incoming.once('end', finish);
    incoming.once('close', finish);
    incoming.once('error', finish);
    incoming.resume();
  });
}

/** The only listener is loopback; a reverse proxy supplies HTTPS and strips its prefix. */
export async function startRemoteMcpServer({ port = 4177, pairingStorePath, ...settings } = {}) {
  if (pairingStorePath && !settings.pairingAuthority)
    settings.pairingAuthority = await loadPairingAuthority({ filePath: pairingStorePath, now: settings.now });
  const bridge = createRemoteMcpBridge(settings);
  const server = http.createServer({ maxHeaderSize: 16384 }, async (incoming, outgoing) => {
    const bodyDeadline = Date.now() + 15000;
    const abort = new AbortController();
    incoming.once('aborted', () => abort.abort());
    outgoing.once('close', () => { if (!outgoing.writableEnded) abort.abort(); });
    try {
      if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//'))
        throw new Error('Invalid request target');
      const forwarded = incoming.headers['x-forwarded-for']?.split(',')[0].trim();
      const request = new Request(new URL(incoming.url, settings.publicUrl).href, {
        method: incoming.method,
        headers: incoming.headers,
        ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: incomingBody(incoming), duplex: 'half' }),
        signal: abort.signal
      });
      const response = await bridge.fetch(request, {
        clientAddress: forwarded && isIP(forwarded) ? forwarded : incoming.socket.remoteAddress
      });
      if (request.body && !request.bodyUsed) await request.body.cancel();
      // With Connection: close, ending a 413 before its rejected upload has
      // drained can reset the TCP connection and hide the HTTP response. Read
      // and discard the remainder within the existing 15-second body deadline.
      if (response.status === 413) await drainRejectedBody(incoming, bodyDeadline);
      if (outgoing.destroyed || outgoing.writableEnded) return;
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) outgoing.end();
      else {
        const stream = Readable.fromWeb(response.body);
        stream.on('error', () => outgoing.destroy());
        outgoing.once('close', () => stream.destroy());
        stream.pipe(outgoing);
      }
    } catch {
      if (!outgoing.destroyed && !outgoing.headersSent) {
        outgoing.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        outgoing.end(JSON.stringify({ ok: false, code: 'invalid_request', error: '请求未完成。' }));
      } else outgoing.destroy();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 128;
  server.maxHeadersCount = 64;
  server.on('close', () => { void bridge.close(); });
  server.on('error', () => { void bridge.close(); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    // Production switches a `current` directory symlink between releases. Node
    // resolves import.meta.url to the release while argv retains that symlink.
    return realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const server = await startRemoteMcpServer(remoteSettings());
    console.log(`Yuandian MCP listening on 127.0.0.1:${server.address().port}`);
    const stop = () => {
      server.close();
      server.closeAllConnections();
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch {
    console.error('Yuandian MCP startup failed; check its local environment settings.');
    process.exitCode = 1;
  }
}
