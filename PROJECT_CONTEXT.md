# Meet Agent — contexto completo del proyecto

> Documento de contexto técnico y funcional generado a partir del estado del repositorio al 12 de septiembre de 2026.
>
> Proyecto ubicado en `MeetAI/`. La documentación de arquitectura de memoria está en [`docs/contextual-memory-architecture.md`](docs/contextual-memory-architecture.md) y las instrucciones de desarrollo están en [`CLAUDE.md`](CLAUDE.md).

## 1. Resumen ejecutivo

Meet Agent es un asistente silencioso para Google Meet. Observa subtítulos y mensajes de chat finalizados, identifica señales relevantes de la conversación y muestra una única tarjeta contextual cuando puede aportar información verificable o una acción útil.

El producto busca convertir conversaciones efímeras en memoria organizacional temporal y trazable:

- Detecta compromisos, decisiones, cambios, riesgos, preguntas y referencias a documentos o correos.
- Recupera contexto anterior respetando vigencia temporal, workspace, proyecto, participantes y permisos.
- Conserva la evidencia original y el historial: una decisión nueva reemplaza a la anterior sin borrarla.
- Sugiere eventos de Google Calendar, pero solo ejecuta una acción externa después de confirmación explícita.
- Permite buscar Gmail/Drive y preparar borradores de correo; el envío de Gmail también requiere clic de la persona.
- Registra auditoría del grafo de memoria y ofrece un visor local en tiempo real.

La implementación actual es un MVP funcional con extensión Chrome MV3, backend Express/TypeScript y PostgreSQL con pgvector. La captura de audio propia, diarización y STT no están implementados todavía; el contrato estable ya está preparado para recibir futuros segmentos provenientes de esa capa.

## 2. Problema y experiencia objetivo

En reuniones de seguimiento se repiten decisiones, fechas y compromisos, pero el contexto histórico suele quedar disperso en transcripciones, documentos y correos. Meet Agent escucha de forma discreta y solo interrumpe cuando la utilidad esperada supera el costo de distraer a la persona.

Experiencia principal:

1. La persona entra a una llamada de Google Meet.
2. La extensión detecta que está dentro de la llamada y puede iniciar el agente automáticamente; también existe un botón manual.
3. Se observan subtítulos y chat. Cada entrada se espera/debouncea y se envía como segmento final.
4. El backend analiza el segmento con un Observer estructurado.
5. Si la señal lo amerita, recupera memoria y evidencia autorizadas.
6. Un Orchestrator decide si permanece en silencio, informa, pregunta para aclarar o propone una acción.
7. La extensión presenta la tarjeta, evidencia, resultados y controles de feedback.
8. Las señales útiles se encolan para que el Memory Curator actualice la memoria de forma asíncrona.
9. Si se propone Calendar, primero se persiste un preview; solo la confirmación de la persona ejecuta Google Calendar.
10. Al terminar la reunión, el backend devuelve un cierre con decisiones, compromisos, preguntas, documentos y acciones pendientes.

## 3. Arquitectura

```text
Google Meet DOM
  ├─ subtítulos finales
  └─ chat finalizado
        │
        ▼
Extensión Chrome MV3 (content.js + styles.css)
        │ POST /events/transcript.segment.final
        │ (alias actual: POST /analyze)
        ▼
Express + TypeScript (src/server.ts)
        │
        ├─ guarda transcript_segments
        ├─ LiveCopilot
        │    ├─ Observer: señal + estado estructurado
        │    ├─ Retrieval híbrido con ACL y vigencia
        │    └─ Orchestrator: decisión de UX
        ├─ devuelve una tarjeta a la extensión
        └─ encola memory_jobs
              │
              ▼
        Memory Curator Worker
              ├─ recupera contexto existente
              ├─ propone mutaciones validadas
              └─ persiste el grafo en una transacción idempotente

Confirmación explícita
        │
        ▼
Action Executor
        └─ Google Calendar + evidencia de ejecución

PostgreSQL / pgvector
  reuniones · transcripciones · memorias · aristas · fuentes · señales
  acciones · cola · auditoría · conexiones OAuth cifradas
```

