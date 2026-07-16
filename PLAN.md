# Manga Tracker — Plan de implementación

**Versión:** 2.1 (reconciliada con el repo real; ver `docs/GUIA-IMPLEMENTACION.md` para el paso a paso)
**Fecha:** julio 2026

> **Nota de reconciliación (v2.1):** el scaffold de `manga-tracker-api` ya está más avanzado que
> los ejemplos de código de la v2.0. Manda el repo real: `OpenAPIHono` + `createRoute` + Zod,
> `src/config.ts` como único lector de env, `src/db/client.ts`, y Prisma 7 con el generador nuevo
> `prisma-client`. Los bloques de código de abajo fueron corregidos para reflejarlo.

## Objetivo

Herramienta local en macOS que trackea automáticamente qué manga/manhwa se lee en cualquier sitio, en qué capítulo, y sobrevive al cambio de servidor de esos sitios. Datos en SQLite local, sin dependencia de servicios externos.

## Constraints críticos

1. **Backend siempre disponible sin acción manual del usuario.** LaunchAgent con `RunAtLoad` y `KeepAlive`. Se instala apenas el backend es funcional (Fase 3), no al final.
2. **Standalone.** Tres repos separados: `manga-tracker-api`, `manga-tracker-extension`, `manga-tracker-dashboard`. Sin monorepo.
3. **Tipos duplicados manualmente entre API y extensión.** Al tocar un contrato en la API, actualizar en la extensión en el mismo commit.
4. **Adapter oficial de Prisma.** `@prisma/adapter-libsql`, no adapters de comunidad. `better-sqlite3` no funciona en Bun.

## Stack (versiones pineadas a julio 2026)

| Componente | Versión | Uso |
|---|---|---|
| Bun | 1.3.14 | Runtime + package manager |
| Hono | 4.x | HTTP framework |
| Prisma | 7.x | ORM |
| @prisma/adapter-libsql | latest | Único adapter oficial soportado en Bun |
| SQLite | 3.46+ | DB (archivo local) |
| React | 19 | Extension popup + dashboard |
| Vite | 8 | Bundler (con Rolldown) |
| WXT | 0.20.x | Framework para la extensión (CLI con soporte Bun, manifest generado, HMR) |
| Manifest V3 | — | Único soportado por Chrome desde ago 2026 |

## Arquitectura

Tres componentes que corren en la Mac local:

**Backend API** (`manga-tracker-api`, puerto 5150)
Hono + Prisma + SQLite. Bind a `127.0.0.1` (no `0.0.0.0`). Recibe eventos de lectura, sirve endpoints REST, sirve el dashboard como estáticos.

**Extensión** (`manga-tracker-extension`, MV3)
Service worker (comunicación con backend), content script (detección de manga/capítulo), popup React (estado + calibración manual), overlay (calibración por click cuando la heurística falla).

**Dashboard** (`manga-tracker-dashboard`)
React 19 + Jotai + Vite. Build estático servido desde el backend en `/`. Al vivir en el mismo origen que la API (`http://localhost:5150`), no dispara el permiso Local Network Access de Chrome 142+.

**LaunchAgent**
`~/Library/LaunchAgents/com.mangatracker.plist`. Ejecuta el binario compilado del backend con `KeepAlive` + `RunAtLoad`. Backend arranca al login, se reinicia solo si crashea.

## Modelo de datos (schema.prisma)

```prisma
generator client {
  provider = "prisma-client"          // Prisma 7: generador nuevo (ESM, sin engine binario)
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "sqlite"
  // En Prisma 7 la URL vive en prisma.config.ts (env("DATABASE_URL")); en runtime la conexión
  // pasa por @prisma/adapter-libsql en src/db/client.ts. Ya NO hace falta previewFeatures.
}

model Manga {
  id             String         @id @default(uuid())
  canonicalName  String
  normalizedSlug String         @unique
  createdAt      DateTime       @default(now())
  events         ReadingEvent[]
}

model ReadingEvent {
  id            String   @id @default(uuid())
  mangaId       String
  chapterLabel  String   // Texto original: "Cap. 130.5", "Chapter 12", etc.
  chapterNumber Float?   // Parseado a número para ordenar. Null si no se pudo parsear.
  sourceUrl     String   // URL completa del capítulo
  sourceDomain  String   // "olympusxyz.com"
  readAt        DateTime @default(now())
  manga         Manga    @relation(fields: [mangaId], references: [id], onDelete: Cascade)

  @@index([mangaId, readAt(sort: Desc)])
}

model SiteAdapter {
  id              String   @id @default(uuid())
  domain          String   @unique
  titleSelector   String
  chapterSelector String?
  chapterUrlRegex String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}
```

