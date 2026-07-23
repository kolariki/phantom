# Phantom Download Worker — Setup

## 1. Instalar Wrangler CLI
```bash
npm install -g wrangler
wrangler login
```

## 2. Crear KV namespace
```bash
cd cloudflare-worker
wrangler kv:namespace create DOWNLOADS
```
Copiar el `id` que devuelve y pegarlo en `wrangler.toml` donde dice `id = ""`.

## 3. Configurar secrets
```bash
# Tu Stripe Secret Key (empieza con sk_live_ o sk_test_)
wrangler secret put STRIPE_SECRET_KEY

# Una clave admin para ver estadísticas (inventá una random)
wrangler secret put ADMIN_KEY
```

## 4. Deploy
```bash
wrangler deploy
```

Esto te da una URL tipo: `https://phantom-download.TU_SUBDOMAIN.workers.dev`

## 5. Actualizar success.html
En `docs/success.html`, cambiar:
```js
const WORKER_URL = 'https://phantom-download.YOUR_SUBDOMAIN.workers.dev';
```
Por tu URL real del worker.

## 6. Configurar Stripe redirect
En Stripe Dashboard → Payment Links → tu link → After payment:
- Redirect URL: `https://TU_DOMINIO/success.html?session_id={CHECKOUT_SESSION_ID}`

Stripe reemplaza `{CHECKOUT_SESSION_ID}` automáticamente por el ID real de la sesión.

## 7. Actualizar ALLOWED_ORIGIN
En `wrangler.toml`, cambiar `ALLOWED_ORIGIN` por tu dominio real:
```toml
ALLOWED_ORIGIN = "https://tudominio.com"
```

## Endpoints

### POST /validate
Valida un session_id de Stripe y devuelve el link de descarga (una sola vez).

```bash
curl -X POST https://phantom-download.xxx.workers.dev/validate \
  -H "Content-Type: application/json" \
  -d '{"session_id": "cs_live_xxx"}'
```

### GET /stats?key=TU_ADMIN_KEY
Estadísticas de descargas.

```bash
curl "https://phantom-download.xxx.workers.dev/stats?key=TU_ADMIN_KEY"
```

Respuesta:
```json
{
  "total_downloads": 6,
  "recent": [
    {
      "session_id": "cs_live_xxx",
      "customer_email": "user@email.com",
      "amount": 999,
      "currency": "usd",
      "used_at": "2026-05-13T...",
      "country": "AR"
    }
  ]
}
```

## Flujo completo
1. Usuario clickea "Comprar" → Stripe Checkout
2. Paga → Stripe redirige a `success.html?session_id=cs_xxx`
3. success.html muestra el botón de descarga
4. Click → POST al Worker con session_id
5. Worker valida con Stripe API → pago real → marca como usado en KV → devuelve URL del DMG
6. Segundo intento → Worker rechaza "already_used"
7. Sin session_id (acceso directo) → página muestra "Acceso no autorizado"
