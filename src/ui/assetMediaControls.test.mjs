import test from 'node:test';
import assert from 'node:assert/strict';

import { aircraftIdentity, vesselIdentity } from './assetMediaControls.js';

test('aircraft media identity prefers registration-backed model metadata', () => {
  assert.deepEqual(
    aircraftIdentity({
      icao24: 'e490a1',
      callsign: 'TAM8084',
      registration: 'PT-MUA',
      typeName: 'Boeing 777-32WER',
    }),
    {
      kind: 'aircraft',
      id: 'e490a1',
      label: 'TAM8084',
      subtitle: 'Boeing 777-32WER · PT-MUA',
      query: {
        icao24: 'e490a1',
        registration: 'PT-MUA',
        model: 'Boeing 777-32WER',
      },
    },
  );
});

test('vessel media identity carries IMO and public AIS type', () => {
  assert.deepEqual(
    vesselIdentity({
      mmsi: '353136000',
      imo: '9811000',
      name: 'EVER GIVEN',
      type: 'Container Ship',
    }),
    {
      kind: 'vessel',
      id: '353136000',
      label: 'EVER GIVEN',
      subtitle: 'Container Ship · IMO 9811000',
      query: {
        name: 'EVER GIVEN',
        imo: '9811000',
        mmsi: '353136000',
        type: 'Container Ship',
      },
    },
  );
});
