'use strict';
// Transcribe el audio del tendero con Whisper, en un proveedor compatible con OpenAI (Groq).
//
// A diferencia de la interpretación, esto NO pasa por n8n. Es una decisión consciente: n8n es el
// orquestador de la interpretación, que es la parte con reglas y validación; transcribir es una
// sola llamada sin lógica. Metiéndola por n8n, una caída del contenedor dejaría a la app sin voz
// Y sin interpretación a la vez, y el día de la sustentación eso es una pieza más que puede
// fallar. Si alguna vez hace falta, el cambio es el mismo patrón de src/ia.js.
//
// El navegador manda el audio en base64 dentro del JSON, no como binario: así la ruta conserva la
// misma protección contra CSRF que el resto de la API (solo se acepta application/json).

const { ErrorApi } = require('./errores');

const MODELO_POR_DEFECTO = 'whisper-large-v3-turbo';
const URL_POR_DEFECTO = 'https://api.groq.com/openai/v1/audio/transcriptions';
// Un dictado de mostrador dura segundos. Con 1,5 MB caben varios minutos en opus, de sobra,
// y evita que alguien suba un archivo grande para gastarnos la cuota.
const MAX_AUDIO = 1536 * 1024;
// Formatos que graban los navegadores. El nombre del archivo que se le manda al proveedor sale
// de aquí, porque algunos deducen el formato por la extensión.
const FORMATOS = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav'
};

function fechaLocal(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// Devuelve null si la transcripción está apagada; si está encendida y falta algo, falla al
// arrancar en lugar de apagarse en silencio.
function configDesdeEntorno(env) {
  if (!env.STOCKVOZ_VOZ || env.STOCKVOZ_VOZ === '0') { return null; }
  const clave = env.VOZ_CLAVE || env.IA_CLAVE;
  if (!clave) { throw new Error('STOCKVOZ_VOZ=1 exige IA_CLAVE (o VOZ_CLAVE) en .env.'); }
  return {
    url: env.VOZ_URL || URL_POR_DEFECTO,
    clave: clave,
    modelo: env.VOZ_MODELO || MODELO_POR_DEFECTO,
    idioma: env.VOZ_IDIOMA || 'es',
    timeoutMs: Number(env.VOZ_TIMEOUT_MS) || 20000,
    limiteDiario: Number(env.STOCKVOZ_VOZ_LIMITE_DIARIO) || 200
  };
}

// opciones (para pruebas): fetch, ahora.
function crearVoz(config, opciones) {
  const o = opciones || {};
  const fetchFn = o.fetch || fetch;
  const ahora = o.ahora || function () { return new Date(); };
  // shortcut: el conteo vive en la memoria de un proceso y se reinicia al reiniciar; pasarlo a
  // la base si hay varias instancias. Es el mismo atajo que en src/ia.js.
  const usos = new Map();

  return {
    activa: Boolean(config),
    modelo: config ? config.modelo : null,

    // audioBase64: el audio tal cual lo grabó el navegador, en base64.
    // tipo: su content-type ('audio/webm'…). Devuelve { texto }.
    transcribir: async function (audioBase64, tipo, negocioId) {
      if (!config) { throw new ErrorApi(503, 'La transcripción por voz no está activada.'); }
      const extension = FORMATOS[String(tipo || '').split(';')[0].trim()];
      if (!extension) { throw new ErrorApi(415, 'Formato de audio no admitido.'); }
      if (typeof audioBase64 !== 'string' || !audioBase64) { throw new ErrorApi(400, 'No llegó el audio.'); }

      let bytes;
      try { bytes = Buffer.from(audioBase64, 'base64'); } catch (e) { bytes = null; }
      if (!bytes || !bytes.length) { throw new ErrorApi(400, 'El audio no se pudo leer.'); }
      if (bytes.length > MAX_AUDIO) { throw new ErrorApi(413, 'La grabación es demasiado larga.'); }

      const hoy = fechaLocal(ahora());
      const clave = negocioId + '|' + hoy;
      usos.forEach(function (v, k) { if (k.slice(k.indexOf('|') + 1) !== hoy) { usos.delete(k); } });
      if ((usos.get(clave) || 0) >= config.limiteDiario) {
        throw new ErrorApi(429, 'Este negocio ya usó sus transcripciones de hoy. Escribe la instrucción a mano.');
      }
      usos.set(clave, (usos.get(clave) || 0) + 1);

      const form = new FormData();
      form.append('file', new Blob([bytes], { type: tipo }), 'audio.' + extension);
      form.append('model', config.modelo);
      form.append('language', config.idioma);
      form.append('response_format', 'json');
      // Le da contexto al modelo sobre de qué se habla, que es lo que más ayuda con los nombres
      // de productos y las cantidades.
      form.append('prompt', 'Inventario de una tienda de barrio en Colombia: ventas, entradas y mermas de productos.');

      let r;
      try {
        r = await fetchFn(config.url, {
          method: 'POST',
          redirect: 'error',                 // la clave no debe seguir una redirección a otro sitio
          signal: AbortSignal.timeout(config.timeoutMs),
          headers: { authorization: 'Bearer ' + config.clave },
          body: form
        });
      } catch (e) {
        const lento = e.name === 'TimeoutError' || e.name === 'AbortError';
        throw new ErrorApi(504, lento ? 'La transcripción tardó demasiado. Escribe la instrucción a mano.'
          : 'No se pudo contactar al servicio de voz. Escribe la instrucción a mano.');
      }

      const crudo = await r.text();
      if (!r.ok) {
        throw new ErrorApi(r.status === 429 ? 429 : 502,
          r.status === 429 ? 'El servicio de voz llegó a su cuota. Escribe la instrucción a mano.'
            : 'El servicio de voz respondió un error. Escribe la instrucción a mano.');
      }
      let datos;
      try { datos = JSON.parse(crudo); } catch (e) { throw new ErrorApi(502, 'El servicio de voz respondió algo que no se entiende.'); }
      const texto = typeof datos.text === 'string' ? datos.text.trim() : '';
      // Se recorta a lo mismo que acepta /api/interpretar, para que no haya sorpresas después.
      return { texto: texto.slice(0, 300) };
    }
  };
}

module.exports = { crearVoz, configDesdeEntorno, MAX_AUDIO, MODELO_POR_DEFECTO, URL_POR_DEFECTO };
