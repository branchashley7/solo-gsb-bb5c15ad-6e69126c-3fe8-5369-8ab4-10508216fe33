import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { buildApp } from '../src/app.js';

const app = buildApp();
const url = '/plan';

function plan({ size, range, contentType, etag, lastModified, ifRange }) {
  const body = {
    size,
    ...(contentType ? { contentType } : {}),
    ...(etag !== undefined ? { etag } : {}),
    ...(lastModified !== undefined ? { lastModified } : {}),
  };
  const headers = {
    Range: range ?? '',
    'content-type': 'application/json',
    ...(ifRange !== undefined ? { 'If-Range': ifRange } : {}),
  };
  return app.inject({
    method: 'POST',
    url,
    headers,
    payload: JSON.stringify(body),
  });
}

test('closed interval is accepted verbatim', async () => {
  const res = await plan({ size: 10000, range: 'bytes=0-499' });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.segmentsCount, 1);
  assert.deepEqual(body.segments[0], {
    index: 1,
    start: 0,
    end: 499,
    bytes: 500,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Range': 'bytes 0-499/10000',
    },
    partHeaderBlock:
      'Content-Type: application/octet-stream\r\n' +
      'Content-Range: bytes 0-499/10000\r\n\r\n',
  });
  assert.deepEqual(body.responseHeaders, {
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream',
    'Content-Range': 'bytes 0-499/10000',
    'Content-Length': '500',
  });
  assert.equal(body.multipart, null);
  assert.equal(body.bytes.total, 500);
});

test('open tail range extends to the last byte', async () => {
  const res = await plan({ size: 100, range: 'bytes=95-' });
  assert.equal(res.statusCode, 206);
  const segment = res.json().segments[0];
  assert.deepEqual([segment.start, segment.end], [95, 99]);
  assert.equal(segment.bytes, 5);
});

test('suffix range returns the last N bytes', async () => {
  const res = await plan({ size: 100, range: 'bytes=-25' });
  assert.equal(res.statusCode, 206);
  const segment = res.json().segments[0];
  assert.deepEqual([segment.start, segment.end], [75, 99]);
  assert.equal(segment.bytes, 25);
});

test('suffix longer than the resource clamps to the whole representation (RFC 9110)', async () => {
  const res = await plan({ size: 50, range: 'bytes=-200' });
  assert.equal(res.statusCode, 206);
  const segment = res.json().segments[0];
  assert.deepEqual([segment.start, segment.end], [0, 49]);
  assert.equal(segment.bytes, 50);
  assert.equal(res.json().responseHeaders['Content-Range'], 'bytes 0-49/50');
});

test('suffix equal to the resource covers the whole representation', async () => {
  const res = await plan({ size: 50, range: 'bytes=-50' });
  assert.equal(res.statusCode, 206);
  const segment = res.json().segments[0];
  assert.deepEqual([segment.start, segment.end], [0, 49]);
});

test('end beyond the resource is clamped to the last byte', async () => {
  const res = await plan({ size: 100, range: 'bytes=90-500' });
  assert.equal(res.statusCode, 206);
  const segment = res.json().segments[0];
  assert.deepEqual([segment.start, segment.end], [90, 99]);
});

test('reversed closed interval is dropped as unsatisfiable per spec', async () => {
  const res = await plan({ size: 100, range: 'bytes=50-10' });
  assert.equal(res.statusCode, 416);
});

test('range starting at or beyond size is unsatisfiable', async () => {
  let res = await plan({ size: 100, range: 'bytes=100-200' });
  assert.equal(res.statusCode, 416);
  assert.equal(res.json().responseHeaders['Content-Range'], 'bytes */100');
  res = await plan({ size: 100, range: 'bytes=200-' });
  assert.equal(res.statusCode, 416);
});

test('suffix -0 on a non-empty resource is unsatisfiable', async () => {
  const res = await plan({ size: 100, range: 'bytes=-0' });
  assert.equal(res.statusCode, 416);
  assert.equal(res.json().responseHeaders['Content-Range'], 'bytes */100');
});

test('empty resource cannot satisfy any range', async () => {
  let res = await plan({ size: 0, range: 'bytes=0-' });
  assert.equal(res.statusCode, 416);
  assert.equal(res.json().responseHeaders['Content-Range'], 'bytes */0');
  res = await plan({ size: 0, range: 'bytes=-1' });
  assert.equal(res.statusCode, 416);
});