### Componentes

| Componente | Ubicación | Responsabilidad |
|---|---|---|
| Extensión | `extension/content.js`, `extension/styles.css`, `extension/manifest.json` | Integración con Meet, detección de llamada, lectura de captions/chat, tarjeta y feedback. |
| API | `src/server.ts` | HTTP, composición de dependencias, autenticación por petición y ciclo de vida. |
| Contratos | `src/contracts.ts` | Esquemas Zod y tipos compartidos de señales, estado, memoria, evidencia y acciones. |
| Live Copilot | `src/live-copilot.ts` | Observer y Orchestrator; ventana de segmentos, estado incremental y presupuesto de intervenciones. |
| Curator | `src/memory-curator.ts` | Worker en segundo plano, propuestas de memoria, validación e idempotencia. |
| Recuperación | `src/services/retrieval.ts`, `src/services/embeddings.ts` | Búsqueda de memorias y, opcionalmente, Drive/Gmail. |
| Persistencia | `src/memory/store.ts`, `src/memory/postgres-store.ts` | Abstracción `MemoryStore`; PostgreSQL es la implementación persistente. |
| Demo/test store | `src/memory/in-memory-store.ts` | Store en memoria para pruebas y demo sin base de datos. |
| Acciones | `src/action-executor.ts`, `src/calendar.ts` | Preview, conflicto, confirmación y ejecución idempotente en Calendar. |
| Google | `src/drive.ts`, `src/gmail.ts`, `src/calendar.ts` | OAuth y APIs de Drive, Gmail y Calendar. |
| Observabilidad | `src/memory-observer.ts`, `public/memory-observer.html` | Snapshot del grafo y actividad vía PostgreSQL LISTEN/NOTIFY + SSE. |
| Datos | `migrations/`, `demo/seed.sql`, `docker/` | Esquema, RLS, triggers de auditoría, bootstrap local y seed. |

## 4. Flujo de procesamiento en vivo

### 4.1 Inicio y fin de reunión

`POST /meeting/start` crea o recupera una reunión, registra título, URL y participantes, y fija la reunión activa por combinación workspace/usuario. La extensión conserva `meetingId`, `workspaceId` y `userId` para los eventos posteriores.

`POST /meeting/end` marca la reunión como `ended`, elimina la reunión activa, encola `meeting.ended` para el Curator y devuelve el cierre de 60 segundos junto con las acciones pendientes.

La extensión detecta la llamada buscando algunos `aria-label` de Meet y, como respaldo independiente del idioma, el icono Material `call_end`. Exige tres sondeos consecutivos sin detectar llamada antes de considerar que terminó. Una detención manual no se revierte automáticamente durante esa llamada.

### 4.2 Segmentos

La extensión observa cambios del DOM. Los subtítulos se agrupan por speaker y usan debounce de 1500 ms; el chat usa identificadores de mensaje, debounce de 800 ms y evita procesar el mismo mensaje dos veces.

El contrato de segmento final acepta:

```json
{
  "meetingId": "uuid",
  "sequence": 14,
  "segmentId": "uuid",
  "speaker": "Ana",
  "text": "La entrega cambia del viernes al lunes.",
  "endedAt": "2026-09-12T16:30:00-06:00",
  "source": "meet_caption",
  "currentDateTime": "...",
  "timeZone": "America/Mexico_City"
}
```

El backend persiste el texto original en `transcript_segments`, con secuencia única por reunión. Si no se envía secuencia, calcula la siguiente con base en el último segmento. El endpoint con nombre de evento es el contrato futuro para productores de `tabCapture` + STT; `/analyze` permanece por compatibilidad con la extensión.

### 4.3 Observer

El Observer recibe el segmento actual, hasta ocho segmentos recientes, estado breve y versión de prompt. En producción usa `@openai/agents` con salida estructurada Zod; en `DEMO_MODE=true` usa heurísticas deterministas.

Tipos de señal permitidos:

