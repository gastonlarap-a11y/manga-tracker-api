# Guía de implementación — Manga Tracker

Guía paso a paso, en lenguaje simple y **sin código**, para terminar de construir el sistema.
Describe **qué** crear, **dónde** y **con qué reglas**. Los nombres de archivos y carpetas son
los que hay que respetar; la lógica se explica en prosa.

El sistema son **tres repos separados**:

1. **`manga-tracker-api`** — el backend (este repo). Guarda los datos y expone la API.
2. **`manga-tracker-extension`** — la extensión del navegador que detecta qué manga lees.
3. **`manga-tracker-dashboard`** — la web para mirar tu biblioteca.

> **Regla de oro que atraviesa todo:** tu progreso personal **nunca se borra ni retrocede**.
> Las páginas de manga cambian de servidor seguido y "pierden" el progreso (te muestran el
> capítulo 1 de nuevo). El sistema está diseñado para que eso no te afecte: cada lectura se
> guarda como un evento nuevo (nunca se pisa lo anterior) y el "capítulo al que llegaste" se
> calcula como el **capítulo más alto de toda tu historia**, no el último que la web te mostró.

---

## Parte 1 — Backend (`manga-tracker-api`)

### Estado actual del repo

**La Parte 1 (backend) está completa.** El servidor arranca, tiene documentación automática en
`/docs`, la base de datos tiene sus tres tablas (`Manga`, `ReadingEvent`, `SiteAdapter`), los
cuatro módulos (`events`, `library`, `adapters`, `duplicates`) están construidos con sus
pruebas, y el LaunchAgent (Paso 7) está instalado y validado. Los pasos de abajo quedan como
referencia de cómo funciona cada pieza. **Falta construir la extensión (Parte 2) y el
dashboard (Parte 3).**

### Cómo está organizado (y cómo debe quedar)

Cada "funcionalidad" vive en su propia carpeta dentro de `src/modules/`, y cada carpeta tiene
siempre tres archivos: las **rutas** (qué URL responde y qué datos entran/salen), el **servicio**
(la lógica y las validaciones) y las **pruebas**. Las rutas solo validan y arman la respuesta; la
lógica de verdad va siempre en el servicio.

Estructura objetivo del backend cuando esté terminado:

```
manga-tracker-api/
├─ src/
│  ├─ index.ts              → arranca el servidor, engancha todos los módulos, sirve /docs
│  ├─ config.ts             → único lugar que lee variables de entorno (DATABASE_URL, PORT)
│  ├─ db/
│  │  └─ client.ts          → conexión a la base de datos (ya existe)
│  ├─ lib/
│  │  ├─ normalize.ts       → utilidades: limpiar nombres y leer números de capítulo
│  │  └─ normalize.test.ts  → pruebas de esas utilidades
│  └─ modules/
│     ├─ health/            → (ya existe) el "ping"
│     ├─ events/            → recibe cada lectura y la guarda
│     ├─ library/           → muestra la biblioteca, el historial y corrige nombres
│     ├─ adapters/          → memoria de cómo leer cada sitio web
│     └─ duplicates/        → detecta posibles mangas repetidos
├─ prisma/                  → definición de la base de datos y sus migraciones
├─ public/                  → aquí se copia la web (dashboard) ya compilada
└─ docs/                    → esta guía
```

Regla de dependencias: `index.ts` usa los módulos; los módulos usan `db` y `config`; `db` y
`config` **nunca** usan los módulos. La carpeta `lib/` es para funciones puras (que no dependen de
nada) reutilizables por varios módulos.

---

### Paso 1 — Ajustes de arranque y seguridad

Antes de construir funcionalidades, hay que dejar el arranque como debe ser.

- **En `src/index.ts`:**
  - Hacer que el servidor escuche **solo en `127.0.0.1`** (la propia Mac), nunca en `0.0.0.0`
    (toda la red). Esto es clave de seguridad: nadie en tu red puede tocar el backend.
    **Ya está hecho.**
  - Fijar el puerto en **5150**. **Ya está hecho.**
  - Activar **CORS** con una lista blanca corta: solo se aceptan pedidos desde `http://localhost:5150`
    y desde la extensión propia (su dirección `chrome-extension://...`, que se conoce recién cuando
    la instalás; se agrega después).
  - Enganchar los módulos nuevos bajo el prefijo `/api` (por ejemplo `/api/events`, `/api/library`).

