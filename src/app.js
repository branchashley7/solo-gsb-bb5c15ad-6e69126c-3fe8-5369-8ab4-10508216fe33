import Fastify from 'fastify';
import {
  planRanges,
  DEFAULT_MAX_SEGMENTS,
  DEFAULT_TRANSFER_SIZE_RATIO,
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
  },
};

const MAX_HEADER_LENGTH = 4096;

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
    const rangeError = checkRangeHeader(request);
    if (rangeError) return reply.status(400).send(rangeError);

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
      rangeHeader: request.headers.range,
      maxSegments,
      transferSizeRatio,
    });

    return reply.status(result.statusCode).send(result);
  });

  // Convenience endpoint so the API is probeable with a bare curl:
  //   curl 'http://localhost:3000/plan?size=1000' -H 'Range: bytes=0-99'
  app.get('/plan', async (request, reply) => {
    const { size: sizeRaw, contentType } = request.query;

    const size = Number(sizeRaw);
    if (sizeRaw === undefined || !Number.isSafeInteger(size) || size < 0 || String(size) !== String(sizeRaw).trim()) {
      return reply.status(400).send({
        statusCode: 400,
        code: 'INVALID_SIZE',
        error: 'Bad Request',
        message: 'query parameter size is required and must be a non-negative integer',
      });
    }
    if (contentType !== undefined && !MEDIA_TYPE_RE.test(contentType)) {
      return reply.status(400).send({
        statusCode: 400,
        code: 'INVALID_CONTENT_TYPE',
        error: 'Bad Request',
        message: 'contentType must be a valid media type, e.g. application/pdf',
      });
    }

    const rangeError = checkRangeHeader(request);
    if (rangeError) return reply.status(400).send(rangeError);

    const result = planRanges({
      size,
      contentType,
      rangeHeader: request.headers.range,
      maxSegments,
      transferSizeRatio,
    });

    return reply.status(result.statusCode).send(result);
  });

  return app;
}

function checkRangeHeader(request) {
  // Reject duplicate Range headers explicitly; Node would otherwise silently
  // join them with a comma and produce a confusing parse error.
  let occurrences = 0;
  for (let i = 0; i < request.raw.rawHeaders.length; i += 2) {
    if (request.raw.rawHeaders[i].toLowerCase() === 'range') occurrences += 1;
  }
  if (occurrences > 1) {
    return {
      statusCode: 400,
      code: 'DUPLICATE_RANGE_HEADER',
      error: 'Bad Request',
      message: 'exactly one Range header is allowed',
    };
  }

  const rangeHeader = request.headers.range;
  if (rangeHeader === undefined) {
    return {
      statusCode: 400,
      code: 'MISSING_RANGE',
      error: 'Bad Request',
      message: 'a Range request header is required',
    };
  }
  if (rangeHeader.length > MAX_HEADER_LENGTH) {
    return {
      statusCode: 400,
      code: 'MALFORMED_RANGE',
      error: 'Bad Request',
      message: `Range header exceeds the ${MAX_HEADER_LENGTH}-byte limit`,
    };
  }
  return null;
}
