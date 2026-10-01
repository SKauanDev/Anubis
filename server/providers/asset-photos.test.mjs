import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assetPhotoQueries,
  assetPhotoRequest,
  normalizeCommonsPhoto,
} from './asset-photos.js';

test('asset photo request accepts bounded structured identities only', () => {
  const request = assetPhotoRequest(
    new URLSearchParams({
      kind: 'aircraft',
      icao24: 'A1B2C3',
      registration: 'N123AB',
      model: 'Airbus A320-214',
    }),
  );
  assert.deepEqual(request, {
    kind: 'aircraft',
    icao24: 'a1b2c3',
    registration: 'N123AB',
    model: 'Airbus A320-214',
    name: '',
    imo: '',
    mmsi: '',
    type: '',
  });
  assert.equal(
    assetPhotoRequest(
      new URLSearchParams({ kind: 'aircraft', icao24: '../bad' }),
    ),
    null,
  );
  assert.equal(
    assetPhotoRequest(new URLSearchParams({ kind: 'person', name: 'Someone' })),
    null,
  );
});

test('asset photo queries prefer exact identity before representative type', () => {
  const aircraft = assetPhotoQueries({
    kind: 'aircraft',
    registration: 'N123AB',
    model: 'Boeing 737-800',
  });
  assert.equal(aircraft[0].exact, 'N123AB');
  assert.equal(aircraft[1].representative, 'Boeing 737-800');

  const vessel = assetPhotoQueries({
    kind: 'vessel',
    imo: '9876543',
    name: 'EXAMPLE STAR',
    type: 'Cargo ship',
  });
  assert.deepEqual(
    vessel.map((query) => Object.keys(query).find((key) => key !== 'text')),
    ['exact', 'exact', 'representative'],
  );
});

test('Commons normalization keeps attribution and marks exact matches honestly', () => {
  const photo = normalizeCommonsPhoto(
    {
      query: {
        pages: [
          {
            title: 'File:N123AB Airbus A320.jpg',
            imageinfo: [
              {
                thumburl: 'https://upload.wikimedia.org/example/thumb.jpg',
                descriptionurl:
                  'https://commons.wikimedia.org/wiki/File:N123AB_Airbus_A320.jpg',
                user: 'Fallback user',
                extmetadata: {
                  ImageDescription: { value: 'Aircraft N123AB at the airport' },
                  Artist: { value: '<b>Jane Aviator</b>' },
                  LicenseShortName: { value: 'CC BY-SA 4.0' },
                  LicenseUrl: {
                    value: 'https://creativecommons.org/licenses/by-sa/4.0/',
                  },
                },
              },
            ],
          },
        ],
      },
    },
    { kind: 'aircraft' },
    { text: '"N123AB" aircraft', exact: 'N123AB' },
  );
  assert.equal(photo.exact, true);
  assert.equal(photo.author, 'Jane Aviator');
  assert.equal(photo.license, 'CC BY-SA 4.0');
  assert.match(photo.sourceUrl, /^https:\/\/commons\.wikimedia\.org\//);
});

test('Commons normalization rejects unrelated or untrusted image results', () => {
  const payload = {
    query: {
      pages: [
        {
          title: 'File:City skyline.jpg',
          imageinfo: [
            {
              thumburl: 'https://evil.example/image.jpg',
              descriptionurl:
                'https://commons.wikimedia.org/wiki/File:City.jpg',
              extmetadata: {},
            },
          ],
        },
      ],
    },
  };
  assert.equal(
    normalizeCommonsPhoto(
      payload,
      { kind: 'vessel' },
      { text: 'cargo ship', representative: 'cargo ship' },
    ),
    null,
  );
});