- **En `src/config.ts`:** dejar que el puerto por defecto sea **5150** (sigue siendo el único
  archivo que lee variables de entorno). **Ya está hecho.**

- **Verificación técnica (resuelta):** el nombre correcto del conector es `PrismaLibSql`, tal
  como ya lo importa `src/db/client.ts`; el chequeo de tipos (`bun run typecheck`) pasa.

**Cómo probar este paso:** levantar el backend y pedir el "ping" de salud; debe responder que está
vivo, y solo desde la propia Mac.

---

### Paso 2 — Utilidades compartidas (carpeta `lib/`)

Crear `src/lib/normalize.ts` con **dos funciones puras** (y su archivo de pruebas
`normalize.test.ts`):

- **`normalizeSlug(nombre)`** — recibe el nombre del manga tal como aparece en la web y devuelve
  una versión "limpia y estándar" para poder compararlos. Los pasos de limpieza: pasar todo a
  minúsculas, quitar acentos y tildes, quitar caracteres raros, unificar espacios y guiones, y
  quitar palabras sobrantes al final como "manga", "manhwa", "manhua", "comic" o "novel".
  Esta función es **el corazón de la deduplicación**: gracias a ella, el mismo manga leído en dos
  sitios distintos (o en el mismo sitio después de que cambió de servidor y cambió un poco el
  nombre) cae siempre en el mismo registro.

- **`parseChapterNumber(texto)`** — recibe el texto del capítulo tal como aparece ("Cap. 130.5",
  "Chapter 12", "Capítulo 7") y devuelve el número (130.5, 12, 7). Si no encuentra ningún número,
  devuelve "nada" (null). **Este número lo calcula el backend, no la extensión**: no se confía en
  lo que manda el cliente.

**Pruebas obligatorias:** nombres con acentos, nombres con sufijos ("One Piece Manga" y "One
Piece" deben dar el mismo resultado), capítulos con decimales, y textos sin número (deben dar
"nada").

---

### Paso 3 — Módulo `events`: recibir y guardar cada lectura (el corazón)

Este es el módulo más importante. La extensión llama aquí cada vez que lees un capítulo.

- **Ruta:** `POST /api/events`.

- **Datos que entran** (lo que valida la ruta):
  - `mangaName`: texto, obligatorio, no vacío — el nombre detectado en la página.
  - `chapterLabel`: texto, obligatorio, no vacío — el capítulo tal cual aparece ("Cap. 130.5").
  - `sourceUrl`: texto con formato de URL válida — la dirección completa del capítulo.
  - (El backend deduce solo el dominio, el número de capítulo y el nombre normalizado; la extensión
    no manda esas cosas.)

- **Qué hace el servicio** (la lógica):
  1. Limpia el nombre con `normalizeSlug` para obtener la clave estándar.
  2. Deduce el **dominio** a partir de la URL (por ejemplo `olympusxyz.com`).
  3. Deduce el **número de capítulo** con `parseChapterNumber` (puede quedar "nada" si no se pudo).
  4. **Busca o crea el manga** por su clave normalizada: si ya existe, lo usa; si no, lo crea (con
     el nombre visible original y su clave).
  5. **Inserta un evento de lectura nuevo**, apuntando a ese manga. Nunca modifica ni borra eventos
     anteriores: siempre agrega uno.
  6. Responde "creado" (201) con el evento y el manga.

- **La regla anti-pérdida de progreso vive aquí:** el servicio **siempre** inserta el evento,
  aunque el número de capítulo sea *menor* al máximo que ya tenías. Ese es justo el caso de "la web
  cambió de servidor y me muestra el capítulo 1": se guarda igual como parte del historial, pero
  **no** hace retroceder tu progreso, porque el "capítulo al que llegaste" se calcula después como
  el máximo de toda tu historia (ver Paso 4). Nada se sobrescribe nunca.

- **Manejo de errores en el borde:** si la URL viene mal, responder "pedido inválido" (400); si
  falla la base de datos, responder error del servidor (500) de forma explícita, sin tragarse el
  error en silencio.

**Cómo probar:** enviar 3 lecturas del mismo manga con capítulos 10, 11 y 12; luego enviar una con
capítulo 1 (simulando cambio de servidor). La biblioteca (Paso 4) debe seguir mostrando 12 como
progreso, no 1.

