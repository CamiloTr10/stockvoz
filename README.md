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
| `STOCKVOZ_PROXIES_CONFIABLES` | `0` | Cuántos proxies propios hay delante (CloudFront, balanceador). Sin esto la IP del cliente se pierde; con esto de más, cualquiera podría falsearla |
| `STOCKVOZ_IA` | `0` | `n8n` o `directo` para interpretar con IA, con las reglas como respaldo (ver abajo) |
| `N8N_URL`, `N8N_SECRETO` | — | Webhook de n8n y secreto compartido (mínimo 16 caracteres). Obligatorias con `STOCKVOZ_IA=n8n` |
| `IA_CLAVE`, `IA_URL`, `IA_MODELO` | Groq / `gpt-oss-20b` | Clave y modelo del proveedor. `IA_CLAVE` es obligatoria con `STOCKVOZ_IA=directo` |
| `N8N_TIMEOUT_MS` | `6000` | Milisegundos que se espera a n8n antes de usar el respaldo |
| `STOCKVOZ_IA_LIMITE_DIARIO` | `500` | Interpretaciones con IA por negocio y día; pasado el tope se usan las reglas |
| `STOCKVOZ_VOZ` | `0` | `1` para transcribir el dictado en el servidor con Whisper en vez del dictado del navegador |
| `VOZ_CLAVE`, `VOZ_URL`, `VOZ_MODELO` | `IA_CLAVE` / Groq / `whisper-large-v3-turbo` | Proveedor de transcripción. Por defecto reutiliza la clave de la IA |
| `STOCKVOZ_VOZ_LIMITE_DIARIO` | `200` | Transcripciones por negocio y día |

**Dictado por voz:** funciona en Chrome y Edge (Web Speech API). El navegador envía el audio a su
servicio de reconocimiento y StockVoz solo recibe el texto. En otros navegadores se usa el campo de texto.

**Al publicar.** `STOCKVOZ_DEMO=0` es obligatorio: las cuentas de demostración usan una clave que está
en este README, a la vista de cualquiera. La app **se niega a arrancar** si detecta un despliegue
público con esas cuentas encendidas. El paso a paso completo para AWS está en
[docs/despliegue-aws.md](docs/despliegue-aws.md).

## Pruebas

```bash
cd stockvoz
node --test
```

137 pruebas: el intérprete de frases (53 casos vigilados, incluidas las frases con varias operaciones), las migraciones (4), el flujo de n8n generado (3), el módulo de IA con n8n y un proveedor simulados (24) y la API de punta a punta (aislamiento entre negocios,
roles, stock insuficiente, ventas simultáneas, anulaciones, invitaciones, exportación, archivos de la app instalable, validaciones, sesiones, CSRF, bloqueo por intentos fallidos, URLs malformadas y cabeceras de seguridad).
Las que usan la base lo hacen sobre `DATABASE_URL_PRUEBA` y se niegan a correr si esa base no termina en `_prueba`.

## Migraciones de la base de datos

Los cambios al esquema viven en `migraciones/`, un archivo por cambio: `001_esquema_inicial.sql`, `002_...sql`, etc.
Al arrancar, la aplicación aplica en orden las que faltan y deja registro en la tabla `migraciones`.

- Para cambiar el esquema, **crea un archivo nuevo** con el siguiente número. **Nunca edites uno ya aplicado**: en las bases que ya lo corrieron no se repetiría.
- Cada migración corre en una transacción: si falla, no queda nada a medias y la aplicación no arranca.
- Si dos procesos arrancan a la vez, un candado hace que uno espere al otro.

En GitHub corren solas en cada push y pull request (GitHub Actions, `.github/workflows/pruebas.yml`),
contra un PostgreSQL 17 temporal. El resultado aparece en la pestaña **Actions** del repositorio.

## Dictado por voz

El tendero puede dictar en vez de escribir. Hay dos motores, y la app elige solo:

