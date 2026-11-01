'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { interpretar } = require('../src/interprete');

const CATALOGO = [
  { id: 1, nombre: 'Gaseosa 1,5 L' },
  { id: 2, nombre: 'Gaseosa 400 ml' },
  { id: 3, nombre: 'Pan tajado' },
  { id: 4, nombre: 'Huevos (u)' },
  { id: 5, nombre: 'Arroz 500 g' },
  { id: 6, nombre: 'Leche 1 L' },
  { id: 7, nombre: 'Camiseta talla M' },
  { id: 8, nombre: 'Botella de agua 600 ml' }
];

function caso(texto, esperado) {
  test('"' + texto + '"', function () {
    const r = interpretar(texto, CATALOGO);
    const real = { estado: r.estado, tipo: r.tipo, cantidad: r.cantidad, producto: r.producto && r.producto.id };
    if (esperado.candidatos) { real.candidatos = r.candidatos.map(function (p) { return p.id; }); }
    assert.deepStrictEqual(real, esperado);
  });
}

// Frases de los wireframes y del sitio
caso('Vendí 3 camisetas talla M', { estado: 'ok', tipo: 'venta', cantidad: 3, producto: 7 });
caso('Entraron 40 unidades de arroz', { estado: 'ok', tipo: 'entrada', cantidad: 40, producto: 5 });
caso('Vendi 3 gaseosas 1.5', { estado: 'ok', tipo: 'venta', cantidad: 3, producto: 1 });
caso('se vendieron 6 gaseosas de 400', { estado: 'ok', tipo: 'venta', cantidad: 6, producto: 2 });

// Números escritos, plurales y mermas
caso('vendí dos panes', { estado: 'ok', tipo: 'venta', cantidad: 2, producto: 3 });
caso('se dañaron tres huevos', { estado: 'ok', tipo: 'merma', cantidad: 3, producto: 4 });
caso('llegó una docena de huevos', { estado: 'ok', tipo: 'entrada', cantidad: 12, producto: 4 });
caso('se vencieron media docena de leches', { estado: 'ok', tipo: 'merma', cantidad: 6, producto: 6 });
caso('recibimos treinta y cinco arroces', { estado: 'ok', tipo: 'entrada', cantidad: 35, producto: 5 });
caso('le vendí a un señor 4 panes tajados', { estado: 'ok', tipo: 'venta', cantidad: 4, producto: 3 });
caso('compramos 20 leches al proveedor', { estado: 'ok', tipo: 'entrada', cantidad: 20, producto: 6 });
caso('se rompieron 2 botellas de agua', { estado: 'ok', tipo: 'merma', cantidad: 2, producto: 8 });
caso('Vendí 5 botellas de agua', { estado: 'ok', tipo: 'venta', cantidad: 5, producto: 8 });

// Casos que el usuario debe resolver
caso('se vendieron 6 gaseosas', { estado: 'ambiguo', tipo: 'venta', cantidad: 6, producto: null, candidatos: [1, 2] });
caso('vendí 2 chocolatinas', { estado: 'sin_producto', tipo: 'venta', cantidad: 2, producto: null });
caso('vendí arroz', { estado: 'sin_cantidad', tipo: 'venta', cantidad: null, producto: 5 });
caso('hola, buenos días', { estado: 'no_entendido', tipo: null, cantidad: null, producto: null });
caso('', { estado: 'no_entendido', tipo: null, cantidad: null, producto: null });

// Consultas
caso('¿cuánto queda de arroz?', { estado: 'consulta', tipo: 'consulta', cantidad: null, producto: 5 });
caso('cuantos huevos hay', { estado: 'consulta', tipo: 'consulta', cantidad: null, producto: 4 });

test('la búsqueda conserva lo que no se encontró', function () {
  assert.strictEqual(interpretar('vendí 2 chocolatinas jet', CATALOGO).busqueda, 'chocolatinas jet');
});
