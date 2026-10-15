# Sismo Alerta

[English](README.md) · **Español**

**En vivo:** https://sismo-alerta-235ca.web.app · Hecho con [Claude](https://claude.ai): empezó como un Claude Dashboard y Claude escribió el código, las pruebas y la configuración de despliegue.

![Página en vivo: cifras principales y cada sismo por hora y magnitud](docs/dashboard-es.png)

Notificaciones de sismos para Panamá y la región, con la **intensidad estimada en tu ubicación**, un mapa de los sismos recientes y una **simulación de las ondas P y S** viajando desde el epicentro.

> **Importante:** esto **no es una alerta temprana**. Las agencias publican cada sismo minutos después de que ocurre. Para un sismo cercano, la sacudida llega antes que el aviso. Sirve para saber al instante qué fue, de qué tamaño y cómo te afectó, y para seguir las réplicas. Ante un sismo fuerte, sigue las indicaciones de SINAPROC.

```
EMSC (IGC, UNA, EMSC…)  ──WebSocket──┐
EMSC FDSN (cada 30 s)  ──────────────┼──► Cloud Run "sismo-ingestor" ──► Firestore  events/{id}
USGS (cada 30 s)  ───────────────────┘        │  agrupa orígenes del mismo sismo
                                              │  calcula la intensidad en cada teléfono
                                              └─► FCM ──► app Flutter (notificación)
app Flutter ──► Firestore devices/{uid}: token, ubicación (~1 km), umbral, ajuste local
```

## Qué hay en el repo

| Carpeta | Qué es |
|---|---|
| `backend/` | Servicio Python (aiohttp) para Cloud Run. Escucha el WebSocket del EMSC y además consulta EMSC y USGS cada 30 s como respaldo. Une las soluciones de distintas agencias en un solo evento, lo guarda en Firestore y manda la notificación a cada teléfono cuya intensidad estimada supere su umbral. |
| `app/` | App Flutter (Android e iOS). Incluye el mapa de sismos recientes coloreados por la intensidad que tendrían donde estás, el detalle con la animación de las ondas P y S y las zonas de intensidad que deja la onda S, y los ajustes de umbral, ubicación y ajuste local. |
| `web/` | Página web pública en vivo: mapa de epicentros con reproducción, gráficas, intensidad estimada en un lugar de referencia y tabla. Lee el EMSC directamente desde el navegador de cada visitante, sin servidor. |
| `infra/` | Reglas de Firestore y `deploy.sh` para Cloud Run. |
| `.github/workflows/ci.yml` | Pruebas del backend y, para la app, análisis, pruebas y compilación Android en cada push. |

## Cómo se estima la intensidad

Se usa la ecuación de Atkinson, Worden y Wald (2014), con la magnitud y la distancia hipocentral, más un **ajuste local** configurable en la app.

Con el sismo M7.7 del 9 de octubre de 2026, el modelo coincide con lo que reportó la gente al USGS ("Did You Feel It?") en Chitré (6.5) y en Santiago (6.2). En Ciudad de Panamá, en cambio, el modelo da 4.6 contra 5.1 reportado (169 reportes). Por eso el ajuste local viene en **+0.6** por defecto. La misma fórmula está en `backend/app/intensity.py` y en `app/lib/core/intensity.dart`, y ambas tienen pruebas con esos datos.

Las ondas se animan con velocidades medias de la corteza: P a 6.0 km/s y S a 3.5 km/s.

## Puesta en marcha

### 1. Firebase y Google Cloud
1. **Proyecto:** crea un proyecto en Firebase (o usa uno de Google Cloud y agrégale Firebase).
2. **Firestore:** créalo en modo nativo, en la región que prefieras (por ejemplo `us-east1`).
3. **Autenticación:** en *Authentication → Sign-in method*, activa **Anónimo**.
4. **Notificaciones en iPhone:** sube tu clave APNs en *Project settings → Cloud Messaging*.