| Motor | Cuándo se usa | Cómo funciona |
|---|---|---|
| **Whisper en el servidor** | Con `STOCKVOZ_VOZ=1` y un navegador que sepa grabar | El navegador graba el audio, StockVoz se lo manda a `whisper-large-v3-turbo` y devuelve el texto |
| **Web Speech API** | Si lo anterior no está disponible | El navegador transcribe; solo funciona en Chrome/Edge y el audio pasa por Google |

Whisper es el camino principal porque funciona en cualquier navegador y el audio no sale hacia el
servicio de voz del navegador. La Web Speech API queda como respaldo, igual que las reglas son el
respaldo de la IA: si el proveedor se cae, en Chrome se puede seguir dictando.

- **No pasa por n8n**, a diferencia de la interpretación. Transcribir es una sola llamada sin lógica,
  y meterla por n8n haría que una caída del contenedor dejara a la app sin voz **y** sin
  interpretación a la vez. El porqué está escrito en `src/voz.js`.
- **El audio viaja en base64 dentro del JSON**, no como binario, para que la ruta conserve la misma
  protección contra CSRF que el resto de la API (solo se acepta `application/json`).
- Tope de 1,5 MB por grabación y corte automático al minuto, para no gastar cuota por un micrófono
  que quedó abierto. Si algo falla, el mensaje siempre ofrece escribir la instrucción a mano.
- Cupo del plan gratuito de Groq: 2.000 transcripciones al día, aparte del cupo de la interpretación.

### Recoger frases de tenderos

En `#/recolectar` hay una herramienta interna, **sin enlace en el menú a propósito**: no es una
función para el tendero, es la máquina de armar el banco de pruebas.

El ciclo es: grabar al tendero → ver la transcripción y corregirla si Whisper se equivocó → ver qué
entendió StockVoz → corregirlo → guardar el caso. Al final se descarga un JSON con el mismo formato
de `evaluacion/casos.json`, listo para mezclar. **No registra ningún movimiento.**

Las frases viven en el navegador hasta que se descargan, así que hay que descargarlas antes de
cerrar o de cambiar de equipo.

Esto existe porque el banco actual lo escribimos nosotros, y ese es el punto más débil del proyecto:
ver [docs/plan-hasta-la-sustentacion.md](docs/plan-hasta-la-sustentacion.md).

## Interpretación con IA y evaluación

Por defecto cada frase la interpreta `src/interprete.js` (reglas, gratis y sin conexión). Con la IA encendida,
`POST /api/interpretar` se la pasa a un modelo de lenguaje. Hay dos modos:

| `STOCKVOZ_IA` | Cómo llega la frase al modelo | Para qué |
|---|---|---|
| `n8n` | StockVoz → flujo de n8n → modelo | La arquitectura que define el proyecto |
| `directo` | StockVoz → API compatible con OpenAI (Groq, DeepSeek…) | Medir modelos sin montar n8n, y como respaldo si n8n no está disponible |

Las instrucciones y el esquema que recibe el modelo están en `src/ia-instrucciones.js`, en un solo lugar
para que el flujo de n8n y el modo directo usen exactamente lo mismo. En los dos modos:

- **La IA solo propone.** El backend valida la respuesta: solo acepta productos del catálogo del propio negocio, cantidades válidas y campos coherentes con el estado. Después el usuario confirma y `POST /api/movimientos` guarda, igual que siempre.
- **Diminutivos y aumentativos.** «Gaseositas», «borradorcitos», «arrocito», «gaseosotas»: el tendero
  los usa todo el tiempo y no cambian el producto. Las reglas los resuelven quitando el afijo y
  probando la palabra base (`basesPosibles` en `src/interprete.js`); al modelo además se le dice.
