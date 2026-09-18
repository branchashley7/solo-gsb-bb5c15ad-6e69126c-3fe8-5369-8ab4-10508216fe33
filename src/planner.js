// RFC 9110 byte-range response planner.
//
// Parsing, endpoint clamping and overlap/adjacency merging are delegated to
// range-parser.  The only pre-processing done here is RFC 9110 §14.1.2
// suffix normalisation (a suffix longer than the resource covers the whole
// representation) and strict byte-unit / syntax validation, which
// range-parser does not perform.
//
// If-Range (RFC 9110 §13.2.2) is evaluated as a precondition on the Range:
// the resource's current `etag` / `lastModified` are compared against the
// supplied validator before any range work.  When the validator does not
// match (or cannot be parsed), the Range is ignored and a complete 200
// representation plan is returned instead.

import { createHash } from 'node:crypto';
import createRangeParser from 'range-parser';

const rangeParser = createRangeParser.default ?? createRangeParser;

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
export const DEFAULT_MAX_SEGMENTS = 16;
export const DEFAULT_TRANSFER_SIZE_RATIO = 2;
export const MAX_HEADER_VALUE_LENGTH = 4096;

const CRLF = '\r\n';

// One byte-range-spec: whitespace, digits, whitespace, '-', whitespace, digits, whitespace.
// At least one side must carry digits (checked separately).
const RANGE_SPEC_RE = /^\s*(\d*)\s*-\s*(\d*)\s*$/;

// RFC 9110 §5.6.7 entity-tag:  [ weak ] opaque-tag
//   opaque-tag  = DQUOTE *etagc DQUOTE
//   etagc       = %x21 / %x23-7E / obs-text / DQUOTE; the quoted-string form
//                 additionally allows backslash-escaped HTAB / SP / VCHAR.
const ETAGC = '(?:[\\x21\\x23-\\x5b\\x5d-\\x7e\\x80-\\xff]|\\\\[\\t\\x20-\\x7e\\x80-\\xff])';
const ENTITY_TAG_RE = new RegExp(`^(?:W/)?\"${ETAGC}*\"$`);
const STRONG_ENTITY_TAG_RE = new RegExp(`^\"${ETAGC}*\"$`);

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_ALT = MONTH_NAMES.join('|');
const WEEKDAY_ALT = WEEKDAY_NAMES.join('|');

// The three HTTP-date shapes from RFC 9110 §5.6.7:
//   Sun, 06 Nov 1994 08:49:37 GMT       (IMF-fixdate)
//   Sunday, 06-Nov-94 08:49:37 GMT      (obsolete RFC 850)
//   Sun Nov  6 08:49:37 1994            (obsolete asctime)
const IMF_FIXDATE_RE =
  new RegExp(`^(${WEEKDAY_ALT}), (\\d{2}) (${MONTH_ALT}) (\\d{4}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$`);
const RFC850_DATE_RE =
  new RegExp(`^(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\\d{2})-(${MONTH_ALT})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$`);
const ASCTIME_DATE_RE =
  new RegExp(`^(${WEEKDAY_ALT}) (${MONTH_ALT}) ([ \\d]\\d) (\\d{2}):(\\d{2}):(\\d{2}) (\\d{4})$`);

/**
 * Plan a byte-range response for the given resource size and Range header.
 *
 * Optional resource metadata (`etag`, `lastModified`) and an `ifRangeHeader`
 * implement RFC 9110 §13.2.2: range planning only proceeds when the If-Range
 * validator matches; otherwise the Range is ignored and a complete 200
 * representation plan is returned.
 *
 * @returns a result object whose `statusCode` is the status the origin would
 *          send: 200 (full representation, decision: 'full'), 206 (one
 *          segment), 206 + multipart plan (several segments), 416 (nothing
 *          satisfiable) or 422 (plan rejected by a guard).
 *          A 400 result means the Range header or request metadata itself
 *          was malformed/unsupported.
 */
