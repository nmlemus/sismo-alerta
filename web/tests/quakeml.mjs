// Test helper: EMSC GeoJSON features -> EMSC-style QuakeML with all origins, so the
// fixtures recorded as JSON can feed the XML reader. Each feature gets its preferred
// agency's solution (manual, except UNA/UCR, which publish automatic ones); UNA and UCR
// events also get an IGC solution unless `lone` lists them (a lone automatic solution).
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function origin(ev, n, p, author, mode) {
  const pid = `quakeml:eu.emsc/event/${ev}/origin/O${n}`;
  return `  <origin publicID="${pid}">
    <time><value>${p.time}</value></time>
    <latitude><value>${p.lat}</value></latitude>
    <longitude><value>${p.lon}</value></longitude>
    <depth><value>${(p.depth ?? 10) * 1000}</value></depth>
    <evaluationMode>${mode}</evaluationMode>
    <creationInfo><authorURI>smi:smi-registry/organization/${author}</authorURI></creationInfo>
  </origin>
  <magnitude publicID="${pid}/mag/1">
    <originID>${pid}</originID>
    <mag><value>${p.mag}</value></mag>
    <type>${esc(p.magtype || 'm')}</type>
  </magnitude>
`;
}

export function toQuakeML(features, { lone = new Set() } = {}) {
  const events = features.map((f) => {
    const p = f.properties;
    const id = p.unid || f.id;
    const auto = ['UNA', 'UCR'].includes(p.auth);
    let body = origin(id, 1, p, p.auth, auto ? 'automatic' : 'manual');
    if (auto && !lone.has(id)) body += origin(id, 2, p, 'IGC', 'manual');
    const type = !p.evtype || ['ke', 'se'].includes(p.evtype) ? 'earthquake' : 'quarry blast';
    return `<event publicID="quakeml:eu.emsc/event/${id}">
  <preferredOriginID>quakeml:eu.emsc/event/${id}/origin/O1</preferredOriginID>
  <preferredMagnitudeID>quakeml:eu.emsc/event/${id}/origin/O1/mag/1</preferredMagnitudeID>
  <type>${type}</type>
  <creationInfo><authorURI>smi:smi-registry/organization/${p.auth}</authorURI><creationTime>${p.lastupdate || p.time}</creationTime></creationInfo>
  <description><text>${esc(p.flynn_region || '')}</text><type>Flinn-Engdahl region</type></description>
${body}</event>`;
  });
  return `<?xml version="1.0"?>\n<q:quakeml xmlns:q="http://quakeml.org/xmlns/quakeml/1.2" xmlns="http://quakeml.org/xmlns/bed/1.2">\n<eventParameters publicID="smi:eu.emsc/unid">\n${events.join('\n')}\n</eventParameters>\n</q:quakeml>\n`;
}
