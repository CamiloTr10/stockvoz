'use strict';
// El flujo de n8n se genera (npm run flujo) a partir de src/ia-instrucciones.js. Estas pruebas
// vigilan las dos promesas de ese archivo: que diga lo mismo que el modo directo y que no
// lleve secretos dentro, porque se sube al repositorio.

const { test } = require('node:test');
const assert = require('node:assert');
const flujo = require('../n8n/flujo-stockvoz.json');
const ia = require('../src/ia-instrucciones');

function plantillaDelFlujo() {
  const nodo = flujo.nodes.find(function (n) { return n.name === 'Armar la petición'; });
  const linea = nodo.parameters.jsCode.match(/^const PLANTILLA = (".*");$/m);
  return JSON.parse(JSON.parse(linea[1]));
}

test('el flujo le manda al modelo lo mismo que el modo directo', function () {
  const esperado = ia.cuerpoPeticion({
    texto: '', catalogo: [{ id: 0, nombre: '__CATALOGO__' }], esfuerzo: 'low'
  });
  assert.deepStrictEqual(plantillaDelFlujo(), esperado,
    'las instrucciones cambiaron: corre `npm run flujo` para regenerar n8n/flujo-stockvoz.json');
});

test('el flujo no lleva secretos dentro', function () {
  const texto = JSON.stringify(flujo);
  assert.ok(!/gsk_[A-Za-z0-9]/.test(texto), 'hay una clave de Groq dentro del flujo');
  assert.ok(texto.includes('$env.IA_CLAVE'), 'la clave debe leerse del entorno');
  assert.ok(texto.includes('$env.N8N_SECRETO'), 'el secreto debe leerse del entorno');
});

// Desde typeVersion 4 el nodo HTTP de n8n sigue redirecciones cuando la opción NO está, así que
// se vigila que esté puesta: si alguien la quita, la clave volvería a viajar a donde la manden.
// (Con neverError, un 3xx llega como dato y "Traducir la respuesta" lo convierte en 502; la
// clave sigue sin salir, que es lo que importa.)
test('el nodo HTTP no sigue redirecciones, como el modo directo', function () {
  const nodo = flujo.nodes.find(function (n) { return n.name === 'Preguntarle al modelo'; });
  assert.ok(nodo.typeVersion >= 4, 'esta prueba asume el comportamiento de typeVersion 4');
  assert.strictEqual(nodo.parameters.options.redirect.redirect.followRedirects, false);
});

// Si el nodo HTTP fallara por el código de respuesta, n8n devolvería un 500 pelado y se perdería
// la diferencia entre "se acabó la cuota" (429) y "n8n se rompió", que src/ia.js sí distingue.
test('el flujo deja pasar el código del proveedor en vez de fallar', function () {
  const nodo = flujo.nodes.find(function (n) { return n.name === 'Preguntarle al modelo'; });
  assert.deepStrictEqual(nodo.parameters.options.response.response,
    { fullResponse: true, neverError: true });

  const traducir = flujo.nodes.find(function (n) { return n.name === 'Traducir la respuesta'; });
  assert.match(traducir.parameters.jsCode, /statusCode !== 200/, 'debe mirar el código');
  assert.match(traducir.parameters.jsCode, /429/, 'debe distinguir el 429');

  // El código de la respuesta sale del dato, no está fijo en el nodo.
  const responder = flujo.nodes.find(function (n) { return n.name === 'Responder'; });
  assert.strictEqual(responder.parameters.options.responseCode, '={{ $json.codigo || 200 }}');
});

test('el flujo responde 401 cuando el secreto no coincide', function () {
  const si = flujo.nodes.find(function (n) { return n.name === '¿Secreto correcto?'; });
  assert.ok(si, 'falta el nodo que compara el secreto');
  const rechazo = flujo.nodes.find(function (n) { return n.name === 'Rechazar 401'; });
  assert.strictEqual(rechazo.parameters.options.responseCode, 401);
  // La rama falsa del If (índice 1) es la que tiene que ir al rechazo.
  assert.strictEqual(flujo.connections['¿Secreto correcto?'].main[1][0].node, 'Rechazar 401');
});
