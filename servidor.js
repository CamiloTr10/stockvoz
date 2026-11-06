'use strict';
// Servidor de StockVoz: API JSON + archivos de la interfaz (carpeta public/).
// Uso: node servidor.js   (configuración en .env; ver .env.example)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
require('./src/entorno');

const db = require('./src/db');
const auth = require('./src/auth');
const inv = require('./src/inventario');
const { crearIA, configDesdeEntorno } = require('./src/ia');
const { crearVoz, configDesdeEntorno: configVozDesdeEntorno, MAX_AUDIO } = require('./src/voz');
const { sembrarSiVacia } = require('./src/demo');
const { ErrorApi } = require('./src/errores');

const VERSION = require('./package.json').version;
const PUBLICO = path.join(__dirname, 'public');
const MAX_CUERPO = 16 * 1024;
const COOKIE = 'sv_sesion';
const TIPOS_ARCHIVO = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const CABECERAS = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()'
};

// Detrás de un CDN o un balanceador (CloudFront, ALB) la IP del socket es la del proxy, no la
// del cliente. Solo se cree en X-Forwarded-For cuando STOCKVOZ_PROXIES_CONFIABLES dice cuántos
// saltos propios hay delante: cualquiera puede inventarse esa cabecera, así que creerle sin
// saber quién está delante sería peor que no usarla. El valor que importa es el que puso el
// proxy más cercano, así que se cuenta desde el final de la cadena hacia atrás.
function ipCliente(req, proxiesConfiables) {
  if (!proxiesConfiables) { return req.socket.remoteAddress; }
  const cadena = String(req.headers['x-forwarded-for'] || '')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const i = cadena.length - proxiesConfiables;
  return (i >= 0 && cadena[i]) || req.socket.remoteAddress;
}

function leerCookie(req) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  return m ? m[1] : null;
}

function cookieSesion(token, segura) {
  const base = COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Strict' + (segura ? '; Secure' : '');
  return token ? base + '; Max-Age=' + auth.DURACION_SESION_MS / 1000 : COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
}

function responder(res, estado, datos, extra) {
  res.writeHead(estado, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CABECERAS, extra));
  res.end(JSON.stringify(datos));
}

function leerCuerpo(req, maximo) {
  const tope = maximo || MAX_CUERPO;
  return new Promise(function (resolver, rechazar) {
    if (req.method === 'GET' || req.method === 'DELETE') { return resolver({}); }
    // Exigir JSON evita que un formulario de otro sitio dispare acciones (CSRF).
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
      return rechazar(new ErrorApi(415, 'El cuerpo debe enviarse como JSON.'));
    }
    let tam = 0;
    const partes = [];
    req.on('data', function (c) {
      tam += c.length;
      if (tam > tope) { rechazar(new ErrorApi(413, 'La petición es demasiado grande.')); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', function () {
      try {
        const datos = partes.length ? JSON.parse(Buffer.concat(partes).toString('utf8')) : {};
        resolver(datos && typeof datos === 'object' && !Array.isArray(datos) ? datos : {});
      } catch (e) { rechazar(new ErrorApi(400, 'El JSON enviado no es válido.')); }
    });
    req.on('error', rechazar);
  });
}

function estadoSesion(sesion) {
  return { usuario: sesion.usuario, negocios: sesion.negocios, negocio: sesion.negocio, rol: sesion.rol };
}

