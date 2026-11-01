'use strict';
// Acceso a datos. shortcut: SQLite embebido (node:sqlite) para que el prototipo corra sin
// instalar nada; al pasar a PostgreSQL (decisión del proyecto) solo cambian este archivo y
// las consultas SQL de inventario.js/auth.js.
const { DatabaseSync } = require('node:sqlite');

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS negocios (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  creado_en TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  correo TEXT NOT NULL UNIQUE,
  clave_hash TEXT NOT NULL,
  creado_en TEXT NOT NULL
);
-- Un usuario puede trabajar en varios negocios con un rol distinto en cada uno.
CREATE TABLE IF NOT EXISTS membresias (
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  negocio_id INTEGER NOT NULL REFERENCES negocios(id),
  rol TEXT NOT NULL CHECK (rol IN ('dueno', 'encargado')),
  PRIMARY KEY (usuario_id, negocio_id)
);
CREATE TABLE IF NOT EXISTS sesiones (
  token_hash TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  negocio_id INTEGER REFERENCES negocios(id),
  expira_en INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS productos (
  id INTEGER PRIMARY KEY,
  negocio_id INTEGER NOT NULL REFERENCES negocios(id),
  nombre TEXT NOT NULL COLLATE NOCASE,
  precio INTEGER NOT NULL DEFAULT 0 CHECK (precio >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  stock_minimo INTEGER NOT NULL DEFAULT 0 CHECK (stock_minimo >= 0),
  activo INTEGER NOT NULL DEFAULT 1,
  UNIQUE (negocio_id, nombre)
);
-- El stock solo cambia por movimientos: cada fila deja rastro de quién, cuándo y desde qué frase.
CREATE TABLE IF NOT EXISTS movimientos (
  id INTEGER PRIMARY KEY,
  negocio_id INTEGER NOT NULL REFERENCES negocios(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  usuario_id INTEGER REFERENCES usuarios(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('venta', 'entrada', 'merma')),
  cantidad INTEGER NOT NULL CHECK (cantidad > 0),
  precio_unitario INTEGER NOT NULL,
  stock_resultante INTEGER NOT NULL,
  origen TEXT NOT NULL CHECK (origen IN ('voz', 'texto', 'manual', 'inicial')),
  texto_original TEXT,
  fecha_local TEXT NOT NULL,
  creado_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movimientos_negocio_fecha ON movimientos (negocio_id, fecha_local);
CREATE INDEX IF NOT EXISTS idx_productos_negocio ON productos (negocio_id);
`;

function abrir(ruta) {
  const db = new DatabaseSync(ruta);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  db.exec(ESQUEMA);
  return db;
}

// Ejecuta fn dentro de una transacción; si lanza, deshace todo.
function transaccion(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { abrir, transaccion };
