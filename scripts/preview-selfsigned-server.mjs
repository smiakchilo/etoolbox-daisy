#!/usr/bin/env node
/**
 * Self-signed HTTPS preview server for exercising the AEM pane's
 * certificate-exception flow by hand.
 *
 * Run `npm run preview:dev`, then in EToolbox Daisy add a server whose origin
 * is the printed URL (e.g. `https://127.0.0.1:8443`) and navigate to it. The
 * browser pane shows the "Untrusted certificate" banner; Allow persists the
 * exception for exactly this origin + fingerprint and re-navigates.
 *
 * The served page is deliberately AEM-flavoured so `/` loads like a minimal
 * content page and `/content.json` answers like a JSON AEM endpoint the model
 * could read through the bridge. Everything is trusted only because this
 * script runs it — it is not part of the packaged application.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import selfsigned from 'selfsigned';

const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.PREVIEW_PORT ?? '8443', 10);

function sha256FingerprintHex(pemData) {
  const body = pemData.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, '');
  const der = Buffer.from(body, 'base64');
  return createHash('sha256').update(der).digest('hex');
}

const { private: key, cert } = await selfsigned.generate([{ name: 'commonName', value: HOST }], {
  keyType: 'rsa',
  keySize: 2048,
  algorithm: 'sha256',
  extensions: [
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: HOST }] },
  ],
});

const origin = `https://${HOST}:${PORT}`;
const fingerprint = sha256FingerprintHex(cert);

const indexHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Daisy preview</title></head>
<body><h1>EToolbox Daisy preview</h1>
<p>Served over HTTPS with a self-signed certificate.</p>
<p>Endpoint for the model: <code>/content.json</code></p></body></html>`;

const contentJson = JSON.stringify(
  {
    'jcr:primaryType': 'cq:Page',
    'jcr:content': {
      'jcr:primaryType': 'cq:PageContent',
      'jcr:title': 'Preview page',
      text: 'Served by the self-signed preview server.',
      path: '/content/preview',
    },
  },
  null,
  2,
);

const server = createServer({ key, cert }, (req, res) => {
  const url = new URL(req.url ?? '/', origin);
  if (url.pathname === '/content.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(contentJson);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(indexHtml);
});

server.listen(PORT, HOST, () => {
  console.log(`Serving ${origin}`);
  console.log(`Certificate SHA-256 fingerprint (hex): ${fingerprint}`);
  console.log(
    'Add a server with this origin in EToolbox Daisy, navigate to it, and approve the banner.',
  );
});

const stop = () => {
  server.close(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// Keep the process alive if the server is somehow closed by an error.
server.on('error', (error) => {
  console.error('preview server error:', error);
  process.exit(1);
});