test('overlapping ranges merge into one segment and skip multipart', async () => {
  const res = await plan({ size: 100, range: 'bytes=0-10,5-20' });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.segmentsCount, 1);
  assert.deepEqual([body.segments[0].start, body.segments[0].end], [0, 20]);
  assert.equal(body.bytes.total, 21);
});

test('adjacent ranges merge into one segment', async () => {
  const res = await plan({ size: 100, range: 'bytes=0-9,10-19,20-29' });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.segmentsCount, 1);
  assert.deepEqual([body.segments[0].start, body.segments[0].end], [0, 29]);
});

test('separate ranges produce a deterministic multipart plan', async () => {
  const first = await plan({ size: 1000, range: 'bytes=0-99, 200-299' });
  const second = await plan({ size: 1000, range: 'bytes=200-299, 0-99' });
  assert.equal(first.statusCode, 206);
  assert.equal(second.statusCode, 206);

  const a = first.json();
  const b = second.json();

  // Same merged plan => same deterministic boundary and same segments order
  // (first appearance order, per range-parser combine semantics).
  assert.equal(a.multipart.boundary, b.multipart.boundary);
  assert.match(a.multipart.boundary, /^brp-[0-9a-f]{48}$/);
  assert.equal(a.segmentsCount, 2);
  assert.deepEqual(
    a.segments.map((s) => [s.start, s.end]),
    [
      [0, 99],
      [200, 299],
    ],
  );
  assert.deepEqual(
    b.segments.map((s) => [s.start, s.end]),
    [
      [200, 299],
      [0, 99],
    ],
  );

  assert.equal(a.responseHeaders['Content-Type'], `multipart/byteranges; boundary=${a.multipart.boundary}`);

  // Byte accounting: two 100-byte payloads plus the multipart framing.
  assert.equal(a.bytes.selected, 200);
  const boundary = a.multipart.boundary;
  const expectedFraming =
    (`--${boundary}\r\n`.length + a.segments[0].partHeaderBlock.length + 2) +
    (`--${boundary}\r\n`.length + a.segments[1].partHeaderBlock.length + 2) +
    `--${boundary}--\r\n`.length;
  assert.equal(a.bytes.framing, expectedFraming);
  assert.equal(a.bytes.total, 200 + expectedFraming);
  assert.equal(a.responseHeaders['Content-Length'], String(a.bytes.total));
});

test('unsatisfiable specs in a mixed list are dropped, rest are served', async () => {
  const res = await plan({ size: 10000, range: 'bytes=0-9,500-600,9000-' });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.deepEqual(
    body.segments.map((s) => [s.start, s.end]),
    [
      [0, 9],
      [500, 600],
      [9000, 9999],
    ],
  );
  assert.equal(body.segmentsCount, 3);
});

test('whitespace and multiple spaces around commas are tolerated', async () => {
  const res = await plan({ size: 10000, range: 'bytes = 0-9 , 9000 - 9099' });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().segmentsCount, 2);
});

test('more than 16 merged segments yields 422 TOO_MANY_SEGMENTS', async () => {
  const specs = Array.from({ length: 17 }, (_, i) => `${i * 10}-${i * 10 + 1}`).join(',');
  const res = await plan({ size: 1000, range: `bytes=${specs}` });
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.code, 'TOO_MANY_SEGMENTS');
  assert.equal(body.segmentsCount, 17);
  assert.equal(body.maxSegments, 16);
});

test('exactly 16 merged segments are allowed', async () => {
  const specs = Array.from({ length: 16 }, (_, i) => `${i * 100}-${i * 100 + 1}`).join(',');
  const res = await plan({ size: 10000, range: `bytes=${specs}` });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().segmentsCount, 16);
});

test('planned transfer over 2x the resource size yields 422 TRANSFER_LIMIT_EXCEEDED', async () => {
  // size=50, 16 single-byte segments: 16 payload bytes but long part headers.
  const specs = Array.from({ length: 16 }, (_, i) => `${i * 3}-${i * 3}`).join(',');
  const res = await plan({
    size: 50,
    range: `bytes=${specs}`,
    contentType: 'application/x-very-long-mediatype-name-for-overhead-v1',
  });
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.code, 'TRANSFER_LIMIT_EXCEEDED');
  assert.equal(body.segmentsCount, 16);
  assert.ok(body.transferBytes > 100);
  assert.equal(body.limitBytes, 100);
});