- **Varias operaciones en una frase.** «Vendí 2 borradores y compré 3 lápices» son dos operaciones, y se muestran como dos filas que el usuario revisa, corrige o quita antes de confirmar. Se guardan de a una y en orden: si una no cabe en el stock, las demás sí se guardan y se dice cuál falló y por qué. El diseño y por qué se decidió así están en [docs/diseno-varias-operaciones.md](docs/diseno-varias-operaciones.md).
- **Respaldo:** si el proveedor está caído, tarda más de `N8N_TIMEOUT_MS`, responde un error, devuelve algo inválido, se acaba su cuota o el negocio llegó a su límite diario, se usan las reglas y la interfaz sigue funcionando. La respuesta indica `fuente` (`ia` o `reglas`) y, si hubo respaldo, `motivoRespaldo`.
- **Formato garantizado:** con Groq se envía el esquema con `strict: true`, así que el modelo no puede responder otra cosa. Con proveedores que no lo admitan se usa `IA_ESQUEMA_ESTRICTO=0` y la validación del backend hace el resto.
- **El estado lo decide el backend.** El modelo aporta tipo, producto, cantidad y candidatos; si hay
  producto y cantidad es `ok`, si falta la cantidad es `sin_cantidad`, y así. Midiendo se vio que a
  veces los datos venían bien y la etiqueta mal, y rechazar toda la respuesta por eso desperdiciaba
  interpretaciones correctas.
- **Privacidad:** a n8n solo viajan la frase y los `id` y nombres de los productos del negocio. Sin precios, stock ni datos de personas.
- El formato exacto que debe recibir y devolver el flujo está en [docs/contrato-n8n.md](docs/contrato-n8n.md).

### Levantar n8n en local

El flujo de n8n **no se arma a mano**: se genera desde `src/ia-instrucciones.js`, para que el modo
directo y el flujo le manden exactamente lo mismo al modelo.

```bash
docker compose up -d              # n8n 2.46.6 en http://localhost:5678
npm run flujo                     # regenera n8n/flujo-stockvoz.json
```

Para cargarlo en n8n, con el contenedor arriba:

```bash
docker cp n8n/flujo-stockvoz.json stockvoz-n8n:/tmp/flujo.json
docker exec stockvoz-n8n n8n import:workflow --input=/tmp/flujo.json
docker exec stockvoz-n8n n8n publish:workflow --id=stockvozinterpreta
docker compose restart n8n
```

La primera vez hay que **crear la cuenta de dueño** en <http://localhost:5678>: hasta que exista,
n8n no registra los webhooks de producción y el flujo responde 404. Es una cuenta local, vive solo
en tu máquina.

**Los secretos nunca entran al flujo.** `compose.yml` le pasa `N8N_SECRETO` e `IA_CLAVE` al
contenedor desde el `.env` (que está en `.gitignore`), y el flujo los lee con `$env`. Por eso
`n8n/flujo-stockvoz.json` se puede subir al repositorio sin peligro; `test/flujo-n8n.test.js`
lo comprueba en cada corrida.

**Medir un intérprete.** `evaluacion/casos.json` es el banco de frases con su resultado esperado, agrupadas por categoría
(coloquial, números en letras, errores de dictado…). Son frases propuestas: hay que reemplazarlas y ampliarlas con frases reales de tenderos.

```bash
npm run evaluar            # intérprete por reglas (gratis)
npm run evaluar -- --ia    # la IA, según .env (gasta cuota de la API)
```

Muestra aciertos por categoría, tiempo por frase (mediana y p95), cuántas respondió la IA y cuántas cayeron al respaldo
(esas **no** cuentan como acierto de la IA) y la lista de fallos. Las frases marcadas `"regresion": true` también las vigila `node --test`.

### Medición del 5 de noviembre de 2026

Groq con `openai/gpt-oss-20b`, esquema estricto y `IA_ESFUERZO=low`:

| Categoría | Reglas | Groq |
|---|---|---|
| Frases de los wireframes | 100 % | 100 % |
| Números y mermas | 100 % | 100 % |
| Casos que el usuario debe resolver | 100 % | 100 % |
| Consultas | 75 % | **100 %** |
| Coloquial | 92 % | **100 %** |
| Números en letras | 57 % | **100 %** |
| Errores de dictado | 57 % | **100 %** |
| Nombres de producto | 100 % | 100 % |
| Varias operaciones en una frase | 100 % | **100 %** |
| Diminutivos y aumentativos | 90 % | sin medir |
| **Total** | **88 %** | **97 %** |

