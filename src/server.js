import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initDb } from './db.js';
import adminRouter from './admin.js';
import apiRouter from './api.js';
import { ingestHandler } from './ingest.js';
import { startGithubPoller } from './github.js';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get('/healthz', (req, res) => res.send('ok'));

// Traccar posts here; also accepts GET with query params (old OsmAnd style).
app.all('/ingest/:userId', (req, res, next) => ingestHandler(req, res).catch(next));

app.use('/api/admin', adminRouter);

// Sponsor/brand strip: drop logo files into public/brands/ and they appear on
// the board. Order by filename (prefix 01-, 02-, ... to control it).
app.get('/api/brands', (req, res) => {
  const dir = path.join(publicDir, 'brands');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /\.(svg|png|jpe?g|webp)$/i.test(f)).sort()
    : [];
  res.json(files.map((f) => `/brands/${f}`));
});

app.use('/api', apiRouter);

// QR as SVG for team pages / printouts. Only encodes URLs on this host.
app.get('/qr.svg', async (req, res) => {
  const text = String(req.query.text || '');
  const origin = `${req.protocol}://${req.get('host')}`;
  if (!text.startsWith(origin) || text.length > 500) return res.status(400).send('bad text');
  res.type('image/svg+xml').send(
    await QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#08182F', light: '#F4F3EF' } })
  );
});

// Public landing: the list of events and their live boards. Admin is /admin.
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));
app.get('/admin', (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));
app.get('/:slug/join', (req, res) => res.sendFile(path.join(publicDir, 'join.html')));
app.get('/:slug/board', (req, res) => res.sendFile(path.join(publicDir, 'board.html')));
app.get('/:slug/team/:teamId', (req, res) => res.sendFile(path.join(publicDir, 'team.html')));
app.use(express.static(publicDir));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const port = process.env.PORT || 3000;
await initDb();
startGithubPoller();
app.listen(port, () => console.log(`runhack server on :${port}`));