---

### Paso 4 — Módulo `library`: ver la biblioteca, el historial y corregir nombres

Aquí se **lee y se muestra** la información (nunca se guardan eventos). Tiene tres rutas:

- **`GET /api/library`** — la lista de todos tus mangas. Por cada manga, el servicio **calcula a
  partir de sus eventos**:
  - **Capítulo alcanzado** = el número de capítulo **más alto** de toda su historia (tu progreso
    real, que nunca retrocede) y su texto original.
  - **Última actividad** = la fecha del evento más reciente y el capítulo de esa última vez (útil
    para saber cuándo lo leíste por última vez, aunque haya sido una relectura de un capítulo
    viejo).
  - Cantidad de lecturas y en qué sitios lo leíste.
  - Admite filtros opcionales: por sitio (dominio) y por antigüedad.
  - Como el volumen es chico (decenas de lecturas por día), no hace falta optimizar: se puede
    calcular con consultas normales.

  > **Por qué dos números y no uno:** "capítulo alcanzado" te dice hasta dónde vas de verdad;
  > "última actividad" te dice cuándo fue la última vez que abriste algo. Separarlos es lo que
  > evita que una relectura o un cambio de servidor te confunda el progreso.

- **`GET /api/mangas/:id/history`** — el historial completo de un manga: todas sus lecturas
  ordenadas de la más reciente a la más antigua. Si el manga no existe, responder "no encontrado"
  (404).

- **`PUT /api/mangas/:id`** — corregir a mano el **nombre visible** de un manga (cuando la
  detección puso un nombre feo o equivocado).
  - Datos que entran: `canonicalName` (texto, no vacío).
  - **Importante:** esta corrección cambia solo el nombre que ves, **no** la clave normalizada.
    La clave se deja quieta a propósito, para no romper la deduplicación futura ni chocar con otro
    manga. Si el manga no existe, responder "no encontrado" (404).

**Cómo probar:** después de cargar eventos, pedir la biblioteca y confirmar el capítulo alcanzado;
pedir el historial de un manga; corregir un nombre y ver que el nombre cambia pero el manga sigue
siendo el mismo.

---

### Paso 5 — Módulo `adapters`: memoria de cómo leer cada sitio

Cada sitio web tiene su propia forma de mostrar el título y el capítulo. Cuando la detección
automática falla, tú "calibras" el sitio con dos clics (en la extensión) y esa configuración se
guarda aquí para no volver a calibrar nunca más ese sitio.

- **`GET /api/adapters/:domain`** — la extensión pregunta "¿ya sé leer este sitio?". Devuelve la
  configuración guardada del dominio, o "no encontrado" (404) si es un sitio nuevo.

- **`POST /api/adapters`** — guarda (o actualiza si ya existía) la configuración de un sitio tras
  la calibración. Datos que entran:
  - `domain`: texto (el sitio, por ejemplo `olympusxyz.com`).
  - `titleSelector`: texto, obligatorio — cómo encontrar el título en esa página.
  - `chapterSelector`: texto, opcional — cómo encontrar el capítulo.
  - `chapterUrlRegex`: texto, opcional — patrón para sacar el capítulo desde la URL.
  - Se guarda de forma "una por dominio": si ya había una, se reemplaza.

**Cómo probar:** guardar un adapter para un dominio y luego pedirlo; debe volver igual. Pedir un
dominio que no guardaste debe dar "no encontrado".

---

### Paso 6 — Módulo `duplicates`: detectar mangas repetidos (solo sugerir)

A veces el mismo manga queda registrado dos veces con nombres apenas distintos. Este módulo
**solo detecta y sugiere**; no fusiona nada automáticamente.

- **`GET /api/duplicates`** — devuelve pares de mangas cuyos nombres normalizados son muy parecidos
  (parecido alto, del orden del 85% o más). Es una lista de sugerencias del tipo "¿estos dos son el
  mismo?". La corrección se hace a mano corrigiendo el nombre (Paso 4).

> **Por qué no hay "fusión automática" todavía:** fusionar implicaría mover eventos de un manga a
> otro, y eso contradice la regla de que los eventos nunca se modifican. Por ahora se deja solo la
> detección; si más adelante hace falta fusionar de verdad, se diseñará respetando esa regla (por
> ejemplo con una tabla de "alias" en vez de mover eventos).