test('planned transfer at or below 2x the resource size is accepted', async () => {
  // Two far-apart ranges: 2 payload bytes plus multipart framing, which fits
  // comfortably under 2 * 200 = 400.
  const res = await plan({ size: 200, range: 'bytes=0-0,199-199', contentType: 'a/b' });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.ok(body.bytes.total <= 400, `total ${body.bytes.total} should be <= 2x resource`);
});

test('syntactically malformed Range headers yield 400', async () => {
  for (const range of ['0-99', 'bytes', 'bytes=', 'bytes=-', 'bytes=abc-5', 'bytes=1,', 'bytes=1-2-3', '']) {
    const res = await plan({ size: 100, range });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(range)}`);
    assert.equal(res.json().code, 'MALFORMED_RANGE');
  }
});

test('non-byte range units yield 400 UNSUPPORTED_RANGE_UNIT', async () => {
  const res = await plan({ size: 100, range: 'items=0-9' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'UNSUPPORTED_RANGE_UNIT');
});

test('missing Range header yields 400 MISSING_RANGE', async () => {
  const res = await app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ size: 100 }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'MISSING_RANGE');
});

test('invalid size is rejected by schema validation', async () => {
  const res = await app.inject({
    method: 'POST',
    url,
    headers: { Range: 'bytes=0-1', 'content-type': 'application/json' },
    payload: JSON.stringify({ size: -1 }),
  });
  assert.equal(res.statusCode, 400);
});

test('invalid contentType is rejected', async () => {
  const res = await plan({ size: 100, range: 'bytes=0-1', contentType: 'not a media type' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_CONTENT_TYPE');
});

test('GET endpoint supports query-based planning', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/plan?size=1000&contentType=application/pdf',
    headers: { Range: 'bytes=-100' },
  });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.deepEqual([body.segments[0].start, body.segments[0].end], [900, 999]);
  assert.equal(body.responseHeaders['Content-Type'], 'application/pdf');
});

test('health endpoint', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
});

// --- If-Range (RFC 9110 §13.2.2) ----------------------------------------

const CURRENT_ETAG = '"v1-abc123"';
const CURRENT_DATE = 'Wed, 21 Oct 2015 07:28:00 GMT';

test('If-Range matching the current strong ETag verbatim performs the range', async () => {
  const res = await plan({
    size: 1000,
    range: 'bytes=0-99',
    etag: CURRENT_ETAG,
    ifRange: CURRENT_ETAG,
  });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.decision, 'partial');
  assert.deepEqual(body.ifRange, {
    rangesAllowed: true,
    matched: true,
    kind: 'etag',
    reason: 'ETAG_MATCH',
  });
});

test('If-Range etag without surrounding double quotes is not an entity-tag', async () => {
  const res = await plan({
    size: 1000,
    range: 'bytes=0-99',
    etag: CURRENT_ETAG,
    ifRange: 'v1-abc123',
  });
  // Not quoted => must be an HTTP-date, which this is not => invalid validator.
  assertFull200(res, { reason: 'INVALID_VALIDATOR', kind: null });
});

test('If-Range etag that does not match falls back to a full 200 plan', async () => {
  const res = await plan({
    size: 1000,
    range: 'bytes=0-99',
    etag: CURRENT_ETAG,
    ifRange: '"v2-zzz999"',
  });
  assertFull200(res, { reason: 'ETAG_MISMATCH', kind: 'etag' });
});

test('entity-tag matching is byte for byte (case sensitive)', async () => {
  const res = await plan({
    size: 1000,
    range: 'bytes=0-99',
    etag: CURRENT_ETAG,
    ifRange: CURRENT_ETAG.toUpperCase(),
  });
  assertFull200(res, { reason: 'ETAG_MISMATCH', kind: 'etag' });
});

test('If-Range etag without current etag metadata ignores the range', async () => {
  const res = await plan({
    size: 1000,
    range: 'bytes=0-99',
    ifRange: CURRENT_ETAG,
  });
  assertFull200(res, { reason: 'MISSING_RESOURCE_ETAG', kind: 'etag' });
});

test('a weak current ETag cannot satisfy an If-Range entity-tag', async () => {
  const res = await plan({
    size: 1000,
    range: 'bytes=0-99',
    etag: 'W/"v1-abc123"',
    ifRange: CURRENT_ETAG,
  });
  assertFull200(res, { reason: 'RESOURCE_ETAG_NOT_STRONG', kind: 'etag' });
});

test('a weak validator in If-Range is always a fallback', async () => {
  const res = await plan({
    size: 1000,
    range: 'bytes=0-99',
    etag: 'W/"x"',
    ifRange: 'W/"x"',
  });
  assertFull200(res, { reason: 'WEAK_VALIDATOR_NOT_ALLOWED', kind: null });
});

test('If-Range HTTP-date equal to lastModified performs the range', async () => {
  const res = await plan({
    size: 1000,
    range: 'bytes=0-499',
    lastModified: CURRENT_DATE,
    ifRange: CURRENT_DATE,
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().decision, 'partial');
  assert.deepEqual(res.json().ifRange, {
    rangesAllowed: true,
    matched: true,
    kind: 'date',
    reason: 'DATE_NOT_EARLIER',
  });
});

test('If-Range HTTP-date later than lastModified performs the range', async () => {
  const res = await plan({
    size: 1000,
    range: 'bytes=0-499',
    lastModified: CURRENT_DATE,
    ifRange: 'Thu, 22 Oct 2015 00:00:00 GMT',
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().ifRange.reason, 'DATE_NOT_EARLIER');
});

test('If-Range HTTP-date earlier than lastModified falls back to full 200', async () => {
  const res = await plan({
    size: 1000,
    range: 'bytes=0-499',
    lastModified: CURRENT_DATE,
    ifRange: 'Tue, 20 Oct 2015 07:28:00 GMT',
  });
  assertFull200(res, { reason: 'DATE_EARLIER_THAN_LAST_MODIFIED', kind: 'date' });
});

test('obsolete RFC 850 dates are accepted in If-Range and lastModified', async () => {
  const res = await plan({
    size: 1000,
    range: 'bytes=0-9',
    lastModified: 'Wednesday, 21-Oct-15 07:28:00 GMT',
    ifRange: 'Wednesday, 21-Oct-15 07:28:00 GMT',
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().ifRange.reason, 'DATE_NOT_EARLIER');
});

test('obsolete asctime dates are accepted in If-Range', async () => {
  // Wed Oct 21 07:28:00 2015 — equal to lastModified.
  const res = await plan({
    size: 1000,
    range: 'bytes=0-9',
    lastModified: CURRENT_DATE,
    ifRange: 'Wed Oct 21 07:28:00 2015',
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().ifRange.kind, 'date');
});

test('If-Range date with impossible calendar values is an invalid validator', async () => {
  for (const bad of [
    'Thu, 21 Oct 2015 07:28:00 GMT', // wrong weekday
    'Wed, 31 Feb 2015 07:28:00 GMT', // impossible date
    'Wed, 21 Oct 2015 07:28:61 GMT', // seconds out of range
    'not-a-date',
  ]) {
    const res = await plan({
      size: 1000,
      range: 'bytes=0-9',
      lastModified: CURRENT_DATE,
      ifRange: bad,
    });
    assertFull200(res, { reason: 'INVALID_VALIDATOR', kind: null }, bad);
  }
});

test('If-Range date without lastModified metadata ignores the range', async () => {
  const res = await plan({
    size: 1000,
    range: 'bytes=0-9',
    ifRange: CURRENT_DATE,
  });
  assertFull200(res, { reason: 'MISSING_RESOURCE_LAST_MODIFIED', kind: 'date' });
});

test('empty If-Range is an invalid validator and yields full 200', async () => {
  const res = await plan({
    size: 1000,
    range: 'bytes=0-9',
    etag: CURRENT_ETAG,
    ifRange: '   ',
  });
  assertFull200(res, { reason: 'INVALID_VALIDATOR', kind: null });
});

test('failed If-Range precondition bypasses Range parsing entirely', async () => {
  // Even a malformed Range is ignored: RFC semantics is "send full 200".
  const res = await plan({
    size: 1000,
    range: 'bytes=garbage',
    etag: CURRENT_ETAG,
    ifRange: '"other"',
  });
  assertFull200(res, { reason: 'ETAG_MISMATCH', kind: 'etag' });
});

test('failed If-Range on an unsatisfiable range still returns full 200', async () => {
  const res = await plan({
    size: 100,
    range: 'bytes=500-600',
    etag: CURRENT_ETAG,
    ifRange: '"stale"',
  });
  assertFull200(res, { reason: 'ETAG_MISMATCH', kind: 'etag' });
});

test('matched If-Range preserves the original 416 semantics', async () => {
  const res = await plan({
    size: 100,
    range: 'bytes=500-600',
    etag: CURRENT_ETAG,
    ifRange: CURRENT_ETAG,
  });
  assert.equal(res.statusCode, 416);
  assert.equal(res.json().decision, 'partial');
  assert.equal(res.json().ifRange.reason, 'ETAG_MATCH');
});

test('matched If-Range preserves the original 422 semantics', async () => {
  const specs = Array.from({ length: 17 }, (_, i) => `${i * 10}-${i * 10 + 1}`).join(',');
  const res = await plan({
    size: 1000,
    range: `bytes=${specs}`,
    etag: CURRENT_ETAG,
    ifRange: CURRENT_ETAG,
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, 'TOO_MANY_SEGMENTS');
  assert.equal(res.json().decision, 'partial');
});

test('requests without If-Range carry decision=partial and no ifRange block', async () => {
  const res = await plan({ size: 1000, range: 'bytes=0-9' });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.decision, 'partial');
  assert.equal(body.ifRange, undefined);
});

test('full 200 plan for size 0 reports Content-Length 0', async () => {
  const res = await plan({
    size: 0,
    range: 'bytes=0-9',
    etag: CURRENT_ETAG,
    ifRange: '"different"',
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.decision, 'full');
  assert.equal(body.responseHeaders['Content-Length'], '0');
  assert.equal(body.bytes.total, 0);
  assert.equal(body.bytes.ratio, 1);
});

test('full 200 plan preserves the requested content type', async () => {
  const res = await plan({
    size: 250,
    range: 'bytes=0-9',
    contentType: 'video/mp4',
    etag: CURRENT_ETAG,
    ifRange: '"different"',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().responseHeaders['Content-Type'], 'video/mp4');
});

test('malformed current etag metadata is rejected with 400', async () => {
  for (const etag of ['noquotes', '"unclosed', 'W/"', '"bad\x7fchar"']) {
    const res = await plan({ size: 1000, range: 'bytes=0-9', etag, ifRange: '"x"' });
    assert.equal(res.statusCode, 400, `expected 400 for etag ${JSON.stringify(etag)}`);
    assert.equal(res.json().code, 'INVALID_ETAG');
  }
});

test('malformed lastModified metadata is rejected with 400', async () => {
  for (const lastModified of ['not a date', 'Thu, 21 Oct 2015 07:28:00 GMT', 'Wed, 31 Feb 2015 07:28:00 GMT']) {
    const res = await plan({ size: 1000, range: 'bytes=0-9', lastModified });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(lastModified)}`);
    assert.equal(res.json().code, 'INVALID_LAST_MODIFIED');
  }
});