### 2. Backend
```bash
PROJECT_ID=tu-proyecto REGION=us-east1 ./infra/deploy.sh
gcloud run services logs read sismo-ingestor --project tu-proyecto --region us-east1 --limit 50
```
Para probarlo en local sin tocar nada, usa `cd backend && DRY_RUN=true python -m app.main` y abre `localhost:8080/status`.

**Costo:** el servicio necesita una instancia siempre encendida (1 vCPU, 512 MiB) para mantener abierto el WebSocket. Con los precios de Cloud Run son unos **US$40–45 al mes**, ya descontado el nivel gratuito; confírmalo en la calculadora de Google Cloud.

Si quieres pagar menos:
- **Consultar cada 30 s sin WebSocket:** pon `POLL_SECONDS=30` y quita el WebSocket. Cloud Run sigue necesitando una instancia activa.
- **Una VM `e2-micro`:** corre el mismo contenedor y entra en el nivel gratuito de Compute Engine en algunas regiones de EE. UU.

### 3. App
Necesitas Flutter estable, Xcode para iOS y Android Studio para Android.
```bash
cd app
python3 tool/setup_platforms.py      # crea android/ e ios/ y agrega permisos y configuración
dart pub global activate flutterfire_cli
flutterfire configure --project=tu-proyecto   # reemplaza lib/firebase_options.dart
flutter run
```
En iOS, abre `ios/Runner.xcworkspace` y agrega las capacidades *Push Notifications* y *Background Modes → Remote notifications*.

## Página web en vivo (`web/`)

Es un sitio estático, sin paso de compilación, en `index.html`, `js/` y `css/`, con d3 y Leaflet incluidos en `vendor/`. Funciona así:
- **Al abrir:** pide al EMSC el catálogo desde el sismo principal, en páginas de 300 eventos.
- **En vivo:** se conecta al WebSocket del EMSC y agrega cada sismo nuevo segundos después de que se publica.
- **Respaldo:** consulta el catálogo cada 2 minutos por si se cae la conexión.

Además lee del USGS los reportes "Did You Feel It?" y el pronóstico oficial de réplicas del sismo principal (`SEQUENCE.usgsEventId`), y permite descargar la tabla en CSV con un enlace a la ficha de cada sismo en el EMSC. Los colores siguen una paleta validada para daltonismo, con pasos propios para modo claro y oscuro: un color por día de la secuencia, rojo para el sismo principal, gris para la semana anterior y la escala de colores de intensidad del USGS (ShakeMap).

Los filtros sobre el mapa eligen el periodo (semana previa, todo, hoy, últimas 24 h, últimas 6 h) la magnitud mínima (M3+, M4+, M5+) y el área: la zona de réplicas inicial, toda la región o lo que muestra el mapa (útil porque la secuencia se va moviendo). El área decide qué sismos cuentan en toda la página, cifras incluidas. El periodo y la magnitud se aplican al mapa, la línea de tiempo, la gráfica de intensidad, la tabla y el CSV; las cifras de arriba y las gráficas de ritmo siempre cuentan toda la secuencia. Los filtros quedan en la dirección, así que un link como `?periodo=24h&mag=4&area=region` abre esa vista.

La gráfica de frecuencia muestra, hora a hora, los sismos por hora de las 6 horas anteriores (todos y M4+, en escala logarítmica), y debajo, en paneles alineados, su magnitud promedio y la intensidad estimada promedio en el lugar de referencia.

**La última réplica, arriba.** Una tarjeta con su magnitud, lugar, hora, profundidad y energía (en toneladas de TNT), la intensidad estimada en el lugar de referencia y cuánto tardó la onda S en llegar a cada pueblo; las barras crecen a una misma velocidad, así que se ve cómo la sacudida llega primero a los más cercanos. "Calcular para mi ubicación" agrega tu propia fila e intensidad (la ubicación no sale del navegador). Lleva al sismo en el mapa, donde el último conserva un anillo que late despacio, se comparte por WhatsApp y se ilumina cuando llega uno nuevo con la página abierta. Debajo del titular, un indicador por fuente (lista web del IGC, IGC en X, EMSC, USGS) dice si está al día. Las animaciones se apagan para quien pide menos movimiento en su sistema.

