import express from 'express';
import path from 'path';
import cache from 'memory-cache';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import { createStream } from 'rotating-file-stream';

import {
  Response as ApiResponse,
  NestedResponse as ApiNestedResponse,
} from './fetch';

import { fetchContributionsForQuery } from './fetch';
import { UserNotFoundError } from './errors';

export interface ParsedQuery {
  years: Array<number>;
  fetchAll: boolean;
  lastYear: boolean;
  format: QueryParams['format'];
}

interface Params {
  username: string;
}

interface QueryParams {
  y?: string | Array<string>;
  format?: 'nested';
}

type Request = express.Request<
  Params,
  ApiResponse | ApiNestedResponse | { error: string },
  {},
  QueryParams
>;

const app = express();

app.use(cors());
app.use(compression());

// Access log (everything)
app.use(
  morgan('combined', {
    stream: createStream('access.log', {
      path: path.join(__dirname, '../logs'),
      interval: '1M', // Rotate every month
    }),
  }),
);

// Log to stdout (errors only)
app.use(
  morgan('combined', {
    skip: (req, res) => res.statusCode < 400 || process.env.NODE_ENV === 'test',
  }),
);

app.get('/v4/:username', async (req: Request, res, next) => {
  const { username } = req.params;

  if (req.query.format && req.query.format !== 'nested') {
    return res.status(400).send({
      error: "Query parameter 'format' must be 'nested' or undefined",
    });
  }

  // prettier-ignore
  const years = req.query.y != null
    ? (typeof req.query.y === 'string' ? [req.query.y] : req.query.y)
    : [];

  if (years.some(y => !/^\d+$/.test(y) && y !== 'all' && y !== 'last')) {
    return res.status(400).send({
      error: "Query parameter 'y' must be an integer, 'all' or 'last'",
    });
  }

  const query: ParsedQuery = {
    years: years.map(y => parseInt(y, 10)).filter(isFinite),
    fetchAll: years.includes('all') || years.length === 0,
    lastYear: years.includes('last'),
    format: req.query.format,
  };

  const key = `${username}-${JSON.stringify(query)}`;
  const cached = cache.get(key);

  if (cached !== null) {
    return res.json(cached);
  }

  try {
    const response = await fetchContributionsForQuery(username, query);
    cache.put(key, response, 1000 * 3600); // Store for an hour

    return res.json(response);
  } catch (error) {
    switch (error.constructor) {
      case UserNotFoundError:
        return res.status(404).send({
          error: error.message,
        });
      default:
        next(
          new Error(
            `Unable to fetch contribution data of \'${username}\': ${error.message}.`,
          ),
        );
    }
  }
});

// Error handler
// noinspection JSUnusedLocalSymbols `next` argument is required
app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) =>
    res.status(500).send({
      error: err.message,
    }),
);

export default app;
