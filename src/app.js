import Fastify from 'fastify';
import {
  planRanges,
  DEFAULT_MAX_SEGMENTS,
  DEFAULT_TRANSFER_SIZE_RATIO,
  MAX_HEADER_VALUE_LENGTH,
} from './planner.js';

const MEDIA_TYPE_RE =
  /^[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*\/[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*(?:\s*;\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+=(?:[A-Za-z0-9!#$%&'*+.^_`|~-]+|"(?:[^"\\\r\n]|\\.)*"))*$/;

const planBodySchema = {
  type: 'object',
  required: ['size'],
  additionalProperties: false,
  properties: {
    size: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    contentType: { type: 'string', minLength: 1, maxLength: 255 },
    // Current resource validators, used together with the If-Range header.
    etag: { type: 'string', minLength: 1, maxLength: MAX_HEADER_VALUE_LENGTH },
    lastModified: { type: 'string', minLength: 1, maxLength: MAX_HEADER_VALUE_LENGTH },
  },
};

export function buildApp(config = {}) {
  const app = Fastify({
    logger: config.logger ?? false,
    trustProxy: true,
  });

  const maxSegments = config.maxSegments ?? DEFAULT_MAX_SEGMENTS;
  const transferSizeRatio = config.transferSizeRatio ?? DEFAULT_TRANSFER_SIZE_RATIO;

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      statusCode,
      code: error.code ?? 'REQUEST_ERROR',
      error: error.name ?? 'Error',
      message: error.message,
    });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  // Primary endpoint: POST /plan with a JSON body, Range carried as a header
  // exactly as it would arrive on a real origin request.
  app.post('/plan', { schema: { body: planBodySchema } }, async (request, reply) => {
    const headerError = checkConditionalHeaders(request);
    if (headerError) return reply.status(400).send(headerError);

    if (request.body.contentType !== undefined && !MEDIA_TYPE_RE.test(request.body.contentType)) {
      return reply.status(400).send({
        statusCode: 400,
        code: 'INVALID_CONTENT_TYPE',
        error: 'Bad Request',
        message: 'contentType must be a valid media type, e.g. application/pdf',
      });
    }

    const result = planRanges({
      size: request.body.size,
      contentType: request.body.contentType,
      etag: request.body.etag,
      lastModified: request.body.lastModified,
      rangeHeader: request.headers.range,
      ifRangeHeader: request.headers['if-range'],
      maxSegments,
      transferSizeRatio,
    });

    return reply.status(result.statusCode).send(result);
  });

  // Convenience endpoint so the API is probeable with a bare curl:
  //   curl 'http://localhost:3000/plan?size=1000' -H 'Range: bytes=0-99'
  app.get('/plan', async (request, reply) => {
    const { size: sizeRaw, contentType, etag, lastModified } = request.query;

    const size = Number(sizeRaw);
    if (sizeRaw === undefined || !Number.isSafeInteger(size) || size < 0 || String(size) !== String(sizeRaw).trim()) {
      return reply.status(400).send({
        statusCode: 400,
        code: 'INVALID_SIZE',
        error: 'Bad Request',
        message: 'query parameter size is required and must be a non-negative integer',
      });
    }
    if (contentType !== undefined && (!singleString(contentType) || !MEDIA_TYPE_RE.test(contentType))) {
      return reply.status(400).send({
        statusCode: 400,
        code: 'INVALID_CONTENT_TYPE',
        error: 'Bad Request',
        message: 'contentType must be a valid media type, e.g. application/pdf',
      });
    }
    // Reject duplicated query parameters (e.g. ?etag=a&etag=b) before they
    // reach the planner as arrays.
    if ((etag !== undefined && !singleString(etag)) ||
        (lastModified !== undefined && !singleString(lastModified))) {
      return reply.status(400).send({
        statusCode: 400,
        code: 'INVALID_QUERY_PARAMETER',
        error: 'Bad Request',
        message: 'etag and lastModified must each appear at most once',
      });
    }

    const headerError = checkConditionalHeaders(request);
    if (headerError) return reply.status(400).send(headerError);

    const result = planRanges({
      size,
      contentType,
      etag,
      lastModified,
      rangeHeader: request.headers.range,
      ifRangeHeader: request.headers['if-range'],
      maxSegments,
      transferSizeRatio,
    });

    return reply.status(result.statusCode).send(result);
  });

  return app;
}

function singleString(value) {
  return typeof value === 'string' && value.length > 0;
}

function checkConditionalHeaders(request) {
  const counts = { range: 0, 'if-range': 0 };
  for (let i = 0; i < request.raw.rawHeaders.length; i += 2) {
    const name = request.raw.rawHeaders[i].toLowerCase();
    if (name === 'range' || name === 'if-range') {
      counts[name] += 1;
      const value = request.raw.rawHeaders[i + 1];
      // Header injection defense: CR/LF must never appear inside a value.
      if (typeof value === 'string' && /[\r\n]/.test(value)) {
        return badRequest(
          name === 'range' ? 'MALFORMED_RANGE' : 'MALFORMED_IF_RANGE',
          `${name} header value must not contain CR or LF characters`,
        );
      }
    }
  }

  if (counts.range > 1) {
    return badRequest('DUPLICATE_RANGE_HEADER', 'exactly one Range header is allowed');
  }
  if (counts['if-range'] > 1) {
    return badRequest('DUPLICATE_IF_RANGE_HEADER', 'exactly one If-Range header is allowed');
  }

  const rangeHeader = request.headers.range;
  if (rangeHeader === undefined) {
    return badRequest('MISSING_RANGE', 'a Range request header is required');
  }
  if (rangeHeader.length > MAX_HEADER_VALUE_LENGTH) {
    return badRequest(
      'MALFORMED_RANGE',
      `Range header exceeds the ${MAX_HEADER_VALUE_LENGTH}-byte limit`,
    );
  }

  const ifRangeHeader = request.headers['if-range'];
  if (ifRangeHeader !== undefined && ifRangeHeader.length > MAX_HEADER_VALUE_LENGTH) {
    return badRequest(
      'MALFORMED_IF_RANGE',
      `If-Range header exceeds the ${MAX_HEADER_VALUE_LENGTH}-byte limit`,
    );
  }

  return null;
}

function badRequest(code, message) {
  return {
    statusCode: 400,
    code,
    error: 'Bad Request',
    message,
  };
}
