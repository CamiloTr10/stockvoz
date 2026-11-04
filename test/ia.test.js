'use strict';
// Pruebas del módulo de IA contra un n8n simulado. No usan la base ni gastan crédito de ninguna API.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { crearIA, configDesdeEntorno, validar } = require('../src/ia');
const { cargarCasos } = require('../evaluacion/comun');

const { catalogo } = cargarCasos();
const SECRETO = 'secreto-de-prueba';

let n8n;
let url;
let manejador;     // lo que el n8n simulado hace en la prueba en curso
let recibidas;

test.before(function () {
  n8n = http.createServer(function (req, res) {
    const partes = [];
    req.on('data', function (c) { partes.push(c); });
    req.on('end', function () {
      recibidas.push({ cabeceras: req.headers, cuerpo: Buffer.concat(partes).toString('utf8') });
      manejador(req, res);
    });
  });
  return new Promise(function (r) { n8n.listen(0, '127.0.0.1', function () { url = 'http://127.0.0.1:' + n8n.address().port + '/webhook'; r(); }); });
});
test.after(function () { n8n.close(); n8n.closeAllConnections(); });
test.beforeEach(function () { recibidas = []; });

function responderJson(cuerpo, estado) {
  return function (req, res) {
    res.writeHead(estado || 200, { 'Content-Type': 'application/json' });
    res.end(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo));
  };
}

const OK = { estado: 'ok', tipo: 'venta', cantidad: 3, productoId: 2, candidatosIds: [], busqueda: '' };

function ia(extra, opciones) {
  return crearIA(Object.assign({ url: url, secreto: SECRETO, timeoutMs: 1000, limiteDiario: 100 }, extra), Object.assign({ avisar: function () {} }, opciones));
}

test('usa la respuesta de n8n y devuelve los objetos del catálogo', async function () {
  manejador = responderJson(OK);
  const r = await ia().interpretar('vendí 3 gaseosas de 400', catalogo, 1);
  assert.strictEqual(r.fuente, 'ia');
  assert.strictEqual(r.motivoRespaldo, undefined);
  assert.deepStrictEqual([r.estado, r.tipo, r.cantidad, r.producto.id], ['ok', 'venta', 3, 2]);
  assert.strictEqual(r.producto, catalogo[1]);
});

test('envía el secreto y solo la frase y los id y nombres del catálogo', async function () {
  manejador = responderJson(OK);
  const conPrecios = catalogo.map(function (p) { return Object.assign({ precio: 9999, stock: 5 }, p); });
  await ia().interpretar('  vendí 3 gaseosas de 400  ', conPrecios, 1);
  assert.strictEqual(recibidas[0].cabeceras['x-stockvoz-secreto'], SECRETO);
  const cuerpo = JSON.parse(recibidas[0].cuerpo);
  assert.deepStrictEqual(Object.keys(cuerpo).sort(), ['catalogo', 'texto']);
  assert.strictEqual(cuerpo.texto, 'vendí 3 gaseosas de 400');
  assert.deepStrictEqual(cuerpo.catalogo[0], { id: 1, nombre: 'Gaseosa 1,5 L' });
});

test('acepta consulta, ambiguo, sin_producto, sin_cantidad y no_entendido bien formados', async function () {
  const bien = [
    { estado: 'consulta', tipo: 'consulta', productoId: 5 },
    { estado: 'ambiguo', tipo: 'venta', cantidad: 2, candidatosIds: [1, 2] },
    { estado: 'sin_producto', tipo: 'venta', cantidad: 2, busqueda: 'chocolatinas' },
    { estado: 'sin_cantidad', tipo: 'venta', productoId: 5 },
    { estado: 'no_entendido', tipo: null }
  ];
  for (const d of bien) {
    assert.doesNotThrow(function () { validar(d, catalogo, 'x'); }, JSON.stringify(d));
  }
});

test('conserva el uso de tokens cuando n8n lo informa', async function () {
  manejador = responderJson(Object.assign({ uso: { entrada: 1400, salida: 60 } }, OK));
  assert.deepStrictEqual((await ia().interpretar('vendí 3 gaseosas de 400', catalogo, 1)).uso, { entrada: 1400, salida: 60 });
});

async function respaldo(texto, esperadoMotivo, config, opciones) {
  const r = await ia(config, opciones).interpretar(texto || 'vendí 3 panes', catalogo, 1);
  assert.strictEqual(r.fuente, 'reglas');
  assert.strictEqual(r.motivoRespaldo, esperadoMotivo);
  assert.strictEqual(r.estado, 'ok', 'el respaldo por reglas debe seguir respondiendo');
  return r;
}

test('respaldo por timeout cuando n8n tarda demasiado', async function () {
  manejador = function () { /* no responde */ };
  await respaldo(null, 'timeout', { timeoutMs: 150 });
});

test('respaldo por red cuando n8n está caído', async function () {
  await respaldo(null, 'red', { url: 'http://127.0.0.1:9/webhook' });
});

test('respaldo por http cuando n8n responde un error o rechaza el secreto', async function () {
  manejador = responderJson({ error: 'no autorizado' }, 401);
  await respaldo(null, 'http');
  manejador = responderJson('', 500);
  await respaldo(null, 'http');
});

