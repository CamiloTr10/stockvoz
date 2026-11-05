'use strict';
// Mide qué tan bien interpreta las frases de evaluacion/casos.json.
//   npm run evaluar                 intérprete por reglas (gratis)
//   npm run evaluar -- --ia         la IA con la configuración de .env (gasta cuota de la API)
//   npm run evaluar -- --resumen    sin la lista de fallos
//   npm run evaluar -- --ia --pausa 0   sin esperar entre frases (puede chocar con el límite por minuto)
require('../src/entorno');
const { interpretar } = require('../src/interprete');
const { crearIA, configDesdeEntorno } = require('../src/ia');
const { cargarCasos, resumir, coincide } = require('./comun');

const usarIA = process.argv.indexOf('--ia') !== -1;
const soloResumen = process.argv.indexOf('--resumen') !== -1;
// Los planes gratuitos limitan los tokens por minuto, así que por defecto se espera entre frases.
const posPausa = process.argv.indexOf('--pausa');
const pausaMs = posPausa === -1 ? 5000 : Number(process.argv[posPausa + 1]) || 0;

function esperar(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function percentil(valores, p) {
  const orden = valores.slice().sort(function (a, b) { return a - b; });
  return orden.length ? orden[Math.min(orden.length - 1, Math.ceil(p * orden.length) - 1)] : 0;
}

function pct(a, b) { return b ? Math.round(100 * a / b) + ' %' : '-'; }

async function main() {
  const { catalogo, casos } = cargarCasos();
  let ia = null;
  let config = null;
  if (usarIA) {
    // La evaluación siempre prueba la IA, aunque STOCKVOZ_IA esté apagada en .env. Si no se
    // indicó modo, se usa el que tenga credenciales.
    const enEntorno = process.env.STOCKVOZ_IA;
    const modo = enEntorno && enEntorno !== '0' ? enEntorno : (process.env.IA_CLAVE ? 'directo' : 'n8n');
    config = configDesdeEntorno(Object.assign({}, process.env, { STOCKVOZ_IA: modo }));
    ia = crearIA(config, { avisar: function () {} });
    if (pausaMs) { console.log('\nEsperando ' + pausaMs + ' ms entre frases para no pasarse del límite por minuto (cámbialo con --pausa).'); }
  }

  const filas = [];
  for (const c of casos) {
    if (usarIA && pausaMs && filas.length) { await esperar(pausaMs); }
    const t0 = process.hrtime.bigint();
    const resultado = usarIA ? await ia.interpretar(c.texto, catalogo, 0) : interpretar(c.texto, catalogo);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const real = resumir(resultado, c.esperadas);
    // Si la IA falló y hubo que usar el respaldo, el caso no cuenta como acierto suyo. Una frase
    // vacía no se le manda al modelo a propósito, y eso no es un fallo.
    const respaldo = usarIA && resultado.fuente !== 'ia' && Boolean(resultado.motivoRespaldo);
    filas.push({ caso: c, real: real, ok: !respaldo && coincide(real, c.esperadas), ms: ms, respaldo: respaldo, motivo: resultado.motivoRespaldo, uso: resultado.uso });
  }

  const categorias = {};
  filas.forEach(function (f) {
    const k = f.caso.categoria;
    categorias[k] = categorias[k] || { ok: 0, total: 0 };
    categorias[k].total += 1;
    if (f.ok) { categorias[k].ok += 1; }
  });

  console.log('\nIntérprete evaluado: ' + (usarIA
    ? (config.modo === 'directo' ? 'IA directa · ' + config.modelo : 'IA vía n8n')
    : 'reglas') + '\n');
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
      console.log('  Tokens informados por el proveedor: ' + usos.reduce(function (s, f) { return s + f.uso.entrada; }, 0) + ' de entrada, ' +
        usos.reduce(function (s, f) { return s + f.uso.salida; }, 0) + ' de salida (' + usos.length + ' frases)');
    }
  }

  if (!soloResumen) {
    const fallos = filas.filter(function (f) { return !f.ok; });
    if (fallos.length) {
      console.log('\nFallos (' + fallos.length + '):');
      fallos.forEach(function (f) {
        console.log('  [' + f.caso.categoria + '] «' + f.caso.texto + '»' + (f.respaldo ? '  (respaldo: ' + f.motivo + ')' : ''));
        console.log('      esperado ' + JSON.stringify(f.caso.esperadas));
        console.log('      obtenido ' + JSON.stringify(f.real));
      });
    }
  }
  console.log('');
}

main().catch(function (e) { console.error('No se pudo evaluar: ' + e.message); process.exit(1); });
