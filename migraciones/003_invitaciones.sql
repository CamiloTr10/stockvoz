-- Invitaciones: el dueño genera un código y se lo pasa a su empleado (por WhatsApp, dictado…).
-- Solo se guarda el hash del código, como con las sesiones: si alguien lee la base, no puede usarlos.
CREATE TABLE IF NOT EXISTS invitaciones (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo_hash text NOT NULL UNIQUE,
  negocio_id integer NOT NULL REFERENCES negocios(id),
  rol text NOT NULL CHECK (rol IN ('dueno', 'encargado')),
  creada_por integer REFERENCES usuarios(id),
  creada_en timestamptz NOT NULL,
  expira_en timestamptz NOT NULL,
  usada_en timestamptz,
  usada_por integer REFERENCES usuarios(id)
);
CREATE INDEX IF NOT EXISTS idx_invitaciones_negocio ON invitaciones (negocio_id);
