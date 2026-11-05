'use strict';
// Casos de evaluación y la forma de compararlos, compartidos por las pruebas y por evaluar.js.
const fs = require('node:fs');
const path = require('node:path');

function cargarCasos() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'casos.json'), 'utf8'));
}

// Reduce el resultado de un intérprete a lo que se compara: una lista con el estado, tipo,
// cantidad e id del producto de cada operación. Los candidatos solo se incluyen si el caso
// los espera, para poder comparar con igualdad estricta.
function resumir(resultado, esperadas) {
  return resultado.operaciones.map(function (o, i) {
    const real = {
      estado: o.estado, tipo: o.tipo, cantidad: o.cantidad,
      producto: o.producto ? o.producto.id : null
    };
    if (esperadas && esperadas[i] && esperadas[i].candidatos) {
      real.candidatos = o.candidatos.map(function (p) { return p.id; });
    }
    return real;
  });
}

// Acierta solo si hay el mismo número de operaciones y cada una coincide en todo lo esperado.
// El orden importa: el tendero las dijo en un orden y así se le muestran.
function coincide(reales, esperadas) {
  if (reales.length !== esperadas.length) { return false; }
  return esperadas.every(function (e, i) {
    return Object.keys(e).every(function (k) { return JSON.stringify(reales[i][k]) === JSON.stringify(e[k]); });
  });
}

module.exports = { cargarCasos, resumir, coincide };
