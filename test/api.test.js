'use strict';
// Pruebas de la API de punta a punta: servidor real en un puerto libre y la base de pruebas
// de PostgreSQL (DATABASE_URL_PRUEBA), que se vacía al empezar.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Client } = require('pg');
const { crearApp } = require('../servidor');

let servidor;
let base;
let n8n;                // n8n simulado: lo que hace en cada prueba lo decide manejadorIA
let manejadorIA = function (req, res) { res.writeHead(503); res.end(); };
let recibidasIA = [];

test.before(async function () {
  const url = process.env.DATABASE_URL_PRUEBA;
  assert.ok(url, 'Falta DATABASE_URL_PRUEBA en .env (ver .env.example).');
  // Protección: estas pruebas borran las tablas, así que nunca se corren contra la base real.
  assert.match(new URL(url).pathname, /_prueba$/, 'La base de pruebas debe llamarse algo_prueba.');
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query('DROP TABLE IF EXISTS movimientos, productos, sesiones, membresias, usuarios, negocios, migraciones');
  await c.end();
  n8n = http.createServer(function (req, res) {
    const partes = [];
    req.on('data', function (c) { partes.push(c); });
    req.on('end', function () { recibidasIA.push(Buffer.concat(partes).toString('utf8')); manejadorIA(req, res); });
  });
  const urlIA = await new Promise(function (r) { n8n.listen(0, '127.0.0.1', function () { r('http://127.0.0.1:' + n8n.address().port + '/webhook'); }); });
  servidor = await crearApp({ urlDb: url, demo: true, ia: { url: urlIA, secreto: 'secreto-de-prueba', timeoutMs: 1000, limiteDiario: 1000 }, avisarIA: function () {} });
  await new Promise(function (r) { servidor.listen(0, '127.0.0.1', function () { base = 'http://127.0.0.1:' + servidor.address().port; r(); }); });
});
test.after(function () { servidor.close(); n8n.close(); n8n.closeAllConnections(); });

// Cliente mínimo que guarda la cookie de sesión como lo haría el navegador.
function cliente() {
  let cookie = '';
  return async function (metodo, ruta, cuerpo, cabeceras) {
    const r = await fetch(base + ruta, {
      method: metodo,
      headers: Object.assign({ cookie: cookie }, cuerpo === undefined ? {} : { 'content-type': 'application/json' }, cabeceras),
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
    });
    const set = r.headers.get('set-cookie');
    if (set) { cookie = set.split(';')[0]; }
    return { estado: r.status, datos: await r.json(), cabeceras: r.headers };
  };
}

async function ingresar(correo) {
  const api = cliente();
  const r = await api('POST', '/api/sesion', { correo: correo, clave: 'demo12345' });
  assert.strictEqual(r.estado, 200, JSON.stringify(r.datos));
  return { api: api, sesion: r.datos };
}

async function elegir(api, sesion, nombre) {
  const n = sesion.negocios.find(function (x) { return x.nombre.indexOf(nombre) === 0; });
  const r = await api('POST', '/api/sesion/negocio', { negocioId: n.id });
  assert.strictEqual(r.estado, 200);
  return n.id;
}

test('sin sesión la API responde 401', async function () {
  const r = await cliente()('GET', '/api/productos');
  assert.strictEqual(r.estado, 401);
});

test('clave incorrecta: 401 con mensaje genérico', async function () {
  const r = await cliente()('POST', '/api/sesion', { correo: 'demo@stockvoz.test', clave: 'otra-cosa' });
  assert.strictEqual(r.estado, 401);
  assert.strictEqual(r.datos.error, 'Correo o contraseña incorrectos.');
});

