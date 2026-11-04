'use strict';
// Mide qué tan bien interpreta las frases de evaluacion/casos.json.
//   npm run evaluar              intérprete por reglas (gratis)
//   npm run evaluar -- --ia      la IA vía n8n, con la configuración de .env (gasta crédito de la API)
//   npm run evaluar -- --resumen sin la lista de fallos
require('../src/entorno');
const { interpretar } = require('../src/interprete');
const { crearIA, configDesdeEntorno } = require('../src/ia');
const { cargarCasos, resumir, coincide } = require('./comun');

const usarIA = process.argv.indexOf('--ia') !== -1;
const soloResumen = process.argv.indexOf('--resumen') !== -1;

function percentil(valores, p) {
  const orden = valores.slice().sort(function (a, b) { return a - b; });
  return orden.length ? orden[Math.min(orden.length - 1, Math.ceil(p * orden.length) - 1)] : 0;
}

function pct(a, b) { return b ? Math.round(100 * a / b) + ' %' : '-'; }

async function main() {
  const { catalogo, casos } = cargarCasos();
  let ia = null;
  if (usarIA) {
    // La evaluación siempre prueba la IA, aunque STOCKVOZ_IA esté en 0 en .env.
    ia = crearIA(configDesdeEntorno(Object.assign({}, process.env, { STOCKVOZ_IA: '1' })), { avisar: function () {} });
  }

  const filas = [];
  for (const c of casos) {
    const t0 = process.hrtime.bigint();
    const resultado = usarIA ? await ia.interpretar(c.texto, catalogo, 0) : interpretar(c.texto, catalogo);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const real = resumir(resultado, c.esperado);
    // Si la IA no respondió y se usó el respaldo, el caso no cuenta como acierto de la IA.
    const respaldo = usarIA && resultado.fuente !== 'ia';
    filas.push({ caso: c, real: real, ok: !respaldo && coincide(real, c.esperado), ms: ms, respaldo: respaldo, motivo: resultado.motivoRespaldo, uso: resultado.uso });
  }

  const categorias = {};
  filas.forEach(function (f) {
    const k = f.caso.categoria;
    categorias[k] = categorias[k] || { ok: 0, total: 0 };
    categorias[k].total += 1;
    if (f.ok) { categorias[k].ok += 1; }
  });

  console.log('\nIntérprete evaluado: ' + (usarIA ? 'IA vía n8n' : 'reglas') + '\n');
  const ancho = Math.max.apply(null, Object.keys(categorias).map(function (k) { return k.length; }));
  Object.keys(categorias).forEach(function (k) {
    const c = categorias[k];
    console.log('  ' + k.padEnd(ancho) + '  ' + String(c.ok).padStart(2) + ' de ' + String(c.total).padEnd(2) + '  ' + pct(c.ok, c.total));
  });
  const aciertos = filas.filter(function (f) { return f.ok; }).length;
  console.log('\n  ' + 'TOTAL'.padEnd(ancho) + '  ' + String(aciertos).padStart(2) + ' de ' + String(filas.length).padEnd(2) + '  ' + pct(aciertos, filas.length));

  const tiempos = filas.map(function (f) { return f.ms; });
  console.log('\n  Tiempo por frase: mediana ' + percentil(tiempos, 0.5).toFixed(1) + ' ms, p95 ' + percentil(tiempos, 0.95).toFixed(1) + ' ms');
  if (usarIA) {
    const conRespaldo = filas.filter(function (f) { return f.respaldo; });
    console.log('  Respondió la IA: ' + (filas.length - conRespaldo.length) + ' de ' + filas.length + '; respaldo por reglas: ' + conRespaldo.length +
      (conRespaldo.length ? ' (' + Object.entries(conRespaldo.reduce(function (m, f) { m[f.motivo] = (m[f.motivo] || 0) + 1; return m; }, {}))
        .map(function (e) { return e[0] + ': ' + e[1]; }).join(', ') + ')' : ''));
    const usos = filas.filter(function (f) { return f.uso; });
    if (usos.length) {
      console.log('  Tokens informados por n8n: ' + usos.reduce(function (s, f) { return s + f.uso.entrada; }, 0) + ' de entrada, ' +
        usos.reduce(function (s, f) { return s + f.uso.salida; }, 0) + ' de salida (' + usos.length + ' frases)');
    }
  }

  if (!soloResumen) {
    const fallos = filas.filter(function (f) { return !f.ok; });
    if (fallos.length) {
      console.log('\nFallos (' + fallos.length + '):');
      fallos.forEach(function (f) {
        console.log('  [' + f.caso.categoria + '] «' + f.caso.texto + '»' + (f.respaldo ? '  (respaldo: ' + f.motivo + ')' : ''));
        console.log('      esperado ' + JSON.stringify(f.caso.esperado));
        console.log('      obtenido ' + JSON.stringify(f.real));
      });
    }
  }
  console.log('');
}

main().catch(function (e) { console.error('No se pudo evaluar: ' + e.message); process.exit(1); });