async function crearApp(opciones) {
  const base = await db.abrir(opciones.urlDb);
  const ahora = opciones.ahora || function () { return new Date(); };
  if (opciones.demo !== false) { await sembrarSiVacia(base, ahora()); }
  // La pantalla de ingreso muestra las cuentas de prueba solo si existen.
  const demo = opciones.demo !== false && Boolean(await db.uno(base, "SELECT 1 FROM usuarios WHERE correo = 'demo@stockvoz.test'"));
  const limitador = auth.crearLimitador();
  // Frena el probar códigos de invitación al azar (ver la ruta de aceptar).
  const limitadorCodigos = auth.crearLimitador();
  const ia = crearIA(opciones.ia, { fetch: opciones.fetchIA, avisar: opciones.avisarIA });
  const voz = crearVoz(opciones.voz, { fetch: opciones.fetchVoz });
  const proxies = Number(opciones.proxies) || 0;
  const segura = Boolean(opciones.cookieSegura);

  // Rutas: [método, patrón, requiere ('nada' | 'sesion' | 'negocio' | 'dueno'), manejador]
  const RUTAS = [
    ['GET', /^\/api\/config$/, 'nada', function () { return { demo: demo, voz: voz.activa }; }],
    // Lo consultan App Runner y los balanceadores de Amazon. Toca la base a propósito: una app
    // que responde pero no puede leer el inventario no está sana, y seguirían mandándole gente.
    ['GET', /^\/api\/salud$/, 'nada', async function () {
      await base.query('SELECT 1');
      return { estado: 'ok', version: VERSION };
    }],
    ['POST', /^\/api\/registro$/, 'nada', async function (c) {
      const r = await auth.registrar(base, c.cuerpo, ahora());
      const token = await auth.crearSesion(base, r.usuarioId, r.negocioId);
      c.cookie = cookieSesion(token, segura);
      c.estado = 201;
      return estadoSesion(await auth.leerSesion(base, token));
    }],
    ['POST', /^\/api\/sesion$/, 'nada', async function (c) {
      const clave = String(c.cuerpo.correo || '').toLowerCase() + '|' + c.ip;
      limitador.revisar(clave);
      let usuarioId;
      try { usuarioId = await auth.autenticar(base, c.cuerpo.correo, c.cuerpo.clave); }
      catch (e) { limitador.fallo(clave); throw e; }
      limitador.exito(clave);
      const negocios = await auth.negociosDe(base, usuarioId);
      const token = await auth.crearSesion(base, usuarioId, negocios.length === 1 ? negocios[0].id : null);
      c.cookie = cookieSesion(token, segura);
      return estadoSesion(await auth.leerSesion(base, token));
    }],
    ['GET', /^\/api\/sesion$/, 'sesion', function (c) { return estadoSesion(c.sesion); }],
    ['DELETE', /^\/api\/sesion$/, 'nada', async function (c) {
      await auth.cerrarSesion(base, c.token);
      c.cookie = cookieSesion(null, segura);
      return { ok: true };
    }],
    ['POST', /^\/api\/sesion\/negocio$/, 'sesion', async function (c) {
      await auth.elegirNegocio(base, c.sesion, Number(c.cuerpo.negocioId));
      return estadoSesion(await auth.leerSesion(base, c.token));
    }],
    ['POST', /^\/api\/invitaciones\/aceptar$/, 'sesion', async function (c) {
      // Se limita por usuario, no por IP: en un negocio todos salen a internet por la misma.
      const quien = String(c.sesion.usuario.id);
      limitadorCodigos.revisar(quien);
      let r;
      try { r = await auth.aceptarInvitacion(base, c.cuerpo.codigo, c.sesion.usuario.id, ahora()); }
      catch (e) { if (e.estado === 404) { limitadorCodigos.fallo(quien); } throw e; }
      limitadorCodigos.exito(quien);
      // Si no estaba trabajando en ningún negocio, queda en el que acaba de entrar.
      const sesion = await auth.leerSesion(base, c.token);
      if (!sesion.negocio) { await auth.elegirNegocio(base, sesion, r.negocioId); }
      return estadoSesion(await auth.leerSesion(base, c.token));
    }],
    ['GET', /^\/api\/equipo$/, 'dueno', function (c) { return auth.equipo(base, c.negocioId, ahora()); }],
    ['POST', /^\/api\/equipo\/invitaciones$/, 'dueno', function (c) {
      c.estado = 201;
      return auth.crearInvitacion(base, c.negocioId, c.sesion.usuario.id, c.cuerpo.rol, ahora());
    }],
    ['DELETE', /^\/api\/equipo\/invitaciones\/(\d+)$/, 'dueno', async function (c) {
      await auth.cancelarInvitacion(base, c.negocioId, Number(c.params[1]));
      return { ok: true };
    }],
    ['DELETE', /^\/api\/equipo\/miembros\/(\d+)$/, 'dueno', async function (c) {
      await auth.quitarMiembro(base, c.negocioId, Number(c.params[1]), c.sesion.usuario.id);
      return { ok: true };
    }],
    ['GET', /^\/api\/productos$/, 'negocio', function (c) {
      return inv.listarProductos(base, c.negocioId, c.url.searchParams.get('inactivos') === '1');
    }],
    ['POST', /^\/api\/productos$/, 'dueno', function (c) {
      c.estado = 201;
      return inv.crearProducto(base, c.negocioId, c.sesion.usuario.id, c.cuerpo);
    }],
    ['PATCH', /^\/api\/productos\/(\d+)$/, 'dueno', function (c) {
      return inv.actualizarProducto(base, c.negocioId, Number(c.params[1]), c.cuerpo);
    }],
    ['POST', /^\/api\/interpretar$/, 'negocio', async function (c) {
      const texto = typeof c.cuerpo.texto === 'string' ? c.cuerpo.texto.slice(0, 300) : '';
      const catalogo = await inv.listarProductos(base, c.negocioId, false);
      return ia.interpretar(texto, catalogo, c.negocioId);
    }],
    // El audio llega en base64 dentro del JSON y no como binario: así esta ruta conserva la
    // protección contra CSRF que da exigir application/json en todo lo demás.
    ['POST', /^\/api\/transcribir$/, 'negocio', function (c) {
      return voz.transcribir(c.cuerpo.audio, c.cuerpo.tipo, c.negocioId);
    }],
    ['POST', /^\/api\/movimientos$/, 'negocio', function (c) {
      c.estado = 201;
      return inv.registrarMovimiento(base, c.negocioId, c.sesion.usuario.id, Object.assign({}, c.cuerpo, { ahora: ahora() }));
    }],
    ['POST', /^\/api\/movimientos\/(\d+)\/anular$/, 'negocio', function (c) {
      return inv.anularMovimiento(base, c.negocioId, { id: c.sesion.usuario.id, rol: c.sesion.rol }, Number(c.params[1]), ahora());
    }],
    ['GET', /^\/api\/movimientos\.csv$/, 'negocio', function (c) {
      const dias = Math.min(Math.max(Number(c.url.searchParams.get('dias')) || 30, 1), 365);
      c.tipoContenido = 'text/csv; charset=utf-8';
      c.extra = { 'Content-Disposition': 'attachment; filename="stockvoz-movimientos-' + inv.fechaLocal(ahora()) + '.csv"' };
      return inv.movimientosCsv(base, c.negocioId, { tipo: c.url.searchParams.get('tipo'), desde: inv.diasAtras(ahora(), dias - 1) });
    }],
    ['GET', /^\/api\/movimientos$/, 'negocio', function (c) {
      return inv.listarMovimientos(base, c.negocioId, { tipo: c.url.searchParams.get('tipo'), limite: c.url.searchParams.get('limite') });
    }],
    ['GET', /^\/api\/panel$/, 'negocio', function (c) { return inv.panel(base, c.negocioId, ahora()); }],
    ['GET', /^\/api\/reportes$/, 'negocio', function (c) {
      return inv.reporte(base, c.negocioId, ahora(), Number(c.url.searchParams.get('dias')));
    }]
  ];

  async function manejarApi(req, res, url) {
    const candidatas = RUTAS.filter(function (r) { return r[1].test(url.pathname); });
    const ruta = candidatas.find(function (r) { return r[0] === req.method; });
    if (!ruta) {
      throw new ErrorApi(candidatas.length ? 405 : 404, candidatas.length ? 'Método no permitido.' : 'Ruta no encontrada.');
    }
    const c = { url: url, params: ruta[1].exec(url.pathname), token: leerCookie(req), ip: ipCliente(req, proxies), estado: 200, cookie: null };
    // El audio necesita un cuerpo mucho mayor: base64 lo engorda una tercera parte.
    c.cuerpo = await leerCuerpo(req, url.pathname === '/api/transcribir' ? Math.ceil(MAX_AUDIO * 4 / 3) + 1024 : MAX_CUERPO);
    if (ruta[2] !== 'nada') {
      c.sesion = await auth.leerSesion(base, c.token);
      if (!c.sesion) { throw new ErrorApi(401, 'Tu sesión terminó. Vuelve a ingresar.'); }
      if (ruta[2] !== 'sesion') {
        if (!c.sesion.negocio) { throw new ErrorApi(409, 'Primero elige un negocio.'); }
        if (ruta[2] === 'dueno' && c.sesion.rol !== 'dueno') { throw new ErrorApi(403, 'Solo el dueño del negocio puede hacer esto.'); }
        c.negocioId = c.sesion.negocio.id;
      }
    }
    const datos = await ruta[3](c);
    // Una ruta puede responder algo que no es JSON (por ejemplo el CSV) fijando c.tipoContenido.
    if (c.tipoContenido) {
      res.writeHead(c.estado, Object.assign({ 'Content-Type': c.tipoContenido, 'Cache-Control': 'no-store' }, CABECERAS, c.extra || {}));
      return res.end(datos);
    }
    responder(res, c.estado, datos, c.cookie ? { 'Set-Cookie': c.cookie } : null);
  }

  function servirArchivo(res, url) {
    let ruta;
    try { ruta = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400, CABECERAS); return res.end(); }
    const archivo = path.join(PUBLICO, path.normalize(ruta === '/' ? 'index.html' : ruta.slice(1)));
    if (!archivo.startsWith(PUBLICO + path.sep)) { res.writeHead(403, CABECERAS); return res.end(); }
    fs.readFile(archivo, function (err, datos) {
      if (err) { res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, CABECERAS)); return res.end('No encontrado'); }
      res.writeHead(200, Object.assign({ 'Content-Type': TIPOS_ARCHIVO[path.extname(archivo)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }, CABECERAS));
      res.end(datos);
    });
  }

  const servidor = http.createServer(function (req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end(); }
    if (!url.pathname.startsWith('/api/')) { return servirArchivo(res, url); }
    manejarApi(req, res, url).catch(function (e) {
      if (e instanceof ErrorApi) { return responder(res, e.estado, { error: e.message }); }
      console.error(e);
      responder(res, 500, { error: 'Ocurrió un error inesperado. Inténtalo de nuevo.' });
    });
  });
  servidor.on('close', function () { base.end(); });
  return servidor;
}

