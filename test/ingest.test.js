import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFixes } from '../src/ingest.js';

test('parses OsmAnd query-string coordinates and converts knots to m/s', () => {
  const [fix] = parseFixes({
    query: { lat: '51.5', lon: '-0.1', timestamp: '1700000000', speed: '10', accuracy: '7' },
    body: {},
  });

  assert.deepEqual(fix, {
    lat: 51.5,
    lng: -0.1,
    timestampMs: 1700000000000,
    accuracyM: 7,
    speedMs: 10 * 0.514444,
  });
});

test('parses Traccar nested location coordinates', () => {
  const [fix] = parseFixes({
    query: {},
    body: {
      location: {
        coords: {
          latitude: '51.501',
          longitude: '-0.101',
          speed: '4',
          accuracy: '9',
        },
      },
      timestamp: '2024-01-02T03:04:05.000Z',
    },
  });

  assert.equal(fix.lat, 51.501);
  assert.equal(fix.lng, -0.101);
  assert.equal(fix.speedMs, 4 * 0.514444);
  assert.equal(fix.accuracyM, 9);
  assert.equal(fix.timestampMs, Date.parse('2024-01-02T03:04:05.000Z'));
});

test('parses OwnTracks timestamps, accuracy, and km/h speed', () => {
  const [fix] = parseFixes({
    query: {},
    body: { _type: 'location', lat: 51.502, lon: -0.102, tst: 1700000012, acc: 12, vel: 18 },
  });

  assert.deepEqual(fix, {
    lat: 51.502,
    lng: -0.102,
    timestampMs: 1700000012000,
    accuracyM: 12,
    speedMs: 18 / 3.6,
  });
});

test('parses Overland batches oldest-first without swapping coordinates', () => {
  const fixes = parseFixes({
    query: {},
    body: {
      locations: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-0.104, 51.504] },
          properties: { timestamp: '2024-01-02T03:04:07.000Z', horizontal_accuracy: 14, speed: 3 },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-0.103, 51.503] },
          properties: { timestamp: '2024-01-02T03:04:05.000Z', horizontal_accuracy: 11, speed: 2 },
        },
      ],
    },
  });

  assert.deepEqual(fixes, [
    {
      lat: 51.503,
      lng: -0.103,
      timestampMs: Date.parse('2024-01-02T03:04:05.000Z'),
      accuracyM: 11,
      speedMs: 2,
    },
    {
      lat: 51.504,
      lng: -0.104,
      timestampMs: Date.parse('2024-01-02T03:04:07.000Z'),
      accuracyM: 14,
      speedMs: 3,
    },
  ]);
});

test('returns no fixes when coordinates are missing', () => {
  assert.deepEqual(parseFixes({ query: { speed: '2' }, body: {} }), []);
});

test('parses ISO-string and epoch-millisecond timestamps', () => {
  const [iso] = parseFixes({
    query: { lat: 51.505, lon: -0.105, timestamp: '2024-01-02T03:04:05.000Z' },
    body: {},
  });
  const [millis] = parseFixes({
    query: { lat: 51.506, lon: -0.106, timestamp: '1700000000123' },
    body: {},
  });

  assert.equal(iso.timestampMs, Date.parse('2024-01-02T03:04:05.000Z'));
  assert.equal(millis.timestampMs, 1700000000123);
});
