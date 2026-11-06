// Entry point: `npm start`. Serves the website from ./public and the accounts API on the same port.
//   PORT      (default 5173)
//   HOST      (default 127.0.0.1 - this machine only; set HOST=0.0.0.0 to share it, ideally behind HTTPS)
//   DATA_DIR  (default ./data - where users and their plans are saved)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 5173;
const host = process.env.HOST || '127.0.0.1';
const dataDir = process.env.DATA_DIR || path.join(here, 'data');

createServer({ dataDir }).listen(port, host, () =>
  console.log(`Smart Scheduler running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}  (data in ${dataDir})`),
);