**Solo sismos confirmados.** La página le pide a EMSC todas las soluciones de cada sismo (QuakeML con `includeallorigins`), no solo la que EMSC prefiere. Un sismo cuenta si lo localizó la red nacional (el IGC, definido en `EMSC.trustedAuthors`), si lo localizaron dos o más agencias, o si un analista revisó alguna solución. Una única solución automática de otra agencia, como el falso M4.0 cerca de Ciudad de Panamá del 13 de octubre de 2026, queda *sin confirmar*: se dibuja hueca en el mapa y se lista debajo, pero no se cuenta ni genera avisos. Si otra agencia lo confirma, empieza a contarse solo.

**Sismos falsos.** A veces una agencia publica una solución automática de un sismo que no ocurrió. Agrega su id de EMSC en `web/data/excluded.json`, con el motivo en español e inglés, y publica: la página lo saca de todas las cifras, gráficas, el mapa y la tabla, y lo lista en el pie. Las páginas ya abiertas toman el cambio en menos de 5 minutos. Los eventos que el propio EMSC borra o reclasifica desaparecen solos: en vivo, o en la siguiente recarga completa del catálogo (cada 30 minutos).

Para seguir otro sismo, cambia `SEQUENCE` en `web/js/config.js`.

La página está en español e inglés. Toma el idioma del navegador, y el botón ES/EN de arriba lo cambia y lo recuerda. Para compartir un enlace en un idioma, agrega `?lang=en` o `?lang=es`. Todos los textos están en `web/js/i18n.js`.

**Probar en local**
```bash
cd web
npm run serve            # http://localhost:8080
npm install && npm test && npm run e2e   # pruebas; la e2e usa datos fijos del 9 de octubre
```

**Publicar en Firebase Hosting (una vez)**
```bash
npm install -g firebase-tools
firebase login
firebase deploy --only hosting --project tu-proyecto    # desde la raíz del repo
```
Queda en `https://tu-proyecto.web.app`.

**Despliegue automático (opcional).** Cada push a `main` que toque `web/` se publica solo con dos ajustes del repositorio en GitHub:
- **Variable `FIREBASE_PROJECT_ID`:** con el id de tu proyecto.
- **Secreto `FIREBASE_SERVICE_ACCOUNT`:** con la clave JSON de una cuenta de servicio con el rol *Firebase Hosting Admin*.

**Costos.** Una primera visita descarga unos 120 KB comprimidos (d3 va recortado a los módulos que usa la página: `web/tools/build-d3.sh`); las siguientes solo revalidan los archivos propios, unos pocos KB.
- **Plan gratuito (Spark):** el límite es de 360 MB al día, unas 3,000 primeras visitas diarias. Se revisa en la consola de Firebase, en *Hosting → Uso*. Si se pasa del límite, **el sitio deja de servirse hasta el día siguiente**.
- **Plan Blaze:** el exceso cuesta US$0.15/GB, unos 2 centavos por cada 1,000 visitas. Si vas a compartir el link en público, usa Blaze con una alerta de presupuesto (el backend de la app también lo necesita).

**Estadísticas de visitas (opcional).** Pega el ID de medición de Google Analytics 4 (`G-…`) en `ANALYTICS.measurementId` de `web/js/config.js`. Las funciones de publicidad van apagadas, el pie de página lo avisa, y se registra qué filtros, idioma y lugar de referencia usa la gente. Sin ID no se carga nada.