### Por qué append-only

`ReadingEvent` es un log de eventos, no un campo mutable en `Manga`. Beneficios:

- Errores de detección se recuperan sin perder datos previos.
- El "último capítulo por manga" es una vista derivada (`GROUP BY mangaId, MAX(readAt)`), no un campo que hay que mantener consistente.
- Historial y estadísticas naturales sin diseño adicional.

### Por qué `normalizedSlug` único

`normalizeSlug()` lowercase + sin acentos + sin caracteres especiales + sin sufijos ("manga", "manhwa", "comic"). Deduplica automáticamente cuando el mismo manga se lee desde dos sitios con nombres levemente distintos. La búsqueda en `POST /api/events` es siempre por `normalizedSlug`, nunca por `canonicalName`.

## Flujo de datos

**Lectura típica** (todo automático, <100ms):
1. Content script chequea si el dominio tiene adapter guardado (`GET /api/adapters/:domain`).
2. Extrae `mangaName + chapterLabel` con el adapter o con heurística default.
3. Service worker envía `POST /api/events`.
4. Backend normaliza el nombre, deduplica el `Manga`, inserta el `ReadingEvent`.

**Primera visita a un sitio** (5-10 seg de intervención una sola vez):
1. Extensión pide permiso para el dominio vía `chrome.permissions.request()`.
2. Intenta heurística; si confianza < 0.7, muestra overlay de calibración.
3. Dos clicks (título + capítulo) → guarda `SiteAdapter`.
4. Próximas visitas: automáticas.

**Cambio de servidor** (sin acción manual):
- `Manga` y `ReadingEvent` sobreviven porque no dependen del dominio.
- Nuevo dominio → onboarding automático → `mangaName` normalizado matchea `Manga` existente → nuevo evento se vincula al mismo `Manga`.

## Plan por fases

Las fases 1-3 son bloque de setup: backend levantado, datos persistentes, ejecución automática. Después (Fases 4+) todo el trabajo es sobre la extensión y features, sin volver a tocar operación.

### Fase 1 — Backend con `/health` y CORS

Estado inicial (YA hecho en el repo): dependencias instaladas (`hono`, `@hono/zod-openapi`,
`@hono/swagger-ui`, `@prisma/client`, `@prisma/adapter-libsql`, `zod`), app construida con
`OpenAPIHono`, `/openapi.json` + `/docs`, y el slice `health` que responde `{ status: "ok" }`.

Estado en `src/index.ts` (toda ruta se define con `createRoute` + Zod, NO `Hono` plano):
- **Bind a `127.0.0.1`** — hecho (`hostname: "127.0.0.1"` en el `export default`).
- Puerto fijo `5150` — hecho (default en `src/config.ts`).
- `hono/cors` — allowlist con `http://127.0.0.1:5150`, `http://localhost:5150` y
  `chrome-extension://cfjiinlnepkmlaafdclmlpjbmpofplop` (id fijo de la extensión, ver Fase 4).
- Módulos montados bajo el prefijo `/api` — hecho (`health` queda en `/health`).

**Verificación:** `curl http://localhost:5150/health` responde `{ "status": "ok" }`, y solo desde
la propia Mac (127.0.0.1).

Docs: https://hono.dev/docs/getting-started/bun · https://hono.dev/docs/middleware/builtin/cors

### Fase 2 — Modelo de datos + endpoints CRUD

> **Estado (jul 2026): hecha.** Los cuatro slices (`events`, `library`, `adapters`,
> `duplicates`) están implementados con sus tests, más `src/lib/` (normalize + similarity).

1. Escribir `prisma/schema.prisma` con los tres modelos (ver sección "Modelo de datos").
2. Configurar `.env` con `DATABASE_URL="file:./data/mangatracker.db"`.
3. Migración inicial:
   ```bash
   mkdir -p data
   bunx prisma migrate dev --name init
   ```
4. `src/db/client.ts` (YA existe; lee la URL vía `src/config.ts`, único lector de env):
   ```typescript
   import { PrismaLibSql } from "@prisma/adapter-libsql";
   import { config } from "../config";
   import { PrismaClient } from "../generated/prisma/client";

   const adapter = new PrismaLibSql({ url: config.databaseUrl });
   export const prisma = new PrismaClient({ adapter });
   ```
   > Verificado (jul 2026): el nombre exportado por `@prisma/adapter-libsql` es `PrismaLibSql`
   > — el repo ya lo importa así y `bun run typecheck` pasa.