if (require.main === module) {
  const puerto = Number(process.env.PORT) || 3000;
  // En producción (HTTPS) usar STOCKVOZ_COOKIE_SEGURA=1 para que la cookie solo viaje cifrada.
  const demo = process.env.STOCKVOZ_DEMO !== '0';
  const cookieSegura = process.env.STOCKVOZ_COOKIE_SEGURA === '1';
  const pareceProduccion = cookieSegura || process.env.NODE_ENV === 'production';
  // Las cuentas de demostración usan una clave que está publicada en el README. En local son
  // comodísimas; en internet son una puerta abierta. Mejor no arrancar que arrancar inseguro.
  if (demo && pareceProduccion) {
    console.error('No se pudo iniciar StockVoz: esto parece un despliegue público y STOCKVOZ_DEMO sigue encendida.\n' +
      'Las cuentas de demostración usan una clave publicada en el README: cualquiera podría entrar.\n' +
      'Pon STOCKVOZ_DEMO=0 para publicar, o quita STOCKVOZ_COOKIE_SEGURA/NODE_ENV si esto es desarrollo local.');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production' && !cookieSegura) {
    console.warn('[aviso] NODE_ENV=production sin STOCKVOZ_COOKIE_SEGURA=1: la cookie de sesión podría viajar sin cifrar.');
  }

  let configIA = null;
  let configVoz = null;
  try {
    configIA = configDesdeEntorno(process.env);
    configVoz = configVozDesdeEntorno(process.env);
  } catch (e) { console.error('No se pudo iniciar StockVoz: ' + e.message); process.exit(1); }
  crearApp({ urlDb: process.env.DATABASE_URL, demo: demo, cookieSegura: cookieSegura, ia: configIA, voz: configVoz, proxies: process.env.STOCKVOZ_PROXIES_CONFIABLES })
    .then(function (servidor) {
      // Al desplegar, Amazon manda SIGTERM y espera. Sin esto se cortan peticiones a medias y
      // la conexión a la base queda colgada; servidor.close() también cierra el pool.
      ['SIGTERM', 'SIGINT'].forEach(function (senal) {
        process.once(senal, function () {
          console.log('Cerrando StockVoz…');
          servidor.close(function () { process.exit(0); });
          // Si una petición se queda colgada, no bloquear el despliegue para siempre.
          setTimeout(function () { process.exit(0); }, 10000).unref();
        });
      });
      servidor.listen(puerto, function () {
        console.log('StockVoz escuchando en http://localhost:' + puerto +
          (configIA ? ' (IA activa vía ' + configIA.modo + ')' : ' (interpretación solo por reglas)') +
          (configVoz ? ' · voz por ' + configVoz.modelo : ' · voz por el navegador'));
      });
    })
    .catch(function (e) {
      console.error('No se pudo iniciar StockVoz: ' + e.message);
      process.exit(1);
    });
}

module.exports = { crearApp, ipCliente };
