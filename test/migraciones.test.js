'use strict';
// Pruebas del ejecutor de migraciones. Corren en un esquema propio de la base de pruebas para no
// chocar con api.test.js, que se ejecuta en paralelo sobre el esquema principal.
require('../src/entorno');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { migrar, leerMigraciones, CARPETA_MIGRACIONES } = require('../src/db');

const url = process.env.DATABASE_URL_PRUEBA;
const esquema = 'prueba_mig_' + process.pid;
let admin;
let pool;
let carpeta;

function escribir(nombre, sql) { fs.writeFileSync(path.join(carpeta, nombre), sql); }

test.before(async function () {
  assert.ok(url, 'Falta DATABASE_URL_PRUEBA en .env (ver .env.example).');
  assert.match(new URL(url).pathname, /_prueba$/, 'La base de pruebas debe llamarse algo_prueba.');
  admin = new Pool({ connectionString: url });
  await admin.query('CREATE SCHEMA ' + esquema);
  pool = new Pool({ connectionString: url, options: '-c search_path=' + esquema });
  carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'stockvoz-mig-'));
});

test.after(async function () {
  await pool.end();
  await admin.query('DROP SCHEMA ' + esquema + ' CASCADE');
  await admin.end();
  fs.readdirSync(carpeta).forEach(function (f) { fs.unlinkSync(path.join(carpeta, f)); });
  fs.rmdirSync(carpeta);
});

async function versiones() {
  return (await pool.query('SELECT version FROM migraciones ORDER BY version')).rows.map(function (r) { return r.version; });
}

test('aplica las migraciones en orden y no repite las ya aplicadas', async function () {
  escribir('001_cosas.sql', 'CREATE TABLE cosas (id integer PRIMARY KEY);');
  // Sin IF NOT EXISTS: si se ejecutara dos veces, la segunda corrida fallaría.
  escribir('002_columna.sql', 'ALTER TABLE cosas ADD COLUMN extra text;');
  await migrar(pool, carpeta);
  assert.deepStrictEqual(await versiones(), [1, 2]);
  await pool.query("INSERT INTO cosas (id, extra) VALUES (1, 'ok')");
  await migrar(pool, carpeta);
  assert.deepStrictEqual(await versiones(), [1, 2]);
});

test('una migración que falla se deshace entera y las siguientes no corren', async function () {
  escribir('003_rota.sql', 'CREATE TABLE a_medias (id integer); SELECT esto_no_existe();');
  escribir('004_no_debe_correr.sql', 'CREATE TABLE no_debe_existir (id integer);');
  await assert.rejects(migrar(pool, carpeta), /Falló la migración 003_rota\.sql/);
  assert.deepStrictEqual(await versiones(), [1, 2]);
  const tablas = (await pool.query('SELECT tablename FROM pg_tables WHERE schemaname = $1', [esquema])).rows.map(function (r) { return r.tablename; });
  assert.ok(tablas.indexOf('a_medias') === -1 && tablas.indexOf('no_debe_existir') === -1, 'quedaron tablas de una migración fallida');
});

test('dos migraciones simultáneas no se pisan', async function () {
  const otra = fs.mkdtempSync(path.join(os.tmpdir(), 'stockvoz-mig-'));
  fs.writeFileSync(path.join(otra, '005_una.sql'), 'CREATE TABLE una (id integer);');
  const otroPool = new Pool({ connectionString: url, options: '-c search_path=' + esquema });
  try {
    await Promise.all([migrar(pool, otra), migrar(otroPool, otra)]);
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1 AND tablename = $2', [esquema, 'una'])).rows[0].n, 1);
  } finally {
    await otroPool.end();
    fs.unlinkSync(path.join(otra, '005_una.sql'));
    fs.rmdirSync(otra);
  }
});

test('las migraciones reales tienen versiones consecutivas desde 1', function () {
  const reales = leerMigraciones(CARPETA_MIGRACIONES);
  assert.ok(reales.length >= 1);
  reales.forEach(function (m, i) { assert.strictEqual(m.version, i + 1, m.nombre); });
});
