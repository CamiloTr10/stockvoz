'use strict';
// Transcripción por voz: se le pasa un fetch falso para no llamar al proveedor de verdad.
// Lo que se vigila es que el audio del tendero no se le mande a nadie sin control, que los
// errores del proveedor no tumben la app y que siempre quede la salida de escribir a mano.

const test = require('node:test');
const assert = require('node:assert');
const { crearVoz, configDesdeEntorno, MAX_AUDIO } = require('../src/voz');

const CLAVE = 'gsk-clave-de-prueba';
const CONFIG = { url: 'https://proveedor.test/v1/audio', clave: CLAVE, modelo: 'whisper-de-prueba', idioma: 'es', timeoutMs: 1000, limiteDiario: 3 };
const AUDIO = Buffer.from('finge que esto es un webm').toString('base64');

// Guarda lo que se le mandó al proveedor y responde lo que le digan.
function proveedor(respuesta, estado) {
  const llamadas = [];
  const fn = async function (url, opciones) {
    llamadas.push({ url: url, opciones: opciones });
    if (typeof respuesta === 'function') { return respuesta(); }
    return new Response(typeof respuesta === 'string' ? respuesta : JSON.stringify(respuesta), { status: estado || 200 });
  };
  fn.llamadas = llamadas;
  return fn;
}

function voz(fetchFn, extra) {
  return crearVoz(Object.assign({}, CONFIG, extra), { fetch: fetchFn });
}

async function falla(promesa, estado, trozoDelMensaje) {
  try {
    await promesa;
    assert.fail('se esperaba un error ' + estado);
  } catch (e) {
    assert.strictEqual(e.estado, estado, e.message);
    if (trozoDelMensaje) { assert.ok(e.message.includes(trozoDelMensaje), e.message); }
    return e;
  }
}

test('transcribe y devuelve el texto', async function () {
  const f = proveedor({ text: '  vendí 3 gaseosas  ' });
  const r = await voz(f).transcribir(AUDIO, 'audio/webm', 1);
  assert.deepStrictEqual(r, { texto: 'vendí 3 gaseosas' });
  assert.strictEqual(f.llamadas.length, 1);
});

test('le manda al proveedor la clave, el modelo y el idioma, y nada más del negocio', async function () {
  const f = proveedor({ text: 'hola' });
  await voz(f).transcribir(AUDIO, 'audio/webm', 7);
  const o = f.llamadas[0].opciones;
  assert.strictEqual(o.headers.authorization, 'Bearer ' + CLAVE);
  assert.strictEqual(o.redirect, 'error', 'la clave no debe seguir una redirección a otro sitio');
  assert.strictEqual(o.body.get('model'), 'whisper-de-prueba');
  assert.strictEqual(o.body.get('language'), 'es');
  // Lo único que viaja es el audio: ni el id del negocio ni nada del inventario.
  assert.strictEqual(f.llamadas[0].opciones.body.get('negocioId'), null);
  assert.ok(o.body.get('file'), 'debe ir el archivo de audio');
});

test('el nombre del archivo lleva la extensión del formato, que algunos proveedores miran', async function () {
  const f = proveedor({ text: 'hola' });
  await voz(f).transcribir(AUDIO, 'audio/ogg; codecs=opus', 1);
  assert.strictEqual(f.llamadas[0].opciones.body.get('file').name, 'audio.ogg');
});

test('rechaza un formato que no es audio de navegador', async function () {
  const f = proveedor({ text: 'hola' });
  await falla(voz(f).transcribir(AUDIO, 'application/zip', 1), 415);
  assert.strictEqual(f.llamadas.length, 0, 'no debe llamarse al proveedor');
});

test('rechaza audio vacío o ilegible', async function () {
  const f = proveedor({ text: 'hola' });
  await falla(voz(f).transcribir('', 'audio/webm', 1), 400);
  await falla(voz(f).transcribir(null, 'audio/webm', 1), 400);
  assert.strictEqual(f.llamadas.length, 0);
});

