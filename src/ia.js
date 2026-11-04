'use strict';
// Interpretación con IA a través de n8n, con el intérprete por reglas como respaldo.
// El backend no confía en la IA: valida su respuesta contra el catálogo del negocio y, si algo
// falla (n8n caído, lento, respuesta rara, producto ajeno), responde con las reglas. La IA solo
// propone; quien guarda es POST /api/movimientos, después de que el usuario confirma.
// El formato de la petición y de la respuesta está en docs/contrato-n8n.md.
const { interpretar } = require('./interprete');
const { fechaLocal, MAX_CANTIDAD } = require('./inventario');

const ESTADOS = ['ok', 'consulta', 'ambiguo', 'sin_producto', 'sin_cantidad', 'no_entendido'];
const OPERACIONES = ['venta', 'entrada', 'merma'];
const MAX_RESPUESTA = 16 * 1024;
const MAX_CANDIDATOS = 5;

function fallo(motivo, mensaje) {
  const e = new Error(mensaje);
  e.motivo = motivo;
  return e;
}

// Convierte la respuesta de n8n en el mismo formato que devuelve interpretar(), o lanza
// un error 'invalida' si no es una respuesta que el backend acepte.
function validar(d, catalogo, texto) {
  const invalida = function (m) { return fallo('invalida', m); };
  if (!d || typeof d !== 'object' || Array.isArray(d)) { throw invalida('la respuesta no es un objeto'); }
  if (ESTADOS.indexOf(d.estado) === -1) { throw invalida('estado desconocido'); }
  const tipo = d.tipo === undefined ? null : d.tipo;
  if (tipo !== null && tipo !== 'consulta' && OPERACIONES.indexOf(tipo) === -1) { throw invalida('tipo desconocido'); }
  const cantidad = d.cantidad === undefined ? null : d.cantidad;
  if (cantidad !== null && (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_CANTIDAD)) { throw invalida('cantidad fuera de rango'); }

  // Solo se aceptan productos del catálogo que se le envió: así nunca aparece uno de otro negocio.
  const porId = new Map(catalogo.map(function (p) { return [p.id, p]; }));
  const buscar = function (id) {
    const p = porId.get(id);
    if (!p) { throw invalida('producto que no está en el catálogo'); }
    return p;
  };
  const producto = d.productoId === undefined || d.productoId === null ? null : buscar(d.productoId);
  const ids = d.candidatosIds === undefined ? [] : d.candidatosIds;
  if (!Array.isArray(ids) || ids.length > MAX_CANDIDATOS || new Set(ids).size !== ids.length) { throw invalida('candidatos inválidos'); }
  const candidatos = ids.map(buscar);

  const operacion = OPERACIONES.indexOf(tipo) !== -1;
  const coherente = {
    ok: operacion && producto !== null && cantidad !== null,
    consulta: tipo === 'consulta' && producto !== null,
    ambiguo: operacion && producto === null && candidatos.length >= 2,
    sin_producto: operacion && producto === null,
    sin_cantidad: operacion && producto !== null && cantidad === null,
    no_entendido: tipo === null && producto === null
  }[d.estado];
  if (!coherente) { throw invalida('los campos no cuadran con el estado'); }

  const resultado = {
    estado: d.estado, tipo: tipo, cantidad: cantidad, producto: producto, candidatos: candidatos,
    busqueda: typeof d.busqueda === 'string' ? d.busqueda.trim().slice(0, 120) : '', texto: texto
  };
  const uso = d.uso;
  if (uso && Number.isInteger(uso.entrada) && Number.isInteger(uso.salida) && uso.entrada >= 0 && uso.salida >= 0) {
    resultado.uso = { entrada: uso.entrada, salida: uso.salida };
  }
  return resultado;
}

