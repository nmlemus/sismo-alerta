import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

import '../core/intensity.dart';
import '../core/mmi_colors.dart';
import '../models/quake.dart';
import '../services/device_service.dart';
import '../widgets/quake_tile.dart';
import 'quake_screen.dart';
import 'settings_screen.dart';

const _panama = LatLng(8.4, -80.1);

/// Recent earthquakes on a map, colored by the intensity they'd have where you are.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _map = MapController();
  int _days = 2;
  late Stream<List<Quake>> _stream = _quakes();

  Stream<List<Quake>> _quakes() => FirebaseFirestore.instance
      .collection('events')
      .where('time', isGreaterThan: Timestamp.fromDate(DateTime.now().subtract(Duration(days: _days))))
      .orderBy('time', descending: true)
      .limit(300)
      .snapshots()
      .map((s) => s.docs.map(Quake.fromDoc).toList());

  void _open(Quake q) => Navigator.of(context).push(MaterialPageRoute(builder: (_) => QuakeScreen(quake: q)));

  @override
  Widget build(BuildContext context) {
    final dev = DeviceService.instance;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Sismo Alerta'),
        actions: [
          PopupMenuButton<int>(
            tooltip: 'Periodo',
            icon: const Icon(Icons.history),
            initialValue: _days,
            onSelected: (d) => setState(() {
              _days = d;
              _stream = _quakes();
            }),
            itemBuilder: (_) => const [
              PopupMenuItem(value: 1, child: Text('Últimas 24 horas')),
              PopupMenuItem(value: 2, child: Text('Últimos 2 días')),
              PopupMenuItem(value: 7, child: Text('Última semana')),
            ],
          ),
          IconButton(
            tooltip: 'Simular el sismo del 9 de octubre',
            icon: const Icon(Icons.waves),
            onPressed: () => _open(Quake.demo),
          ),
          IconButton(
            tooltip: 'Ajustes',
            icon: const Icon(Icons.settings),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const SettingsScreen())),
          ),
        ],
      ),
      body: ListenableBuilder(
        listenable: dev,
        builder: (context, _) => StreamBuilder<List<Quake>>(
          stream: _stream,
          builder: (context, snap) {
            final quakes = snap.data ?? const <Quake>[];
            final me = dev.location;
            return Stack(children: [
              FlutterMap(
                mapController: _map,
                options: const MapOptions(initialCenter: _panama, initialZoom: 6.3),
                children: [
                  TileLayer(
                    urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                    userAgentPackageName: 'pa.aiudalabs.sismo_alerta',
                  ),
                  CircleLayer(circles: [
                    // Oldest first so the newest ends up on top.
                    for (final q in quakes.reversed)
                      CircleMarker(
                        point: LatLng(q.lat, q.lon),
                        radius: 3 + (q.mag - 2).clamp(0.0, 6.0).toDouble() * 3.2,
                        color: _colorFor(q, me).withValues(alpha: 0.75),
                        borderColor: DateTime.now().difference(q.time).inHours < 1 ? sWaveColor : Colors.black54,
                        borderStrokeWidth: DateTime.now().difference(q.time).inHours < 1 ? 2.5 : 1,
                      ),
                  ]),
                  if (me != null)
                    MarkerLayer(markers: [
                      Marker(point: me, width: 22, height: 22, child: const _MeDot()),
                    ]),
                  const SimpleAttributionWidget(source: Text('OpenStreetMap')),
                ],
              ),
              if (dev.status != null)
                Positioned(
                  top: 8,
                  left: 8,
                  right: 8,
                  child: Material(
                    color: Theme.of(context).colorScheme.errorContainer,
                    borderRadius: BorderRadius.circular(8),
                    child: Padding(padding: const EdgeInsets.all(10), child: Text(dev.status!)),
                  ),
                ),
              DraggableScrollableSheet(
                initialChildSize: 0.32,
                minChildSize: 0.12,
                maxChildSize: 0.85,
                builder: (context, scroll) => Material(
                  elevation: 8,
                  color: Theme.of(context).colorScheme.surface,
                  borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
                  child: ListView.builder(
                    controller: scroll,
                    itemCount: quakes.length + 1,
                    itemBuilder: (context, i) {
                      if (i == 0) return _SheetHeader(count: quakes.length, loading: !snap.hasData, error: snap.error);
                      final q = quakes[i - 1];
                      return QuakeTile(
                        quake: q,
                        here: me,
                        siteAdjust: dev.settings.siteAdjust,
                        onTap: () => _open(q),
                        onLongPress: () => _map.move(LatLng(q.lat, q.lon), 8),
                      );
                    },
                  ),
                ),
              ),
            ]);
          },
        ),
      ),
      floatingActionButton: dev.location == null
          ? null
          : Padding(
              padding: const EdgeInsets.only(bottom: 120),
              child: FloatingActionButton.small(
                tooltip: 'Centrar en mí',
                onPressed: () => _map.move(dev.location!, 8),
                child: const Icon(Icons.my_location),
              ),
            ),
    );
  }

  Color _colorFor(Quake q, LatLng? me) {
    if (me == null) return Colors.orange;
    final epi = epicentralKm(q.lat, q.lon, me.latitude, me.longitude);
    final mmi = mmiAtEpicentral(q.mag, q.depthKm, epi, siteAdjust: DeviceService.instance.settings.siteAdjust);
    return mmiColor(mmiLevel(mmi));
  }
}

class _SheetHeader extends StatelessWidget {
  const _SheetHeader({required this.count, required this.loading, this.error});
  final int count;
  final bool loading;
  final Object? error;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final msg = error != null
        ? 'No se pudieron cargar los sismos.'
        : loading
            ? 'Cargando…'
            : count == 0
                ? 'Sin sismos registrados en este periodo.'
                : '$count sismos · color = intensidad estimada donde estás';
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      child: Column(children: [
        Container(width: 36, height: 4, decoration: BoxDecoration(color: Colors.grey, borderRadius: BorderRadius.circular(2))),
        const SizedBox(height: 10),
        Align(alignment: Alignment.centerLeft, child: Text(msg, style: t.bodySmall)),
      ]),
    );
  }
}

class _MeDot extends StatelessWidget {
  const _MeDot();

  @override
  Widget build(BuildContext context) => Container(
        decoration: BoxDecoration(
          color: pWaveColor,
          shape: BoxShape.circle,
          border: Border.all(color: Colors.white, width: 3),
          boxShadow: const [BoxShadow(blurRadius: 4, color: Colors.black38)],
        ),
      );
}
