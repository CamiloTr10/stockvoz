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

const OK = { operaciones: [{ tipo: 'venta', cantidad: 3, productoId: 2, candidatosIds: [], busqueda: '' }] };

function ia(extra, opciones) {
  return crearIA(Object.assign({ url: url, secreto: SECRETO, timeoutMs: 1000, limiteDiario: 100 }, extra), Object.assign({ avisar: function () {} }, opciones));
}

test('usa la respuesta de n8n y devuelve los objetos del catálogo', async function () {
  manejador = responderJson(OK);
  const r = await ia().interpretar('vendí 3 gaseosas de 400', catalogo, 1);
  assert.strictEqual(r.fuente, 'ia');
  assert.strictEqual(r.motivoRespaldo, undefined);
  const o = r.operaciones[0];
  assert.deepStrictEqual([r.operaciones.length, o.estado, o.tipo, o.cantidad, o.producto.id], [1, 'ok', 'venta', 3, 2]);
  assert.strictEqual(o.producto, catalogo[1]);
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

test('el backend calcula el estado de cada operación a partir de los campos', function () {
  const casos = [
    [{ tipo: 'consulta', productoId: 5 }, 'consulta'],
    [{ tipo: 'venta', cantidad: 2, candidatosIds: [1, 2] }, 'ambiguo'],
    [{ tipo: 'venta', cantidad: 2, busqueda: 'chocolatinas' }, 'sin_producto'],
    [{ tipo: 'venta', productoId: 5 }, 'sin_cantidad'],
    [{ tipo: 'venta', cantidad: 3, productoId: 5 }, 'ok']
  ];
  for (const [op, estado] of casos) {
    const r = validar({ operaciones: [op] }, catalogo, 'x');
    assert.strictEqual(r.operaciones[0].estado, estado, JSON.stringify(op));
  }
});

test('una operación sin tipo se descarta en vez de estorbar en la pantalla', function () {
  const r = validar({ operaciones: [{ tipo: null }, { tipo: 'venta', cantidad: 3, productoId: 5 }] }, catalogo, 'x');
  assert.strictEqual(r.operaciones.length, 1);
  assert.strictEqual(r.operaciones[0].tipo, 'venta');
});

test('acepta varias operaciones y conserva el orden en que se dijeron', function () {
  const r = validar({ operaciones: [
    { tipo: 'venta', cantidad: 2, productoId: 3 },
    { tipo: 'entrada', cantidad: 3, productoId: 6 }
  ] }, catalogo, 'x');
  assert.deepStrictEqual(r.operaciones.map(function (o) { return [o.tipo, o.cantidad, o.producto.id]; }),
    [['venta', 2, 3], ['entrada', 3, 6]]);
});

test('conserva el uso de tokens cuando n8n lo informa', async function () {
  manejador = responderJson(Object.assign({ uso: { entrada: 1400, salida: 60 } }, OK));
  assert.deepStrictEqual((await ia().interpretar('vendí 3 gaseosas de 400', catalogo, 1)).uso, { entrada: 1400, salida: 60 });
});

async function respaldo(texto, esperadoMotivo, config, opciones) {
  const r = await ia(config, opciones).interpretar(texto || 'vendí 3 panes', catalogo, 1);
  assert.strictEqual(r.fuente, 'reglas');
  assert.strictEqual(r.motivoRespaldo, esperadoMotivo);
  assert.strictEqual(r.operaciones[0].estado, 'ok', 'el respaldo por reglas debe seguir respondiendo');
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
  const op = function (extra) { return { operaciones: [Object.assign({ tipo: 'venta', cantidad: 3, productoId: 2 }, extra)] }; };
  const muchas = { operaciones: [1, 2, 3, 4, 5, 6].map(function () { return { tipo: 'venta', cantidad: 1, productoId: 2 }; }) };
  const malas = [
    'esto no es json', '[]', 'null', '{}',
    { operaciones: 'dos' },                  // la lista no es una lista
    { operaciones: [null] },                 // una operación que no es un objeto
    muchas,                                  // más del tope de operaciones
    op({ productoId: 999 }),                 // producto que no es del negocio
    op({ productoId: '2' }),                 // id como texto
    op({ cantidad: 0 }),
    op({ cantidad: 2.5 }),
    op({ cantidad: 1e9 }),
    op({ tipo: 'regalo' }),
    { operaciones: [{ tipo: 'venta', candidatosIds: [1, 999] }] },
    { operaciones: [{ tipo: 'venta', candidatosIds: [1, 1] }] },
    // Una operación válida entre inválidas invalida toda la respuesta: la frase se
    // reinterpreta con las reglas, en vez de guardar una parte de lo que el tendero dijo.
    { operaciones: [{ tipo: 'venta', cantidad: 3, productoId: 2 }, { tipo: 'venta', productoId: 999 }] }
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
  assert.deepStrictEqual([sinIA.fuente, sinIA.motivoRespaldo, sinIA.operaciones[0].estado], ['reglas', undefined, 'ok']);
  const vacia = await ia().interpretar('   ', catalogo, 1);
  assert.deepStrictEqual([vacia.fuente, vacia.operaciones.length], ['reglas', 0]);
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

// ---------- Modo directo: API compatible con OpenAI (Groq, DeepSeek…) ----------

const { cuerpoPeticion, ESQUEMA, instrucciones } = require('../src/ia-instrucciones');

const CLAVE = 'gsk-clave-de-prueba';

function iaDirecta(extra, opciones) {
  return crearIA(Object.assign({ modo: 'directo', url: url, clave: CLAVE, modelo: 'modelo-de-prueba', timeoutMs: 1000, limiteDiario: 100, esquemaEstricto: true }, extra),
    Object.assign({ avisar: function () {} }, opciones));
}

// Respuesta con la forma que devuelve una API compatible con OpenAI.
function comoOpenAI(contenido, extra) {
  return responderJson(Object.assign({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: typeof contenido === 'string' ? contenido : JSON.stringify(contenido) } }],
    usage: { prompt_tokens: 420, completion_tokens: 35 }
  }, extra));
}

const RESPUESTA_OK = { operaciones: [{ tipo: 'venta', cantidad: 3, productoId: 2, candidatosIds: [], busqueda: '' }] };

test('modo directo: usa la respuesta del modelo y cuenta los tokens', async function () {
  manejador = comoOpenAI(RESPUESTA_OK);
  const r = await iaDirecta().interpretar('vendí 3 gaseosas de 400', catalogo, 1);
  assert.strictEqual(r.fuente, 'ia');
  const o = r.operaciones[0];
  assert.deepStrictEqual([o.estado, o.tipo, o.cantidad, o.producto.id], ['ok', 'venta', 3, 2]);
  assert.deepStrictEqual(r.uso, { entrada: 420, salida: 35 });
});

test('modo directo: envía la clave, el modelo y el esquema estricto', async function () {
  manejador = comoOpenAI(RESPUESTA_OK);
  await iaDirecta().interpretar('vendí 3 gaseosas de 400', catalogo, 1);
  assert.strictEqual(recibidas[0].cabeceras.authorization, 'Bearer ' + CLAVE);
  const c = JSON.parse(recibidas[0].cuerpo);
  assert.strictEqual(c.model, 'modelo-de-prueba');
  assert.strictEqual(c.temperature, 0, 'la misma frase debe dar siempre lo mismo');
  assert.strictEqual(c.response_format.type, 'json_schema');
  assert.strictEqual(c.response_format.json_schema.strict, true);
  const esquema = c.response_format.json_schema.schema;
  assert.deepStrictEqual(esquema.required, ['operaciones'], 'la respuesta es una lista de operaciones');
  assert.deepStrictEqual(esquema.properties.operaciones.items.required.sort(),
    ['busqueda', 'candidatosIds', 'cantidad', 'productoId', 'tipo']);
  assert.strictEqual(esquema.additionalProperties, false);
  assert.strictEqual(esquema.properties.operaciones.items.additionalProperties, false);
});

test('modo directo: al modelo solo le llegan la frase y los id y nombres del catálogo', async function () {
  manejador = comoOpenAI(RESPUESTA_OK);
  const conPrecios = catalogo.map(function (p) { return Object.assign({ precio: 9999, stock: 7 }, p); });
  await iaDirecta().interpretar('vendí 3 gaseosas de 400', conPrecios, 1);
  const c = JSON.parse(recibidas[0].cuerpo);
  assert.strictEqual(c.messages.length, 2);
  assert.strictEqual(c.messages[1].content, 'vendí 3 gaseosas de 400', 'la frase va sola en el mensaje del usuario');
  assert.ok(c.messages[0].content.indexOf('2 = Gaseosa 400 ml') !== -1, 'el catálogo va con sus id');
  assert.ok(recibidas[0].cuerpo.indexOf('9999') === -1, 'no deben viajar los precios');
  assert.ok(recibidas[0].cuerpo.indexOf('"stock"') === -1, 'no debe viajar el stock');
});

test('modo directo: sin esquema estricto pide json y lo nombra en las instrucciones', async function () {
  manejador = comoOpenAI(RESPUESTA_OK);
  await iaDirecta({ esquemaEstricto: false }).interpretar('vendí 3 panes', catalogo, 1);
  const c = JSON.parse(recibidas[0].cuerpo);
  assert.deepStrictEqual(c.response_format, { type: 'json_object' });
  assert.ok(/json/i.test(c.messages[0].content), 'DeepSeek exige la palabra json en el mensaje');
});

test('modo directo: respaldo cuando el proveedor falla o responde algo raro', async function () {
  const casos = [
    ['cuota', responderJson({ error: { message: 'rate limit' } }, 429)],
    ['http', responderJson({ error: { message: 'clave inválida' } }, 401)],
    ['http', responderJson({}, 500)],
    ['invalida', responderJson('esto no es json')],
    ['invalida', responderJson({ choices: [] })],
    ['invalida', comoOpenAI('no soy json')],
    ['invalida', comoOpenAI('')],
    ['invalida', comoOpenAI(RESPUESTA_OK, { choices: [{ finish_reason: 'length', message: { content: '{"operaciones":[' } }] })],
    ['invalida', comoOpenAI({ operaciones: [{ tipo: 'venta', cantidad: 3, productoId: 999, candidatosIds: [], busqueda: '' }] })]
  ];
  for (const [motivo, respuesta] of casos) {
    manejador = respuesta;
    const r = await iaDirecta().interpretar('vendí 3 panes', catalogo, 1);
    assert.deepStrictEqual([r.fuente, r.motivoRespaldo], ['reglas', motivo], JSON.stringify(motivo));
    assert.strictEqual(r.operaciones[0].estado, 'ok', 'el respaldo por reglas debe seguir respondiendo');
  }
});

test('modo directo: respaldo si el proveedor se demora o no responde', async function () {
  manejador = function () { /* no responde */ };
  const lento = await iaDirecta({ timeoutMs: 150 }).interpretar('vendí 3 panes', catalogo, 1);
  assert.deepStrictEqual([lento.fuente, lento.motivoRespaldo], ['reglas', 'timeout']);
  const caido = await iaDirecta({ url: 'http://127.0.0.1:9/v1' }).interpretar('vendí 3 panes', catalogo, 1);
  assert.deepStrictEqual([caido.fuente, caido.motivoRespaldo], ['reglas', 'red']);
});

test('las instrucciones explican los tipos, la lista y el catálogo', function () {
  const texto = instrucciones(catalogo);
  ESQUEMA.properties.operaciones.items.properties.tipo.enum
    .filter(function (t) { return t; })
    .forEach(function (t) { assert.ok(texto.indexOf(t) !== -1, 'falta explicar ' + t); });
  assert.ok(/LISTA|lista/.test(texto), 'debe decir que la respuesta es una lista de operaciones');
  assert.ok(texto.indexOf('1 = Gaseosa 1,5 L') !== -1);
});

test('cuerpoPeticion usa el modelo por defecto y no inventa campos', function () {
  const c = cuerpoPeticion({ texto: 'hola', catalogo: catalogo });
  assert.strictEqual(c.model, 'openai/gpt-oss-20b');
  assert.deepStrictEqual(Object.keys(c).sort(), ['max_completion_tokens', 'messages', 'model', 'response_format', 'temperature']);
  assert.strictEqual(cuerpoPeticion({ texto: 'hola', catalogo: catalogo, esfuerzo: 'low' }).reasoning_effort, 'low');
});

test('el backend recalcula el estado cuando el modelo pone mal la etiqueta', function () {
  // Medido contra Groq: a veces los datos vienen bien y la etiqueta mal. El estado es un
  // resumen de los otros campos, así que lo decide el backend y la respuesta se aprovecha.
  const casos = [
    ['sin cantidad es sin_cantidad', { tipo: 'venta', cantidad: null, productoId: 2 }, 'sin_cantidad'],
    ['un solo candidato no es ambiguo', { tipo: 'venta', cantidad: 2, candidatosIds: [1] }, 'sin_producto'],
    ['con producto y cantidad está completo', { tipo: 'venta', cantidad: 2, productoId: 2 }, 'ok'],
    ['preguntar por algo que no está es sin_producto', { tipo: 'consulta', productoId: null }, 'sin_producto']
  ];
  for (const [nombre, d, esperado] of casos) {
    assert.strictEqual(validar({ operaciones: [d] }, catalogo, 'x').operaciones[0].estado, esperado, nombre);
  }
  // En una consulta la cantidad sobra y se descarta, para no mostrarle un número al usuario.
  assert.strictEqual(validar({ operaciones: [{ tipo: 'consulta', cantidad: 3, productoId: 5 }] }, catalogo, 'x').operaciones[0].cantidad, null);
});