**Límites**
- **Carga sobre el EMSC.** Cada visitante consulta al EMSC directamente, lo que va bien para cientos de personas. Si el link se vuelve viral, conviene que la página lea de un archivo que actualice el backend de la app, para no multiplicar las consultas.
- **Mapas.** Sin configurar nada, el mapa usa los tiles de OpenStreetMap, que sirven para uso ligero. Para compartirlo en público, pide una clave gratuita de CARTO en https://carto.com/basemaps/apikey (uso no comercial: 5 millones de tiles al mes) y pégala en `TILES.cartoKey` de `web/js/config.js`.

## Monitor del IGC y alertas por Telegram

El Instituto de Geociencias (IGC) publica sus sismos en https://sismosgeociencias.up.ac.pa/ unos 2–3 minutos después de ocurrir, antes que EMSC (3–10 minutos), pero solo como una tabla HTML, sin API. El monitor (`backend/app/monitor_main.py`) es un servicio pequeño de Cloud Run que Cloud Scheduler despierta cada minuto:

- **Revisa barato:** le pregunta al IGC si la página cambió (ETag), y solo la lee cuando cambió.
- **Sigue las revisiones:** encuentra los sismos nuevos y las revisiones del IGC (PRELIMINAR → REVISADO, cambios de magnitud), y cada sismo conserva su id a través de ellas.
- **Avisa por Telegram:** publica cada sismo nuevo en un canal de Telegram, con la intensidad estimada en Ciudad de Panamá y enlaces, y edita ese mensaje cuando el IGC revisa el sismo, además de responderle (en silencio) con lo que cambió, para que en el chat se vea qué mensaje se actualizó. Un sismo nuevo a menos de 10 minutos y 40 km de uno ya anunciado se manda como respuesta a ese, aclarando que el IGC lo lista como otro sismo. Por defecto cubre los M3.5 o más a menos de 400 km de Ciudad de Panamá; por debajo de M4.0 llegan en silencio.
- **Tiene respaldo:** si la página del IGC se cae (mantenimiento, errores) o deja de cambiar por 15 minutos, toma de EMSC las soluciones del propio IGC (solo autor IGC), unos minutos más tarde, y avisa con esas. Cuando la lista del IGC vuelve, las empata con sus filas y edita los mensajes en vez de repetirlos. Si el IGC sigue caído 10 minutos, un mensaje sin sonido en el canal lo dice, citando la página, y otro avisa cuando vuelve.
- **Lee las publicaciones del IGC en X:** el IGC publica cada sismo en X (@igcpanamaup) con el mismo texto que sus avisos de WhatsApp, minutos antes que su lista web, y siguió haciéndolo el 14 de octubre de 2026 mientras su página y su envío a EMSC estaban caídos. Con un token de la API de X (`X_BEARER_TOKEN`, pago por uso en developer.x.com), cada revisión lee solo las publicaciones nuevas, así que un minuto sin sismos no cuesta nada y un día movido, unos centavos. Se anuncian igual que los de la lista, la publicación REVISADO edita el mensaje y el botón enlaza a la publicación del IGC.
- **Recibe los avisos de WhatsApp del IGC:** los avisos del IGC por WhatsApp llegan minutos antes que su lista web, y a veces son lo único que publica (el 14 de octubre de 2026 su página y su envío a EMSC se detuvieron por horas mientras WhatsApp seguía). Una persona autorizada (`RELAY_USERS`) le reenvía o pega el aviso al bot en un chat privado. El bot lo lee, calcula la ubicación a partir del pueblo, la distancia y la dirección, y publica la misma tarjeta en el canal en segundos, con los mismos filtros. Cuando la lista del IGC trae el sismo, el bot actualiza ese mensaje en vez de repetirlo. Si el mensaje empieza con `prueba`, solo muestra cómo quedaría; `/estado` dice si la lista del IGC funciona.
- **Guarda todo lo que ve:** un archivo que solo crece, en el bucket, con una línea JSON por observación en `archive/raw/AAAA-MM-DD.jsonl`: las filas de la lista del IGC cuando aparecen o cambian, cada publicación en X con su texto original, cada aviso de WhatsApp reenviado y las soluciones de respaldo de EMSC, con la hora en que se vieron. La primera vez guarda además todos los sismos que ya conocía (la lista del IGC solo muestra 7 días). Nada se reescribe, así que lo que publicó el IGC queda registrado aunque lo revise, lo borre o se caiga la página; el catálogo limpio y las descargas saldrán de aquí.
- **Alimenta la página:** escribe un feed público en Cloud Storage que la página lee cada minuto (`IGC_FEED` en `web/js/config.js`). Los sismos del IGC cuentan como confirmados, aparecen antes de que EMSC los tenga y se unen con la versión de EMSC cuando esta llega.

