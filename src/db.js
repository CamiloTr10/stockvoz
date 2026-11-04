'use strict';
// Acceso a datos en PostgreSQL. Las funciones de auth.js e inventario.js reciben `db`, que puede
// ser el pool o el cliente de una transacción: ambos tienen .query().
const fs = require('node:fs');
const path = require('node:path');
const { Pool, types } = require('pg');

const CARPETA_MIGRACIONES = path.join(__dirname, '..', 'migraciones');
// Identifica el candado que impide que dos procesos migren a la vez.
const CANDADO_MIGRACIONES = 5170001;

// COUNT y SUM devuelven bigint, que pg entrega como texto; los montos del negocio caben en Number.
types.setTypeParser(types.builtins.INT8, Number);
// Las fechas del calendario se usan como texto "2026-10-31", sin pasar por zonas horarias.
types.setTypeParser(types.builtins.DATE, function (v) { return v; });

// Archivos NNN_nombre.sql de la carpeta, en orden. El número es la versión y no puede repetirse.
function leerMigraciones(carpeta) {
  const lista = fs.readdirSync(carpeta).filter(function (f) { return /^\d+_.+\.sql$/.test(f); }).sort()
    .map(function (f) { return { version: parseInt(f, 10), nombre: f, sql: fs.readFileSync(path.join(carpeta, f), 'utf8') }; });
  lista.forEach(function (m, i) {
    if (i > 0 && m.version === lista[i - 1].version) { throw new Error('Dos migraciones con la versión ' + m.version + '.'); }
  });
  return lista;
}

// Aplica las migraciones que faltan, cada una en su propia transacción: si una falla, no deja
// nada a medias y las siguientes no corren. Una migración ya aplicada nunca se vuelve a ejecutar.
async function migrar(pool, carpeta) {
  const cliente = await pool.connect();
  try {
    await cliente.query('SELECT pg_advisory_lock($1)', [CANDADO_MIGRACIONES]);
    await cliente.query('CREATE TABLE IF NOT EXISTS migraciones (version integer PRIMARY KEY, nombre text NOT NULL, aplicada_en timestamptz NOT NULL DEFAULT now())');
    const hechas = new Set((await cliente.query('SELECT version FROM migraciones')).rows.map(function (r) { return r.version; }));
    for (const m of leerMigraciones(carpeta || CARPETA_MIGRACIONES)) {
      if (hechas.has(m.version)) { continue; }
      await cliente.query('BEGIN');
      try {
        await cliente.query(m.sql);
        await cliente.query('INSERT INTO migraciones (version, nombre) VALUES ($1, $2)', [m.version, m.nombre]);
        await cliente.query('COMMIT');
      } catch (e) {
        await cliente.query('ROLLBACK').catch(function () {});
        throw new Error('Falló la migración ' + m.nombre + ': ' + e.message);
      }
    }
  } finally {
    await cliente.query('SELECT pg_advisory_unlock($1)', [CANDADO_MIGRACIONES]).catch(function () {});
    cliente.release();
  }
}

// Abre el pool y aplica las migraciones pendientes.
async function abrir(url) {
  if (!url) { throw new Error('Falta DATABASE_URL. Copia .env.example como .env y complétalo.'); }
  const pool = new Pool({ connectionString: url });
  try {
    await migrar(pool);
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

module.exports = { abrir, migrar, leerMigraciones, CARPETA_MIGRACIONES, uno, todos, transaccion, esDuplicado };
