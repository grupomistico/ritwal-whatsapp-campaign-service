# Grupo Mistico WhatsApp Campaign Service

Servicio seguro para preparar, probar, aprobar, enviar y medir campanas de WhatsApp por la API oficial de Meta.

## Principios

- La API de Meta queda detras de `x-tool-secret`.
- Toda mutacion exige un `x-actor-id` incluido en `AUTHORIZED_ACTORS`.
- Los telefonos y parametros se cifran en reposo.
- Una campana no puede enviarse sin prueba y aprobacion.
- La confirmacion de envio debe coincidir con el ID de campana.
- Los reintentos no vuelven a enviar destinatarios ya aceptados.
- `accepted` se reporta separado de `delivered`, `read` y `failed`.
- Las bajas y numeros no entregables alimentan supresiones permanentes.

## Uso local

```bash
npm install
cp .env.example .env
npm test
npm start
```

En otra terminal:

```bash
npm run masivoswpp -- account
npm run masivoswpp -- templates
npm run masivoswpp -- create --name son-cubano-julio --template soncubanojueves \
  --contacts ./private/audiencia.csv --actor-id 8474026326 --source precompro
npm run masivoswpp -- status GM-20260723-ABC123
```

Los comandos que cambian estado requieren `--actor-id` o
`MASIVOSWPP_ACTOR_ID`. `send` ademas exige:

```bash
npm run masivoswpp -- send GM-20260723-ABC123 \
  --actor-id 8474026326 --confirm GM-20260723-ABC123 \
  --idempotency-key GM-20260723-ABC123-v1
```

## CSV

Usar una columna `phone`, `telefono` o `whatsapp`. Para plantillas con
`{{nombre}}`, usar `first_name`, `firstName`, `name` o `nombre`. Los demas
parametros nombrados pueden ir como columnas con el mismo nombre.

Los CSV, bases, resultados crudos y `.env` estan excluidos de Git.

## Despliegue

```bash
npm run provision:dokploy
npm run deploy:dokploy
npm run smoke:production
npm run configure:webhook
```

El aprovisionamiento es idempotente: reutiliza proyecto, aplicacion, volumen y
dominio cuando ya existen. `configure:webhook` solicita el App Secret sin
mostrarlo, sincroniza Dokploy y registra el callback firmado en Meta.