test('la cookie de sesión es HttpOnly y SameSite=Strict', async function () {
  const r = await cliente()('POST', '/api/sesion', { correo: 'encargado@stockvoz.test', clave: 'demo12345' });
  const set = r.cabeceras.get('set-cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
});

test('peticiones que no son JSON se rechazan (protección CSRF)', async function () {
  const r = await cliente()('POST', '/api/sesion', undefined, { 'content-type': 'application/x-www-form-urlencoded' });
  assert.strictEqual(r.estado, 415);
});

test('con dos negocios pide elegir antes de ver datos', async function () {
  const s = await ingresar('demo@stockvoz.test');
  assert.strictEqual(s.sesion.negocio, null);
  assert.strictEqual(s.sesion.negocios.length, 2);
  assert.strictEqual((await s.api('GET', '/api/productos')).estado, 409);
});

test('flujo completo: interpretar, confirmar y ver el stock actualizado', async function () {
  const s = await ingresar('demo@stockvoz.test');
  await elegir(s.api, s.sesion, 'Tienda');
  const i = await s.api('POST', '/api/interpretar', { texto: 'Vendí 2 panes tajados' });
  assert.strictEqual(i.datos.estado, 'ok');
  const antes = i.datos.producto.stock;
  const m = await s.api('POST', '/api/movimientos', { productoId: i.datos.producto.id, tipo: i.datos.tipo, cantidad: i.datos.cantidad, origen: 'texto', textoOriginal: 'Vendí 2 panes tajados' });
  assert.strictEqual(m.estado, 201, JSON.stringify(m.datos));
  assert.strictEqual(m.datos.producto.stock, antes - 2);
  const lista = await s.api('GET', '/api/movimientos?limite=1');
  assert.strictEqual(lista.datos[0].textoOriginal, 'Vendí 2 panes tajados');
});

test('no se puede vender más de lo que hay (409) y el stock no cambia', async function () {
  const s = await ingresar('demo@stockvoz.test');
  await elegir(s.api, s.sesion, 'Tienda');
  const p = (await s.api('GET', '/api/productos')).datos.find(function (x) { return x.nombre === 'Aceite 1 L'; });
  const r = await s.api('POST', '/api/movimientos', { productoId: p.id, tipo: 'venta', cantidad: p.stock + 1 });
  assert.strictEqual(r.estado, 409);
  assert.match(r.datos.error, /Stock insuficiente/);
  const despues = (await s.api('GET', '/api/productos')).datos.find(function (x) { return x.id === p.id; });
  assert.strictEqual(despues.stock, p.stock);
});

test('ventas simultáneas del mismo producto no dejan el stock negativo', async function () {
  const s = await ingresar('demo@stockvoz.test');
  await elegir(s.api, s.sesion, 'Tienda');
  const p = (await s.api('POST', '/api/productos', { nombre: 'Panela', precio: 3000, stock: 5 })).datos;
  const r = await Promise.all([1, 2, 3, 4, 5].map(function () {
    return s.api('POST', '/api/movimientos', { productoId: p.id, tipo: 'venta', cantidad: 2 });
  }));
  const estados = r.map(function (x) { return x.estado; }).sort();
  assert.deepStrictEqual(estados, [201, 201, 409, 409, 409]);
  const despues = (await s.api('GET', '/api/productos')).datos.find(function (x) { return x.id === p.id; });
  assert.strictEqual(despues.stock, 1);
});

test('cantidades inválidas se rechazan con 400', async function () {
  const s = await ingresar('demo@stockvoz.test');
  await elegir(s.api, s.sesion, 'Tienda');
  const p = (await s.api('GET', '/api/productos')).datos[0];
  for (const cantidad of [0, -3, 2.5, 'tres', null]) {
    const r = await s.api('POST', '/api/movimientos', { productoId: p.id, tipo: 'venta', cantidad: cantidad });
    assert.strictEqual(r.estado, 400, 'cantidad ' + cantidad);
  }
  assert.strictEqual((await s.api('POST', '/api/movimientos', { productoId: p.id, tipo: 'regalo', cantidad: 1 })).estado, 400);
});

test('aislamiento entre negocios: no se ve ni se toca un producto ajeno', async function () {
  const s = await ingresar('demo@stockvoz.test');
  await elegir(s.api, s.sesion, 'Papelería');
  const ajeno = (await s.api('GET', '/api/productos')).datos[0];

  const e = await ingresar('encargado@stockvoz.test');   // solo pertenece a la tienda
  assert.strictEqual(e.sesion.negocios.length, 1);
  const visibles = (await e.api('GET', '/api/productos')).datos.map(function (p) { return p.id; });
  assert.ok(visibles.indexOf(ajeno.id) === -1);
  assert.strictEqual((await e.api('POST', '/api/movimientos', { productoId: ajeno.id, tipo: 'venta', cantidad: 1 })).estado, 404);
  const papeleria = s.sesion.negocios.find(function (n) { return n.nombre.indexOf('Papelería') === 0; });
  assert.strictEqual((await e.api('POST', '/api/sesion/negocio', { negocioId: papeleria.id })).estado, 403);
});

test('el encargado registra movimientos pero no administra productos', async function () {
  const e = await ingresar('encargado@stockvoz.test');
  assert.strictEqual((await e.api('POST', '/api/productos', { nombre: 'Galletas', precio: 1500 })).estado, 403);
  const p = (await e.api('GET', '/api/productos')).datos[0];
  assert.strictEqual((await e.api('PATCH', '/api/productos/' + p.id, { activo: false })).estado, 403);
  assert.strictEqual((await e.api('POST', '/api/movimientos', { productoId: p.id, tipo: 'entrada', cantidad: 5 })).estado, 201);
});

test('crear producto registra el stock inicial y no permite duplicados', async function () {
  const s = await ingresar('demo@stockvoz.test');
  await elegir(s.api, s.sesion, 'Tienda');
  const r = await s.api('POST', '/api/productos', { nombre: 'Galletas de soda', precio: 1800, stock: 24, stockMinimo: 6 });
  assert.strictEqual(r.estado, 201, JSON.stringify(r.datos));
  assert.strictEqual(r.datos.estado, 'ok');
  const mov = (await s.api('GET', '/api/movimientos?limite=1')).datos[0];
  assert.deepStrictEqual([mov.producto, mov.tipo, mov.cantidad, mov.origen], ['Galletas de soda', 'entrada', 24, 'inicial']);
  assert.strictEqual((await s.api('POST', '/api/productos', { nombre: 'galletas de soda', precio: 1 })).estado, 409);
});

test('un producto desactivado no admite movimientos ni aparece al interpretar', async function () {
  const s = await ingresar('demo@stockvoz.test');
  await elegir(s.api, s.sesion, 'Tienda');
  const p = (await s.api('POST', '/api/productos', { nombre: 'Velas', precio: 500, stock: 10 })).datos;
  await s.api('PATCH', '/api/productos/' + p.id, { activo: false });
  assert.strictEqual((await s.api('POST', '/api/movimientos', { productoId: p.id, tipo: 'venta', cantidad: 1 })).estado, 409);
  assert.strictEqual((await s.api('POST', '/api/interpretar', { texto: 'vendí 2 velas' })).datos.estado, 'sin_producto');
});

test('registro de un negocio nuevo: queda vacío y separado de los demás', async function () {
  const api = cliente();
  const r = await api('POST', '/api/registro', { negocio: 'Mi Tienda', nombre: 'Ana', correo: 'ana@ejemplo.test', clave: 'clave-segura-1' });
  assert.strictEqual(r.estado, 201, JSON.stringify(r.datos));
  assert.strictEqual(r.datos.rol, 'dueno');
  assert.deepStrictEqual((await api('GET', '/api/productos')).datos, []);
  assert.strictEqual((await cliente()('POST', '/api/registro', { negocio: 'Otra', nombre: 'Ana', correo: 'ana@ejemplo.test', clave: 'clave-segura-1' })).estado, 409);
  assert.strictEqual((await cliente()('POST', '/api/registro', { negocio: 'Otra', nombre: 'Ana', correo: 'x@ejemplo.test', clave: 'corta' })).estado, 400);
});

test('panel y reportes devuelven cifras coherentes', async function () {
  const s = await ingresar('demo@stockvoz.test');
  await elegir(s.api, s.sesion, 'Tienda');
  const panel = (await s.api('GET', '/api/panel')).datos;
  assert.strictEqual(panel.ventas7.length, 7);
  assert.strictEqual(panel.ventasHoy, panel.ventas7[6].total);
  assert.ok(panel.alertas.length >= 2, 'la demo deja productos en alerta');
  const rep = (await s.api('GET', '/api/reportes?dias=7')).datos;
  const suma = panel.ventas7.reduce(function (a, d) { return a + d.total; }, 0);
  assert.strictEqual(rep.vendido.valor, suma);
  assert.ok(rep.topVendidos.length > 0 && rep.topMermas.length > 0);
});

test('cerrar sesión invalida la cookie', async function () {
  const s = await ingresar('encargado@stockvoz.test');
  await s.api('DELETE', '/api/sesion');
  assert.strictEqual((await s.api('GET', '/api/sesion')).estado, 401);
});

test('bloquea tras 5 intentos fallidos', async function () {
  const api = cliente();
  for (let i = 0; i < 5; i++) { await api('POST', '/api/sesion', { correo: 'bloqueo@stockvoz.test', clave: 'x' }); }
  assert.strictEqual((await api('POST', '/api/sesion', { correo: 'bloqueo@stockvoz.test', clave: 'x' })).estado, 429);
});

test('una URL mal codificada no tumba el servidor', async function () {
  assert.strictEqual((await fetch(base + '/%E0%A4%A')).status, 400);
  assert.strictEqual((await fetch(base + '/api/config')).status, 200);
});

test('archivos: no se puede salir de public/ y hay cabeceras de seguridad', async function () {
  const r = await fetch(base + '/..%2fservidor.js');
  assert.notStrictEqual(r.status, 200);
  const h = await fetch(base + '/api/config');
  assert.match(h.headers.get('content-security-policy'), /default-src 'self'/);
  assert.strictEqual(h.headers.get('x-content-type-options'), 'nosniff');
});

test('interpretar usa la IA cuando n8n responde bien y marca la fuente', async function () {
  const s = await ingresar('demo@stockvoz.test');
  await elegir(s.api, s.sesion, 'Tienda');
  const pan = (await s.api('GET', '/api/productos')).datos.find(function (p) { return p.nombre === 'Pan tajado'; });
  manejadorIA = function (req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ estado: 'ok', tipo: 'venta', cantidad: 2, productoId: pan.id, candidatosIds: [], busqueda: '' }));
  };
  const r = await s.api('POST', '/api/interpretar', { texto: 'despaché dos pancitos' });
  assert.strictEqual(r.estado, 200);
  assert.deepStrictEqual([r.datos.fuente, r.datos.estado, r.datos.cantidad, r.datos.producto.id], ['ia', 'ok', 2, pan.id]);
  assert.strictEqual(r.datos.producto.stock, pan.stock, 'el producto trae los datos reales del inventario, no los de la IA');
});

