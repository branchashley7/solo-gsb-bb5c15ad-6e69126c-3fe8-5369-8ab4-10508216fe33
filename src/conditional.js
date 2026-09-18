// RFC 9110 §13.1.3 If-Range precondition handling.
//
// An If-Range validator is either a single entity-tag or one HTTP-date.
// Range processing continues only when:
//   - the validator is a *strong* entity-tag verbatim-equal to the current
//     strong ETag of the representation (If-Match-style strong comparison),
//     or
//   - the validator is an HTTP-date that is not earlier than the current
//     Last-Modified instant (earlier-than comparison per RFC 9110 §13.1.3).
// Anything else (mismatch, missing resource metadata, weak validator,
// unparseable validator) makes the precondition fail: the recipient then
// ignores Range and sends the full representation.

// RFC 9110 §8.8.3:
//   entity-tag = [ weak ] opaque-tag
//   weak       = %x57.2F   ; "W/", case-sensitive
//   opaque-tag = DQUOTE *etagc DQUOTE
//   etagc      = %x21 / %x23-7E / obs-text
// CR, LF, other controls, DEL and a bare DQUOTE can therefore never occur
// inside a well-formed entity-tag.
const ETAGC_SOURCE = '\\x21\\x23-\\x7e\\x80-\\xff';
export const ENTITY_TAG_RE = new RegExp(`^(?:W/)?"(?:[${ETAGC_SOURCE}])*"$`);
export const STRONG_ENTITY_TAG_RE = new RegExp(`^"(?:[${ETAGC_SOURCE}])*"$`);

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_INDEX = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

// IMF-fixdate, the sole HTTP-date shape senders generate (RFC 9110 §5.6.7):
//   Sun-day-name "," SP 2DIGIT SP month SP 4DIGIT SP time SP "GMT"
const IMF_FIXDATE_RE =
  /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a strict IMF-fixdate into a millisecond timestamp.
 *
 * Returns null for anything that is not a syntactically and semantically
 * valid HTTP-date: the shape is matched with a strict regex, then the value
 * is reconstructed via Date.UTC to reject impossible dates (e.g. Feb 30) and
 * weekdays that do not match the calendar date.
 */
export function parseHttpDate(value) {
  if (typeof value !== 'string' || !IMF_FIXDATE_RE.test(value)) return null;

  const weekday = value.slice(0, 3);
  const day = Number(value.slice(5, 7));
  const month = MONTH_INDEX[value.slice(8, 11)];
  const year = Number(value.slice(12, 16));
  const hour = Number(value.slice(17, 19));
  const minute = Number(value.slice(20, 22));
  const second = Number(value.slice(23, 25));

  if (hour > 23 || minute > 59 || second > 59) return null;

  const time = Date.UTC(year, month, day, hour, minute, second);
  const date = new Date(time);

  // Round-trip rejects e.g. "Mon, 31 Feb 2024 ..." and wrong weekdays.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    WEEKDAYS[date.getUTCDay()] !== weekday
  ) {
    return null;
  }
  return time;
}

/**
 * Evaluate an If-Range header against the current representation metadata.
 *
 * @param {string} ifRange      received If-Range field value
 * @param {string} [etag]       current ETag of the resource (strong or weak)
 * @param {string} [lastModified] current Last-Modified as an IMF-fixdate
 * @returns {{satisfied: boolean, kind: 'etag'|'date', reason: string}}
 *   reason is one of etag-match / etag-mismatch / weak-validator /
 *   date-not-earlier / date-earlier / resource-metadata-missing /
 *   invalid-validator.
 */
export function evaluateIfRange({ ifRange, etag, lastModified } = {}) {
  const value = ifRange;
  if (typeof value !== 'string' || value.length === 0) {
    return { satisfied: false, kind: 'etag', reason: 'invalid-validator' };
  }

  // An entity-tag validator starts with DQUOTE (weak ones with the case-
  // sensitive "W/"); anything else must parse as an HTTP-date.
  if (value.charCodeAt(0) === 0x22) {
    if (!STRONG_ENTITY_TAG_RE.test(value)) {
      return { satisfied: false, kind: 'etag', reason: 'invalid-validator' };
    }
    if (typeof etag !== 'string') {
      return { satisfied: false, kind: 'etag', reason: 'resource-metadata-missing' };
    }
    // Verbatim strong comparison: a weak current validator can never match,
    // and no normalisation (whitespace, case, weak prefix) is performed.
    if (!STRONG_ENTITY_TAG_RE.test(etag) || value !== etag) {
      return { satisfied: false, kind: 'etag', reason: 'etag-mismatch' };
    }
    return { satisfied: true, kind: 'etag', reason: 'etag-match' };
  }

  if (value.startsWith('W/')) {
    // RFC 9110: a weak validator in If-Range cannot authorise a partial
    // response; ignore the field entirely.
    return { satisfied: false, kind: 'etag', reason: 'weak-validator' };
  }

  const requestTime = parseHttpDate(value);
  if (requestTime === null) {
    return { satisfied: false, kind: 'date', reason: 'invalid-validator' };
  }
  const currentTime = typeof lastModified === 'string' ? parseHttpDate(lastModified) : null;
  if (currentTime === null) {
    return { satisfied: false, kind: 'date', reason: 'resource-metadata-missing' };
  }

  // Earlier-than comparison: equal or fresher validators still select the
  // range (the common case is the client echoing Last-Modified verbatim).
  return requestTime < currentTime
    ? { satisfied: false, kind: 'date', reason: 'date-earlier' }
    : { satisfied: true, kind: 'date', reason: 'date-not-earlier' };
}
