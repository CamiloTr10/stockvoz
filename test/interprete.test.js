'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { interpretar } = require('../src/interprete');
const { cargarCasos, resumir } = require('../evaluacion/comun');

// Los casos viven en evaluacion/casos.json (los mismos que mide npm run evaluar).
// Aquí solo se vigilan los marcados con "regresion": que el intérprete por reglas no empeore.
const { catalogo, casos } = cargarCasos();

casos.filter(function (c) { return c.regresion; }).forEach(function (c) {
  test('"' + c.texto + '"', function () {
    assert.deepStrictEqual(resumir(interpretar(c.texto, catalogo), c.esperadas), c.esperadas);
  });
});

// La coma de "1,5" es el mismo separador por el que se parten las operaciones: si se partiera
// ahí, la app propondría una venta que el tendero nunca dijo.
test('la coma de un decimal no inventa una operación', function () {
  const r = interpretar('vendí 1,5 kilos de arroz y 2 panes', catalogo);
  assert.strictEqual(r.operaciones.length, 1);
});

test('la búsqueda conserva lo que no se encontró', function () {
  assert.strictEqual(interpretar('vendí 2 chocolatinas jet', catalogo).operaciones[0].busqueda, 'chocolatinas jet');
});