test('la IA no puede nombrar un producto de otro negocio y a n8n solo le llega el catálogo del negocio', async function () {
  const dueña = await ingresar('demo@stockvoz.test');
  await elegir(dueña.api, dueña.sesion, 'Papelería');
  const ajeno = (await dueña.api('GET', '/api/productos')).datos[0];

  const e = await ingresar('encargado@stockvoz.test');   // solo pertenece a la tienda
  recibidasIA = [];
  manejadorIA = function (req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ estado: 'ok', tipo: 'venta', cantidad: 1, productoId: ajeno.id, candidatosIds: [], busqueda: '' }));
  };
  const r = await e.api('POST', '/api/interpretar', { texto: 'vendí 1 cuaderno' });
  assert.deepStrictEqual([r.datos.fuente, r.datos.motivoRespaldo], ['reglas', 'invalida']);
  assert.ok(!r.datos.producto || r.datos.producto.id !== ajeno.id);
  assert.ok(recibidasIA.length === 1 && recibidasIA[0].indexOf('Cuaderno') === -1, 'n8n recibió productos de otro negocio');
});

test('si n8n falla, interpretar sigue funcionando con las reglas', async function () {
  const s = await ingresar('encargado@stockvoz.test');
  manejadorIA = function (req, res) { res.writeHead(500); res.end(); };
  const r = await s.api('POST', '/api/interpretar', { texto: 'vendí 2 panes tajados' });
  assert.strictEqual(r.estado, 200);
  assert.deepStrictEqual([r.datos.fuente, r.datos.motivoRespaldo, r.datos.estado], ['reglas', 'http', 'ok']);
});