**Cómo probar:** cargar dos mangas con nombres casi iguales y confirmar que aparecen como par
sugerido.

---

### Paso 7 — Arranque automático del backend (para no levantar nada a mano)

El objetivo es que el backend esté **siempre corriendo** sin que tengas que abrir nada. En macOS
esto se logra con un "LaunchAgent" (un archivo que le dice al sistema que mantenga un programa
vivo). Elegimos **correr el backend directamente con Bun** (sin compilar a un binario), porque es
más simple y evita problemas conocidos al empaquetar la base de datos.

Qué hay que preparar:

- **Ubicación de la base de datos de producción:** `~/Library/Application Support/MangaTracker/`.
  Es la carpeta estándar de macOS para datos de apps y **sí** se puede escribir (a diferencia de
  `/Applications`, que necesita permisos de administrador). La primera vez, aplicar las migraciones
  contra esa base para crear las tablas.

- **Ubicación de los registros (logs):** `~/Library/Logs/MangaTracker/` (mejor que `/tmp`, que se
  borra al reiniciar).

- **El archivo del LaunchAgent:** `~/Library/LaunchAgents/com.mangatracker.plist`. Debe indicar:
  - que ejecute **Bun** corriendo el punto de entrada del backend (`src/index.ts`);
  - la carpeta de trabajo (la ruta de este repo);
  - las variables de entorno propias de producción: la ruta de la base en "Application Support" y
    el puerto 5150 (así producción usa su propia base, sin tocar la de desarrollo);
  - que **arranque al iniciar sesión** y que **se reinicie solo** si se cae;
  - dónde escribir los logs.

- **Activarlo:** cargar el LaunchAgent con `launchctl`.

**Flujo cuando estés programando (para no chocar el puerto):** descargar temporalmente el
LaunchAgent (libera el 5150), correr el backend en modo desarrollo con recarga en caliente,
trabajar, y volver a cargar el LaunchAgent al terminar.

**Flujo al publicar un cambio:** si hubo cambios en la base, aplicar las migraciones contra la base
de producción; luego reiniciar el LaunchAgent. **No hay paso de compilación.**

**Cómo probar:** pedir el "ping" de salud en el puerto 5150 y ver que responde; matar el proceso a
mano y confirmar que el sistema lo vuelve a levantar solo en un par de segundos; reiniciar la Mac y,
sin abrir nada, confirmar que el backend responde.

---

### Paso 8 — Servir el dashboard desde el backend

Cuando el dashboard (Parte 3) esté compilado, su resultado se copia a la carpeta `public/` de este
repo y el backend lo sirve en la raíz (`/`). Al vivir en la **misma dirección** que la API
(`http://localhost:5150`), el navegador no dispara el permiso de "acceso a red local" de Chrome. En
`src/index.ts` hay que servir esos archivos estáticos con el servidor de archivos propio de Bun.

---

## Parte 2 — Extensión del navegador (`manga-tracker-extension`)

Es un proyecto **nuevo y separado**, que se crea con la plantilla de React + TypeScript para
extensiones. Es una extensión Manifest V3 (el estándar actual de Chrome). Su trabajo: detectar qué
manga y capítulo estás leyendo y avisarle al backend.

### Estructura orientativa

```
manga-tracker-extension/
├─ manifest.json           → permisos y piezas de la extensión
└─ src/
   ├─ background/          → "service worker": habla con el backend
   ├─ content/             → se inyecta en la página del manga y detecta título/capítulo
   ├─ popup/               → la ventanita de la extensión (estado + calibración)
   └─ overlay/             → capa de calibración por clics cuando la detección falla
```

### El manifiesto (`manifest.json`)

Debe declarar:

- **Permisos** básicos: almacenamiento, pestaña activa y capacidad de inyectar scripts.
- **Permiso de host fijo:** solo `localhost:5150` (para hablar con el backend).
- **Permisos de host opcionales:** los sitios de manga se piden **en el momento** (cuando entrás a
  uno nuevo), no todos de entrada. Es más seguro y respeta tu privacidad.
- **Una "llave" fija** para que la dirección de la extensión (`chrome-extension://...`) sea
  **siempre la misma**. Esto es importante: si la dirección cambia cada vez, se rompe la lista
  blanca de CORS del backend. Con la llave fija, la agregás una vez y listo.
- Declarar el **service worker** (fondo) y el **popup** (la ventanita).

