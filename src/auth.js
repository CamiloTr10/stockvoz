'use strict';
// Cuentas, contraseñas y sesiones. Cada sesión queda atada a un negocio (tenant) y todas las
// consultas de inventario usan ese negocio, nunca uno que venga en la petición.
const crypto = require('node:crypto');
const { uno, todos, transaccion, esDuplicado } = require('./db');
const { ErrorApi } = require('./errores');

const DURACION_SESION_MS = 8 * 60 * 60 * 1000;
const MAX_FALLOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;
const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function hashClave(clave) {
  const sal = crypto.randomBytes(16);
  return 'scrypt$' + sal.toString('hex') + '$' + crypto.scryptSync(clave, sal, 64).toString('hex');
}

function verificarClave(clave, guardado) {
  const partes = guardado.split('$');
  const esperado = Buffer.from(partes[2], 'hex');
  const real = crypto.scryptSync(clave, Buffer.from(partes[1], 'hex'), 64);
  return crypto.timingSafeEqual(real, esperado);
}

// Se compara contra este hash cuando el correo no existe, para que la respuesta tarde
// lo mismo y no revele qué correos están registrados.
const HASH_FALSO = hashClave(crypto.randomBytes(12).toString('hex'));

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function texto(valor, campo, min, max) {
  const v = typeof valor === 'string' ? valor.trim() : '';
  if (v.length < min || v.length > max) {
    throw new ErrorApi(400, campo + ' debe tener entre ' + min + ' y ' + max + ' caracteres.');
  }
  return v;
}

function validarCorreo(valor) {
  const correo = texto(valor, 'El correo', 5, 120).toLowerCase();
  if (!CORREO.test(correo)) { throw new ErrorApi(400, 'Escribe un correo válido.'); }
  return correo;
}

async function crearSesion(db, usuarioId, negocioId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query('DELETE FROM sesiones WHERE expira_en < $1', [Date.now()]);
  await db.query('INSERT INTO sesiones (token_hash, usuario_id, negocio_id, expira_en) VALUES ($1, $2, $3, $4)',
    [hashToken(token), usuarioId, negocioId || null, Date.now() + DURACION_SESION_MS]);
  return token;
}

function negociosDe(db, usuarioId) {
  return todos(db, 'SELECT n.id, n.nombre, m.rol FROM membresias m JOIN negocios n ON n.id = m.negocio_id WHERE m.usuario_id = $1 ORDER BY lower(n.nombre), n.id',
    [usuarioId]);
}

// Devuelve { usuario, negocios, negocio, rol, tokenHash } o null si la sesión no vale.
async function leerSesion(db, token) {
  if (!token) { return null; }
  const fila = await uno(db, 'SELECT s.token_hash, s.negocio_id, s.expira_en, u.id, u.nombre, u.correo FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token_hash = $1',
    [hashToken(token)]);
  if (!fila || fila.expira_en < Date.now()) { return null; }
  const negocios = await negociosDe(db, fila.id);
  // Si le quitaron el acceso al negocio, la sesión vuelve a pedir que elija uno.
  const actual = negocios.find(function (n) { return n.id === fila.negocio_id; }) || null;
  return {
    tokenHash: fila.token_hash,
    usuario: { id: fila.id, nombre: fila.nombre, correo: fila.correo },
    negocios: negocios,
    negocio: actual ? { id: actual.id, nombre: actual.nombre } : null,
    rol: actual ? actual.rol : null
  };
}

async function cerrarSesion(db, token) {
  if (token) { await db.query('DELETE FROM sesiones WHERE token_hash = $1', [hashToken(token)]); }
}

async function elegirNegocio(db, sesion, negocioId) {
  const existe = sesion.negocios.some(function (n) { return n.id === negocioId; });
  if (!existe) { throw new ErrorApi(403, 'No tienes acceso a ese negocio.'); }
  await db.query('UPDATE sesiones SET negocio_id = $1 WHERE token_hash = $2', [negocioId, sesion.tokenHash]);
}

// Crea negocio + usuario dueño en una sola transacción.
async function registrar(db, datos) {
  const negocio = texto(datos.negocio, 'El nombre del negocio', 2, 80);
  const nombre = texto(datos.nombre, 'Tu nombre', 2, 80);
  const correo = validarCorreo(datos.correo);
  const clave = typeof datos.clave === 'string' ? datos.clave : '';
  if (clave.length < 8 || clave.length > 200) { throw new ErrorApi(400, 'La contraseña debe tener al menos 8 caracteres.'); }
  const yaExiste = new ErrorApi(409, 'Ya existe una cuenta con ese correo.');
  if (await uno(db, 'SELECT 1 FROM usuarios WHERE correo = $1', [correo])) { throw yaExiste; }
  const ahora = new Date();
  try {
    return await transaccion(db, async function (t) {
      const negocioId = (await uno(t, 'INSERT INTO negocios (nombre, creado_en) VALUES ($1, $2) RETURNING id', [negocio, ahora])).id;
      const usuarioId = (await uno(t, 'INSERT INTO usuarios (nombre, correo, clave_hash, creado_en) VALUES ($1, $2, $3, $4) RETURNING id',
        [nombre, correo, hashClave(clave), ahora])).id;
      await t.query('INSERT INTO membresias (usuario_id, negocio_id, rol) VALUES ($1, $2, $3)', [usuarioId, negocioId, 'dueno']);
      return { usuarioId: usuarioId, negocioId: negocioId };
    });
  } catch (e) {
    // Dos registros simultáneos con el mismo correo: la base rechaza el segundo.
    throw esDuplicado(e) ? yaExiste : e;
  }
}

// Limita intentos fallidos por correo + IP para frenar ataques de fuerza bruta.
// shortcut: vive en memoria de un solo proceso; pasarlo a la base o a Redis si hay varias instancias.
function crearLimitador() {
  const fallos = new Map();
  return {
    revisar: function (clave) {
      const r = fallos.get(clave);
      if (r && r.hasta > Date.now()) {
        throw new ErrorApi(429, 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
      }
    },
    fallo: function (clave) {
      // Evita que miles de correos inventados llenen la memoria: se descartan los bloqueos vencidos.
      if (fallos.size > 10000) {
        fallos.forEach(function (v, k) { if (v.hasta < Date.now()) { fallos.delete(k); } });
      }
      const r = fallos.get(clave) || { n: 0, hasta: 0 };
      r.n += 1;
      if (r.n >= MAX_FALLOS) { r.hasta = Date.now() + BLOQUEO_MS; r.n = 0; }
      fallos.set(clave, r);
    },
    exito: function (clave) { fallos.delete(clave); }
  };
}

// Devuelve el id del usuario si la clave es correcta; lanza 401 si no.
async function autenticar(db, correoCrudo, clave) {
  const correo = typeof correoCrudo === 'string' ? correoCrudo.trim().toLowerCase() : '';
  const usuario = await uno(db, 'SELECT id, clave_hash FROM usuarios WHERE correo = $1', [correo]);
  const ok = verificarClave(typeof clave === 'string' ? clave : '', usuario ? usuario.clave_hash : HASH_FALSO);
  if (!usuario || !ok) { throw new ErrorApi(401, 'Correo o contraseña incorrectos.'); }
  return usuario.id;
}

module.exports = {
  hashClave, autenticar, registrar, crearSesion, leerSesion, cerrarSesion, elegirNegocio,
  negociosDe, crearLimitador, DURACION_SESION_MS
};