Se apaga entre revisiones y queda dentro de los niveles gratuitos de Cloud Run, Cloud Scheduler y Cloud Storage (el proyecto debe estar en el plan Blaze). Se identifica ante el IGC en su User-Agent.

**Puesta en marcha**
1. **Bot:** en Telegram, habla con @BotFather, manda `/newbot` y guarda el token.
2. **Canal:** crea un canal público (por ejemplo `@sismos_panama_live`) y agrega el bot como administrador que puede publicar.
3. **Despliegue:** corre `PROJECT_ID=tu-proyecto TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=@sismos_panama_live RELAY_USERS=@tu_usuario ./infra/deploy-monitor.sh`. El servicio es público para que Telegram llegue a `/telegram`, y cada ruta exige una clave que crea el script (`monitor-key` en Secret Manager).
4. **Conecta la página:** pega la URL del feed que imprime el script en `IGC_FEED.base` de `web/js/config.js` y publica la página.

Para probar Telegram sin un sismo real, `POST /test` manda un mensaje marcado "🧪 PRUEBA — no es un sismo real" por los mismos filtros y formato, lo edita como haría una revisión y lo borra a los 30 segundos (`?keep=0` lo deja). Nunca toca el estado ni el feed. El script de despliegue imprime el comando exacto.

Se ajusta con `NOTIFY_MIN_MAG`, `LOUD_MIN_MAG` y `NOTIFY_MAX_KM` al correr el script. En su primera vuelta el monitor solo aprende lo que ya está listado, y nunca anuncia nada de más de 30 minutos.

## Variables del backend

| Variable | Por defecto | Para qué |
|---|---|---|
| `WATCH_MIN_LAT`, `WATCH_MAX_LAT`, `WATCH_MIN_LON`, `WATCH_MAX_LON` | 2…13 N, 87…73 O | Zona vigilada |
| `MIN_MAG_STORE` | 2.5 | Magnitud mínima que se guarda |
| `POLL_SECONDS` | 30 | Cada cuánto se consultan EMSC y USGS |
| `MAX_NOTIFY_AGE_S` | 1200 | No notificar sismos con más de 20 min de antigüedad |
| `RENOTIFY_DELTA` | 1.0 | Mandar una actualización si la intensidad estimada sube al menos esto |
| `DRY_RUN` | false | No escribe ni envía nada (para pruebas) |

## Limitaciones conocidas
- **Retraso de minutos.** El IGC y el EMSC publican de 3 a 10 minutos después del sismo. Un aviso que llegue antes de la sacudida requiere sensores propios o un sistema oficial.
- **Ubicación con la app abierta.** La ubicación por GPS se actualiza al abrir la app y mientras está abierta. Para recibir alertas con la app cerrada, fija una ubicación (casa u oficina) en Ajustes.
- **El modelo es un promedio.** La intensidad real varía en uno o más grados según el suelo, el edificio y el piso.
- **Mapas de OpenStreetMap.** Usa los tiles públicos, que sirven para uso personal. Si la app crece, conviene un proveedor de tiles propio.

## Licencia

[MIT](LICENSE) © 2026 Noel Moreno Lemus