// ---------- Anular movimientos ----------

// Registra una venta con la sesión dada y devuelve el id del movimiento y el stock previo.
async function venderParaAnular(s, nombreProducto, cantidad) {
  const p = (await s.api('GET', '/api/productos')).datos.find(function (x) { return x.nombre === nombreProducto; });
  const r = await s.api('POST', '/api/movimientos', { productoId: p.id, tipo: 'venta', cantidad: cantidad, origen: 'texto', textoOriginal: 'venta de prueba' });
  assert.strictEqual(r.estado, 201, JSON.stringify(r.datos));
  return { movimientoId: r.datos.id, productoId: p.id, stockAntes: p.stock };
}

test('el dueño anula una venta: el stock vuelve y el movimiento queda marcado', async function () {
  const s = await ingresar('demo@stockvoz.test');
  await elegir(s.api, s.sesion, 'Tienda');
  const v = await venderParaAnular(s, 'Leche 1 L', 3);

  const r = await s.api('POST', '/api/movimientos/' + v.movimientoId + '/anular', {});
  assert.strictEqual(r.estado, 200, JSON.stringify(r.datos));
  assert.strictEqual(r.datos.producto.stock, v.stockAntes);

  const despues = (await s.api('GET', '/api/productos')).datos.find(function (x) { return x.id === v.productoId; });
  assert.strictEqual(despues.stock, v.stockAntes, 'el stock debe volver a como estaba');

  const mov = (await s.api('GET', '/api/movimientos?limite=200')).datos.find(function (m) { return m.id === v.movimientoId; });
  assert.ok(mov, 'el movimiento anulado sigue en el historial');
  assert.ok(mov.anuladoEn, 'debe quedar marcado como anulado');
  assert.strictEqual(mov.anuladoPor, 'Usuaria demo');
});