5. Endpoints, agrupados en **vertical slices** (`src/modules/<feature>/` con
   `*.routes.ts` + `*.service.ts` + `*.test.ts`; las rutas solo validan/mapean, la lógica va al
   servicio):
   - **`events/`** → `POST /api/events` — recibe lectura, deduplica `Manga` por `normalizedSlug`,
     inserta evento (append-only; nunca hace retroceder el progreso).
   - **`library/`** → `GET /api/library` (progreso alcanzado = `MAX(chapterNumber)` + última
     actividad), `GET /api/mangas/:id/history`, `PUT /api/mangas/:id` (corrige solo el
     `canonicalName` visible; NO toca `normalizedSlug`).
   - **`adapters/`** → `GET /api/adapters/:domain`, `POST /api/adapters` (upsert por `domain`).
   - **`duplicates/`** → `GET /api/duplicates` (solo detección; ver Fase 9).
6. `src/lib/normalize.ts` con `normalizeSlug(name)` y `parseChapterNumber(label)` (utils puras,
   con sus tests). El número de capítulo lo deriva el servidor, no el cliente.

**Cada slice se entrega con su `*.test.ts`** (el proyecto exige tests por feature).

**Verificación:** insertar 3 eventos con `curl`, `GET /api/library` devuelve un manga con último capítulo correcto.

Docs: https://www.prisma.io/docs/orm/overview/databases/sqlite · https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7

### Fase 3 — LaunchAgent (backend automático)

> **Estado (jul 2026): hecha.** Instalado y validado (health + kill/auto-restart); pendiente
> solo el test de reinicio de la Mac. Nota: el binario de bun viene de mise
> (`~/.local/share/mise/installs/bun/latest/bin/bun`), no de Homebrew. Ver
> `.claude/skills/deploy/`.

**Este es el paso que resuelve el "no quiero estar levantando nada".** Se hace ahora, no al final.

> **Decisión (v2.1): correr Bun directo, sin compilar.** `bun build --compile` con Prisma +
> `@prisma/adapter-libsql` NO está certificado como estable (bindings nativos + cliente generado
> que está gitignored). El LaunchAgent ejecuta `bun run src/index.ts` desde el repo. Bun ya está
> instalado en la Mac.

1. Preparar la base de datos de producción en la carpeta estándar de macOS (user-writable, a
   diferencia de `/Applications`):
   ```bash
   mkdir -p ~/Library/Application\ Support/MangaTracker ~/Library/Logs/MangaTracker
   DATABASE_URL="file:$HOME/Library/Application Support/MangaTracker/mangatracker.db" \
     bunx --bun prisma migrate deploy
   ```

2. La configuración de producción (ruta de la DB y puerto) se pasa por `EnvironmentVariables` del
   propio LaunchAgent (paso 3), así producción usa su base sin tocar el `.env` de desarrollo.

3. Crear `~/Library/LaunchAgents/com.mangatracker.plist`:
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
     "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key><string>com.mangatracker</string>
     <key>ProgramArguments</key>
     <array>
       <string>/opt/homebrew/bin/bun</string>   <!-- ruta absoluta de bun: `which bun` -->
       <string>run</string>
       <string>src/index.ts</string>
     </array>
     <key>WorkingDirectory</key><string>/Users/gaston/Documents/Git/manga-tracker-api</string>
     <key>EnvironmentVariables</key>
     <dict>
       <key>DATABASE_URL</key><string>file:/Users/gaston/Library/Application Support/MangaTracker/mangatracker.db</string>
       <key>PORT</key><string>5150</string>
     </dict>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><true/>
     <key>StandardOutPath</key><string>/Users/gaston/Library/Logs/MangaTracker/out.log</string>
     <key>StandardErrorPath</key><string>/Users/gaston/Library/Logs/MangaTracker/err.log</string>
   </dict>
   </plist>
   ```

4. Cargar (forma moderna; `launchctl load` sigue funcionando como alternativa):
   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mangatracker.plist
   ```

**Verificación:**
- `curl http://localhost:5150/health` responde.
- Matar el proceso a mano (`pkill -f 'bun run src/index.ts'`) → launchd lo reinicia solo en 1-2 seg.
- Reiniciar la Mac → sin abrir nada, `curl` responde.

