# Imagen de StockVoz para App Runner, ECS o cualquier servicio que corra contenedores.
#   docker build -t stockvoz .
#   docker run -p 3000:3000 -e DATABASE_URL=... -e STOCKVOZ_DEMO=0 -e STOCKVOZ_COOKIE_SEGURA=1 stockvoz
# La guía completa, con las variables y CloudFront, está en docs/despliegue-aws.md.

# Node 24: la app usa process.loadEnvFile() y FormData, que no existen en versiones viejas.
FROM node:24-alpine

WORKDIR /app

# NODE_ENV=production hace que la app se niegue a arrancar con las cuentas de demostración
# encendidas (su clave está publicada en el README). Hay que pasar STOCKVOZ_DEMO=0.
ENV NODE_ENV=production

# Primero las dependencias, para que Docker reutilice esta capa si solo cambia el código.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Solo lo que el servidor necesita: ni pruebas, ni el banco de frases, ni el flujo de n8n.
COPY servidor.js ./
COPY src ./src
COPY public ./public
COPY migraciones ./migraciones
COPY admin ./admin

# Sin permisos de administrador dentro del contenedor.
USER node
EXPOSE 3000
CMD ["node", "servidor.js"]
