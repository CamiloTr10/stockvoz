# StockVoz — prototipo funcional

Aplicación web para registrar **ventas, entradas y mermas** de inventario **hablando o escribiendo**.
El sistema interpreta la frase, el usuario confirma y el backend valida antes de guardar.

Este prototipo implementa las 10 pantallas de los wireframes (web y app) más los casos que no
estaban dibujados: instrucción no entendida, producto ambiguo, producto inexistente, falta de
cantidad, stock insuficiente, alta de productos, historial de movimientos y registro de negocios.

## Cómo correrlo

Requisitos: **Node.js 22.13 o superior** y **PostgreSQL 17**. La única dependencia es el driver `pg`.

### 1. Crear el usuario y las bases (una sola vez)

Con el servicio de PostgreSQL encendido, abre `psql` como `postgres`
(en Windows: `"C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres`) y ejecuta:

```sql
CREATE ROLE stockvoz LOGIN;
\password stockvoz
CREATE DATABASE stockvoz OWNER stockvoz ENCODING 'UTF8' TEMPLATE template0;
CREATE DATABASE stockvoz_prueba OWNER stockvoz ENCODING 'UTF8' TEMPLATE template0;
```

`\password` pide la contraseña sin mostrarla y sin dejarla en el historial.
Las tablas las crea la aplicación al arrancar, aplicando las migraciones de `migraciones/` (ver más abajo).

### 2. Configurar y arrancar

```bash
cd stockvoz
npm install
cp .env.example .env     # en PowerShell: Copy-Item .env.example .env
```

Edita `.env` y pon la contraseña de `stockvoz` en las dos URL. Luego:

```bash
npm start
```

Abre <http://localhost:3000>. Si la base está vacía, se cargan los datos de demostración.

| Cuenta de prueba | Contraseña | Qué puede hacer |
|---|---|---|
| `demo@stockvoz.test` | `demo12345` | Dueña de dos negocios (tienda y papelería): todo |
| `encargado@stockvoz.test` | `demo12345` | Encargado de la tienda: registra movimientos, no edita productos |

### Configuración (`.env`)

El servidor lee `.env` al arrancar; si una variable ya existe en el sistema, esa tiene prioridad.
`.env` está en `.gitignore`: **las contraseñas nunca van en el código ni en git**. La plantilla es `.env.example`.

| Variable | Por defecto | Para qué |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor web |
| `DATABASE_URL` | — (obligatoria) | `postgres://usuario:clave@host:5432/stockvoz` |
| `DATABASE_URL_PRUEBA` | — (para `node --test`) | Base que las pruebas **borran** en cada corrida; su nombre debe terminar en `_prueba` |
| `STOCKVOZ_DEMO` | `1` | `0` para no cargar las cuentas y negocios de demostración |
| `STOCKVOZ_COOKIE_SEGURA` | `0` | `1` para que la cookie de sesión solo viaje por HTTPS (obligatorio al publicar) |
| `STOCKVOZ_IA` | `0` | `1` para interpretar con IA vía n8n, con las reglas como respaldo (ver abajo) |
| `N8N_URL`, `N8N_SECRETO` | — | Webhook de n8n y secreto compartido (mínimo 16 caracteres). Obligatorias si `STOCKVOZ_IA=1` |
| `N8N_TIMEOUT_MS` | `6000` | Milisegundos que se espera a n8n antes de usar el respaldo |
| `STOCKVOZ_IA_LIMITE_DIARIO` | `500` | Interpretaciones con IA por negocio y día; pasado el tope se usan las reglas |

**Dictado por voz:** funciona en Chrome y Edge (Web Speech API). El navegador envía el audio a su
servicio de reconocimiento y StockVoz solo recibe el texto. En otros navegadores se usa el campo de texto.

## Pruebas

```bash
cd stockvoz
node --test
```

109 pruebas: el intérprete de frases (47 casos vigilados), las migraciones (4), el módulo de IA con un n8n simulado (13) y la API de punta a punta (aislamiento entre negocios,
roles, stock insuficiente, ventas simultáneas, anulaciones, invitaciones, validaciones, sesiones, CSRF, bloqueo por intentos fallidos, URLs malformadas y cabeceras de seguridad).
Las que usan la base lo hacen sobre `DATABASE_URL_PRUEBA` y se niegan a correr si esa base no termina en `_prueba`.

## Migraciones de la base de datos

