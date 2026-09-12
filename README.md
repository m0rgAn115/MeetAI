# Meet Agent

Asistente silencioso para Google Meet con memoria organizacional temporal,
recuperación trazable y acciones externas confirmadas por una persona.

La arquitectura encontrada y las decisiones de integración están documentadas
en [`docs/contextual-memory-architecture.md`](docs/contextual-memory-architecture.md).

## Componentes

- Extensión Chrome MV3: observa subtítulos y chat finalizados, mantiene una sola
  tarjeta contextual y envía feedback.
- Express + TypeScript: recibe eventos de transcripción, coordina el Live
  Copilot, expone recuperación y confirma acciones.
- PostgreSQL/Supabase + pgvector: reuniones, evidencia, señales, grafo temporal,
  ACL, trabajos y acciones.
- Live Copilot: Observer y orquestador de intervención con salidas Zod.
- Memory Curator: proceso en segundo plano con cola PostgreSQL idempotente.
- Knowledge Retrieval: búsqueda híbrida, vigencia, ACL y expansión de un salto.
- Action Executor: preview persistido y ejecución de Calendar tras confirmación.

## Arranque real con Docker

El backend, PostgreSQL 16, pgvector y las migraciones están empaquetados en
Compose. El perfil predeterminado usa OpenAI y Google reales; no carga datos
demo ni simula Calendar.

Configura `.env` antes de arrancar:

```env
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-luna
OPENAI_CURATOR_MODEL=gpt-5.6-luna
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
DEMO_MODE=false
ALLOW_LOCAL_IDENTITY=true
SEED_DEMO_DATA=false
```

`ALLOW_LOCAL_IDENTITY=true` habilita una identidad local fija para probar en
una sola computadora sin construir todavía una pantalla de login. No lo uses
en un despliegue compartido.

```bash
docker compose up --build -d
docker compose ps
curl http://localhost:3000/health
```

La respuesta de salud debe indicar `openai-structured-output`, `calendar:
"google"`, `openAIConfigured: true` y `googleOAuthConfigured: true`.

En Google Cloud habilita **Google Calendar API** y **Google Drive API**. En el
cliente OAuth de tipo aplicación web registra exactamente este redirect URI:

```text
http://localhost:3000/auth/google/callback
```

Con los contenedores activos, abre `http://localhost:3000/auth/google` en el
navegador y concede acceso. Comprueba la sesión con:

```bash
curl http://localhost:3000/calendar/status
```

Debe responder `{"connected":true}`. La conexión OAuth se cifra y guarda en
PostgreSQL, y se restaura automáticamente al reiniciar los contenedores.

## Visor de memoria local

Con el stack Docker activo, abre `http://localhost:3000/memory-observer`.
Muestra el grafo de memorias, sus fuentes y relaciones, y una actividad en vivo
de creaciones, actualizaciones y recuperaciones. El visor conserva auditoría
completa en PostgreSQL para depuración y los puertos del Compose se publican
únicamente en localhost.

La extensión no es un proceso de servidor: Chrome exige cargarla como MV3.
Abre `chrome://extensions`, activa **Developer mode**, elige **Load unpacked**
y selecciona la carpeta `extension/`. Después abre Meet, activa sus subtítulos
y pulsa **Start Agent**. El backend queda publicado en `localhost:3000`.

Para inspeccionar el grafo y la actividad mientras pruebas, abre
`http://localhost:3000/memory-observer`.

Para detener sin borrar memoria usa `docker compose down`. Para eliminar además
el volumen PostgreSQL usa `docker compose down -v`.

## Configuración sin Docker

Requiere Node.js 22+, PostgreSQL con `pgvector`, una clave de OpenAI y, para
Drive/Calendar, credenciales OAuth de Google.

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run db:seed
npm run dev
```

Variables principales:

```env
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.6-luna
OPENAI_CURATOR_MODEL=gpt-5.6-luna
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres
DATABASE_SSL=false
SUPABASE_URL=
SUPABASE_JWT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
MEETING_INTERVENTION_BUDGET=4
CURATOR_POLL_INTERVAL_MS=1500
ALLOW_DEMO_IDENTITY=false
DEMO_MODE=false
```

Con Supabase, configura `SUPABASE_URL` para verificar JWT mediante JWKS. Para
un proyecto que todavía use el secreto JWT simétrico, configura
`SUPABASE_JWT_SECRET`. En un despliegue multiusuario establece
`ALLOW_LOCAL_IDENTITY=false`; cada petición debe llevar `Authorization: Bearer
<supabase-jwt>` y `x-workspace-id`.

## Demo completa sin servicios externos

La demo determinista recorre decisión anterior → posible cambio → evidencia →
aclaración neutral → sustitución temporal → preview Calendar → confirmación:

```bash
npm run demo-memory
```

Para probar la extensión contra el modo local sin PostgreSQL ni OpenAI:

```bash
DEMO_MODE=true ALLOW_DEMO_IDENTITY=true npm run dev
```

Después abre `chrome://extensions`, activa Developer mode, elige Load unpacked
y selecciona `extension/`. Abre Meet, habilita subtítulos y pulsa Start Agent.

Para conectar Google, con el backend activo abre:

```text
http://localhost:3000/auth/google
```

## Contratos HTTP principales

- `POST /meeting/start`
- `POST /events/transcript.segment.final` (`/analyze` permanece como alias)
- `POST /meeting/end`
- `POST /memory/retrieve`
- `POST /signals/:id/feedback`
- `POST /actions/calendar/propose`
- `POST /actions/:id/confirm`

Con autenticación Supabase activa, el `sub` verificado del JWT se usa como
usuario. Un `x-user-id` enviado por el cliente no puede sustituirlo.

Ejemplo de segmento final:

```json
{
  "meetingId": "uuid",
  "sequence": 14,
  "segmentId": "uuid",
  "speaker": "Ana",
  "text": "La entrega cambia del viernes al lunes.",
  "endedAt": "2026-09-12T16:30:00-06:00",
  "source": "meet_caption"
}
```

## Verificación

```bash
npm run typecheck
npm test
node --check extension/content.js
```

Las pruebas cubren los nueve escenarios de aceptación: compromiso con fuente,
documentos con permisos, hitos distintos, sustitución temporal, recuperación
vigente con historial, reintentos, ACL, confirmación de Calendar y baja
confianza.

Para observar el servicio durante una prueba real:

```bash
docker compose logs -f app
docker compose down          # conserva PostgreSQL
docker compose down -v       # borra PostgreSQL local
```

## Archivos principales

```text
migrations/001_contextual_memory.sql
src/contracts.ts
src/live-copilot.ts
src/memory-curator.ts
src/action-executor.ts
src/services/retrieval.ts
src/memory/postgres-store.ts
src/tool-contracts.ts
src/prompts/*.v1.ts
tests/memory.acceptance.test.ts
demo/seed.sql
src/demo.ts
```