Tiempo por frase: mediana 751 ms, p95 1,3 s (el límite antes del respaldo son 6 s), medido por el flujo de n8n.

La columna de reglas son 67 de 76 frases, medidas hoy. El 97 % de Groq son 60 de 62, medido antes
de que el banco creciera. Los dos fallos de esa
corrida (no marcar como ambigua una «gaseosa» cuando hay dos en el catálogo, y leer «quedé sin
arroz» como una pregunta) se corrigieron después afinando las instrucciones, y esas frases ya pasan.

**Falta volver a correr el banco completo, ahora de 76 frases, con las instrucciones finales.** Se
acabó el cupo diario de Groq (200.000 tokens) y las diez frases con diminutivos **todavía no se han
medido con IA**: la única que alcanzó a pasar por el modelo, «vendí dos gaseositas de 400», salió
bien, pero una golondrina no hace verano.
Gasto: unos 900 tokens por frase, así que los 200.000 diarios del plan gratuito dan para unas 220 frases,
o sea unas tres corridas del banco completo por día. Pasado ese tope, Groq responde 429 y todo cae al
respaldo por reglas: la app sigue funcionando, pero ya no es la IA la que interpreta.

### Cuánto cabe: el catálogo contra el límite por minuto

El catálogo entero va en cada petición, así que cuanto más grande el negocio, más caro cada frase.
Medido el 5 de noviembre con nombres como los de una tienda de verdad («Gaseosa Postobón 1,5 L»):

| Productos | Tokens de entrada | Total por frase | Frases por minuto | Frases por día |
|---|---|---|---|---|
| 8 (el banco) | 1.049 | ~1.270 | 6 | ~157 |
| 100 | 2.018 | ~2.300 | 3 | ~87 |
| 400 | 5.192 | ~5.350 | 1 | ~37 |

Las tres filas de entrada son medidas; el resto sale de ellas. Las instrucciones solas son unos
960 tokens y **cada producto cuesta 10,6**, así que a partir de unos **640 productos una sola frase
ya no cabe** en el límite de 8.000 tokens por minuto, que Groq confirma en la cabecera
`x-ratelimit-limit-tokens`.

Esto no rompe nada, y se comprobó: con 401 productos, la primera frase la contesta la IA y las
siguientes caen al intérprete por reglas, **que las contesta bien igual**. Pero quiere decir que el
plan gratuito alcanza para el demo y para un negocio pequeño, no para una tienda surtida en hora
pico. Para eso hay que pagar un plan con más tokens por minuto, o mandarle al modelo solo una parte
del catálogo en vez de todo (lo segundo es gratis pero limita la precisión al acierto del filtro,
que es justo lo que la IA viene a mejorar).

**Ojo con este 100 %:** las 55 frases las escribimos nosotros, no son de tenderos reales. Sirve para
ver que el modelo entiende el español coloquial y los errores de dictado, no para decir que el
problema está resuelto. El banco hay que rehacerlo con frases grabadas de verdad.

## Estructura