`commitment`, `decision`, `change`, `possible_contradiction`, `question`, `document_reference`, `email_search`, `email_draft`, `risk`, `topic_boundary` y `noop`.

El payload distingue la etapa `mentioned`, `proposed`, `decided`, `confirmed`, `executed` o `unknown`. No se debe convertir una mención en decisión ni una propuesta en compromiso. Una frase ambigua se registra como posible contradicción o pregunta, nunca como contradicción definitiva.

El estado incremental contiene: tema actual, decisiones activas, compromisos, preguntas abiertas, documentos referenciados, participantes, entidades relevantes y resumen acumulado.

### 4.4 Retrieval y Orchestrator

Cuando una señal lo requiere, `KnowledgeRetrievalService` genera embedding si hay clave de OpenAI y consulta el store con:

- workspace y membresía del usuario;
- proyecto y participantes opcionales;
- fecha `asOf`, `validFrom` y `validUntil`;
- estado `active` o `confirmed`;
- snapshot de permisos de cada fuente;
- búsqueda semántica + texto completo + confianza + importancia + actualidad;
- relaciones del grafo, con expansión máxima de un salto.

El ranking persistente pondera embedding `0.45`, texto `0.30`, confianza `0.10`, importancia `0.10` y actualidad `0.05`. El resultado incluye memoria, fuente, cita original, fecha, score y aristas recorridas.

Si se solicita, también consulta hasta tres resultados de Drive y Gmail y mezcla esos resultados con las memorias antes de limitar el conjunto final a diez elementos.

El Orchestrator recibe la señal y la evidencia, y usa silencio como opción predeterminada. Sus intervenciones posibles son `silent`, `informative`, `neutral_question`, `prior_evidence`, `propose_action` y `meeting_close`. El presupuesto por reunión se configura con `MEETING_INTERVENTION_BUDGET` y por defecto es cuatro.

### 4.5 Curator asíncrono

Cada segmento procesado genera un trabajo idempotente para `memory_jobs`. El worker hace polling cada `CURATOR_POLL_INTERVAL_MS` milisegundos, toma hasta cinco trabajos, incrementa intentos y procesa de forma serializada dentro del proceso.

El Curator puede proponer:

- `ADD`: crear una memoria atómica.
- `LINK`: crear relaciones entre memorias.
- `CONFIRM`: aumentar confianza y confirmar una memoria existente.
- `SUPERSEDE`: cerrar la vigencia anterior, crear una nueva y enlazarla con `reemplaza`.
- `CONTRADICT`: reservado para casos con revisión humana.
- `IGNORE`: conservar la señal, pero no crear memoria.

La capa determinista valida el esquema, impide alterar evidencia de transcripción, exige permisos en cada fuente y rechaza contradicciones sin revisión humana. Las mutaciones se guardan en una transacción; la clave única de workspace + idempotency key evita duplicados y reintentos seguros.

## 5. Modelo de datos

Migraciones aplicadas por `npm run db:migrate`:

1. `001_contextual_memory.sql`: entidades principales, índices, pgvector y RLS.
2. `002_memory_observer.sql`: auditoría del grafo y notificaciones PostgreSQL.
3. `003_google_oauth_tokens.sql`: tokens Google cifrados y políticas RLS.

### Tablas principales

| Tabla | Contenido |
|---|---|
| `workspaces` | Tenant lógico de la organización. |
| `app_users` | Usuarios locales vinculables a identidad externa. |
| `workspace_members` | Membresía y rol por workspace. |
| `meetings` | Reunión, estado vivo, resumen, participantes y contador de intervenciones. |
| `transcript_segments` | Evidencia textual final con secuencia única por reunión. |
| `memory_nodes` | Afirmaciones temporales con contenido, resumen, embedding, confianza, importancia y metadata JSONB. |
| `memory_edges` | Relaciones dirigidas entre memorias, por ejemplo `reemplaza`. |
| `memory_sources` | Procedencia, cita, reunión/segmento, documento y snapshot de permisos. |
| `meeting_signals` | Señales del Observer, confianza, urgencia, novedad, evidencia y feedback. |
| `proposed_actions` | Preview, payload, estado, confirmador, resultado y evidencia de ejecución. |
| `memory_jobs` | Cola idempotente para `meeting.ended`, señales y acciones completadas. |
| `mutation_batches` | Resultado persistido de cada lote de mutaciones idempotente. |
| `memory_activity_events` | Auditoría durable de creaciones, cambios, reemplazos, fuentes y recuperaciones. |
| `google_oauth_connections` | Tokens Google cifrados por workspace/usuario/proveedor. |

