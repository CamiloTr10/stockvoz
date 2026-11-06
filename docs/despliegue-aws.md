# Publicar StockVoz en AWS

Guía para quien se encargue del despliegue. Está escrita para no tener que leer el código.

## Lo primero: qué es StockVoz

**No es un sitio estático.** Es un servidor Node que habla con PostgreSQL. Se compone de:

- un proceso Node (`node servidor.js`) que sirve la API y los archivos de `public/`;
- una base PostgreSQL 17, con los datos de los negocios;
- opcionalmente, un contenedor de n8n que traduce entre StockVoz y el modelo de lenguaje.

CloudFront **no puede ejecutar nada de eso**: es una red de distribución. Sirve archivos y reenvía
peticiones a un origen. Así que hace falta un origen que corra Node.

## Arquitectura mínima

```
Navegador → CloudFront → (origen) App Runner / ECS / EC2 → RDS PostgreSQL
                                        ↓
                                   n8n (opcional) → Groq
```

| Pieza | Qué usar | Notas |
|---|---|---|
| Origen | **App Runner** es lo más simple: le das el repositorio y él construye y escala | ECS Fargate o EC2 también sirven |
| Base de datos | **RDS PostgreSQL 17** | La app crea sus tablas sola al arrancar |
| CDN | **CloudFront** delante del origen | Configuración abajo; no es obligatorio para que funcione |
| n8n | Contenedor aparte, o **no usarlo** | Ver «Sobre n8n» |

No hace falta nada más. Sin Redis, sin colas, sin almacenamiento de archivos.

## Requisitos del origen

- **Node 24 o superior.** Usa `process.loadEnvFile()` y `FormData`, que no existen en versiones viejas.
- `npm ci` para instalar. La única dependencia es `pg`.
- Arranque: `npm start` (equivale a `node servidor.js`).
- Escucha en el puerto de `PORT`, o 3000. Se liga a todas las interfaces, así que funciona en contenedor.
- **Las migraciones se aplican solas al arrancar**, dentro de una transacción y con un bloqueo para
  que dos instancias simultáneas no se pisen. No hay que correr nada aparte.
- Atiende `SIGTERM`: termina las peticiones en curso y cierra la base antes de salir. Si alguna se
  cuelga, se rinde a los 10 segundos para no bloquear el despliegue.

## Comprobación de salud

```
GET /api/salud  →  200  {"estado":"ok","version":"0.1.0"}
```

Consulta la base de datos a propósito: una app que responde pero no puede leer el inventario no está
sana, y no tiene sentido seguir mandándole gente. Si la base está caída devuelve 500.

Configúralo como *health check path* en App Runner o en el grupo de destino del balanceador.

## Variables de entorno

Obligatorias:

| Variable | Valor | Por qué |
|---|---|---|
| `DATABASE_URL` | `postgres://usuario:clave@host-rds:5432/stockvoz` | — |
| `STOCKVOZ_DEMO` | **`0`** | Sin esto se crean cuentas de prueba cuya clave está publicada en el README. **La app se niega a arrancar si detecta que esto es producción y sigue encendida.** |
| `STOCKVOZ_COOKIE_SEGURA` | **`1`** | La cookie de sesión solo viaja por HTTPS |
| `NODE_ENV` | `production` | — |

Detrás de CloudFront o un balanceador:

| Variable | Valor | Por qué |
|---|---|---|
| `STOCKVOZ_PROXIES_CONFIABLES` | `1` o `2` | Cuántos saltos propios hay delante. Solo CloudFront → `1`. CloudFront más un balanceador → `2`. Sin esto, todas las peticiones parecen venir de la misma IP. **No lo pongas si no hay proxy**: cualquiera podría inventarse la cabecera. |

Para la interpretación con IA (opcionales; sin ellas la app usa su intérprete por reglas):

| Variable | Valor |
|---|---|
| `STOCKVOZ_IA` | `n8n` o `directo`. Ver «Sobre n8n» |
| `IA_CLAVE` | La clave de Groq. **Solo con `directo`** |
| `N8N_URL`, `N8N_SECRETO` | Webhook y secreto compartido. **Solo con `n8n`** |
| `STOCKVOZ_VOZ` | `1` para transcribir el dictado con Whisper. Reutiliza `IA_CLAVE` |

La lista completa, con sus valores por defecto, está en `.env.example` y en el README.

**Las claves no van en el repositorio.** En App Runner y ECS se configuran como secretos; lo ideal es
AWS Secrets Manager.

## CloudFront

Dos comportamientos, y el orden importa.

**1. `/api/*` — nada de caché.**

- *Cache policy*: la gestionada que desactiva la caché (`CachingDisabled`).
- *Origin request policy*: la que reenvía todo del visitante (`AllViewer`). Hace falta para que
  lleguen **las cookies**: sin ellas no hay sesión y nadie puede entrar.
- *Allowed methods*: GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE. Si faltan POST y PATCH, no se
  puede ni ingresar ni registrar movimientos.

**2. Todo lo demás — la caché normal** (`CachingOptimized`).

En los dos: *Viewer protocol policy* en **redirigir HTTP a HTTPS**.

### Dos detalles que muerden

