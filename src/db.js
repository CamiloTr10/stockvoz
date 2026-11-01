'use strict';
// Acceso a datos en PostgreSQL. Las funciones de auth.js e inventario.js reciben `db`, que puede
// ser el pool o el cliente de una transacción: ambos tienen .query().
const { Pool, types } = require('pg');

// COUNT y SUM devuelven bigint, que pg entrega como texto; los montos del negocio caben en Number.
types.setTypeParser(types.builtins.INT8, Number);
// Las fechas del calendario se usan como texto "2026-10-31", sin pasar por zonas horarias.
types.setTypeParser(types.builtins.DATE, function (v) { return v; });

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS negocios (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre text NOT NULL,
  creado_en timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS usuarios (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre text NOT NULL,
  correo text NOT NULL UNIQUE,
  clave_hash text NOT NULL,
  creado_en timestamptz NOT NULL
);
-- Un usuario puede trabajar en varios negocios con un rol distinto en cada uno.
CREATE TABLE IF NOT EXISTS membresias (
  usuario_id integer NOT NULL REFERENCES usuarios(id),
  negocio_id integer NOT NULL REFERENCES negocios(id),
  rol text NOT NULL CHECK (rol IN ('dueno', 'encargado')),
  PRIMARY KEY (usuario_id, negocio_id)
);
CREATE TABLE IF NOT EXISTS sesiones (
  token_hash text PRIMARY KEY,
  usuario_id integer NOT NULL REFERENCES usuarios(id),
  negocio_id integer REFERENCES negocios(id),
  expira_en bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS productos (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  negocio_id integer NOT NULL REFERENCES negocios(id),
  nombre text NOT NULL,
  precio integer NOT NULL DEFAULT 0 CHECK (precio >= 0),
  stock integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  stock_minimo integer NOT NULL DEFAULT 0 CHECK (stock_minimo >= 0),
  activo boolean NOT NULL DEFAULT true
);
-- "Pan tajado" y "pan tajado" son el mismo producto dentro de un negocio.
CREATE UNIQUE INDEX IF NOT EXISTS uq_productos_negocio_nombre ON productos (negocio_id, lower(nombre));
-- El stock solo cambia por movimientos: cada fila deja rastro de quién, cuándo y desde qué frase.
CREATE TABLE IF NOT EXISTS movimientos (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  negocio_id integer NOT NULL REFERENCES negocios(id),
  producto_id integer NOT NULL REFERENCES productos(id),
  usuario_id integer REFERENCES usuarios(id),
  tipo text NOT NULL CHECK (tipo IN ('venta', 'entrada', 'merma')),
  cantidad integer NOT NULL CHECK (cantidad > 0),
  precio_unitario integer NOT NULL,
  stock_resultante integer NOT NULL,
  origen text NOT NULL CHECK (origen IN ('voz', 'texto', 'manual', 'inicial')),
  texto_original text,
  fecha_local date NOT NULL,
  creado_en timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movimientos_negocio_fecha ON movimientos (negocio_id, fecha_local);
`;

// Abre el pool y crea las tablas que falten.
async function abrir(url) {
  if (!url) { throw new Error('Falta DATABASE_URL. Copia .env.example como .env y complétalo.'); }
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query(ESQUEMA);
  } catch (e) {
    await pool.end();
    throw e;
  }
  return pool;
}

async function uno(db, sql, parametros) {
  return (await db.query(sql, parametros)).rows[0];
}

async function todos(db, sql, parametros) {
  return (await db.query(sql, parametros)).rows;
}

// Ejecuta fn(cliente) dentro de una transacción; si lanza, deshace todo.
async function transaccion(pool, fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const r = await fn(cliente);
    await cliente.query('COMMIT');
    return r;
  } catch (e) {
    await cliente.query('ROLLBACK').catch(function () {});
    throw e;
  } finally {
    cliente.release();
  }
}

// Violación de una restricción UNIQUE.
function esDuplicado(e) {
  return e && e.code === '23505';
}

module.exports = { abrir, uno, todos, transaccion, esDuplicado };