test('etag or lastModified containing CR/LF is rejected', async () => {
  let res = await plan({
    size: 1000,
    range: 'bytes=0-9',
    etag: '"x"\r\nX-Injected: 1',
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_ETAG');

  res = await plan({
    size: 1000,
    range: 'bytes=0-9',
    lastModified: `${CURRENT_DATE}\r\nX-Injected: 1`,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_LAST_MODIFIED');
});

test('If-Range containing CR/LF is rejected', async () => {
  const res = await plan({
    size: 1000,
    range: 'bytes=0-9',
    etag: CURRENT_ETAG,
    ifRange: `${CURRENT_ETAG}\r\nX-Injected: 1`,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'MALFORMED_IF_RANGE');
});

test('over-long If-Range header is rejected', async () => {
  const res = await plan({
    size: 1000,
    range: 'bytes=0-9',
    etag: '"x"',
    ifRange: `"${'a'.repeat(5000)}"`,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'MALFORMED_IF_RANGE');
});

test('GET endpoint passes etag, lastModified and If-Range through', async () => {
  const match = await app.inject({
    method: 'GET',
    url: `/plan?size=1000&etag=${encodeURIComponent(CURRENT_ETAG)}`,
    headers: { Range: 'bytes=0-9', 'If-Range': CURRENT_ETAG },
  });
  assert.equal(match.statusCode, 206);
  assert.equal(match.json().decision, 'partial');

  const stale = await app.inject({
    method: 'GET',
    url: `/plan?size=1000&lastModified=${encodeURIComponent(CURRENT_DATE)}`,
    headers: { Range: 'bytes=0-9', 'If-Range': 'Mon, 01 Jan 1900 00:00:00 GMT' },
  });
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.json().decision, 'full');
});

test('duplicated etag query parameter is rejected', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/plan?size=1000&etag=${encodeURIComponent(CURRENT_ETAG)}&etag=other`,
    headers: { Range: 'bytes=0-9' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_QUERY_PARAMETER');
});

test('duplicate If-Range request headers are rejected over a real connection', async (t) => {
  const server = await startRawServer(t);
  const { port } = server.address();
  const payload = JSON.stringify({ size: 1000, etag: CURRENT_ETAG });
  const raw =
    `POST /plan HTTP/1.1\r\n` +
    `Host: localhost\r\n` +
    `Content-Type: application/json\r\n` +
    `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
    `Range: bytes=0-9\r\n` +
    `If-Range: ${CURRENT_ETAG}\r\n` +
    `If-Range: "other"\r\n` +
    `Connection: close\r\n\r\n` +
    payload;
  const { status, body } = await rawHttpRequest(port, raw);
  assert.equal(status, 400);
  assert.match(body, /DUPLICATE_IF_RANGE_HEADER/);
});

test('duplicate Range request headers are still rejected over a real connection', async (t) => {
  const server = await startRawServer(t);
  const { port } = server.address();
  const payload = JSON.stringify({ size: 1000 });
  const raw =
    `POST /plan HTTP/1.1\r\n` +
    `Host: localhost\r\n` +
    `Content-Type: application/json\r\n` +
    `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
    `Range: bytes=0-9\r\n` +
    `Range: bytes=10-19\r\n` +
    `Connection: close\r\n\r\n` +
    payload;
  const { status } = await rawHttpRequest(port, raw);
  assert.equal(status, 400);
});

function assertFull200(res, { reason, kind }, label = '') {
  assert.equal(res.statusCode, 200, `status for ${label} (${reason})`);
  const body = res.json();
  assert.equal(body.decision, 'full', `decision for ${label}`);
  assert.equal(body.ifRange.matched, false, `matched for ${label}`);
  assert.equal(body.ifRange.rangesAllowed, false, `rangesAllowed for ${label}`);
  assert.equal(body.ifRange.reason, reason, `reason for ${label}`);
  assert.equal(body.ifRange.kind, kind, `kind for ${label}`);
  assert.equal(body.responseHeaders['Accept-Ranges'], 'bytes', `accept-ranges for ${label}`);
  assert.equal(
    body.responseHeaders['Content-Length'],
    String(body.resource.size),
    `content-length for ${label}`,
  );
  assert.equal(
    body.responseHeaders['Content-Type'],
    body.resource.contentType,
    `content-type for ${label}`,
  );
  assert.equal(body.bytes.total, body.resource.size);
}

function startRawServer(t) {
  return new Promise((resolve, reject) => {
    const fastify = buildApp();
    fastify.ready((err) => {
      if (err) return reject(err);
      const server = fastify.server.listen(0, '127.0.0.1', () => {
        t.after(() => fastify.close());
        resolve(server);
      });
    });
  });
}

function rawHttpRequest(port, raw) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    socket.on('error', reject);
    socket.on('close', () => {
      const headerEnd = data.indexOf('\r\n\r\n');
      const head = data.slice(0, headerEnd);
      const status = Number(head.split('\r\n')[0].split(' ')[1]);
      resolve({ status, head, body: data.slice(headerEnd + 4) });
    });
    socket.write(raw);
  });
}
