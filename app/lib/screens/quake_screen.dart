import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:intl/intl.dart';
import 'package:latlong2/latlong.dart';

import '../core/intensity.dart';
import '../core/mmi_colors.dart';
import '../models/quake.dart';
import '../services/device_service.dart';

/// One earthquake, with an animation of its P and S waves spreading out and the
/// intensity they carry, and what they mean where you are.
class QuakeScreen extends StatefulWidget {
  const QuakeScreen({super.key, required this.quake});
  final Quake quake;

  @override
  State<QuakeScreen> createState() => _QuakeScreenState();
}

class _QuakeScreenState extends State<QuakeScreen> with SingleTickerProviderStateMixin {
  late final Ticker _ticker;
  Duration _lastTick = Duration.zero;
  double _t = 0; // simulated seconds since origin time
  double _speed = 5;
  bool _playing = true;

  late final LatLng _epi = LatLng(widget.quake.lat, widget.quake.lon);
  late final LatLng? _me = DeviceService.instance.location;
  late final double _siteAdjust = DeviceService.instance.settings.siteAdjust;

  // Intensity zones (no local adjustment): level -> epicentral radius in km.
  late final Map<int, double> _zones = {
    for (var lv = 2; lv <= 10; lv++) lv: radiusForLevel(widget.quake.mag, widget.quake.depthKm, lv),
  }..removeWhere((_, r) => r <= 0);

  late final double? _epiKm =
      _me == null ? null : epicentralKm(widget.quake.lat, widget.quake.lon, _me!.latitude, _me!.longitude);
  late final ({double p, double s})? _arrive =
      _epiKm == null ? null : arrivals(hypocentralKm(_epiKm!, widget.quake.depthKm));
  late final double? _mmiHere = _epiKm == null
      ? null
      : mmiAtEpicentral(widget.quake.mag, widget.quake.depthKm, _epiKm!, siteAdjust: _siteAdjust);

  late final double _tEnd = () {
    final feltRadius = _zones[3] ?? _zones[2] ?? 100.0; // keep going until shaking becomes weak
    final tFelt = hypocentralKm(feltRadius, widget.quake.depthKm) / vsKmS;
    final tHere = _arrive == null ? 0.0 : _arrive!.s + 15;
    return math.min(600.0, math.max(30.0, math.max(tFelt, tHere)));
  }();

  @override
  void initState() {
    super.initState();
    _ticker = createTicker(_onTick)..start();
  }

