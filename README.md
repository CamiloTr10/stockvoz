# StockVoz — prototipo funcional

Aplicación web para registrar **ventas, entradas y mermas** de inventario **hablando o escribiendo**.
El sistema interpreta la frase, el usuario confirma y el backend valida antes de guardar.

Este prototipo implementa las 10 pantallas de los wireframes (web y app) más los casos que no
estaban dibujados: instrucción no entendida, producto ambiguo, producto inexistente, falta de
cantidad, stock insuficiente, alta de productos, historial de movimientos y registro de negocios.

## Cómo correrlo

Requisito: **Node.js 22.13 o superior** (no hay que instalar paquetes: no usa dependencias externas).

```bash
cd stockvoz
node servidor.js
```

Abre <http://localhost:3000>. La primera vez se crea `datos/stockvoz.db` con datos de demostración.

| Cuenta de prueba | Contraseña | Qué puede hacer |
|---|---|---|
| `demo@stockvoz.test` | `demo12345` | Dueña de dos negocios (tienda y papelería): todo |
| `encargado@stockvoz.test` | `demo12345` | Encargado de la tienda: registra movimientos, no edita productos |

Variables opcionales: `PORT` (puerto, 3000 por defecto), `STOCKVOZ_DB` (ruta de la base),
`STOCKVOZ_DEMO=0` (no cargar datos de demostración) y `STOCKVOZ_COOKIE_SEGURA=1` (obligatoria al publicar con HTTPS).

**Dictado por voz:** funciona en Chrome y Edge (Web Speech API). El navegador envía el audio a su
servicio de reconocimiento y StockVoz solo recibe el texto. En otros navegadores se usa el campo de texto.

## Pruebas

```bash
cd stockvoz
node --test
```

39 pruebas: el intérprete de frases (21 casos) y la API de punta a punta (aislamiento entre negocios,
roles, stock insuficiente, validaciones, sesiones, CSRF, bloqueo por intentos fallidos, URLs malformadas y cabeceras de seguridad).

## Estructura

```
stockvoz/
├── docs/              Documentación del proyecto (wireframes v1)
├── servidor.js          Servidor HTTP: rutas de la API, sesión por cookie y archivos de public/
├── src/
│   ├── interprete.js    Frase en español → operación propuesta (tipo, producto, cantidad)
│   ├── inventario.js    Reglas del inventario: productos, movimientos, panel y reportes
│   ├── auth.js          Cuentas, contraseñas (scrypt), sesiones y límite de intentos
│   ├── db.js            Esquema y acceso a la base de datos
│   ├── demo.js          Datos de demostración
│   └── errores.js       Error con código HTTP
├── public/              Interfaz: index.html, app.css, app.js (JavaScript nativo)
└── test/                Pruebas con node:test
```

## Flujo principal

```
Usuario (voz o texto)
   → POST /api/interpretar      el intérprete propone {tipo, producto, cantidad}; no guarda nada
   → el usuario revisa / corrige / confirma en pantalla
   → POST /api/movimientos      el backend valida negocio, producto, cantidad y stock, y guarda
```

Así se cumple la decisión del proyecto: **la IA no escribe directamente en la base de datos**.

## API

Todas las rutas responden JSON. Las de inventario usan siempre el negocio de la sesión, nunca uno enviado por el cliente.

| Método | Ruta | Requiere | Descripción |
|---|---|---|---|
| GET | `/api/config` | — | Si hay cuentas demo |
| POST | `/api/registro` | — | Crea negocio + usuario dueño |
| POST | `/api/sesion` | — | Ingresar (`correo`, `clave`) |
| GET / DELETE | `/api/sesion` | sesión | Ver sesión / salir |
| POST | `/api/sesion/negocio` | sesión | Elegir negocio activo |
| GET | `/api/productos` | negocio | Lista (`?inactivos=1` incluye desactivados) |
| POST | `/api/productos` | dueño | Crear (`nombre`, `precio`, `stock`, `stockMinimo`) |
| PATCH | `/api/productos/:id` | dueño | Editar nombre, precio, mínimo o `activo` |
| POST | `/api/interpretar` | negocio | `texto` → propuesta |
| POST | `/api/movimientos` | negocio | Registrar (`productoId`, `tipo`, `cantidad`, `origen`, `textoOriginal`) |
| GET | `/api/movimientos` | negocio | Historial (`?tipo=venta|entrada|merma`) |
| GET | `/api/panel` | negocio | Resumen del día y de 7 días |
| GET | `/api/reportes` | negocio | Totales y rankings (`?dias=7|30`) |

## Modelo de datos

- **negocios**, **usuarios** y **membresias** (un usuario puede estar en varios negocios, con rol `dueno` o `encargado`).
- **productos**: siempre con `negocio_id`; precio en pesos enteros, stock y stock mínimo.
- **movimientos**: venta, entrada o merma, con el precio del momento, el stock resultante, quién lo hizo,
  si vino por voz o texto y la frase original. **El stock solo cambia mediante movimientos**, así el historial siempre cuadra.
- Los productos no se borran: se desactivan, para no romper el historial ni los reportes.

## Decisiones y atajos conscientes

| Hoy | Por qué | Siguiente paso |
|---|---|---|
| SQLite embebido (`node:sqlite`) | Corre sin instalar nada | Pasar a **PostgreSQL** (el proyecto lo define así; está aislado en `db.js`) |
| Intérprete por reglas | Funciona sin claves de API ni costos y es fácil de probar | Conectar el modelo de IA mediante **n8n**, devolviendo el mismo formato que `interpretar()` |
| Web Speech API del navegador | Dictado gratis en Chrome/Edge | Procesar audio en el servidor (por ejemplo Whisper) si se necesita en otros navegadores o en WhatsApp |
| Una operación por frase | Suficiente para el MVP | Frases compuestas («vendí 3 y se dañaron 2») |

## Qué sigue, por rol del equipo

- **Backend y base de datos (Gabriel):** esquema definitivo en PostgreSQL y migración desde `db.js`; revisar la estrategia multi-tenant (filtrado por `negocio_id` en todas las consultas, o Row Level Security).
- **IA y automatización (Nicolás):** flujo en n8n que reciba el texto, llame al modelo de lenguaje y devuelva `{estado, tipo, producto, cantidad}`; usar las pruebas de `test/interprete.test.js` como casos de evaluación.
- **Frontend (Camilo):** convertir la interfaz en PWA instalable y probar con usuarios reales desde el celular.
- **UX y documentación (David):** pruebas de usabilidad con tenderos usando las cuentas demo; documentar los hallazgos de la investigación de usuarios y ajustar los textos de error.
