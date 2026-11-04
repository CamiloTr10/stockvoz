'use strict';
// Casos de evaluación y la forma de compararlos, compartidos por las pruebas y por evaluar.js.
const fs = require('node:fs');
const path = require('node:path');

function cargarCasos() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'casos.json'), 'utf8'));
}

// Reduce el resultado de un intérprete a lo que se compara: estado, tipo, cantidad, id del
// producto y, si el caso espera candidatos, sus ids.
function resumir(resultado, esperado) {
  const real = {
    estado: resultado.estado, tipo: resultado.tipo, cantidad: resultado.cantidad,
    producto: resultado.producto ? resultado.producto.id : null
  };
  if (esperado.candidatos) { real.candidatos = resultado.candidatos.map(function (p) { return p.id; }); }
  return real;
}

function coincide(real, esperado) {
  return Object.keys(esperado).every(function (k) { return JSON.stringify(real[k]) === JSON.stringify(esperado[k]); });
}

module.exports = { cargarCasos, resumir, coincide };