Los cambios al esquema viven en `migraciones/`, un archivo por cambio: `001_esquema_inicial.sql`, `002_...sql`, etc.
Al arrancar, la aplicación aplica en orden las que faltan y deja registro en la tabla `migraciones`.

- Para cambiar el esquema, **crea un archivo nuevo** con el siguiente número. **Nunca edites uno ya aplicado**: en las bases que ya lo corrieron no se repetiría.
- Cada migración corre en una transacción: si falla, no queda nada a medias y la aplicación no arranca.
- Si dos procesos arrancan a la vez, un candado hace que uno espere al otro.

En GitHub corren solas en cada push y pull request (GitHub Actions, `.github/workflows/pruebas.yml`),
contra un PostgreSQL 17 temporal. El resultado aparece en la pestaña **Actions** del repositorio.

## Interpretación con IA y evaluación

Por defecto cada frase la interpreta `src/interprete.js` (reglas, gratis y sin conexión). Con `STOCKVOZ_IA=1`,
`POST /api/interpretar` se la pasa a un flujo de n8n que consulta un modelo de lenguaje:

- **La IA solo propone.** El backend valida la respuesta: solo acepta productos del catálogo del propio negocio, cantidades válidas y campos coherentes con el estado. Después el usuario confirma y `POST /api/movimientos` guarda, igual que siempre.
- **Respaldo:** si n8n está caído, tarda más de `N8N_TIMEOUT_MS`, responde un error o algo inválido, o el negocio ya llegó a su límite diario, se usan las reglas y la interfaz sigue funcionando. La respuesta indica `fuente` (`ia` o `reglas`) y, si hubo respaldo, `motivoRespaldo`.
- **Privacidad:** a n8n solo viajan la frase y los `id` y nombres de los productos del negocio. Sin precios, stock ni datos de personas.
- El formato exacto que debe recibir y devolver el flujo está en [docs/contrato-n8n.md](docs/contrato-n8n.md).

**Medir un intérprete.** `evaluacion/casos.json` es el banco de frases con su resultado esperado, agrupadas por categoría
(coloquial, números en letras, errores de dictado…). Son frases propuestas: hay que reemplazarlas y ampliarlas con frases reales de tenderos.

```bash
npm run evaluar            # intérprete por reglas (gratis)
npm run evaluar -- --ia    # la IA vía n8n, según .env (gasta crédito de la API)
```

Muestra aciertos por categoría, tiempo por frase (mediana y p95), cuántas respondió la IA y cuántas cayeron al respaldo
(esas **no** cuentan como acierto de la IA) y la lista de fallos. Las frases marcadas `"regresion": true` también las vigila `node --test`.

## Estructura