test('respaldo si n8n redirige a otro sitio: el secreto no se envía allá', async function () {
  manejador = function (req, res) { res.writeHead(302, { Location: 'http://127.0.0.1:9/robar' }); res.end(); };
  const r = await ia().interpretar('vendí 3 panes', catalogo, 1);
  assert.strictEqual(r.fuente, 'reglas');
});

test('respaldo por respuesta inválida', async function () {
  const malas = [
    'esto no es json', '[]', 'null', '{}',
    { estado: 'ok', tipo: 'venta', cantidad: 3, productoId: 999 },                        // producto que no es del negocio
    { estado: 'ok', tipo: 'venta', cantidad: 3, productoId: '2' },                        // id como texto
    { estado: 'ok', tipo: 'venta', cantidad: 0, productoId: 2 },
    { estado: 'ok', tipo: 'venta', cantidad: 2.5, productoId: 2 },
    { estado: 'ok', tipo: 'venta', cantidad: 1e9, productoId: 2 },
    { estado: 'ok', tipo: 'regalo', cantidad: 3, productoId: 2 },
    { estado: 'ok', tipo: 'venta', cantidad: null, productoId: 2 },                       // ok sin cantidad
    { estado: 'ok', tipo: 'consulta', cantidad: 3, productoId: 2 },                       // consulta no es una operación
    { estado: 'ambiguo', tipo: 'venta', candidatosIds: [1] },                             // ambiguo con un solo candidato
    { estado: 'ambiguo', tipo: 'venta', candidatosIds: [1, 999] },
    { estado: 'ambiguo', tipo: 'venta', candidatosIds: [1, 1] },
    { estado: 'no_entendido', tipo: 'venta' },
    { estado: 'inventado', tipo: 'venta', cantidad: 3, productoId: 2 }
  ];
  for (const m of malas) {
    manejador = responderJson(m);
    await respaldo(null, 'invalida');
  }
});

test('respaldo por respuesta demasiado grande', async function () {
  manejador = responderJson(Object.assign({}, OK, { busqueda: 'a'.repeat(20000) }));
  await respaldo(null, 'invalida');
});

test('límite diario por negocio: pasado el tope usa reglas y al otro día se restablece', async function () {
  manejador = responderJson(OK);
  let ahora = new Date('2026-11-04T15:00:00Z');
  const motor = ia({ limiteDiario: 2 }, { ahora: function () { return ahora; } });
  assert.strictEqual((await motor.interpretar('vendí 3 panes', catalogo, 1)).fuente, 'ia');
  assert.strictEqual((await motor.interpretar('vendí 3 panes', catalogo, 1)).fuente, 'ia');
  const tercera = await motor.interpretar('vendí 3 panes', catalogo, 1);
  assert.deepStrictEqual([tercera.fuente, tercera.motivoRespaldo], ['reglas', 'limite']);
  assert.strictEqual((await motor.interpretar('vendí 3 panes', catalogo, 2)).fuente, 'ia', 'otro negocio tiene su propio conteo');
  ahora = new Date('2026-11-05T15:00:00Z');
  assert.strictEqual((await motor.interpretar('vendí 3 panes', catalogo, 1)).fuente, 'ia');
});

test('sin configuración o con frase vacía no llama a n8n', async function () {
  manejador = responderJson(OK);
  const sinIA = await crearIA(null).interpretar('vendí 3 panes', catalogo, 1);
  assert.deepStrictEqual([sinIA.fuente, sinIA.motivoRespaldo, sinIA.estado], ['reglas', undefined, 'ok']);
  const vacia = await ia().interpretar('   ', catalogo, 1);
  assert.deepStrictEqual([vacia.fuente, vacia.estado], ['reglas', 'no_entendido']);
  assert.strictEqual(recibidas.length, 0);
});

test('configDesdeEntorno: apagada por defecto y exige URL y secreto cuando se enciende', function () {
  assert.strictEqual(configDesdeEntorno({}), null);
  assert.strictEqual(configDesdeEntorno({ STOCKVOZ_IA: '0', N8N_URL: 'http://localhost:5678/x' }), null);
  assert.throws(function () { configDesdeEntorno({ STOCKVOZ_IA: '1' }); }, /N8N_URL y N8N_SECRETO/);
  assert.throws(function () { configDesdeEntorno({ STOCKVOZ_IA: '1', N8N_URL: 'no es url', N8N_SECRETO: SECRETO }); }, /URL válida/);
  assert.throws(function () { configDesdeEntorno({ STOCKVOZ_IA: '1', N8N_URL: 'ftp://x.com/a', N8N_SECRETO: SECRETO }); }, /http/);
  assert.throws(function () { configDesdeEntorno({ STOCKVOZ_IA: '1', N8N_URL: 'http://localhost:5678/x', N8N_SECRETO: 'corto' }); }, /16 caracteres/);
  const c = configDesdeEntorno({ STOCKVOZ_IA: '1', N8N_URL: 'http://localhost:5678/webhook/stockvoz', N8N_SECRETO: SECRETO, N8N_TIMEOUT_MS: '3000' });
  assert.deepStrictEqual([c.url, c.secreto, c.timeoutMs, c.limiteDiario], ['http://localhost:5678/webhook/stockvoz', SECRETO, 3000, 500]);
});
