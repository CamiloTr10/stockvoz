'use strict';
// Lee .env si existe. Las variables ya definidas en el sistema tienen prioridad.
const path = require('node:path');

try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch (e) { if (e.code !== 'ENOENT') { throw e; } }