### Temporalidad e historial

`validUntil` significa cuándo deja de ser vigente una afirmación; no es una fecha límite de entrega. Al hacer `SUPERSEDE`, la memoria anterior pasa a `superseded`, se cierra su `valid_until` con la fecha de la nueva evidencia y se crea una arista `reemplaza`. El texto y la fuente originales permanecen navegables.

### Seguridad de fuentes

Cada fuente tiene `permissions_snapshot`. Una fuente con visibilidad `workspace` es accesible a miembros; una fuente restringida requiere que el usuario aparezca en `allowedUserIds`. PostgreSQL RLS aplica membresía y usuario mediante `app.user_id`; la recuperación además filtra las fuentes antes de devolver memorias.

## 6. API HTTP

Todas las rutas de negocio llaman `authenticateRequest`. En producción se espera `Authorization: Bearer <JWT>` y `x-workspace-id`; el `sub` verificado del JWT es la identidad efectiva y no puede ser sustituido por `x-user-id`. La identidad local está pensada para desarrollo en una sola computadora.

| Método y ruta | Propósito | Resultado principal |
|---|---|---|
| `GET /health` | Estado del backend, persistencia, modelos y configuración. | JSON de salud. |
| `POST /meeting/start` | Crear/iniciar reunión. | `meetingId`, workspace, usuario y `meetingActive`. |
| `POST /events/transcript.segment.final` | Procesar segmento final. | Evento para la extensión: señal, intervención, evidencia y acción propuesta. |
| `POST /analyze` | Alias de compatibilidad del endpoint anterior. | Igual que el endpoint estable. |
| `POST /meeting/end` | Finalizar reunión y encolar curator. | Cierre con decisiones, compromisos y pendientes. |
| `POST /memory/retrieve` | Recuperar memoria, opcionalmente Drive/Gmail. | `evidence[]`. |
| `POST /signals/:id/feedback` | Guardar `accepted`, `edited`, `dismissed` o `postponed`. | Confirmación simple. |
| `POST /actions/calendar/propose` | Persistir preview Calendar. | Acción `awaiting_confirmation`. |
| `POST /actions/:id/confirm` | Confirmar y ejecutar Calendar. | Acción `completed` y resultado Google. |
| `GET /auth/google` | Iniciar OAuth Google. | Redirección a Google. |
| `GET /auth/google/callback` | Guardar código y tokens. | Página de conexión exitosa. |
| `GET /calendar/status` | Consultar conexión Google en el proceso. | `{ connected: boolean }`. |
| `POST /drive/search` | Buscar archivos autorizados de Drive. | `files[]`. |
| `POST /gmail/search` | Buscar mensajes Gmail. | `messages[]`. |
| `POST /gmail/send` | Enviar un borrador tras acción explícita de la UI. | ID de mensaje/thread. |
| `GET /memory-observer` | Visor local del grafo. | HTML, solo localhost. |
| `GET /memory-observer/api/snapshot` | Snapshot de workspaces, nodos, aristas, fuentes y eventos. | JSON. |
| `GET /memory-observer/api/events` | Actividad en vivo. | Server-Sent Events. |

Las rutas antiguas `POST /calendar/create` y `PATCH /calendar/update` responden `410` para forzar el flujo de preview + confirmación.

## 7. Integraciones externas

### OpenAI

En modo normal, Observer, Orchestrator y Curator usan `@openai/agents` con prompts versionados y salidas estructuradas. `OPENAI_API_KEY` habilita embeddings con `text-embedding-3-small` por defecto; sin clave se usa `NullEmbeddingProvider` y la búsqueda queda basada en texto/heurísticas disponibles.

