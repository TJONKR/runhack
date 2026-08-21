import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb } from './db.js';
import adminRouter from './admin.js';
import apiRouter from './api.js';
import { ingestHandler } from './ingest.js';

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
app.use('/api', apiRouter);

app.get('/admin', (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));
app.get('/:slug/join', (req, res) => res.sendFile(path.join(publicDir, 'join.html')));
app.get('/:slug/board', (req, res) => res.sendFile(path.join(publicDir, 'board.html')));
app.use(express.static(publicDir));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const port = process.env.PORT || 3000;
await initDb();
app.listen(port, () => console.log(`runhack server on :${port}`));