async function consultar(config, fetchFn, texto, catalogo) {
  let crudo;
  try {
    const r = await fetchFn(config.url, {
      method: 'POST',
      redirect: 'error',                       // el secreto no debe seguir una redirección a otro sitio
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: { 'content-type': 'application/json', 'x-stockvoz-secreto': config.secreto },
      // A la IA solo le llegan la frase y los nombres de los productos del negocio.
      body: JSON.stringify({ texto: texto, catalogo: catalogo.map(function (p) { return { id: p.id, nombre: p.nombre }; }) })
    });
    if (!r.ok) { throw fallo('http', 'n8n respondió ' + r.status); }
    crudo = await r.text();
  } catch (e) {
    if (e.motivo) { throw e; }
    throw fallo(e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'red', e.message);
  }
  if (crudo.length > MAX_RESPUESTA) { throw fallo('invalida', 'respuesta demasiado grande'); }
  let datos;
  try { datos = JSON.parse(crudo); } catch (e) { throw fallo('invalida', 'la respuesta no es JSON'); }
  return validar(datos, catalogo, texto);
}

// config: { url, secreto, timeoutMs, limiteDiario } o null para trabajar solo con reglas.
// opciones (para pruebas): fetch, ahora, avisar.
function crearIA(config, opciones) {
  const o = opciones || {};
  const fetchFn = o.fetch || fetch;
  const ahora = o.ahora || function () { return new Date(); };
  const avisar = o.avisar || console.warn;
  // shortcut: el conteo vive en la memoria de un proceso y se reinicia al reiniciar;
  // pasarlo a la base si hay varias instancias o si el límite debe sobrevivir a un reinicio.
  const usos = new Map();

  return {
    activa: Boolean(config),
    // Devuelve el mismo formato que interpretar() más `fuente` ('ia' | 'reglas') y, si se usó el
    // respaldo, `motivoRespaldo` ('limite' | 'timeout' | 'red' | 'http' | 'invalida').
    interpretar: async function (texto, catalogo, negocioId) {
      const reglas = function (motivo) {
        return Object.assign(interpretar(texto, catalogo), { fuente: 'reglas' }, motivo ? { motivoRespaldo: motivo } : {});
      };
      const frase = String(texto || '').trim();
      if (!config || !frase) { return reglas(); }

      const hoy = fechaLocal(ahora());
      const clave = negocioId + '|' + hoy;
      if ((usos.get(clave) || 0) >= config.limiteDiario) { return reglas('limite'); }
      usos.forEach(function (v, k) { if (k.slice(k.indexOf('|') + 1) !== hoy) { usos.delete(k); } });
      usos.set(clave, (usos.get(clave) || 0) + 1);

      try {
        const r = await consultar(config, fetchFn, frase, catalogo);
        r.fuente = 'ia';
        return r;
      } catch (e) {
        avisar('[ia] respaldo por reglas (' + (e.motivo || 'red') + '): ' + e.message);
        return reglas(e.motivo || 'red');
      }
    }
  };
}

// Lee la configuración de .env. Devuelve null si la IA está apagada; si está encendida y falta
// algo, falla al arrancar en lugar de apagarse en silencio.
function configDesdeEntorno(env) {
  if (env.STOCKVOZ_IA !== '1') { return null; }
  if (!env.N8N_URL || !env.N8N_SECRETO) { throw new Error('STOCKVOZ_IA=1 exige N8N_URL y N8N_SECRETO en .env.'); }
  if (env.N8N_SECRETO.length < 16) { throw new Error('N8N_SECRETO debe tener al menos 16 caracteres.'); }
  let url;
  try { url = new URL(env.N8N_URL); } catch (e) { throw new Error('N8N_URL no es una URL válida.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') { throw new Error('N8N_URL debe empezar con http:// o https://.'); }
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].indexOf(url.hostname) === -1) {
    console.warn('[ia] N8N_URL usa http:// hacia un equipo remoto: el secreto viajaría sin cifrar. Usa https://.');
  }
  return {
    url: url.href, secreto: env.N8N_SECRETO,
    timeoutMs: Number(env.N8N_TIMEOUT_MS) || 6000,
    limiteDiario: Number(env.STOCKVOZ_IA_LIMITE_DIARIO) || 500
  };
}

module.exports = { crearIA, configDesdeEntorno, validar };