### Google OAuth, Calendar, Drive y Gmail

`src/calendar.ts` inicializa un cliente OAuth compartido. Los scopes configurados son:

- `calendar.events`
- `drive.metadata.readonly`
- `gmail.readonly`
- `gmail.send`

Los tokens se cifran con AES-256-GCM y se persisten en PostgreSQL; la clave se deriva de `OAUTH_TOKEN_ENCRYPTION_KEY` o, en el MVP local, de `GOOGLE_CLIENT_SECRET`. La conexión se restaura al reiniciar.

Calendar tiene gateway real y gateway simulado. Antes de proponer consulta conflictos en el calendario primario cuando hay conexión. La ejecución solo ocurre al confirmar una acción persistida y se registra evidencia del proveedor.

Drive busca por términos del nombre, con limpieza de palabras comunes, filtro opcional de fecha y fallback de coincidencia estricta a amplia. Gmail busca con la sintaxis de Gmail y obtiene metadata de hasta diez mensajes. El Observer prepara un borrador de correo; el endpoint de envío únicamente se llama desde la acción explícita de la UI.

## 8. Extensión Chrome

Es una extensión MV3 sin service worker propio. Se carga como `Load unpacked` desde `MeetAI/extension/` en `chrome://extensions`.

Permisos y alcance:

- `content_scripts` únicamente para `https://meet.google.com/*`.
- `host_permissions` para `http://localhost:3000/*`.
- La UI se inyecta en Meet y usa CSS propio.

La tarjeta contextual puede mostrar compromisos, acciones, cambios, contradicciones posibles, contexto, Drive, búsqueda de correo y borradores. Incluye controles de aceptar, editar, descartar y posponer; cada reacción se registra en `/signals/:id/feedback`.

Para Calendar, la UI propone y confirma eventos, guarda el ID del evento activo y puede actualizarlo con una nueva propuesta. Para Gmail, presenta destinatario/asunto/cuerpo y el usuario decide si envía. Para Drive, el botón de abrir conserva un estado local de archivos ya abiertos en esa sesión.

## 9. Configuración

La plantilla está en [`.env.example`](.env.example). No incluir secretos en este documento ni en el repositorio.

| Variable | Uso | Valor por defecto/nota |
|---|---|---|
| `PORT` | Puerto HTTP. | `3000`. |
| `DATABASE_URL` | PostgreSQL persistente. | Si falta, store en memoria no persistente. |
| `DATABASE_SSL` | SSL del pool pg. | `false` local; de otro modo usa certificado no verificado. |
| `DATABASE_POOL_SIZE` | Tamaño del pool. | `10`. |
| `OPENAI_API_KEY` | Modelos y embeddings. | Obligatoria para producción de IA. |
| `OPENAI_MODEL` | Observer/Orchestrator. | `gpt-5.6-luna`. |
| `OPENAI_CURATOR_MODEL` | Curator. | Usa su valor o `OPENAI_MODEL`. |
| `OPENAI_EMBEDDING_MODEL` | Embeddings. | `text-embedding-3-small`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth Google. | Necesarias para Calendar/Drive/Gmail. |
| `GOOGLE_REDIRECT_URI` | Callback OAuth. | `http://localhost:3000/auth/google/callback`. |
| `OAUTH_TOKEN_ENCRYPTION_KEY` | Cifrado persistente de tokens. | Recomendada explícitamente. |
| `SUPABASE_URL` | Verificación JWT vía JWKS. | Alternativa a secreto simétrico. |
| `SUPABASE_JWT_SECRET` | Verificación JWT simétrica. | Usar solo si corresponde al despliegue. |
| `ALLOW_LOCAL_IDENTITY` | Identidad fija local. | `true` en Compose por comodidad; desactivar en multiusuario. |
| `LOCAL_WORKSPACE_ID` | Workspace de la identidad local. | UUID fijo `...0001`. |
| `LOCAL_USER_ID` | Usuario de la identidad local. | UUID fijo `...0002`. |
| `LOCAL_USER_EMAIL` | Usuario inicial del bootstrap. | `local@example.com`. |
| `DEMO_MODE` | Heurísticas + Calendar simulado. | `false`. |
| `ALLOW_DEMO_IDENTITY` | Identidad demo sin auth. | Solo demo explícita. |
| `MEETING_INTERVENTION_BUDGET` | Máximo de intervenciones por reunión. | `4`. |
| `CURATOR_POLL_INTERVAL_MS` | Frecuencia del worker. | `1500`. |
| `SEED_DEMO_DATA` | Carga seed al arrancar Docker. | El Compose lo pasa como `false` por defecto; el entrypoint usa `true` si la variable no existe. |

