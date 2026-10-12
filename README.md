# Sismo Alerta

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
| `infra/` | Reglas de Firestore y `deploy.sh` para Cloud Run. |
| `.github/workflows/ci.yml` | Pruebas del backend y, para la app, análisis, pruebas y compilación Android en cada push. |

## Cómo se estima la intensidad

Se usa la ecuación de Atkinson, Worden y Wald (2014), con la magnitud y la distancia hipocentral, más un **ajuste local** configurable en la app.

Con el sismo M7.7 del 9 de octubre de 2026, el modelo coincide con lo que reportó la gente al USGS ("Did You Feel It?") en Chitré (6.5) y en Santiago (6.2). En Ciudad de Panamá, en cambio, el modelo da 4.6 contra 5.2 reportado. Por eso el ajuste local viene en **+0.6** por defecto. La misma fórmula está en `backend/app/intensity.py` y en `app/lib/core/intensity.dart`, y ambas tienen pruebas con esos datos.

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