test('un movimiento anulado no se puede anular otra vez', async function () {
  const s = await ingresar('demo@stockvoz.test');
  await elegir(s.api, s.sesion, 'Tienda');
  const v = await venderParaAnular(s, 'Café 500 g', 2);
  assert.strictEqual((await s.api('POST', '/api/movimientos/' + v.movimientoId + '/anular', {})).estado, 200);
  const segunda = await s.api('POST', '/api/movimientos/' + v.movimientoId + '/anular', {});
  assert.strictEqual(segunda.estado, 409);
  assert.match(segunda.datos.error, /ya estaba anulado/);
});

test('anular quita el movimiento de los totales del panel y de los reportes', async function () {
  const s = await ingresar('demo@stockvoz.test');
  await elegir(s.api, s.sesion, 'Tienda');
  const antesPanel = (await s.api('GET', '/api/panel')).datos.ventasHoy;
  const antesRep = (await s.api('GET', '/api/reportes?dias=7')).datos.vendido;

  const p = (await s.api('GET', '/api/productos')).datos.find(function (x) { return x.nombre === 'Arroz 500 g'; });
  const r = await s.api('POST', '/api/movimientos', { productoId: p.id, tipo: 'venta', cantidad: 4 });
  assert.strictEqual((await s.api('GET', '/api/panel')).datos.ventasHoy, antesPanel + 4 * p.precio);

  assert.strictEqual((await s.api('POST', '/api/movimientos/' + r.datos.id + '/anular', {})).estado, 200);
  assert.strictEqual((await s.api('GET', '/api/panel')).datos.ventasHoy, antesPanel, 'el panel no debe contar la venta anulada');
  const despuesRep = (await s.api('GET', '/api/reportes?dias=7')).datos.vendido;
  assert.deepStrictEqual([despuesRep.unidades, despuesRep.valor], [antesRep.unidades, antesRep.valor], 'los reportes tampoco');
});

