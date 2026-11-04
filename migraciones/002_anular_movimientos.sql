-- Anular movimientos: el movimiento no se borra, se marca como anulado y el stock se devuelve.
-- Así el historial sigue cuadrando y queda registro de quién anuló y cuándo.
ALTER TABLE movimientos
  ADD COLUMN anulado_en timestamptz,
  ADD COLUMN anulado_por integer REFERENCES usuarios(id);