### Las piezas

- **Service worker (fondo):** es quien envía los datos al backend (`POST /api/events`) y consulta
  si un sitio ya tiene configuración (`GET /api/adapters/:domain`). Centraliza la comunicación.

- **Content script (detección):** corre dentro de la página del manga. Su lógica en orden:
  1. Preguntar al backend si ya hay configuración para ese dominio; si la hay, usarla.
  2. Si no, aplicar la **heurística automática**: para el título, probar en orden `og:title`,
     `twitter:title`, el primer encabezado visible, y por último el título de la pestaña (limpio);
     para el capítulo, buscar patrones típicos en la URL (`/capitulo/N`, `/chapter-N`, `/ch-N`,
     `/c/N`).
  3. Calcular una **confianza** de 0 a 1. Si es alta (0,7 o más), enviar el evento directo. Si es
     baja, mostrar el overlay de calibración (siguiente pieza).
  4. Manejar sitios que cambian de página sin recargar (SPAs): escuchar los cambios de dirección
     interna del navegador y volver a detectar, con una pequeña espera (debounce) para no disparar
     de más.

- **Popup (la ventanita):** hecho en React. Muestra si el backend está conectado (haciendo el
  "ping" de salud) y permite lanzar la calibración manual.

- **Overlay de calibración:** un componente React que se inyecta sobre la página en un contenedor
  aislado (Shadow DOM, para no romper los estilos del sitio). Te guía: "seleccioná el título" →
  "seleccioná el capítulo" → confirmar. Con cada clic, genera automáticamente la forma de ubicar
  ese elemento y, al confirmar, guarda la configuración del sitio en el backend (`POST /api/adapters`).

### Nota sobre Chrome y la red local

Los pedidos de la extensión a `localhost` pueden toparse con el permiso de "acceso a red local" de
Chrome. Hay que tenerlo presente al probar la extensión y, si aparece, concederlo una vez.

### Después de instalarla

Al cargar la extensión sin empaquetar en el navegador, anotá su dirección
(`chrome-extension://...`) y agregala a la lista blanca de CORS del backend (Paso 1). Con la
"llave" fija del manifiesto, esto se hace una sola vez.

---

## Parte 3 — Dashboard web (`manga-tracker-dashboard`)

Otro proyecto **nuevo y separado**, hecho con React + Vite, y con Jotai para el manejo de estado.
Es solo para mirar tu biblioteca; consume la misma API.

### Vistas

- **Inicio (`/`)** — la tabla de tu biblioteca, con filtros por sitio y por antigüedad. Muestra por
  cada manga el **capítulo alcanzado** (tu progreso real) y la **última actividad**.
- **Detalle (`/manga/:id`)** — el historial completo de un manga.
- **Duplicados (`/duplicates`)** — las sugerencias de mangas repetidos para revisarlas a mano.

### Cómo se publica

Se compila a archivos estáticos y el resultado se copia a la carpeta `public/` del backend. Así el
dashboard vive en la **misma dirección** que la API, lo que evita el permiso de red local de Chrome
y no necesita configuración de CORS. No es un servidor aparte: lo sirve el propio backend.

---

## Contrato entre los repos (importante)

La API y la extensión **comparten los tipos de datos a mano** (no hay un paquete compartido). Cada
vez que cambies la forma de un dato en la API (por ejemplo, agregás un campo a lo que recibe
`POST /api/events`), tenés que **actualizar el tipo equivalente en la extensión en el mismo
commit**. Si no, la extensión y el backend dejan de entenderse.

---

## Orden recomendado de trabajo

1. Backend Paso 1 (arranque y seguridad) y Paso 2 (utilidades).
2. Backend Paso 3 (`events`) y Paso 4 (`library`) — con esto ya podés guardar y ver lecturas.
3. Backend Paso 7 (arranque automático) — así el backend queda "siempre encendido".
4. Extensión (Parte 2) — primero un esqueleto que se conecte, después la detección y la calibración.
5. Backend Paso 5 (`adapters`) en paralelo con la calibración de la extensión.
6. Dashboard (Parte 3) + Backend Paso 8 (servirlo) + Paso 6 (`duplicates`).

**Cada funcionalidad se entrega con sus pruebas.** Antes de dar por terminado cualquier paso del
backend, correr el lint, el chequeo de tipos y las pruebas, y confirmar que pasan de verdad.
