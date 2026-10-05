import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPresentation } from './presentation.js';

function summaryFor(camera, health = null) {
  const record = { camera };
  const state = {
    _records: [record],
    _healthById: new Map(health ? [[camera.id, health]] : []),
    _coverageMode: 'off',
  };
  const parts = {
    selection: { getActiveRecord: () => record },
    calibration: { deriveCalBadge: () => 'raw-prior' },
    model: { sectorAreaKm2: () => 0.5 },
  };
  return createPresentation({
    state,
    services: {},
    parts,
    source: {},
  }).buildSummaryText();
}

test('camera summary identifies OSM coordinates and avoids invented coverage', () => {
  const summary = summaryFor({
    id: 'osm-webcam-node-1',
    name: 'Praça Central',
    sourceKind: 'osm-webcam',
    feedType: 'image',
    provider: 'Município',
    lat: -23.55052,
    lon: -46.63331,
    headingConfidence: 'low',
    rangeM: 300,
    fovDeg: 70,
  });
  assert.match(summary, /OSM MAPPED -23\.55052, -46\.63331/);
  assert.match(summary, /MEDIA REFRESHED SNAPSHOT/);
  assert.match(summary, /SOURCE MUNICÍPIO/);
  assert.match(summary, /POSE ESTIMATED/);
  assert.match(summary, /HEALTH NOT VERIFIED/);
  assert.doesNotMatch(summary, /COVERAGE/);
});

test('camera summary labels geocoded YouTube positions as approximate', () => {
  const summary = summaryFor({
    id: 'youtube-live-abcdef12345',
    name: 'City Live Webcam',
    sourceKind: 'youtube-live-webcam',
    feedType: 'iframe',
    provider: 'Public Webcam',
    lat: 38.7223,
    lon: -9.1393,
    headingConfidence: 'low',
    rangeM: 300,
    fovDeg: 70,
  });
  assert.match(summary, /SEARCH AREA APPROX/);
  assert.match(summary, /MEDIA LIVE EMBED/);
});

test('camera summary reports public-directory distance from the searched city', () => {
  const summary = summaryFor({
    id: 'opencctv-windy-1',
    name: 'Regional public camera',
    sourceKind: 'opencctv-public',
    distanceKm: 41.7,
    feedType: 'image',
    provider: 'OpenCCTV',
    lat: -22.9,
    lon: -41.9,
    headingConfidence: 'low',
    rangeM: 300,
    fovDeg: 70,
  });
  assert.match(summary, /PUBLIC DIRECTORY MAPPED/);
  assert.match(summary, /SEARCH DISTANCE 42KM/);
});