```
stockvoz/
├── docs/              Documentación del proyecto (wireframes v1) y contrato con n8n
├── n8n/               Generador del flujo (generar-flujo.js) y el flujo listo para importar
├── evaluacion/          Banco de frases (casos.json) y script npm run evaluar
├── servidor.js          Servidor HTTP: rutas de la API, sesión por cookie y archivos de public/
├── migraciones/         Cambios del esquema de PostgreSQL, numerados (001_..., 002_...)
├── src/
│   ├── interprete.js    Frase en español → operación propuesta (tipo, producto, cantidad), por reglas
│   ├── ia.js            Interpretación con IA: validación de la respuesta y respaldo por reglas
│   ├── ia-instrucciones.js  Lo que recibe el modelo: instrucciones, esquema y cuerpo de la petición
│   ├── inventario.js    Reglas del inventario: productos, movimientos, panel y reportes
│   ├── auth.js          Cuentas, contraseñas (scrypt), sesiones, invitaciones y límite de intentos
│   ├── db.js            Pool de PostgreSQL, migraciones y transacciones
│   ├── entorno.js       Lectura del archivo .env
│   ├── demo.js          Datos de demostración
│   └── errores.js       Error con código HTTP
├── public/              Interfaz: index.html, app.css, app.js (JavaScript nativo),
│                       manifest.webmanifest, sw.js e iconos de la app instalable
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
| GET | `/api/movimientos.csv` | negocio | Descargar el historial (`?tipo=`, `?dias=` hasta 365) |
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

## App instalable (PWA)

StockVoz se puede instalar en el celular como una app: `public/manifest.webmanifest` y `public/sw.js`.
El navegador solo lo permite en **https o en localhost**, así que en el celular hace falta publicarla con HTTPS.

El service worker guarda **solo la interfaz** (HTML, CSS, JS e iconos) y usa primero la red: la copia
guardada se usa únicamente si no hay conexión, así nadie se queda con una versión vieja de la app.
**Nunca guarda respuestas de `/api/`**, porque mostrar un stock viejo sería peor que no mostrar nada.
Al cambiar la interfaz hay que subir el número de `CACHE` en `sw.js`.

Para comprobarlo: abre la app en Chrome, entra a *Herramientas de desarrollo → Application → Service Workers*
(debe aparecer activado) y *Manifest* (sin advertencias). Con *Offline* marcado, la app debe seguir abriendo.

## Exportar a CSV

Desde **Movimientos** se descarga el historial del periodo elegido (hasta un año, máximo 5000 filas)
con el filtro de tipo que esté puesto. El archivo está pensado para abrirlo en Excel:
separador `;`, marca de UTF-8 para que se vean las tildes y fin de línea CRLF.

Lo que empiece por `=`, `+`, `-` o `@` y no sea un número se escribe con una comilla delante: así
Excel no ejecuta como fórmula lo que alguien escribió en la frase de un movimiento.

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
| Intérprete por reglas como respaldo, y la IA vía n8n (`STOCKVOZ_IA=n8n`) | La app de un tendero no puede dejar de funcionar porque se cayó un proveedor | Rehacer el banco con frases grabadas a tenderos reales |
| Transcripción con Whisper en el servidor, y la Web Speech API como respaldo | Funciona en cualquier navegador y el audio no pasa por Google | Medir qué tan bien transcribe a tenderos reales, con grabaciones de verdad |
| Las reglas no entienden cantidades con decimales: «vendí 1,5 kilos de arroz» queda sin cantidad | Todo el inventario se mueve en unidades enteras, de la base de datos para arriba | Decidir primero si la app va a manejar fracciones; es un cambio de modelo de datos, no del intérprete |
| Por n8n, un 429 de Groq llega como «n8n respondió 500»: se pierde la diferencia entre gastar la cuota y un error de verdad. El modo directo sí la distingue (`cuota` vs `http`) | La app se comporta igual en los dos casos (cae a reglas), así que es un problema de diagnóstico, no de funcionamiento | Sacar el código del proveedor por la rama de error del nodo HTTP y responderlo, para que `src/ia.js` lo clasifique como `cuota` |

El calendario completo hasta la sustentación, con riesgos y plan B del demo, está en
[docs/plan-hasta-la-sustentacion.md](docs/plan-hasta-la-sustentacion.md).

## Qué sigue, por rol del equipo

- **Backend y base de datos (Gabriel):** revisar el esquema de `migraciones/001_esquema_inicial.sql`; revisar la estrategia multi-tenant (filtrado por `negocio_id` en todas las consultas, o Row Level Security).
- **IA y automatización (Nicolás):** el flujo de n8n ya está armado y generado desde `src/ia-instrucciones.js`; sigue afinar las instrucciones midiendo con `npm run evaluar -- --ia` contra frases reales.
- **Frontend (Camilo):** la PWA ya está; probarla instalada en un celular queda aplazado hasta que haya despliegue con HTTPS.
- **UX y documentación (David):** grabar frases de tenderos reales para rehacer `evaluacion/casos.json`, que hoy son frases nuestras. Es lo que más sube la nota por hora invertida. Luego, pruebas de usabilidad con las cuentas demo y ajustar los textos de error.
