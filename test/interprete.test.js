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

test('la búsqueda conserva lo que no se encontró', function () {
  assert.strictEqual(interpretar('vendí 2 chocolatinas jet', catalogo).operaciones[0].busqueda, 'chocolatinas jet');
});