**Workflow de desarrollo posterior:** durante iteración activa, sacar el LaunchAgent temporalmente para no colisionar con el puerto:
```bash
launchctl bootout gui/$(id -u)/com.mangatracker    # libera el 5150
bun run dev                                         # dev con hot-reload (usa .env / dev.db)
# ... trabajar ...
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mangatracker.plist  # volver a producción
```

**Al publicar cambios del backend** (no hay paso de compilación):
```bash
# Si hubo migración nueva, aplicarla a la DB de producción primero:
DATABASE_URL="file:$HOME/Library/Application Support/MangaTracker/mangatracker.db" \
  bunx --bun prisma migrate deploy
launchctl kickstart -k gui/$(id -u)/com.mangatracker    # reinicia el servicio
```

Docs: https://www.launchd.info/ · https://bun.sh/docs/runtime/http/server

### Fase 4 — Extensión esqueleto (MV3)

> **Estado (jul 2026): hecha (código); pendiente la verificación manual en navegadores.**
> **Decisión: WXT en lugar de CRXJS** — a jul 2026 WXT tiene CLI con soporte Bun nativo,
> manifest auto-generado desde `wxt.config.ts`, entrypoints por archivo y mejor HMR; CRXJS
> exige scaffolding vía npm y manifest manual. Plasmo está en modo mantenimiento.

Nuevo proyecto separado:
```bash
cd /Users/gaston/Documents/Git
bunx wxt@latest init manga-tracker-extension -t react --pm bun
cd manga-tracker-extension && bun install
```

El manifest NO se escribe a mano: se define en `wxt.config.ts` (clave `manifest`) y WXT lo
genera en `.output/<target>/manifest.json`. Configurado:

- `permissions: ["storage", "activeTab", "scripting"]`
- `host_permissions: ["http://localhost:5150/*"]`
- `optional_host_permissions: ["https://*/*", "http://*/*"]`
- `key` fija (pubkey RSA; el `.pem` queda gitignorado) → extension-id estable
  `cfjiinlnepkmlaafdclmlpjbmpofplop`, ya agregado al CORS del backend sin esperar la carga
  manual.

Popup React que hace ping a `GET /health` y muestra estado. Cargar como unpacked
(`.output/chrome-mv3-dev/` en dev) en Brave y Chrome; el id debe coincidir con el calculado.

**Verificación:** popup en ambos navegadores muestra "Conectado".

Docs: https://wxt.dev/guide/installation.html · https://developer.chrome.com/docs/extensions/mv3/intro

### Fase 5 — Handshake end-to-end con botón manual

> **Estado (jul 2026): hecha (código); pendiente la verificación manual end-to-end.**
> Implementado: content script con `registration: "runtime"` (inyectado bajo demanda con
> `activeTab` + `scripting`, devuelve `{title, url}` de la página) y botón "Enviar evento
> test" en el popup que arma el payload con datos reales de la pestaña activa.

Content script inyectado bajo demanda. Botón temporal en el popup "Enviar evento test" que envía un payload dummy. Verificar que llega, se guarda, y que un evento enviado desde Brave se ve al consultar `GET /api/library` desde Chrome (mismo backend).

### Fase 6 — Heurística automática

> **Estado (jul 2026): hecha (código); pendiente la verificación manual.** El tracking es
> opt-in por sitio: botón "Trackear este sitio" en el popup → `permissions.request()` del
> origen → el background registra `detector.content.ts` para ese origen
> (`scripting.registerContentScripts`, persistente). Sin capítulo en la URL (páginas
> catálogo/home) nunca se envía evento; con confianza < 0.7 tampoco (queda para la Fase 7).

Pipeline en el content script:
1. `GET /api/adapters/:domain` — si hay adapter, aplicarlo.
2. Si no, correr heurística:
   - Título: `og:title` → `twitter:title` → `<h1>` visible → `document.title` (limpio).
   - Capítulo: regex sobre URL para `/capitulo/N`, `/chapter-N`, `/ch-N`, `/c/N`.
3. Calcular confianza 0-1. Si ≥ 0.7 → enviar evento. Si < 0.7 → Fase 7.
4. Debounce de 2 seg para SPAs (Fase 8).

### Fase 7 — Overlay de calibración

