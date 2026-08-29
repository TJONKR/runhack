import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestOrigin } from '../src/origin.js';

const req = { protocol: 'https', get: () => 'whatever.example.com' };

test('without INGEST_ORIGIN, falls back to the request origin', () => {
  delete process.env.INGEST_ORIGIN;
  assert.equal(ingestOrigin(req), 'https://whatever.example.com');
});

test('INGEST_ORIGIN wins over the request origin', () => {
  process.env.INGEST_ORIGIN = 'https://app-production-36de.up.railway.app';
  assert.equal(ingestOrigin(req), 'https://app-production-36de.up.railway.app');
  delete process.env.INGEST_ORIGIN;
});

test('bare hostname gets https, trailing slashes are stripped', () => {
  process.env.INGEST_ORIGIN = 'app-production-36de.up.railway.app/';
  assert.equal(ingestOrigin(req), 'https://app-production-36de.up.railway.app');
  delete process.env.INGEST_ORIGIN;
});

test('blank INGEST_ORIGIN is ignored', () => {
  process.env.INGEST_ORIGIN = '  ';
  assert.equal(ingestOrigin(req), 'https://whatever.example.com');
  delete process.env.INGEST_ORIGIN;
});