  void _onTick(Duration elapsed) {
    final dt = (elapsed - _lastTick).inMicroseconds / 1e6;
    _lastTick = elapsed;
    if (!_playing) return;
    setState(() {
      _t = math.min(_tEnd, _t + dt * _speed);
      if (_t >= _tEnd) _playing = false;
    });
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  void _togglePlay() => setState(() {
        if (_t >= _tEnd) _t = 0;
        _playing = !_playing;
      });

  @override
  Widget build(BuildContext context) {
    final q = widget.quake;
    final pR = frontRadiusKm(_t, vpKmS, q.depthKm);
    final sR = frontRadiusKm(_t, vsKmS, q.depthKm);
    final fit = _me == null
        ? null
        : CameraFit.coordinates(coordinates: [_epi, _me!], padding: const EdgeInsets.fromLTRB(48, 48, 48, 300));

    return Scaffold(
      appBar: AppBar(title: Text(q.title, overflow: TextOverflow.ellipsis)),
      body: Stack(children: [
        FlutterMap(
          options: MapOptions(
            initialCenter: _epi,
            initialZoom: 7,
            initialCameraFit: fit,
          ),
          children: [
            TileLayer(
              urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
              userAgentPackageName: 'pa.aiudalabs.sismo_alerta',
            ),
            CircleLayer(circles: [
              // Shaking zones only exist behind the S front: largest (weakest) first.
              for (final e in _zones.entries)
                if (math.min(e.value, sR) > 0)
                  CircleMarker(
                    point: _epi,
                    radius: math.min(e.value, sR) * 1000,
                    useRadiusInMeter: true,
                    color: mmiColor(e.key).withValues(alpha: 0.42),
                  ),
              if (pR > 0)
                CircleMarker(
                  point: _epi,
                  radius: pR * 1000,
                  useRadiusInMeter: true,
                  color: pWaveColor.withValues(alpha: 0.04),
                  borderColor: pWaveColor,
                  borderStrokeWidth: 2,
                ),
              if (sR > 0)
                CircleMarker(
                  point: _epi,
                  radius: sR * 1000,
                  useRadiusInMeter: true,
                  color: Colors.transparent,
                  borderColor: sWaveColor,
                  borderStrokeWidth: 3,
                ),
            ]),
            MarkerLayer(markers: [
              Marker(point: _epi, width: 30, height: 30, child: const Icon(Icons.star, color: sWaveColor, size: 30)),
              if (_me != null)
                Marker(
                  point: _me!,
                  width: 22,
                  height: 22,
                  child: Container(
                    decoration: BoxDecoration(
                      color: _mmiHere == null ? pWaveColor : mmiColor(mmiLevel(_mmiHere!)),
                      shape: BoxShape.circle,
                      border: Border.all(color: Colors.black87, width: 3),
                    ),
                  ),
                ),
            ]),
            const SimpleAttributionWidget(source: Text('OpenStreetMap')),
          ],
        ),
        Align(alignment: Alignment.bottomCenter, child: _panel(context, pR, sR)),
      ]),
    );
  }

  Widget _panel(BuildContext context, double pR, double sR) {
    final q = widget.quake;
    final t = Theme.of(context).textTheme;
    final local = DateFormat("d 'de' MMMM, h:mm:ss a", 'es').format(q.time.toLocal());
    final sFrontMmi = sR > 0 ? mmiAtEpicentral(q.mag, q.depthKm, sR) : null;

    return Card(
      margin: const EdgeInsets.all(10),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 6),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('$local · ${q.depthKm.toStringAsFixed(0)} km de profundidad · ${q.author}', style: t.bodySmall),
          const SizedBox(height: 8),
          Row(children: [
            Text('t = ${_fmt(_t)}', style: t.headlineSmall?.copyWith(fontFeatures: const [FontFeature.tabularFigures()])),
            const Spacer(),
            _legendDot(pWaveColor, 'P ${pR.round()} km'),
            const SizedBox(width: 12),
            _legendDot(sWaveColor, 'S ${sR.round()} km'),
          ]),
          if (sFrontMmi != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text('La onda S lleva intensidad ${describeMmi(sFrontMmi)} en su frente', style: t.bodyMedium),
            ),
          if (_arrive != null) ...[
            const Divider(height: 18),
            _hereLine(context),
          ],
          Row(children: [
            IconButton(
              onPressed: _togglePlay,
              icon: Icon(_playing ? Icons.pause : (_t >= _tEnd ? Icons.replay : Icons.play_arrow)),
            ),
            Expanded(
              child: Slider(
                value: _t,
                max: _tEnd,
                onChanged: (v) => setState(() {
                  _t = v;
                  _playing = false;
                }),
              ),
            ),
            SegmentedButton<double>(
              showSelectedIcon: false,
              style: const ButtonStyle(visualDensity: VisualDensity.compact),
              segments: const [
                ButtonSegment(value: 1, label: Text('1×')),
                ButtonSegment(value: 5, label: Text('5×')),
                ButtonSegment(value: 20, label: Text('20×')),
              ],
              selected: {_speed},
              onSelectionChanged: (s) => setState(() => _speed = s.first),
            ),
          ]),
          _legend(),
        ]),
      ),
    );
  }

  Widget _hereLine(BuildContext context) {
    final a = _arrive!;
    final t = Theme.of(context).textTheme;
    final lv = mmiLevel(_mmiHere!);
    final String countdown;
    if (_t < a.p) {
      countdown = 'La onda P llega en ${(a.p - _t).ceil()} s';
    } else if (_t < a.s) {
      countdown = 'Sacudida fuerte (onda S) en ${(a.s - _t).ceil()} s';
    } else {
      countdown = 'La sacudida ya llegó';
    }
    return Row(children: [
      Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(color: mmiColor(lv), borderRadius: BorderRadius.circular(8)),
        child: Text(roman[lv], style: TextStyle(color: mmiOnColor(lv), fontWeight: FontWeight.w800, fontSize: 18)),
      ),
      const SizedBox(width: 10),
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(countdown, style: t.titleSmall?.copyWith(color: _t >= a.p && _t < a.s ? sWaveColor : null)),
          Text(
            'Donde estás (${_epiKm!.round()} km): P a los ${a.p.round()} s, S a los ${a.s.round()} s · '
            'intensidad estimada ${describeMmi(_mmiHere!)}',
            style: t.bodySmall,
          ),
        ]),
      ),
    ]);
  }

  Widget _legend() {
    final levels = _zones.keys.toList()..sort();
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Wrap(spacing: 4, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
        const Text('Intensidad: ', style: TextStyle(fontSize: 11)),
        for (final lv in levels)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            color: mmiColor(lv),
            child: Text(roman[lv], style: TextStyle(fontSize: 11, color: mmiOnColor(lv))),
          ),
      ]),
    );
  }

  Widget _legendDot(Color c, String label) => Row(mainAxisSize: MainAxisSize.min, children: [
        Container(width: 10, height: 10, decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: c, width: 2))),
        const SizedBox(width: 4),
        Text(label, style: const TextStyle(fontFeatures: [FontFeature.tabularFigures()])),
      ]);

  static String _fmt(double s) {
    final m = s ~/ 60, r = (s % 60).floor();
    return '${m.toString().padLeft(2, '0')}:${r.toString().padLeft(2, '0')}';
  }
}