Componente React en Shadow DOM inyectado por el content script. Estados: "Seleccioná el título" → "Seleccioná el capítulo" → confirmar. Al clickear, generar CSS selector con `@medv/finder`. `POST /api/adapters`.

Docs: https://github.com/antonmedv/finder

### Fase 8 — Detección en SPAs

> **Estado (jul 2026): hecha.** Implementada con el evento `wxt:locationchange` que WXT
> provee en el contexto del content script (cubre pushState/replaceState/popstate), con
> debounce de 2 seg y deduplicación por URL ya reportada.

Interceptar `history.pushState`, `history.replaceState`, evento `popstate`. Re-correr detección con debounce.

### Fase 9 — Deduplicación (solo detección)

- `normalizeSlug()` robusto: `.normalize("NFD").replace(/[\u0300-\u036f]/g, "")` para acentos.
- `GET /api/duplicates`: pares con similitud Levenshtein ≥ 0.85 (solo sugerencia).
- Corrección a mano vía `PUT /api/mangas/:id` (cambia el nombre visible, no la clave).

> **Decisión (v2.1): merge POSPUESTO.** `POST /api/mangas/merge` movería events de un manga a otro
> (UPDATE), lo que contradice la regla append-only (los events nunca se UPDATE/DELETE). Por ahora
> solo se detecta y se corrige el nombre a mano. Si más adelante hace falta fusionar de verdad, se
> hará con una tabla de alias (canonical) resuelta en la proyección, sin mover events.

### Fase 10 — Dashboard

> **Estado (jul 2026): hecha.** Repo `manga-tracker-dashboard` creado (React 19 + Jotai +
> Vite 8 + react-router 8; tooling Bun/Biome/tsgo/vitest espejo de la extensión). Las tres
> vistas implementadas con tests (22), incluida la corrección manual de nombres
> (`PUT /api/mangas/:id`, Fase 9). `bun run deploy` copia `dist/` a
> `manga-tracker-api/public/` y el backend lo sirve con `serveStatic` de `hono/bun`:
> `/assets/*` + rutas SPA conocidas (`/`, `/manga/:id`, `/duplicates`) — sin wildcard,
> así `/api`, `/docs` y `/openapi.json` conservan sus 404 reales.

Proyecto separado:
```bash
cd /Users/gaston/Documents/Git
bun create vite@latest manga-tracker-dashboard -- --template react-ts
cd manga-tracker-dashboard
bun add jotai
```

`bun run build` → `dist/`. Copiar `dist/` a `manga-tracker-api/public/` y servir con `serveStatic`
de `hono/bun` (no el genérico). Al servirse same-origin desde el backend, no dispara el permiso de
red local de Chrome ni necesita CORS.

Vistas:
- `/` — tabla de librería con filtros por sitio y por antigüedad.
- `/manga/:id` — historial completo.
- `/duplicates` — sugerencias de merge.

### Fase 11 — Export/import (opcional)

`GET /api/export` → JSON completo. `POST /api/import` para restaurar. Time Machine ya cubre el `.db`, esto es capa extra de portabilidad.

## Consideraciones de largo plazo

**Seguridad:**
- Backend bind a `127.0.0.1`, nunca `0.0.0.0`.
- CORS estricto: solo el extension-id de la extensión propia y `http://localhost:5150`.
- Extensión pide `optional_host_permissions` en runtime, no `<all_urls>` en install.

**Rendimiento:**
- Índice compuesto `(mangaId, readAt)` para el query de librería.
- Volumen esperado: decenas de eventos por día, `.db` <5MB con 10k rows.

**Mantenimiento:**
- `bun outdated` + `bun update` cada 6 meses.
- Si un sitio cambia HTML, la heurística falla, aparece overlay de calibración, se re-aprende con dos clicks.
- El backend corre con el Bun del sistema (LaunchAgent → `bun run src/index.ts`); mantener Bun al día con `bun upgrade`.

**Portabilidad:**
- `.db` es un archivo. Copiar a otra Mac y apuntar el binario ahí = migración completa.

## Referencias

- Bun: https://bun.sh/docs
- Hono: https://hono.dev/docs
- Prisma: https://www.prisma.io/docs
- Prisma + Bun SQLite: https://www.prisma.io/docs/orm/overview/databases/sqlite
- Chrome Extensions MV3: https://developer.chrome.com/docs/extensions
- Chrome Local Network Access: https://developer.chrome.com/blog/local-network-access
- WXT: https://wxt.dev
- React 19: https://react.dev
- launchd: https://www.launchd.info