```
stockvoz/
├── docs/              Documentación del proyecto (wireframes v1) y contrato con n8n
├── evaluacion/          Banco de frases (casos.json) y script npm run evaluar
├── servidor.js          Servidor HTTP: rutas de la API, sesión por cookie y archivos de public/
├── migraciones/         Cambios del esquema de PostgreSQL, numerados (001_..., 002_...)
├── src/
│   ├── interprete.js    Frase en español → operación propuesta (tipo, producto, cantidad), por reglas
│   ├── ia.js            Interpretación con IA vía n8n: validación de la respuesta y respaldo por reglas
│   ├── inventario.js    Reglas del inventario: productos, movimientos, panel y reportes
│   ├── auth.js          Cuentas, contraseñas (scrypt), sesiones, invitaciones y límite de intentos
│   ├── db.js            Pool de PostgreSQL, migraciones y transacciones
│   ├── entorno.js       Lectura del archivo .env
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
| POST | `/api/registro` | — | Crea cuenta: con `negocio` crea uno nuevo (dueño), con `codigo` entra al que lo invitó |
| POST | `/api/sesion` | — | Ingresar (`correo`, `clave`) |
| GET / DELETE | `/api/sesion` | sesión | Ver sesión / salir |
| POST | `/api/sesion/negocio` | sesión | Elegir negocio activo |
| POST | `/api/invitaciones/aceptar` | sesión | Unirse a un negocio con un `codigo` |
| GET | `/api/equipo` | dueño | Miembros del negocio e invitaciones pendientes |
| POST | `/api/equipo/invitaciones` | dueño | Crear un código (`rol`); se devuelve una sola vez |
| DELETE | `/api/equipo/invitaciones/:id` | dueño | Cancelar una invitación sin usar |
| DELETE | `/api/equipo/miembros/:id` | dueño | Quitar a alguien del negocio |
| GET | `/api/productos` | negocio | Lista (`?inactivos=1` incluye desactivados) |
| POST | `/api/productos` | dueño | Crear (`nombre`, `precio`, `stock`, `stockMinimo`) |
| PATCH | `/api/productos/:id` | dueño | Editar nombre, precio, mínimo o `activo` |
| POST | `/api/interpretar` | negocio | `texto` → propuesta |
| POST | `/api/movimientos` | negocio | Registrar (`productoId`, `tipo`, `cantidad`, `origen`, `textoOriginal`) |
| POST | `/api/movimientos/:id/anular` | negocio | Anular: devuelve el stock y marca el movimiento (ver abajo) |
| GET | `/api/movimientos` | negocio | Historial (`?tipo=venta|entrada|merma`) |
| GET | `/api/panel` | negocio | Resumen del día y de 7 días |
| GET | `/api/reportes` | negocio | Totales y rankings (`?dias=7|30`) |

## Modelo de datos

- **negocios**, **usuarios** y **membresias** (un usuario puede estar en varios negocios, con rol `dueno` o `encargado`).
- **productos**: siempre con `negocio_id`; precio en pesos enteros, stock y stock mínimo.
- **movimientos**: venta, entrada o merma, con el precio del momento, el stock resultante, quién lo hizo,
  si vino por voz o texto y la frase original. **El stock solo cambia mediante movimientos**, así el historial siempre cuadra.
- Los productos no se borran: se desactivan, para no romper el historial ni los reportes.
- **Los movimientos tampoco se borran: se anulan.** Anular devuelve el stock, marca el movimiento con
  `anulado_en` y `anulado_por`, y lo saca de los totales del panel y de los reportes; en el historial sigue visible, marcado.
  El dueño puede anular cualquier movimiento; el encargado, solo los registrados por él y del mismo día,
  para que no pueda borrar las ventas de días anteriores.
- El nombre del producto es único por negocio sin distinguir mayúsculas (índice sobre `lower(nombre)`).
- Al registrar un movimiento, la fila del producto se bloquea (`SELECT … FOR UPDATE`) hasta guardar:
  dos ventas simultáneas se atienden una tras otra y el stock nunca queda negativo.

## Equipo del negocio

El dueño genera un **código de invitación** desde la pantalla **Equipo** y se lo pasa a su empleado
(por WhatsApp, dictándoselo o con el enlace que la misma pantalla copia). Quien lo recibe entra con él,
tenga cuenta o no.

- El código sirve **una sola vez** y vence a los **7 días**. En la base solo se guarda su hash, así que
  solo se ve una vez, al crearlo.
- El rol (dueño o encargado) lo decide quien invita.
- El dueño puede cancelar una invitación sin usar y quitar a alguien del negocio; quien es quitado deja
  de ver ese negocio en el acto, y los movimientos que registró se conservan.
- Nadie puede quitarse a sí mismo: así siempre queda al menos un dueño.

## Decisiones y atajos conscientes

| Hoy | Por qué | Siguiente paso |
|---|---|---|
| Intérprete por reglas como respaldo, y la IA vía n8n opcional (`STOCKVOZ_IA=1`) | Funciona sin claves de API ni costos y es fácil de probar | Armar el flujo de n8n según [docs/contrato-n8n.md](docs/contrato-n8n.md) y elegir el modelo con `npm run evaluar -- --ia` |
| Web Speech API del navegador | Dictado gratis en Chrome/Edge | Procesar audio en el servidor (por ejemplo Whisper) si se necesita en otros navegadores o en WhatsApp |
| Una operación por frase | Suficiente para el MVP | Frases compuestas («vendí 3 y se dañaron 2») |

## Qué sigue, por rol del equipo

- **Backend y base de datos (Gabriel):** revisar el esquema de `migraciones/001_esquema_inicial.sql`; revisar la estrategia multi-tenant (filtrado por `negocio_id` en todas las consultas, o Row Level Security).
- **IA y automatización (Nicolás):** flujo en n8n que reciba el texto, llame al modelo de lenguaje y devuelva `{estado, tipo, producto, cantidad}`; usar las pruebas de `test/interprete.test.js` como casos de evaluación.
- **Frontend (Camilo):** convertir la interfaz en PWA instalable y probar con usuarios reales desde el celular.
- **UX y documentación (David):** pruebas de usabilidad con tenderos usando las cuentas demo; documentar los hallazgos de la investigación de usuarios y ajustar los textos de error.