test('el encargado anula lo suyo de hoy, pero no lo de otra persona', async function () {
  const e = await ingresar('encargado@stockvoz.test');
  const suyo = await venderParaAnular(e, 'Huevos (u)', 2);
  assert.strictEqual((await e.api('POST', '/api/movimientos/' + suyo.movimientoId + '/anular', {})).estado, 200);

  const d = await ingresar('demo@stockvoz.test');
  await elegir(d.api, d.sesion, 'Tienda');
  const ajeno = await venderParaAnular(d, 'Huevos (u)', 2);
  const r = await e.api('POST', '/api/movimientos/' + ajeno.movimientoId + '/anular', {});
  assert.strictEqual(r.estado, 403);
  assert.match(r.datos.error, /registrados por ti/);
});

test('el encargado no puede anular movimientos de días anteriores', async function () {
  const e = await ingresar('encargado@stockvoz.test');
  const v = await venderParaAnular(e, 'Pan tajado', 1);
  // Se retrasa un día la fecha del movimiento para simular que fue de ayer.
  const c = new Client({ connectionString: process.env.DATABASE_URL_PRUEBA });
  await c.connect();
  await c.query('UPDATE movimientos SET fecha_local = fecha_local - 1 WHERE id = $1', [v.movimientoId]);
  await c.end();

  const r = await e.api('POST', '/api/movimientos/' + v.movimientoId + '/anular', {});
  assert.strictEqual(r.estado, 403);
  assert.match(r.datos.error, /de hoy/);
  const d = await ingresar('demo@stockvoz.test');
  await elegir(d.api, d.sesion, 'Tienda');
  assert.strictEqual((await d.api('POST', '/api/movimientos/' + v.movimientoId + '/anular', {})).estado, 200, 'el dueño sí puede');
});

test('no se puede anular un movimiento de otro negocio', async function () {
  const d = await ingresar('demo@stockvoz.test');
  await elegir(d.api, d.sesion, 'Papelería');
  const ajeno = await venderParaAnular(d, 'Lápiz HB', 1);

  const e = await ingresar('encargado@stockvoz.test');   // solo pertenece a la tienda
  assert.strictEqual((await e.api('POST', '/api/movimientos/' + ajeno.movimientoId + '/anular', {})).estado, 404);
});

test('no se puede anular una entrada cuyas unidades ya se vendieron', async function () {
  const s = await ingresar('demo@stockvoz.test');
  await elegir(s.api, s.sesion, 'Tienda');
  const p = (await s.api('POST', '/api/productos', { nombre: 'Panela en bloque', precio: 3000, stock: 0 })).datos;
  const entrada = await s.api('POST', '/api/movimientos', { productoId: p.id, tipo: 'entrada', cantidad: 10 });
  await s.api('POST', '/api/movimientos', { productoId: p.id, tipo: 'venta', cantidad: 8 });

  const r = await s.api('POST', '/api/movimientos/' + entrada.datos.id + '/anular', {});
  assert.strictEqual(r.estado, 409);
  assert.match(r.datos.error, /solo quedan 2/);
  const despues = (await s.api('GET', '/api/productos')).datos.find(function (x) { return x.id === p.id; });
  assert.strictEqual(despues.stock, 2, 'el stock no cambia si la anulación falla');
});

test('dos anulaciones simultáneas del mismo movimiento devuelven el stock una sola vez', async function () {
  const s = await ingresar('demo@stockvoz.test');
  await elegir(s.api, s.sesion, 'Tienda');
  const v = await venderParaAnular(s, 'Aceite 1 L', 3);

  const r = await Promise.all([1, 2, 3].map(function () { return s.api('POST', '/api/movimientos/' + v.movimientoId + '/anular', {}); }));
  assert.deepStrictEqual(r.map(function (x) { return x.estado; }).sort(), [200, 409, 409]);
  const despues = (await s.api('GET', '/api/productos')).datos.find(function (x) { return x.id === v.productoId; });
  assert.strictEqual(despues.stock, v.stockAntes, 'el stock se devolvió una sola vez');
});
