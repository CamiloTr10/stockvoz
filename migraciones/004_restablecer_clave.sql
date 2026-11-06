-- Códigos para cambiar la contraseña de quien la olvidó. StockVoz no manda correos, así que el
-- código lo genera el dueño del negocio (para alguien de su equipo) o quien administra el
-- servidor (para cualquiera, con npm run restablecer). Solo se guarda el hash, como con las
-- invitaciones: si alguien lee la base, no puede usarlos.
CREATE TABLE IF NOT EXISTS restablecimientos (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo_hash text NOT NULL UNIQUE,
  usuario_id integer NOT NULL REFERENCES usuarios(id),
  creado_por integer REFERENCES usuarios(id),   -- NULL: lo generó quien administra el servidor
  creado_en timestamptz NOT NULL,
  expira_en timestamptz NOT NULL,
  usado_en timestamptz
);
CREATE INDEX IF NOT EXISTS idx_restablecimientos_usuario ON restablecimientos (usuario_id);