**El dictado por voz manda hasta unos 2 MB** de JSON en un POST, y la transcripción puede tardar
hasta 20 segundos. Revisa que el tiempo de espera hacia el origen dé margen (el de CloudFront por
defecto es más corto de lo que parece y se puede subir) y que nada en el camino recorte el cuerpo de
la petición.

**Los archivos de `public/` se sirven con `Cache-Control: no-cache`**, así que CloudFront revalida
cada vez. Es seguro —nunca sirve una versión vieja tras un despliegue— pero desaprovecha casi toda la
caché. Si algún día molesta, la solución es ponerles un hash en el nombre, no subirles el TTL a
ciegas: el archivo `sw.js` del service worker cacheado de más deja la app pegada en una versión vieja.

## Sobre n8n

n8n es el orquestador que traduce entre StockVoz y el modelo de lenguaje. **Para publicar hay dos
caminos, y los dos funcionan igual de bien:**

| | `STOCKVOZ_IA=n8n` | `STOCKVOZ_IA=directo` |
|---|---|---|
| Qué hace | StockVoz → n8n → Groq | StockVoz → Groq |
| Qué hay que desplegar | Un contenedor más, con su volumen | Nada |
| Precisión | La misma | La misma |

Si el despliegue va justo de tiempo o de piezas, **`directo` es perfectamente válido**: solo necesita
`IA_CLAVE`. Lo medimos y da el mismo resultado, unos 100 ms más rápido.

Si se despliega n8n, el `compose.yml` del repositorio sirve de punto de partida, pero hay que cambiar
dos cosas: no exponer el puerto 5678 a internet, y poner `N8N_SECRETO` e `IA_CLAVE` desde el gestor de
secretos y no desde un `.env` en el disco.

### Cuánto aguanta el plan gratuito de Groq

El catálogo del negocio va completo en cada petición, así que el costo por frase crece con el
inventario. Medido: las instrucciones solas son unos 960 tokens y **cada producto cuesta 10,6**.

| Productos del negocio | Frases por minuto | Frases por día |
|---|---|---|
| 8 | 6 | ~157 |
| 100 | 3 | ~87 |
| 400 | 1 | ~37 |

Los topes del plan gratuito son 8.000 tokens por minuto y 200.000 por día. A partir de unos **640
productos una sola frase ya no cabe** en el límite por minuto.

**Esto no tumba la app.** Cuando Groq responde 429, StockVoz interpreta con su intérprete por
reglas, que acierta el 88 % del banco; está comprobado con un catálogo de 401 productos. Pero si el
negocio es grande y se quiere que interprete la IA de verdad, hace falta un plan de pago con más
tokens por minuto. Es una decisión de presupuesto, no un cambio de código: se cambia la clave y
nada más.

Aviso de diagnóstico: con `STOCKVOZ_IA=n8n`, un 429 de Groq se registra como «n8n respondió 500».
Si en los registros aparece eso de forma repetida, antes de buscar el problema en n8n hay que
mirar el consumo de Groq. Con `STOCKVOZ_IA=directo` el registro sí dice `cuota`.

## Antes de publicar

- [ ] `STOCKVOZ_DEMO=0`. La app se niega a arrancar si no, pero compruébalo igual.
- [ ] `STOCKVOZ_COOKIE_SEGURA=1` y HTTPS obligatorio en CloudFront.
- [ ] `STOCKVOZ_PROXIES_CONFIABLES` con el número de saltos que hay de verdad.
- [ ] La base de RDS **no** accesible desde internet; solo desde el origen.
- [ ] Claves en el gestor de secretos, nunca en el repositorio ni en la imagen.
- [ ] `/api/salud` configurado como comprobación de salud.
- [ ] `/api/*` sin caché y con las cookies reenviadas.
- [ ] Copias de seguridad automáticas de RDS encendidas.
- [ ] Entrar con una cuenta de verdad y registrar un movimiento. Si la IA no responde, la app debe
      seguir funcionando con su intérprete por reglas: eso es normal, no un fallo.

## Lo que no hay que hacer

- **No publicar con `STOCKVOZ_DEMO=1`.** Las cuentas `demo@stockvoz.test` y `encargado@stockvoz.test`
  usan una clave que está en el README, en un repositorio público.
- **No exponer el puerto de n8n** a internet. Solo lo llama StockVoz, por dentro.
- **No poner `STOCKVOZ_PROXIES_CONFIABLES`** si no hay un proxy delante de verdad: haría que
  cualquiera pudiera falsear su IP mandando una cabecera.
- **No cachear `/api/`.** Se servirían respuestas de un negocio a otro.

## Si algo falla

| Síntoma | Causa más probable |
|---|---|
| No se puede ingresar; la sesión se pierde al recargar | CloudFront no está reenviando las cookies en `/api/*` |
| «Ruta no encontrada» al guardar | Faltan POST/PATCH/DELETE en los métodos permitidos |
| La app no arranca y habla de cuentas de demostración | Falta `STOCKVOZ_DEMO=0` |
| Siempre dice que interpretó «por reglas» | Se acabó el cupo de Groq, o n8n no responde. **La app sigue funcionando**: es el respaldo haciendo su trabajo. Si el negocio tiene muchos productos, es lo normal con el plan gratuito: ver abajo |
| El dictado falla siempre | El POST de audio se está recortando, o el tiempo de espera es muy corto |
