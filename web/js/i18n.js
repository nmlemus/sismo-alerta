// Spanish / English. The language comes from ?lang=, then the visitor's last
// choice, then the browser; Spanish otherwise. Strings are plain text or
// functions of their parameters (for plurals and word order).

export const LANGS = ['es', 'en'];
const KEY = 'sismo-lang';
const pl = (n, one, many) => (Number(n) === 1 ? one : many); // n may come formatted

const STR = {
  es: {
    'doc.title': 'Sismo de Panamá en vivo · réplicas',
    'doc.desc': 'Terremoto M7.7 del 9 de octubre de 2026 en Panamá y sus réplicas, en vivo desde EMSC (incluye al Instituto de Geociencias de la Universidad de Panamá), con el pronóstico oficial de réplicas del USGS.',
    'lang.group': 'Idioma',
    'h1': 'Terremoto de Panamá y sus réplicas',
    'take.loading': 'Cargando el catálogo de sismos…',
    'tiles.aria': 'Cifras principales',
    'tile.main': 'Sismo principal',
    'tile.after': 'Réplicas registradas',
    'tile.big': 'Mayor réplica',
    'tile.rate': 'Ritmo de réplicas fuertes',
    'tile.last': 'Última réplica',
    'pre.toggle': 'Incluir los 7 días antes del sismo principal',
    'map.h2': 'Dónde han ocurrido',
    'map.note': 'Cada epicentro, con tamaño según la magnitud y color según el día; el punto rojo es el sismo principal. Reproduce la secuencia para ver cómo se fue moviendo: los anillos oscuros marcan las 6 horas previas al momento mostrado. Con la semana anterior activada, la barra de tiempo también va hacia atrás. Haz clic en un sismo para ver su ficha, o en el mapa para activar el zoom con la rueda.',
    'map.play': '▶ Reproducir',
    'map.pause': '❚❚ Pausa',
    'map.slider': 'Momento mostrado en el mapa',
    'map.views': 'Vista del mapa',
    'map.aria': 'Mapa de epicentros',
    'view.zone': 'Zona de réplicas',
    'view.country': 'Todo Panamá',
    'tl.h2': 'Cada sismo, por hora y magnitud',
    'tl.note': 'Cada punto es un sismo, con tamaño según su magnitud, en hora de Panamá (UTC−5). El punto rojo es el sismo principal; el color de los demás indica el día. Pasa el cursor para ver los detalles y haz clic para abrir la ficha del sismo en EMSC.',
    'win.h2': 'Réplicas cada 6 horas',
    'win.note': 'La última barra sigue abierta. Con la semana anterior activada, las barras a la izquierda de la línea son los días previos.',
    'leg.m4': 'M4 o más',
    'leg.all': 'Todas (M2.5+)',
    'cum.h2': 'Total acumulado',
    'cum.note': 'Mientras más se aplana la curva, más lento llegan las réplicas. La de M4+ es la más confiable: en las primeras horas muchas réplicas pequeñas no se logran detectar.',
    'bands.h2': 'Réplicas por magnitud',
    'bands.note': 'Las pequeñas son mucho más comunes, aunque mar adentro no todas las de M2.5–3.5 se logran ubicar.',
    'fc.h2': '¿Qué se espera? Pronóstico oficial de réplicas',
    'fc.note': 'Calculado por el Servicio Geológico de EE. UU. (USGS) con los sismos registrados hasta ahora. No predice cuándo ni dónde: da probabilidades.',
    'ref.h2a': '¿Cómo se sintió en ',
    'ref.h2b': '?',
    'ref.for': 'Ver para',
    'ref.selAria': 'Lugar de referencia',
    'ref.note': 'Intensidad en la escala de Mercalli. "Reportado" es lo que la gente contó al USGS después del sismo principal; "estimado" sale de un modelo que usa la magnitud y la distancia, y cambia con el suelo, el edificio y el piso.',
    'ref.reportedLbl': 'Sismo principal, reportado:',
    'ref.mainLbl': 'Sismo principal, estimado:',
    'ref.dayLbl': 'Réplica más sentida en las últimas 24 h:',
    'int.h3': 'Intensidad estimada de cada sismo',
    'dyfi.h2': '¿Qué tan confiable es la estimación?',
    'dyfi.note': 'Lo que la gente reportó al USGS ("Did You Feel It?") en cada lugar de Panamá durante el sismo principal, frente al modelo sin ajuste local. En la capital y Colón se sintió más que lo que predice el modelo; por eso allí se suma +0.6.',
    'table.h2': 'Todos los sismos',
    'csv': 'Descargar CSV',
    'search.ph': 'Buscar por lugar, fecha, magnitud o agencia',
    'search.aria': 'Buscar sismos',
    'foot.1': '<b>Esto no es una alerta temprana.</b> Los sismos se publican minutos después de ocurrir. Ante un sismo fuerte, sigue las indicaciones de SINAPROC.',
    'foot.2': 'Sismos: <a href="https://www.seismicportal.eu" rel="noopener">EMSC Seismic Portal</a>, en vivo. Reúne las soluciones del Instituto de Geociencias de la Universidad de Panamá (IGC), la Universidad Nacional de Costa Rica (UNA), el USGS (NEIC) y el propio EMSC; se muestra la que EMSC considera preferida, y cada sismo enlaza a su ficha. Las cifras cuentan solo la zona de réplicas (recuadro punteado del mapa: 6.5°–8.2° N, 79.5°–82.3° O). Las magnitudes mezclan escalas (mw para los mayores, magnitud local "m" del IGC y la UNA, mb del EMSC y el USGS) y pueden revisarse.',
    'foot.3': 'Pronóstico y reportes de la gente: <a href="https://earthquake.usgs.gov/earthquakes/eventpage/us6000u18k" rel="noopener">USGS</a>. Intensidad estimada: ecuación de Atkinson, Worden y Wald (2014), con +0.6 en Ciudad de Panamá y Colón. Colores de intensidad: escala de los mapas de sacudida del USGS. Mapa: © colaboradores de OpenStreetMap.',

    // status + headline
    'st.offline': 'Sin conexión con EMSC',
    'st.live': 'En vivo',
    'st.reconnecting': 'Reconectando… (se actualiza cada 2 min)',
    'st.loading': 'Cargando…',
    'st.synced': (c) => `Datos al ${c}`,
    'span.hours': (n) => `${n} horas`,
    'span.days': (x) => `${x} días`,
    'after.sub': (span, m5, m6) => `en ${span} · M2.5 o más · ${m5} de M5+, ${m6} de M6+`,
    'm4.sub': (first) => `M4+ por hora en las últimas 12 h (${first} en las primeras 12 h)`,
    'take.count': (n, when) => `Se han registrado ${n} réplicas desde el sismo principal del ${when}.`,
    'take.rate': (a, b, c, d) => `Las fuertes (M4 o más) bajaron de ${a} a ${b} por hora entre las primeras 12 horas y las últimas 12; el total, de ${c} a ${d} por hora.`,
    'take.latest': (mag, place, ago) => `La más reciente: M${mag}, ${place}, ${ago}.`,
    'toast': (mag, place, time) => `Nuevo sismo: M${mag} · ${place} · ${time}`,

    // reference point
    'ref.reported': (roman, cdi, n, name) => `${roman} (${cdi}) según ${n} ${pl(n, 'persona', 'personas')} que lo reportaron al USGS en ${name}`,
    'ref.noReports': 'sin reportes de la gente para este lugar',
    'ref.usgsFail': 'no se pudieron cargar los reportes del USGS',
    'ref.usgsLoading': 'cargando reportes del USGS…',
    'ref.mainEst': (desc, km) => `${desc} a ${km} km del epicentro`,
    'ref.dayNone': 'ninguna réplica en las últimas 24 h',
    'ref.felt': (felt, total, name) => `${felt} de ${total} réplicas probablemente se sintieron dentro de casa en ${name}.`,
    'badge.reported': 'reportado',
    'badge.estimated': 'estimado',
    'ref.me': 'Mi ubicación',
    'ref.meName': 'tu ubicación',
    'ref.locating': 'Buscando tu ubicación…',
    'ref.private': 'Tu ubicación se usa solo en este navegador; no se envía a ningún servidor.',
    'ref.locFail': 'No se pudo leer tu ubicación.',
    'pre.note': (days, n, nz, last) => `En los ${days} días anteriores hubo ${n} sismos en la región, ${nz} de ellos en la zona de réplicas${last ? ` (el último, ${last} antes del sismo principal)` : ''}.`,

    // USGS
    'dyfi.unavailable': 'Los reportes del USGS no están disponibles en este momento.',
    'dyfi.count': (total, places) => `${total} reportes en total; aquí, ${places} lugares de Panamá.`,
    'fc.unavailable': 'El pronóstico del USGS no está disponible en este momento.',
    'fc.loading': 'Cargando el pronóstico del USGS…',
    'fc.row': (m) => `M${m} o más`,
    'fc.range': (a, b) => `${a}–${b} sismos`,
    'fc.none': 'ninguno probable',
    'fc.above': (mag, p) => `Probabilidad de un sismo igual o mayor que el principal (M${mag}) en la próxima semana: ${p}.`,
    'fc.meta': (created, next) => `Pronóstico oficial del USGS, emitido el ${created}${next ? `; próxima actualización: ${next}` : ''}. Cada celda: probabilidad de al menos un sismo de esa magnitud y número probable (rango del 95 %). `,
    'fc.link': 'Ver en el USGS ↗',
    'fc.1 Day': 'Próximo día',
    'fc.1 Week': 'Próxima semana',
    'fc.1 Month': 'Próximo mes',
    'fc.1 Year': 'Próximo año',

    // table + CSV
    'col.t': 'Hora (Panamá)',
    'col.mag': 'Mag.',
    'col.type': 'Tipo',
    'col.agency': 'Agencia',
    'col.depth': 'Prof. (km)',
    'col.place': 'Lugar',
    'col.km': 'Distancia (km)',
    'col.mmi': 'Intensidad est.',
    'col.link': 'Ficha',
    'link.aria': (time) => `Ficha del sismo en EMSC (${time})`,
    'events.count': (shown, total) => `${shown} de ${total} sismos`,
    'csv.file': 'sismos_panama',
    'csv.head': (ref) => ['id', 'hora_utc', 'hora_panama', 'latitud', 'longitud', 'profundidad_km', 'magnitud', 'tipo_magnitud', 'agencia', 'lugar',
      `distancia_km_${ref}`, `intensidad_estimada_${ref}`, 'ficha_emsc'],

    // time
    'ago.now': 'hace segundos',
    'ago': (d) => `hace ${d}`,
    'dur.days': (n) => `${n} ${pl(n, 'día', 'días')}`,

    // charts
    'tl.pre': (days) => `← ${days} días antes del sismo principal`,
    'tl.mainLbl': (mag) => `M${mag} sismo principal`,
    'tl.bigLbl': (mag) => `M${mag} mayor réplica`,
    'tip.beforeMain': ' · antes del sismo principal',
    'tip.click': 'Clic para ver la ficha en EMSC ↗',
    'leg.main': 'Sismo principal',
    'leg.preDays': (days) => `${days} días antes`,
    'leg.until': (day) => `hasta ${day}`,
    'win.before': (a, b) => `${a}–${b} h antes del sismo principal`,
    'win.after': (a, b, open) => `${a}–${b} h después del sismo principal${open ? ' (en curso)' : ''}`,
    'win.small': (n) => `${n} de M2.5–3.9`,
    'win.m4': (n) => `${n} de M4 o más`,
    'win.none': 'Sin sismos',
    'win.max': (m) => `Mayor: M${m}`,
    'win.main': 'sismo principal',
    'cum.all': 'Todas',
    'cum.tipAll': (n) => `${n} réplicas en total`,
    'int.indoors': 'desde aquí se siente dentro de casa',
    'int.tip': (mag, km, name) => `M${mag} a ${km} km de ${name}`,
    'int.est': (desc) => `Intensidad estimada: ${desc}`,
    'dyfi.axis': 'distancia al hipocentro (km)',
    'dyfi.model': 'modelo',
    'dyfi.tipRep': (roman, cdi, n) => `Reportado: ${roman} (${cdi}) · ${n} ${pl(n, 'reporte', 'reportes')}`,
    'dyfi.tipModel': (v, km) => `Modelo: ${v} a ${km} km`,

    // map
    'q.depth': (mag, type, depth) => `M${mag} (${type}) · ${depth} km de profundidad`,
    'q.by': (agency) => `Localizado por ${agency}`,
    'q.link': 'Ver ficha en EMSC ↗',
    'note.main': 'sismo principal',
    'note.other': 'fuera de la zona de réplicas',
    'note.pre': 'antes del sismo principal',
    'map.refTitle': (name) => `Punto de referencia: ${name}`,
    'time.now': (t) => `Ahora (${t})`,
    'time.before': (days, n) => `${days} días antes del sismo principal · ${n} ${pl(n, 'sismo', 'sismos')} en la región hasta ese momento`,
    'time.after': (n) => `${n} ${pl(n, 'réplica', 'réplicas')} hasta ese momento`,
    'leg.recent': (h) => `Últimas ${h} h del momento mostrado`,
    'leg.outside': 'Fuera de la zona de réplicas (recuadro)',
    'leg.ref': 'Punto de referencia',

    // intensity + places
    'mmi': ['', 'no sentido', 'débil', 'débil', 'leve', 'moderado', 'fuerte', 'muy fuerte', 'severo', 'violento', 'extremo'],
    'dirs': ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'],
    'place.near': (name) => `cerca de ${name}`,
    'place.from': (km, dir, name) => `${km} km al ${dir} de ${name}`,
  },

  en: {
    'doc.title': 'Panama earthquake live · aftershocks',
    'doc.desc': 'The M7.7 Panama earthquake of October 9, 2026 and its aftershocks, live from EMSC (including the Institute of Geosciences of the University of Panama), with the official USGS aftershock forecast.',
    'lang.group': 'Language',
    'h1': 'The Panama earthquake and its aftershocks',
    'take.loading': 'Loading the earthquake catalog…',
    'tiles.aria': 'Key figures',
    'tile.main': 'Mainshock',
    'tile.after': 'Aftershocks recorded',
    'tile.big': 'Largest aftershock',
    'tile.rate': 'Rate of strong aftershocks',
    'tile.last': 'Latest aftershock',
    'pre.toggle': 'Include the 7 days before the mainshock',
    'map.h2': 'Where they happened',
    'map.note': 'Each epicenter, sized by magnitude and colored by day; the red dot is the mainshock. Play the sequence to see how it moved: dark rings mark the 6 hours before the moment shown. With the week before turned on, the time bar also goes back. Click an earthquake for its details, or click the map to turn on scroll-wheel zoom.',
    'map.play': '▶ Play',
    'map.pause': '❚❚ Pause',
    'map.slider': 'Moment shown on the map',
    'map.views': 'Map view',
    'map.aria': 'Map of epicenters',
    'view.zone': 'Aftershock zone',
    'view.country': 'All of Panama',
    'tl.h2': 'Every event, by time and magnitude',
    'tl.note': 'Each dot is one earthquake, sized by magnitude, on Panama local time (UTC−5). The red dot is the mainshock; the color of the others shows the day. Hover for details and click to open the earthquake’s EMSC page.',
    'win.h2': 'Aftershocks per 6 hours',
    'win.note': 'The last bar is still open. With the week before turned on, the bars left of the line are the days before.',
    'leg.m4': 'M4 or larger',
    'leg.all': 'All (M2.5+)',
    'cum.h2': 'Running total',
    'cum.note': 'The flatter the curve, the slower aftershocks arrive. The M4+ line is the most reliable: in the first hours many small aftershocks go undetected.',
    'bands.h2': 'Aftershocks by magnitude',
    'bands.note': 'Small ones are far more common, although offshore not every M2.5–3.5 gets located.',
    'fc.h2': 'What to expect: the official aftershock forecast',
    'fc.note': 'Computed by the U.S. Geological Survey (USGS) from the earthquakes recorded so far. It doesn’t predict when or where: it gives probabilities.',
    'ref.h2a': 'How strong was it in ',
    'ref.h2b': '?',
    'ref.for': 'Show for',
    'ref.selAria': 'Reference place',
    'ref.note': 'Intensity on the Mercalli scale. "Reported" is what people told USGS after the mainshock; "estimated" comes from a model that uses magnitude and distance, and varies with the ground, the building and the floor.',
    'ref.reportedLbl': 'Mainshock, reported:',
    'ref.mainLbl': 'Mainshock, estimated:',
    'ref.dayLbl': 'Most strongly felt aftershock in the last 24 h:',
    'int.h3': 'Estimated intensity of each earthquake',
    'dyfi.h2': 'How reliable is the estimate?',
    'dyfi.note': 'What people reported to USGS ("Did You Feel It?") in each place in Panama during the mainshock, against the model without local adjustment. Panama City and Colón felt more than the model predicts, so +0.6 is added there.',
    'table.h2': 'All earthquakes',
    'csv': 'Download CSV',
    'search.ph': 'Search by place, date, magnitude or agency',
    'search.aria': 'Search earthquakes',
    'foot.1': '<b>This is not an early warning.</b> Earthquakes are published minutes after they happen. In a strong earthquake, follow the instructions of SINAPROC, Panama’s civil protection agency.',
    'foot.2': 'Earthquakes: <a href="https://www.seismicportal.eu" rel="noopener">EMSC Seismic Portal</a>, live. It brings together the solutions of the Institute of Geosciences of the University of Panama (IGC), the National University of Costa Rica (UNA), USGS (NEIC) and EMSC itself; the one EMSC prefers is shown, and each earthquake links to its page. Figures count only the aftershock zone (dotted box on the map: 6.5°–8.2° N, 79.5°–82.3° W). Magnitudes mix scales (mw for the largest, local magnitude "m" from IGC and UNA, mb from EMSC and USGS) and may be revised.',
    'foot.3': 'Forecast and people’s reports: <a href="https://earthquake.usgs.gov/earthquakes/eventpage/us6000u18k" rel="noopener">USGS</a>. Estimated intensity: Atkinson, Worden and Wald (2014) equation, with +0.6 in Panama City and Colón. Intensity colors: USGS ShakeMap scale. Map: © OpenStreetMap contributors.',

    'st.offline': 'No connection to EMSC',
    'st.live': 'Live',
    'st.reconnecting': 'Reconnecting… (updates every 2 min)',
    'st.loading': 'Loading…',
    'st.synced': (c) => `Data as of ${c}`,
    'span.hours': (n) => `${n} hours`,
    'span.days': (x) => `${x} days`,
    'after.sub': (span, m5, m6) => `in ${span} · M2.5 or larger · ${m5} M5+, ${m6} M6+`,
    'm4.sub': (first) => `M4+ per hour over the last 12 h (${first} in the first 12 h)`,
    'take.count': (n, when) => `${n} aftershocks have been recorded since the mainshock on ${when}.`,
    'take.rate': (a, b, c, d) => `Strong ones (M4 or larger) fell from ${a} to ${b} per hour between the first 12 hours and the last 12; all of them, from ${c} to ${d} per hour.`,
    'take.latest': (mag, place, ago) => `The latest: M${mag}, ${place}, ${ago}.`,
    'toast': (mag, place, time) => `New earthquake: M${mag} · ${place} · ${time}`,

    'ref.reported': (roman, cdi, n, name) => `${roman} (${cdi}) according to ${n} ${pl(n, 'person', 'people')} who reported it to USGS in ${name}`,
    'ref.noReports': 'no reports from people for this place',
    'ref.usgsFail': 'USGS reports could not be loaded',
    'ref.usgsLoading': 'loading USGS reports…',
    'ref.mainEst': (desc, km) => `${desc}, ${km} km from the epicenter`,
    'ref.dayNone': 'no aftershocks in the last 24 h',
    'ref.felt': (felt, total, name) => `${felt} of ${total} aftershocks were probably felt indoors in ${name}.`,
    'badge.reported': 'reported',
    'badge.estimated': 'estimated',
    'ref.me': 'My location',
    'ref.meName': 'your location',
    'ref.locating': 'Finding your location…',
    'ref.private': 'Your location is used only in this browser; it is not sent to any server.',
    'ref.locFail': 'Your location could not be read.',
    'pre.note': (days, n, nz, last) => `In the ${days} days before, there were ${n} earthquakes in the region, ${nz} of them in the aftershock zone${last ? ` (the last one ${last} before the mainshock)` : ''}.`,

    'dyfi.unavailable': 'USGS reports are not available right now.',
    'dyfi.count': (total, places) => `${total} reports in all; shown here, ${places} places in Panama.`,
    'fc.unavailable': 'The USGS forecast is not available right now.',
    'fc.loading': 'Loading the USGS forecast…',
    'fc.row': (m) => `M${m} or larger`,
    'fc.range': (a, b) => `${a}–${b} earthquakes`,
    'fc.none': 'none likely',
    'fc.above': (mag, p) => `Chance of an earthquake as large as the mainshock (M${mag}) or larger in the next week: ${p}.`,
    'fc.meta': (created, next) => `Official USGS forecast, issued ${created}${next ? `; next update: ${next}` : ''}. Each cell: chance of at least one earthquake of that magnitude, and the likely number (95% range). `,
    'fc.link': 'View at USGS ↗',
    'fc.1 Day': 'Next day',
    'fc.1 Week': 'Next week',
    'fc.1 Month': 'Next month',
    'fc.1 Year': 'Next year',

    'col.t': 'Time (Panama)',
    'col.mag': 'Mag.',
    'col.type': 'Type',
    'col.agency': 'Agency',
    'col.depth': 'Depth (km)',
    'col.place': 'Place',
    'col.km': 'Distance (km)',
    'col.mmi': 'Est. intensity',
    'col.link': 'Details',
    'link.aria': (time) => `Earthquake page at EMSC (${time})`,
    'events.count': (shown, total) => `${shown} of ${total} earthquakes`,
    'csv.file': 'panama_earthquakes',
    'csv.head': (ref) => ['id', 'time_utc', 'time_panama', 'latitude', 'longitude', 'depth_km', 'magnitude', 'magnitude_type', 'agency', 'place',
      `distance_km_${ref}`, `estimated_intensity_${ref}`, 'emsc_page'],

    'ago.now': 'seconds ago',
    'ago': (d) => `${d} ago`,
    'dur.days': (n) => `${n} ${pl(n, 'day', 'days')}`,

    'tl.pre': (days) => `← ${days} days before the mainshock`,
    'tl.mainLbl': (mag) => `M${mag} mainshock`,
    'tl.bigLbl': (mag) => `M${mag} largest aftershock`,
    'tip.beforeMain': ' · before the mainshock',
    'tip.click': 'Click for the EMSC event page ↗',
    'leg.main': 'Mainshock',
    'leg.preDays': (days) => `${days} days before`,
    'leg.until': (day) => `through ${day}`,
    'win.before': (a, b) => `${a}–${b} h before the mainshock`,
    'win.after': (a, b, open) => `${a}–${b} h after the mainshock${open ? ' (in progress)' : ''}`,
    'win.small': (n) => `${n} M2.5–3.9`,
    'win.m4': (n) => `${n} M4 or larger`,
    'win.none': 'No earthquakes',
    'win.max': (m) => `Largest: M${m}`,
    'win.main': 'mainshock',
    'cum.all': 'All',
    'cum.tipAll': (n) => `${n} aftershocks in total`,
    'int.indoors': 'felt indoors from here up',
    'int.tip': (mag, km, name) => `M${mag}, ${km} km from ${name}`,
    'int.est': (desc) => `Estimated intensity: ${desc}`,
    'dyfi.axis': 'distance to the hypocenter (km)',
    'dyfi.model': 'model',
    'dyfi.tipRep': (roman, cdi, n) => `Reported: ${roman} (${cdi}) · ${n} ${pl(n, 'report', 'reports')}`,
    'dyfi.tipModel': (v, km) => `Model: ${v} at ${km} km`,

    'q.depth': (mag, type, depth) => `M${mag} (${type}) · ${depth} km deep`,
    'q.by': (agency) => `Located by ${agency}`,
    'q.link': 'EMSC event page ↗',
    'note.main': 'mainshock',
    'note.other': 'outside the aftershock zone',
    'note.pre': 'before the mainshock',
    'map.refTitle': (name) => `Reference point: ${name}`,
    'time.now': (t) => `Now (${t})`,
    'time.before': (days, n) => `${days} days before the mainshock · ${n} ${pl(n, 'earthquake', 'earthquakes')} in the region up to then`,
    'time.after': (n) => `${n} ${pl(n, 'aftershock', 'aftershocks')} up to then`,
    'leg.recent': (h) => `Last ${h} h before the moment shown`,
    'leg.outside': 'Outside the aftershock zone (box)',
    'leg.ref': 'Reference point',

    'mmi': ['', 'not felt', 'weak', 'weak', 'light', 'moderate', 'strong', 'very strong', 'severe', 'violent', 'extreme'],
    'dirs': ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'],
    'place.near': (name) => `near ${name}`,
    'place.from': (km, dir, name) => `${km} km ${dir} of ${name}`,
  },
};

const inBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

function detect() {
  if (!inBrowser) return 'es';
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (LANGS.includes(q)) return q;
  } catch { /* no query string */ }
  try {
    const saved = localStorage.getItem(KEY);
    if (LANGS.includes(saved)) return saved;
  } catch { /* storage blocked */ }
  const nav = ((navigator.languages && navigator.languages[0]) || navigator.language || '').toLowerCase();
  return nav.startsWith('en') ? 'en' : 'es';
}

let current = detect();

export const lang = () => current;

/** Translated string (or the result of calling it with args). Falls back to Spanish, then to the key. */
export function t(key, ...args) {
  const v = STR[current][key] ?? STR.es[key];
  if (v === undefined) return key;
  return typeof v === 'function' ? v(...args) : v;
}

/** Translation if the key exists, otherwise the fallback. */
export const tOr = (key, fallback) => (key in STR[current] || key in STR.es ? t(key) : fallback);

/** Name of a place or reference point in the current language. */
export const localName = (p) => (current === 'en' && p.en) || p.name;

/** Switch language; remembers the choice and puts it in the address so shared links keep it. */
export function setLang(l, { persist = true } = {}) {
  if (!LANGS.includes(l)) return;
  current = l;
  if (!inBrowser || !persist) return;
  try { localStorage.setItem(KEY, l); } catch { /* storage blocked */ }
  try {
    const u = new URL(location.href);
    u.searchParams.set('lang', l);
    history.replaceState(history.state, '', u);
  } catch { /* not allowed here */ }
}

/** Fill the page's fixed text: data-i18n (text), data-i18n-html (trusted markup from this file), data-i18n-attr ("attr:key;attr:key"). */
export function applyStatic(root = document) {
  document.documentElement.lang = current;
  document.title = t('doc.title');
  document.querySelector('meta[name=description]')?.setAttribute('content', t('doc.desc'));
  root.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
  root.querySelectorAll('[data-i18n-html]').forEach((n) => { n.innerHTML = t(n.dataset.i18nHtml); });
  root.querySelectorAll('[data-i18n-attr]').forEach((n) => {
    for (const pair of n.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':');
      n.setAttribute(attr, t(key));
    }
  });
  root.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === current)));
}
