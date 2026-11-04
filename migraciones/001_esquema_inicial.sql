-- Esquema de la Fase 1. No se edita: los cambios nuevos van en una migración nueva.
CREATE TABLE IF NOT EXISTS negocios (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre text NOT NULL,
  creado_en timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS usuarios (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre text NOT NULL,
  correo text NOT NULL UNIQUE,
  clave_hash text NOT NULL,
  creado_en timestamptz NOT NULL
);
-- Un usuario puede trabajar en varios negocios con un rol distinto en cada uno.
CREATE TABLE IF NOT EXISTS membresias (
  usuario_id integer NOT NULL REFERENCES usuarios(id),
  negocio_id integer NOT NULL REFERENCES negocios(id),
  rol text NOT NULL CHECK (rol IN ('dueno', 'encargado')),
  PRIMARY KEY (usuario_id, negocio_id)
);
CREATE TABLE IF NOT EXISTS sesiones (
  token_hash text PRIMARY KEY,
  usuario_id integer NOT NULL REFERENCES usuarios(id),
  negocio_id integer REFERENCES negocios(id),
  expira_en bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS productos (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  negocio_id integer NOT NULL REFERENCES negocios(id),
  nombre text NOT NULL,
  precio integer NOT NULL DEFAULT 0 CHECK (precio >= 0),
  stock integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  stock_minimo integer NOT NULL DEFAULT 0 CHECK (stock_minimo >= 0),
  activo boolean NOT NULL DEFAULT true
);
-- "Pan tajado" y "pan tajado" son el mismo producto dentro de un negocio.
CREATE UNIQUE INDEX IF NOT EXISTS uq_productos_negocio_nombre ON productos (negocio_id, lower(nombre));
-- El stock solo cambia por movimientos: cada fila deja rastro de quién, cuándo y desde qué frase.
CREATE TABLE IF NOT EXISTS movimientos (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  negocio_id integer NOT NULL REFERENCES negocios(id),
  producto_id integer NOT NULL REFERENCES productos(id),
  usuario_id integer REFERENCES usuarios(id),
  tipo text NOT NULL CHECK (tipo IN ('venta', 'entrada', 'merma')),
  cantidad integer NOT NULL CHECK (cantidad > 0),
  precio_unitario integer NOT NULL,
  stock_resultante integer NOT NULL,
  origen text NOT NULL CHECK (origen IN ('voz', 'texto', 'manual', 'inicial')),
  texto_original text,
  fecha_local date NOT NULL,
  creado_en timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movimientos_negocio_fecha ON movimientos (negocio_id, fecha_local);
