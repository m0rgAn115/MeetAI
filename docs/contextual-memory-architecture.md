# Arquitectura de memoria contextual

## Arquitectura encontrada

El proyecto original era un MVP de dos piezas: una extensión Chrome MV3 con un
content script y un servidor Express en TypeScript. La extensión observaba el
DOM de subtítulos y chat de Google Meet, aplicaba debounce y enviaba cada texto
a `POST /analyze`. Aunque el contexto del producto menciona `chrome.tabCapture`,
el repositorio no contenía captura de audio ni speech-to-text propio.

El backend usaba un único `Agent` de `@openai/agents` con salida Zod. Guardaba
toda la transcripción en un array global y la reenviaba en cada llamada. Drive
y Calendar compartían un cliente OAuth; los tokens, la sesión de reunión y la
memoria vivían en el proceso. No había base de datos, usuarios, workspaces ni
aislamiento por tenant.

## Arquitectura implementada

```text
Subtítulo final / futuro adaptador tabCapture+STT
        │
        ▼
transcript.segment.final
        ├── PostgreSQL: segmento original e identidad monotónica
        ├── Live Copilot / Observer (Structured Output)
        │       └── señal tipada + estado incremental
        │               ├── silencio
        │               └── Retrieval híbrido con ACL
        │                       └── Orquestador de UX (Structured Output)
        │                               └── una tarjeta visible
        └── memory_jobs (cola idempotente)
                └── Memory Curator (Structured Output)
                        └── propuestas validadas
                                └── transacción determinista del grafo

confirmación explícita
        └── Action Executor
                └── Google Calendar + evidencia de ejecución
                        └── memory_jobs: action.completed
```

`LiveCopilot` conserva una ventana de ocho segmentos, un resumen incremental y
estado estructurado por reunión. Observer y orquestador son interfaces
separadas y usan agentes distintos; no comparten a ciegas una conversación del
modelo. El Curator solo consume eventos persistidos y nunca produce UI.

`MemoryStore` es la abstracción del grafo. La implementación principal usa
PostgreSQL/pgvector; `InMemoryMemoryStore` existe para pruebas y demo local. No
se añadió Neo4j ni Trigger.dev. La cola PostgreSQL usa `FOR UPDATE SKIP LOCKED`,
reintentos con backoff y claves únicas, suficiente para el MVP actual.

El paquete Docker usa `pgvector/pgvector:pg16` y una imagen Node 22. El entrypoint
espera PostgreSQL, aplica migración y seed idempotentes, y luego inicia Express.
El build falla si typecheck o los escenarios de aceptación fallan.

## Decisiones de diseño

- El significado vive en texto y `metadata` JSONB; no hay enum de tipos de
  memoria ni de relaciones.
- Procedencia, tenant, identidad, tiempo y permisos sí tienen columnas
  obligatorias al escribir.
- `SUPERSEDE` cierra `valid_until`, marca la versión previa y crea una arista
  `reemplaza`; nunca borra la historia.
- `possible_contradiction` queda como señal. Una mutación `CONTRADICT` sin
  revisión humana se rechaza.
- La recuperación pondera embedding, texto, confianza, importancia y
  actualidad; filtra primero workspace, proyecto, participantes, vigencia y
  ACL. Expande un solo salto y devuelve la arista recorrida y la cita original.
- El modelo no recibe SQL ni credenciales. Las funciones internas están
  documentadas en `src/tool-contracts.ts`.
- Calendar tiene dos fases persistidas: propuesta/preview y confirmación. Las
  rutas antiguas de escritura responden `410` para impedir ejecución directa.
- La identidad de producción usa un JWT Supabase verificado y el workspace se
  vuelve a validar contra `workspace_members`. La identidad por headers solo
  está disponible en el modo de demo explícito.

## Puntos de integración

- `POST /events/transcript.segment.final` es el contrato estable para cualquier
  productor de STT. `POST /analyze` es un alias para la extensión existente.
- `src/live-copilot.ts` contiene las dos interfaces lógicas del camino en vivo.
- `src/services/retrieval.ts` combina memoria y resultados autorizados de
  Drive, siempre como evidencia trazable.
- `src/memory-curator.ts` consume `memory_jobs` y entrega mutaciones a la capa
  transaccional.
- `src/action-executor.ts` prepara y confirma acciones externas.
- `extension/content.js` mantiene una tarjeta activa, presenta frase actual y
  evidencia previa, y registra aceptar/editar/descartar/posponer.

## Seguridad

La migración activa RLS en reuniones, segmentos, señales, memorias, fuentes,
aristas y acciones. Las políticas usan `app.user_id` y membresía del workspace.
Además, cada fuente aplica su `permissions_snapshot`; una fuente restringida
solo aparece si `allowedUserIds` contiene al usuario verificado. Las búsquedas
de Drive usan el OAuth del usuario que Google ya autorizó.

La conexión OAuth de Google se cifra y persiste en PostgreSQL por workspace y
usuario, incluido el refresh token. El MVP local restaura esa conexión al
arrancar; un despliegue multiusuario todavía debe asociar el callback mediante
un parámetro `state` firmado.

## Estado de las diez fases

1. Inspección y arquitectura: completada.
2. Migración y contratos: completada.
3. Eventos y evidencia: completada.
4. Recuperación híbrida: completada.
5. Live Copilot estructurado: completada.
6. Curator asíncrono: completada con cola PostgreSQL.
7. Persistencia transaccional e idempotente: completada.
8. Tarjeta contextual: completada.
9. Confirmación de acciones: completada.
10. Pruebas y demo determinista: completada.

## Limitaciones y siguiente iteración

- La captura real del repositorio sigue basada en subtítulos/chat del DOM. El
  endpoint de segmentos ya desacopla esta capa; la siguiente iteración debe
  añadir un service worker/offscreen document para `chrome.tabCapture` y un STT
  con diarización, manteniendo el mismo evento final.
- OAuth debe incluir `state` firmado antes de un despliegue multiusuario.
- La expansión del grafo está limitada a un salto de forma deliberada.
- La demo heurística permite trabajar sin claves. Los prompts versionados deben
  evaluarse con grabaciones reales antes de fijar umbrales de producción.
- Conviene añadir métricas de precisión por tipo de señal y calibrar el
  presupuesto de intervenciones con el feedback registrado.
