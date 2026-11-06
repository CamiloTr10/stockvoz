'use strict';
// Cosas que solo importan cuando la app vive detrás de un CDN o un balanceador (CloudFront,
// App Runner, ALB). No necesitan base de datos: ipCliente() es una función pura.

const test = require('node:test');
const assert = require('node:assert');
const { ipCliente } = require('../servidor');

function peticion(xff, socket) {
  return { headers: xff === null ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: socket || '10.0.0.1' } };
}

test('sin proxies declarados se usa la IP del socket y se ignora X-Forwarded-For', function () {
  // Cualquiera puede mandar esa cabecera: creerle sin saber quién está delante sería peor
  // que no usarla, porque permitiría saltarse los límites por IP inventando una.
  assert.strictEqual(ipCliente(peticion('1.2.3.4', '10.0.0.1'), 0), '10.0.0.1');
  assert.strictEqual(ipCliente(peticion('1.2.3.4', '10.0.0.1'), undefined), '10.0.0.1');
});

test('con un proxio delante se toma el último de la cadena, que es el que puso ese proxy', function () {
  assert.strictEqual(ipCliente(peticion('190.1.1.1', '10.0.0.1'), 1), '190.1.1.1');
  // El cliente mintió poniendo una IP suya; CloudFront añadió la de verdad al final.
  assert.strictEqual(ipCliente(peticion('6.6.6.6, 190.1.1.1', '10.0.0.1'), 1), '190.1.1.1');
});

test('con dos proxios delante se salta el último y se toma el anterior', function () {
  // CloudFront → balanceador → app: la IP del cliente la puso CloudFront, el penúltimo lugar.
  assert.strictEqual(ipCliente(peticion('190.1.1.1, 70.70.70.70', '10.0.0.1'), 2), '190.1.1.1');
});

test('si la cabecera falta o viene rara, se cae a la IP del socket en vez de fallar', function () {
  assert.strictEqual(ipCliente(peticion(null, '10.0.0.1'), 1), '10.0.0.1');
  assert.strictEqual(ipCliente(peticion('', '10.0.0.1'), 1), '10.0.0.1');
  assert.strictEqual(ipCliente(peticion('   ,  ,', '10.0.0.1'), 1), '10.0.0.1');
  // Se declaran más proxios de los que hay: no se puede saber, así que no se inventa.
  assert.strictEqual(ipCliente(peticion('190.1.1.1', '10.0.0.1'), 3), '10.0.0.1');
});

test('los espacios de la cadena no se cuelan en la IP', function () {
  assert.strictEqual(ipCliente(peticion('  190.1.1.1  ,  70.70.70.70  ', '10.0.0.1'), 2), '190.1.1.1');
});

// La imagen de Docker se sube a un registro y se comparte. Si el .env se colara, las claves de
// la base y de Groq viajarían con ella.
test('la imagen de Docker deja por fuera el .env y trae todo lo que el servidor necesita', function () {
  const fs = require('node:fs');
  const path = require('node:path');
  const raiz = path.join(__dirname, '..');
  const ignorados = fs.readFileSync(path.join(raiz, '.dockerignore'), 'utf8').split(/\r?\n/).map(function (l) { return l.trim(); });
  assert.ok(ignorados.indexOf('.env') !== -1, '.env debe estar en .dockerignore');

  const dockerfile = fs.readFileSync(path.join(raiz, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^ENV NODE_ENV=production$/m, 'sin esto la app no se niega a arrancar con las cuentas demo');
  // Todo lo que servidor.js carga al arrancar tiene que estar copiado en la imagen.
  ['servidor.js', 'src', 'public', 'migraciones', 'admin'].forEach(function (cosa) {
    assert.match(dockerfile, new RegExp('^COPY ' + cosa.replace('.', '\.') + ' ', 'm'), 'falta copiar ' + cosa);
  });
});
