'use strict';
// Interpretación con IA, con el intérprete por reglas como respaldo. Dos modos:
//   n8n      la frase va al flujo de n8n, que llama al modelo (la arquitectura del proyecto)
//   directo  la frase va a una API compatible con OpenAI (Groq, DeepSeek…), sin n8n de por medio
// El modo directo existe para medir modelos con `npm run evaluar -- --ia` sin montar n8n, y como
// respaldo si n8n no está disponible el día de una demostración.
//
// El backend no confía en la IA: valida su respuesta contra el catálogo del negocio y, si algo
// falla (caído, lento, respuesta rara, producto ajeno), responde con las reglas. La IA solo
// propone; quien guarda es POST /api/movimientos, después de que el usuario confirma.
// El formato de la petición y de la respuesta está en docs/contrato-n8n.md.
const { interpretar, MAX_OPERACIONES } = require('./interprete');
const { fechaLocal, MAX_CANTIDAD } = require('./inventario');
const instruccionesIA = require('./ia-instrucciones');

const OPERACIONES = ['venta', 'entrada', 'merma'];
const MAX_RESPUESTA = 16 * 1024;
const MAX_CANDIDATOS = 5;

function fallo(motivo, mensaje) {
  const e = new Error(mensaje);
  e.motivo = motivo;
  return e;
}

// El estado es un resumen de los otros campos, así que lo calcula el backend en vez de pedírselo
// al modelo: midiendo se vio que a veces los datos venían bien y la etiqueta mal ("vendí arroz"
// llegaba como ok y sin cantidad, cuando eso es sin_cantidad).
function estadoSegunCampos(tipo, producto, cantidad, candidatos) {
  if (tipo === null) { return 'no_entendido'; }
  if (tipo === 'consulta') { return producto ? 'consulta' : 'sin_producto'; }
  if (producto === null) { return candidatos.length >= 2 ? 'ambiguo' : 'sin_producto'; }
  return cantidad === null ? 'sin_cantidad' : 'ok';
}

// Valida UNA operación de la lista. `buscar` solo encuentra productos del catálogo que se envió,
// así que una operación nunca puede nombrar un producto de otro negocio.
function validarOperacion(d, buscar, invalida) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) { throw invalida('la operación no es un objeto'); }
  const tipo = d.tipo === undefined ? null : d.tipo;
  if (tipo !== null && tipo !== 'consulta' && OPERACIONES.indexOf(tipo) === -1) { throw invalida('tipo desconocido'); }
  const cantidad = d.cantidad === undefined ? null : d.cantidad;
  if (cantidad !== null && (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_CANTIDAD)) { throw invalida('cantidad fuera de rango'); }
  const producto = d.productoId === undefined || d.productoId === null ? null : buscar(d.productoId);
  const ids = d.candidatosIds === undefined ? [] : d.candidatosIds;
  if (!Array.isArray(ids) || ids.length > MAX_CANDIDATOS || new Set(ids).size !== ids.length) { throw invalida('candidatos inválidos'); }
  const candidatos = ids.map(buscar);

  const estado = estadoSegunCampos(tipo, producto, cantidad, candidatos);
  return {
    estado: estado,
    tipo: tipo,
    // En consulta y no_entendido la cantidad no significa nada: se descarta para no confundir.
    cantidad: estado === 'consulta' || estado === 'no_entendido' ? null : cantidad,
    producto: producto,
    candidatos: candidatos,
    busqueda: typeof d.busqueda === 'string' ? d.busqueda.trim().slice(0, 120) : ''
  };
}

// Convierte la respuesta del modelo en el mismo formato que devuelve interpretar(), o lanza
// un error 'invalida' si no es una respuesta que el backend acepte.
function validar(d, catalogo, texto) {
  const invalida = function (m) { return fallo('invalida', m); };
  if (!d || typeof d !== 'object' || Array.isArray(d)) { throw invalida('la respuesta no es un objeto'); }
  // Se exige la lista para no tragarse una respuesta vacía como si fuera "no entendí".
  if (!Array.isArray(d.operaciones)) { throw invalida('falta la lista de operaciones'); }
  if (d.operaciones.length > MAX_OPERACIONES) { throw invalida('demasiadas operaciones'); }

  const porId = new Map(catalogo.map(function (p) { return [p.id, p]; }));
  const buscar = function (id) {
    const p = porId.get(id);
    if (!p) { throw invalida('producto que no está en el catálogo'); }
    return p;
  };

  const operaciones = d.operaciones
    .map(function (o) { return validarOperacion(o, buscar, invalida); })
    // Una operación sin tipo no se puede ni mostrar ni guardar: solo estorbaría en la pantalla.
    .filter(function (o) { return o.estado !== 'no_entendido'; });

  const resultado = { operaciones: operaciones, texto: texto };
  const uso = d.uso;
  if (uso && Number.isInteger(uso.entrada) && Number.isInteger(uso.salida) && uso.entrada >= 0 && uso.salida >= 0) {
    resultado.uso = { entrada: uso.entrada, salida: uso.salida };
  }
  return resultado;
}