export function planRanges(options) {
  const {
    size,
    rangeHeader,
    contentType = DEFAULT_CONTENT_TYPE,
    etag,
    lastModified,
    ifRangeHeader,
    maxSegments = DEFAULT_MAX_SEGMENTS,
    transferSizeRatio = DEFAULT_TRANSFER_SIZE_RATIO,
  } = options;

  if (!Number.isSafeInteger(size) || size < 0) {
    return fail(400, 'INVALID_SIZE', 'size must be a non-negative safe integer');
  }
  if (typeof rangeHeader !== 'string') {
    return fail(400, 'MISSING_RANGE', 'a Range request header is required');
  }
  if (rangeHeader.length === 0) {
    return fail(400, 'MALFORMED_RANGE', "Range header must look like 'bytes=0-99'");
  }
  if (typeof contentType !== 'string' || /[\r\n]/.test(contentType) || contentType.length === 0) {
    return fail(400, 'INVALID_CONTENT_TYPE', 'contentType must be a single header-safe string');
  }

  const metadataError = validateResourceMetadata({ etag, lastModified });
  if (metadataError) return metadataError;

  // RFC 9110 §13.2.2: If-Range is a precondition on the Range.  When it
  // fails, the Range header is ignored entirely (it is never even parsed)
  // and a complete 200 representation is planned.
  const condition = evaluateIfRange({ ifRangeHeader, etag, lastModified });
  if (condition && !condition.rangesAllowed) {
    return buildFullRepresentation({ size, contentType, condition });
  }

  const normalizedHeaderResult = normalizeRangeHeader(rangeHeader, size);
  if (normalizedHeaderResult.error) return normalizedHeaderResult.error;

  const parsed = rangeParser(size, normalizedHeaderResult.value, { combine: true });

  if (parsed === -2) {
    // Defensive: strict validation above should already have caught this.
    return fail(400, 'MALFORMED_RANGE', 'Range header is not a syntactically valid byte-ranges value');
  }
  if (parsed === -1 || parsed.length === 0) {
    return markPartial(
      {
        statusCode: 416,
        code: 'RANGE_NOT_SATISFIABLE',
        error: 'Range Not Satisfiable',
        message: `none of the requested ranges intersect the ${size}-byte resource`,
        resource: { size, contentType },
        responseHeaders: {
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes */${size}`,
        },
      },
      condition,
    );
  }

  return markPartial(
    buildPlan({ ranges: parsed, size, contentType, maxSegments, transferSizeRatio }),
    condition,
  );
}

/**
 * Validate the current resource's validator metadata.  Invalid metadata is
 * a 400 of the request itself rather than a failed precondition, since the
 * caller asked us to reason about a malformed validator.
 */
function validateResourceMetadata({ etag, lastModified }) {
  if (etag !== undefined) {
    if (typeof etag !== 'string' || etag.length === 0 || etag.length > MAX_HEADER_VALUE_LENGTH) {
      return fail(400, 'INVALID_ETAG', 'etag must be a non-empty RFC 9110 entity-tag');
    }
    if (/[\r\n]/.test(etag) || !ENTITY_TAG_RE.test(etag)) {
      return fail(400, 'INVALID_ETAG', "etag must look like '\"abc123\"' or 'W/\"abc123\"'");
    }
  }
  if (lastModified !== undefined) {
    if (
      typeof lastModified !== 'string' ||
      lastModified.length === 0 ||
      lastModified.length > MAX_HEADER_VALUE_LENGTH
    ) {
      return fail(400, 'INVALID_LAST_MODIFIED', 'lastModified must be an HTTP-date string');
    }
    if (/[\r\n]/.test(lastModified) || parseHttpDate(lastModified) === null) {
      return fail(
        400,
        'INVALID_LAST_MODIFIED',
        "lastModified must be a valid HTTP-date, e.g. 'Wed, 21 Oct 2015 07:28:00 GMT'",
      );
    }
  }
  return null;
}

/**
 * Evaluate an If-Range header against the current resource metadata.
 *
 * Returns null when no If-Range header was sent (normal range semantics),
 * otherwise a condition descriptor:
 *   { rangesAllowed: true,  kind: 'etag'|'date', value, reason }
 *   { rangesAllowed: false, kind, value, reason }
 *
 * Per RFC 9110 a weak entity-tag in If-Range cannot match anything, and a
 * value that is neither a strong entity-tag nor an HTTP-date is an invalid
 * validator: both behave as "precondition failed -> full representation".
 */
function evaluateIfRange({ ifRangeHeader, etag, lastModified }) {
  if (ifRangeHeader === undefined) return null;

  const raw = typeof ifRangeHeader === 'string' ? ifRangeHeader.trim() : '';
  const base = { kind: null, value: ifRangeHeader };

  if (raw === '') {
    return { ...base, rangesAllowed: false, reason: 'INVALID_VALIDATOR' };
  }

  if (raw.startsWith('"')) {
    // Strong entity-tag: compare verbatim (byte for byte) against the
    // current strong ETag.
    if (!STRONG_ENTITY_TAG_RE.test(raw)) {
      return { ...base, rangesAllowed: false, reason: 'INVALID_VALIDATOR' };
    }
    const kind = 'etag';
    if (etag === undefined) {
      return { ...base, kind, rangesAllowed: false, reason: 'MISSING_RESOURCE_ETAG' };
    }
    if (etag.startsWith('W/')) {
      // Only a strong current ETag can satisfy an If-Range entity-tag.
      return { ...base, kind, rangesAllowed: false, reason: 'RESOURCE_ETAG_NOT_STRONG' };
    }
    if (raw === etag) {
      return { ...base, kind, rangesAllowed: true, reason: 'ETAG_MATCH' };
    }
    return { ...base, kind, rangesAllowed: false, reason: 'ETAG_MISMATCH' };
  }

  if (raw.startsWith('W/')) {
    // If-Range only ever uses strong validators.
    return { ...base, rangesAllowed: false, reason: 'WEAK_VALIDATOR_NOT_ALLOWED' };
  }

  // Otherwise the validator must be an HTTP-date.
  const conditionDate = parseHttpDate(raw);
  if (conditionDate === null) {
    return { ...base, rangesAllowed: false, reason: 'INVALID_VALIDATOR' };
  }
  const kind = 'date';
  if (lastModified === undefined) {
    return { ...base, kind, rangesAllowed: false, reason: 'MISSING_RESOURCE_LAST_MODIFIED' };
  }
  const currentDate = parseHttpDate(lastModified);
  if (currentDate === null) {
    // Defensive: validateResourceMetadata rejects this earlier.
    return { ...base, kind, rangesAllowed: false, reason: 'MISSING_RESOURCE_LAST_MODIFIED' };
  }
  if (conditionDate >= currentDate) {
    return { ...base, kind, rangesAllowed: true, reason: 'DATE_NOT_EARLIER' };
  }
  return { ...base, kind, rangesAllowed: false, reason: 'DATE_EARLIER_THAN_LAST_MODIFIED' };
}

/**
 * Stamp a range result with decision='partial' and, when the client sent
 * If-Range, echo the precondition decision.
 */
function markPartial(result, condition) {
  if (condition) {
    result.decision = 'partial';
    result.ifRange = {
      rangesAllowed: condition.rangesAllowed,
      matched: condition.rangesAllowed,
      kind: condition.kind,
      reason: condition.reason,
    };
  } else {
    result.decision = 'partial';
  }
  return result;
}

/**
 * The "ignore Range, send everything" plan: RFC 9110 §13.2.2 says the
 * server responds with a 200 using the entire representation.
 */
function buildFullRepresentation({ size, contentType, condition }) {
  return {
    statusCode: 200,
    decision: 'full',
    ifRange: {
      rangesAllowed: false,
      matched: false,
      kind: condition.kind,
      reason: condition.reason,
    },
    resource: { size, contentType },
    bytes: {
      selected: size,
      framing: 0,
      total: size,
      resource: size,
      ratio: 1,
    },
    responseHeaders: {
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType,
      'Content-Length': String(size),
    },
  };
}

/**
 * Parse the three RFC 9110 HTTP-date shapes into epoch milliseconds, or
 * return null when the value is not a valid HTTP-date.  Every field is
 * cross-checked by round-tripping the constructed timestamp, so impossible
 * dates (Feb 30, weekday mismatch, seconds 61, ...) are rejected.
 */
export function parseHttpDate(value) {
  if (typeof value !== 'string') return null;

  let match = IMF_FIXDATE_RE.exec(value);
  if (match) {
    const [, weekday, day, month, year, hour, minute, second] = match;
    return assembleDate({
      weekday,
      day,
      month,
      year,
      hour,
      minute,
      second,
      expectedFormat: 'imf',
    });
  }

  match = RFC850_DATE_RE.exec(value);
  if (match) {
    const [, day, month, twoDigitYear, hour, minute, second] = match;
    // RFC 9110 §5.6.7: recipients SHOULD parse 2-digit years; values < 50 are
    // interpreted as 2000+, otherwise 1900+.
    const n = Number(twoDigitYear);
    const year = String(n < 50 ? 2000 + n : 1900 + n);
    return assembleDate({
      weekday: null,
      day,
      month,
      year,
      hour,
      minute,
      second,
      expectedFormat: 'rfc850',
      twoDigitYear: true,
    });
  }

  match = ASCTIME_DATE_RE.exec(value);
  if (match) {
    const [, weekday, month, day, hour, minute, second, year] = match;
    return assembleDate({
      weekday,
      day,
      month,
      year,
      hour,
      minute,
      second,
      expectedFormat: 'asctime',
    });
  }

  return null;
}

function assembleDate({
  weekday,
  day,
  month,
  year,
  hour,
  minute,
  second,
  expectedFormat,
  twoDigitYear = false,
}) {
  const monthIndex = MONTH_NAMES.indexOf(month);
  const d = Number(day);
  const y = Number(year);
  const h = Number(hour);
  const min = Number(minute);
  const sec = Number(second);

  const ms = Date.UTC(y, monthIndex, d, h, min, sec);
  if (Number.isNaN(ms)) return null;

  const out = new Date(ms);
  const pad2 = (n) => String(n).padStart(2, '0');
  const actual = {
    day: out.getUTCDate(),
    dayPadded: pad2(out.getUTCDate()),
    month: MONTH_NAMES[out.getUTCMonth()],
    year: out.getUTCFullYear(),
    yearPadded: String(out.getUTCFullYear()).padStart(4, '0'),
    hour: pad2(out.getUTCHours()),
    minute: pad2(out.getUTCMinutes()),
    second: pad2(out.getUTCSeconds()),
    weekday: WEEKDAY_NAMES[out.getUTCDay()],
  };

  if (
    actual.dayPadded !== pad2(d) ||
    actual.month !== month ||
    actual.hour !== pad2(h) ||
    actual.minute !== pad2(min) ||
    actual.second !== pad2(sec)
  ) {
    return null;
  }
  if (weekday !== null && actual.weekday !== weekday) return null;

  if (expectedFormat === 'imf' && actual.yearPadded !== year) return null;
  if (expectedFormat === 'asctime' && String(actual.year) !== String(y)) return null;
  if (twoDigitYear) {
    // Already mapped; Date.UTC round-trip above validates day/month/time.
  }

  return ms;
}

/**
 * Validate the Range header and rewrite it into an equivalent header made
 * solely of absolute byte positions, so range-parser semantics match RFC 9110.
 */
function normalizeRangeHeader(header, size) {
  const eqIndex = header.indexOf('=');
  if (eqIndex === -1) {
    return { error: fail(400, 'MALFORMED_RANGE', "Range header must look like 'bytes=0-99'") };
  }

  const unit = header.slice(0, eqIndex).trim().toLowerCase();
  if (unit !== 'bytes') {
    return {
      error: fail(
        400,
        'UNSUPPORTED_RANGE_UNIT',
        `only byte ranges are supported, received range unit '${unit}'`,
      ),
    };
  }

  const specs = header
    .slice(eqIndex + 1)
    .split(',')
    .map((spec) => normalizeSpec(spec, size));

  if (specs.some((spec) => spec === null)) {
    return {
      error: fail(400, 'MALFORMED_RANGE', 'Range header contains an invalid byte-range-spec'),
    };
  }

  return { value: `bytes=${specs.join(',')}` };
}

/**
 * Normalise one byte-range-spec into absolute digits.
 * Returns null when the spec is syntactically invalid.
 * Unsatisfiable specs are encoded as `${size}-${size}`, which range-parser
 * always rejects (start === size, end clamped to size-1).
 */
function normalizeSpec(rawSpec, size) {
  const match = RANGE_SPEC_RE.exec(rawSpec);
  if (!match) return null;

  const startDigits = match[1];
  const endDigits = match[2];
  if (startDigits === '' && endDigits === '') return null;

  const sizeBig = BigInt(size);

  if (startDigits === '') {
    // Suffix range: bytes=-N  -> last N bytes; N >= size covers everything.
    const suffixLen = BigInt(endDigits);
    if (suffixLen === 0n) return `${size}-${size}`; // zero-length suffix: unsat
    if (size === 0 || suffixLen >= sizeBig) return size === 0 ? `${size}-${size}` : `0-${size - 1}`;
    return `${size - Number(suffixLen)}-${size - 1}`;
  }

  const start = BigInt(startDigits);
  if (start >= sizeBig) return `${size}-${size}`; // starts at/past end: unsat

  if (endDigits === '') {
    // Open-ended range: bytes=N- -> N..size-1.
    return `${Number(start)}-${size - 1}`;
  }

  const end = BigInt(endDigits);
  if (end < start) return `${size}-${size}`; // reversed closed range: unsat
  return `${Number(start)}-${end >= sizeBig ? size - 1 : Number(end)}`;
}

function buildPlan({ ranges, size, contentType, maxSegments, transferSizeRatio }) {
  const boundary = makeBoundary({ size, contentType, ranges });

  const segments = ranges.map((range, index) => {
    const bytes = range.end - range.start + 1;
    const contentRange = `bytes ${range.start}-${range.end}/${size}`;
    return {
      index: index + 1,
      start: range.start,
      end: range.end,
      bytes,
      headers: {
        'Content-Type': contentType,
        'Content-Range': contentRange,
      },
      partHeaderBlock:
        `Content-Type: ${contentType}${CRLF}` +
        `Content-Range: ${contentRange}${CRLF}${CRLF}`,
    };
  });

  const selectedBytes = segments.reduce((sum, segment) => sum + segment.bytes, 0);
  const isMultipart = segments.length > 1;

  let framingBytes = 0;
  if (isMultipart) {
    // Wire layout (CRLF explicit):
    //   --boundary CRLF part1-headers data1 CRLF
    //   --boundary CRLF part2-headers data2 CRLF
    //   --boundary-- CRLF
    const delimiterLine = `--${boundary}${CRLF}`;
    const closingLine = `--${boundary}--${CRLF}`;
    framingBytes =
      segments.reduce(
        (sum, segment) => sum + delimiterLine.length + segment.partHeaderBlock.length + CRLF.length,
        0,
      ) + closingLine.length;
  }

  const totalBytes = selectedBytes + framingBytes;

  if (segments.length > maxSegments) {
    return {
      statusCode: 422,
      code: 'TOO_MANY_SEGMENTS',
      error: 'Unprocessable Entity',
      message: `range plan has ${segments.length} segments; at most ${maxSegments} are allowed`,
      resource: { size, contentType },
      segmentsCount: segments.length,
      maxSegments,
      selectedBytes,
      framingBytes,
      transferBytes: totalBytes,
    };
  }

  if (size > 0 && totalBytes > size * transferSizeRatio) {
    return {
      statusCode: 422,
      code: 'TRANSFER_LIMIT_EXCEEDED',
      error: 'Unprocessable Entity',
      message:
        `planned transfer of ${totalBytes} bytes exceeds ` +
        `${transferSizeRatio}x the ${size}-byte resource`,
      resource: { size, contentType },
      segmentsCount: segments.length,
      selectedBytes,
      framingBytes,
      transferBytes: totalBytes,
      limitBytes: size * transferSizeRatio,
    };
  }

  const base = {
    statusCode: 206,
    resource: { size, contentType },
    segmentsCount: segments.length,
    segments,
    bytes: {
      selected: selectedBytes,
      framing: framingBytes,
      total: totalBytes,
      resource: size,
      ratio: size === 0 ? null : totalBytes / size,
    },
  };

  if (!isMultipart) {
    const only = segments[0];
    return {
      ...base,
      multipart: null,
      responseHeaders: {
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
        'Content-Range': `bytes ${only.start}-${only.end}/${size}`,
        'Content-Length': String(only.bytes),
      },
    };
  }

  const multipartContentType = `multipart/byteranges; boundary=${boundary}`;
  return {
    ...base,
    multipart: {
      boundary,
      boundaryDelimiter: `--${boundary}`,
      closingBoundary: `--${boundary}--`,
      lineTerminator: 'CRLF',
    },
    responseHeaders: {
      'Accept-Ranges': 'bytes',
      'Content-Type': multipartContentType,
      'Content-Length': String(totalBytes),
    },
  };
}

/**
 * Deterministic boundary: identical merged plans always get the same boundary.
 * 52 chars total, well within the 70-char HTTP token budget.
 */
function makeBoundary({ size, contentType, ranges }) {
  // Order-independent: the boundary identifies the covered byte set, not the
  // order the ranges happened to be listed in.
  const ordered = ranges.map((range) => [range.start, range.end]).sort((a, b) => a[0] - b[0]);
  const canonical = JSON.stringify({ size, contentType, ranges: ordered });
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 48);
  return `brp-${hash}`;
}

function fail(statusCode, code, message) {
  return {
    statusCode,
    code,
    error: statusCode === 400 ? 'Bad Request' : 'Unprocessable Entity',
    message,
  };
}