## 10. Ejecución

### Docker recomendado

Requisitos: Docker y credenciales configuradas en `.env`.

```bash
cd MeetAI
docker compose up --build -d
docker compose ps
curl http://localhost:3000/health
```

El stack levanta:

- `db`: `pgvector/pgvector:pg16`, publicado solo en `127.0.0.1:54322`.
- `app`: Node 22, publicado solo en `127.0.0.1:3000`.

El `Dockerfile` ejecuta `npm ci`, `npm run typecheck` y `npm test` durante el build. El entrypoint espera PostgreSQL, aplica migraciones, crea la identidad local si corresponde, carga seed opcional e inicia Express.

Con Google configurado, abrir `http://localhost:3000/auth/google` y conceder permisos. Validar con:

```bash
curl http://localhost:3000/calendar/status
```

Para cargar la extensión: `chrome://extensions` → Developer mode → Load unpacked → seleccionar `MeetAI/extension/`. Después abrir una llamada, habilitar subtítulos y dejar que el agente se inicie o pulsar el control manual.

### Ejecución local sin Docker

Requiere Node.js 22+, PostgreSQL con pgvector y las credenciales necesarias:

```bash
cd MeetAI
npm install
cp .env.example .env
npm run db:migrate
npm run db:seed
npm run dev
```

### Demo sin servicios externos

```bash
cd MeetAI
npm run demo-memory
```

La demo reproduce: memoria previa del viernes → pregunta/posible cambio → confirmación del lunes → `SUPERSEDE` → preview Calendar → confirmación con gateway simulado.

Para probar la extensión con heurísticas y store en memoria:

```bash
DEMO_MODE=true ALLOW_DEMO_IDENTITY=true npm run dev
```

## 11. Verificación y pruebas

Comandos principales:

```bash
npm run typecheck
npm test
node --check extension/content.js
```

La suite [`tests/memory.acceptance.test.ts`](tests/memory.acceptance.test.ts) cubre nueve escenarios:

1. Compromiso provisional con frase original.
2. Diferencia entre revisión ambigua y contradicción definitiva.
3. Recuperación de documento Drive con enlace y evidencia.
4. `SUPERSEDE` conserva la versión anterior y crea `reemplaza`.
5. Recuperación vigente devuelve la nueva versión con historial navegable.
6. Reintentos idempotentes no duplican nodos, fuentes ni resultados.
7. ACL restringe una memoria al usuario autorizado.
8. Calendar no ejecuta antes de confirmar y un reintento no duplica ejecución.
9. Baja confianza produce silencio y no se presenta como hecho.

Logs útiles:

```bash
docker compose logs -f app
```

El visor local está en `http://localhost:3000/memory-observer`. Muestra nodos, relaciones, fuentes, metadatos y hasta 250 eventos de actividad; usa SSE para actualizar creaciones, cambios, recuperaciones y eventos de auditoría en vivo.

## 12. Diseño de seguridad y límites actuales

Medidas implementadas:

- RLS para meetings, segmentos, memorias, aristas, fuentes, señales, acciones, auditoría y OAuth.
- Validación Zod en los bordes de IA y acciones.
- Evidencia de transcripción inmutable en el proceso de curación.
- Idempotencia en segmentos, jobs, lotes de mutaciones y acciones.
- Acciones externas separadas en preview y confirmación.
- Visor de memoria limitado a localhost.
- Puertos Docker publicados solo en localhost.
- No se entrega SQL, credenciales ni herramientas de escritura directa al modelo.