async function consultarN8n(config, fetchFn, texto, catalogo) {
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
    // El flujo responde 429 cuando el que se quedó sin cuota fue el proveedor, igual que el modo
    // directo. Sin eso, gastar la cuota y un error de n8n se registran igual y se busca mal.
    if (!r.ok) { throw fallo(r.status === 429 ? 'cuota' : 'http', 'n8n respondió ' + r.status); }
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

// Llama a una API compatible con OpenAI (Groq, DeepSeek…) y traduce su respuesta al mismo formato.
async function consultarDirecto(config, fetchFn, texto, catalogo) {
  let r;
  try {
    r = await fetchFn(config.url, {
      method: 'POST',
      redirect: 'error',                      // la clave no debe seguir una redirección a otro sitio
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.clave },
      // Al modelo solo le llegan la frase y los id y nombres de los productos del negocio.
      body: JSON.stringify(instruccionesIA.cuerpoPeticion({
        modelo: config.modelo, texto: texto, estricto: config.esquemaEstricto, esfuerzo: config.esfuerzo,
        catalogo: catalogo.map(function (p) { return { id: p.id, nombre: p.nombre }; })
      }))
    });
  } catch (e) {
    throw fallo(e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'red', e.message);
  }
  const crudo = await r.text();
  if (!r.ok) {
    // 429 es haber gastado la cuota del proveedor; conviene distinguirlo de un error suyo.
    throw fallo(r.status === 429 ? 'cuota' : 'http', 'el modelo respondió ' + r.status + ': ' + crudo.slice(0, 200));
  }
  if (crudo.length > MAX_RESPUESTA) { throw fallo('invalida', 'respuesta demasiado grande'); }
  let sobre;
  try { sobre = JSON.parse(crudo); } catch (e) { throw fallo('invalida', 'la respuesta no es JSON'); }
  const eleccion = sobre.choices && sobre.choices[0];
  if (!eleccion) { throw fallo('invalida', 'la respuesta no trae ninguna opción'); }
  if (eleccion.finish_reason === 'length') { throw fallo('invalida', 'el modelo se quedó sin tokens antes de terminar'); }
  const contenido = eleccion.message && typeof eleccion.message.content === 'string' ? eleccion.message.content.trim() : '';
  if (!contenido) { throw fallo('invalida', 'el modelo no devolvió contenido'); }
  let datos;
  try { datos = JSON.parse(contenido); } catch (e) { throw fallo('invalida', 'lo que respondió el modelo no es JSON'); }

  const resultado = validar(datos, catalogo, texto);
  const uso = sobre.usage;
  if (uso && Number.isInteger(uso.prompt_tokens) && Number.isInteger(uso.completion_tokens)) {
    resultado.uso = { entrada: uso.prompt_tokens, salida: uso.completion_tokens };
  }
  return resultado;
}

// config: lo que devuelve configDesdeEntorno, o null para trabajar solo con reglas.
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
    // respaldo, `motivoRespaldo` ('limite' | 'cuota' | 'timeout' | 'red' | 'http' | 'invalida').
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
        const consultar = config.modo === 'directo' ? consultarDirecto : consultarN8n;
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
function urlValida(valor, nombre, avisarSiNoCifrada) {
  let url;
  try { url = new URL(valor); } catch (e) { throw new Error(nombre + ' no es una URL válida.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') { throw new Error(nombre + ' debe empezar con http:// o https://.'); }
  if (avisarSiNoCifrada && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].indexOf(url.hostname) === -1) {
    console.warn('[ia] ' + nombre + ' usa http:// hacia un equipo remoto: el secreto viajaría sin cifrar. Usa https://.');
  }
  return url.href;
}

function configDesdeEntorno(env) {
  // '1' se sigue aceptando como sinónimo de 'n8n' para no romper los .env que ya existen.
  const modo = env.STOCKVOZ_IA === '1' ? 'n8n' : env.STOCKVOZ_IA;
  if (!modo || modo === '0') { return null; }
  if (modo !== 'n8n' && modo !== 'directo') { throw new Error("STOCKVOZ_IA debe ser 0, n8n o directo."); }

  const comun = {
    modo: modo,
    timeoutMs: Number(env.N8N_TIMEOUT_MS) || 6000,
    limiteDiario: Number(env.STOCKVOZ_IA_LIMITE_DIARIO) || 500
  };

  if (modo === 'n8n') {
    if (!env.N8N_URL || !env.N8N_SECRETO) { throw new Error('STOCKVOZ_IA=n8n exige N8N_URL y N8N_SECRETO en .env.'); }
    if (env.N8N_SECRETO.length < 16) { throw new Error('N8N_SECRETO debe tener al menos 16 caracteres.'); }
    return Object.assign(comun, { url: urlValida(env.N8N_URL, 'N8N_URL', true), secreto: env.N8N_SECRETO });
  }

  if (!env.IA_CLAVE) { throw new Error('STOCKVOZ_IA=directo exige IA_CLAVE en .env (la clave de tu proveedor).'); }
  return Object.assign(comun, {
    url: urlValida(env.IA_URL || instruccionesIA.URL_POR_DEFECTO, 'IA_URL', false),
    clave: env.IA_CLAVE,
    modelo: env.IA_MODELO || instruccionesIA.MODELO_POR_DEFECTO,
    esquemaEstricto: env.IA_ESQUEMA_ESTRICTO !== '0',
    esfuerzo: env.IA_ESFUERZO || null
  });
}

module.exports = { crearIA, configDesdeEntorno, validar };