test('rechaza una grabación demasiado larga antes de gastar cuota', async function () {
  const f = proveedor({ text: 'hola' });
  const enorme = Buffer.alloc(MAX_AUDIO + 1).toString('base64');
  await falla(voz(f).transcribir(enorme, 'audio/webm', 1), 413);
  assert.strictEqual(f.llamadas.length, 0, 'no debe llamarse al proveedor');
});

test('el límite diario es por negocio y cada negocio tiene el suyo', async function () {
  const f = proveedor({ text: 'hola' });
  const v = voz(f);
  for (let i = 0; i < 3; i++) { await v.transcribir(AUDIO, 'audio/webm', 1); }
  await falla(v.transcribir(AUDIO, 'audio/webm', 1), 429, 'Escribe la instrucción a mano');
  await v.transcribir(AUDIO, 'audio/webm', 2);   // otro negocio tiene su propio conteo
  assert.strictEqual(f.llamadas.length, 4);
});

test('el conteo diario se reinicia al cambiar el día', async function () {
  const f = proveedor({ text: 'hola' });
  let dia = new Date('2026-11-05T10:00:00');
  const v = crearVoz(CONFIG, { fetch: f, ahora: function () { return dia; } });
  for (let i = 0; i < 3; i++) { await v.transcribir(AUDIO, 'audio/webm', 1); }
  await falla(v.transcribir(AUDIO, 'audio/webm', 1), 429);
  dia = new Date('2026-11-06T10:00:00');
  await v.transcribir(AUDIO, 'audio/webm', 1);
  assert.strictEqual(f.llamadas.length, 4);
});

test('los errores del proveedor no tumban la app y dicen qué hacer', async function () {
  const casos = [
    [proveedor({ error: 'sin cuota' }, 429), 429, 'Escribe la instrucción a mano'],
    [proveedor({ error: 'clave mala' }, 401), 502, 'Escribe la instrucción a mano'],
    [proveedor('esto no es json'), 502, 'no se entiende'],
    [proveedor(function () { throw Object.assign(new Error('tardó'), { name: 'TimeoutError' }); }), 504, 'tardó demasiado'],
    [proveedor(function () { throw new Error('ECONNREFUSED'); }), 504, 'No se pudo contactar']
  ];
  for (const [f, estado, trozo] of casos) {
    await falla(voz(f).transcribir(AUDIO, 'audio/webm', 1), estado, trozo);
  }
});

test('el texto se recorta a lo que acepta /api/interpretar', async function () {
  const f = proveedor({ text: 'a'.repeat(500) });
  const r = await voz(f).transcribir(AUDIO, 'audio/webm', 1);
  assert.strictEqual(r.texto.length, 300);
});

test('apagada: responde 503 en vez de romperse', async function () {
  const v = crearVoz(null, {});
  assert.strictEqual(v.activa, false);
  await falla(v.transcribir(AUDIO, 'audio/webm', 1), 503, 'no está activada');
});

test('configDesdeEntorno: apagada por defecto y reutiliza la clave de la IA', function () {
  assert.strictEqual(configDesdeEntorno({}), null);
  assert.strictEqual(configDesdeEntorno({ STOCKVOZ_VOZ: '0', IA_CLAVE: 'x' }), null);
  assert.throws(function () { configDesdeEntorno({ STOCKVOZ_VOZ: '1' }); }, /IA_CLAVE/);
  const c = configDesdeEntorno({ STOCKVOZ_VOZ: '1', IA_CLAVE: 'clave-de-la-ia' });
  assert.strictEqual(c.clave, 'clave-de-la-ia');
  assert.strictEqual(c.modelo, 'whisper-large-v3-turbo');
  assert.strictEqual(c.idioma, 'es');
  // VOZ_CLAVE permite usar otra cuenta distinta a la de la interpretación.
  assert.strictEqual(configDesdeEntorno({ STOCKVOZ_VOZ: '1', IA_CLAVE: 'a', VOZ_CLAVE: 'b' }).clave, 'b');
});