Limitaciones que deben considerarse antes de un despliegue compartido:

- `ALLOW_LOCAL_IDENTITY=true` habilita una identidad fija y no es apropiado para producción multiusuario.
- El callback OAuth actual usa IDs locales configurados; falta un `state` firmado para asociar de manera segura cada callback a workspace/usuario.
- El cliente OAuth de Google está compartido a nivel de proceso; la separación completa de tokens por usuario requiere completar el diseño multiusuario.
- Drive/Gmail usan la conexión OAuth global actual y no una credencial aislada por petición.
- La extensión depende de selectores internos del DOM de Meet; pueden cambiar por idioma o actualización de Meet.
- No hay `tabCapture`, documento offscreen, speech-to-text ni diarización propios.
- La expansión del grafo está limitada deliberadamente a un salto.
- Los umbrales y prompts deben calibrarse con grabaciones reales y métricas de precisión por tipo de señal.
- Deben añadirse métricas operativas, límites de rate, manejo robusto de expiración OAuth y una interfaz de login para un despliegue real.

## 13. Siguiente iteración recomendada

1. Añadir `tabCapture` + offscreen document + STT con diarización manteniendo `transcript.segment.final`.
2. Implementar OAuth multiusuario con `state` firmado, scopes separados y tokens asociados a la identidad autenticada.
3. Sustituir la detección frágil del DOM por adaptadores versionados y pruebas contra variantes de Meet.
4. Añadir métricas de precisión, latencia, tasa de intervención útil y feedback por señal.
5. Calibrar ranking híbrido, umbrales de confianza y presupuesto de interrupciones.
6. Añadir backoff persistente/visibility timeout más completo para la cola y observabilidad operativa.
7. Definir políticas de retención, borrado solicitado y auditoría de datos sensibles.
8. Evaluar contenido acotado de Drive con permisos actuales si el producto necesita algo más que metadata/enlaces.

## 14. Estructura del repositorio

```text
MeetAgent_Hackathon/
├── README.md
└── MeetAI/
    ├── PROJECT_CONTEXT.md              # Este documento
    ├── README.md                      # Instalación, demo y comandos rápidos
    ├── CLAUDE.md                      # Convenciones de commits y Gitflow
    ├── package.json                   # Scripts y dependencias
    ├── Dockerfile
    ├── compose.yaml
    ├── .env.example
    ├── docker/
    │   ├── entrypoint.sh
    │   └── bootstrap-local.sql
    ├── migrations/
    │   ├── 001_contextual_memory.sql
    │   ├── 002_memory_observer.sql
    │   └── 003_google_oauth_tokens.sql
    ├── demo/
    │   └── seed.sql
    ├── extension/
    │   ├── content.js
    │   ├── manifest.json
    │   └── styles.css
    ├── public/
    │   └── memory-observer.html
    ├── src/
    │   ├── server.ts
    │   ├── contracts.ts
    │   ├── auth.ts
    │   ├── db.ts
    │   ├── agent.ts                    # Flujo legacy/CLI original
    │   ├── live-copilot.ts
    │   ├── memory-curator.ts
    │   ├── action-executor.ts
    │   ├── calendar.ts
    │   ├── drive.ts
    │   ├── gmail.ts
    │   ├── memory-observer.ts
    │   ├── tool-contracts.ts
    │   ├── memory/
    │   │   ├── store.ts
    │   │   ├── postgres-store.ts
    │   │   └── in-memory-store.ts
    │   ├── services/
    │   │   ├── embeddings.ts
    │   │   └── retrieval.ts
    │   └── prompts/
    │       ├── live-copilot.v1.ts
    │       └── memory-curator.v1.ts
    └── tests/
        └── memory.acceptance.test.ts
```

## 15. Convenciones de desarrollo

Según [`CLAUDE.md`](CLAUDE.md), los cambios deben organizarse con Gitflow y commits atómicos, con mensaje corto en español y sin co-author. Para esta documentación, el cambio previsto es un único commit atómico de documentación.
