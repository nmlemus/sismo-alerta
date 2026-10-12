import 'package:cloud_firestore/cloud_firestore.dart';

/// One earthquake as stored by the backend in `events/{id}`.
class Quake {
  Quake({
    required this.id,
    required this.time,
    required this.lat,
    required this.lon,
    required this.depthKm,
    required this.mag,
    required this.magType,
    required this.author,
    required this.region,
    this.latencySeconds,
    this.originCount = 1,
  });

  final String id;
  final DateTime time;
  final double lat;
  final double lon;
  final double depthKm;
  final double mag;
  final String magType;
  final String author;
  final String region;
  final double? latencySeconds;
  final int originCount;

  static double _d(Object? v, [double fallback = 0]) => v is num ? v.toDouble() : fallback;

  factory Quake.fromDoc(DocumentSnapshot<Map<String, dynamic>> doc) {
    final d = doc.data() ?? const {};
    final t = d['time'];
    return Quake(
      id: doc.id,
      time: t is Timestamp ? t.toDate() : DateTime.tryParse('$t') ?? DateTime.now(),
      lat: _d(d['lat']),
      lon: _d(d['lon']),
      depthKm: _d(d['depthKm'], 10),
      mag: _d(d['mag']),
      magType: '${d['magType'] ?? ''}',
      author: '${d['author'] ?? ''}',
      region: '${d['region'] ?? ''}',
      latencySeconds: d['latencySeconds'] is num ? (d['latencySeconds'] as num).toDouble() : null,
      originCount: (d['origins'] is Map) ? (d['origins'] as Map).length : 1,
    );
  }

  /// Built from a push notification's data payload (before the doc is fetched).
  factory Quake.fromPush(Map<String, dynamic> d) => Quake(
        id: '${d['eventId']}',
        time: DateTime.tryParse('${d['time']}') ?? DateTime.now(),
        lat: double.tryParse('${d['lat']}') ?? 0,
        lon: double.tryParse('${d['lon']}') ?? 0,
        depthKm: double.tryParse('${d['depthKm']}') ?? 10,
        mag: double.tryParse('${d['mag']}') ?? 0,
        magType: '${d['magType'] ?? ''}',
        author: '${d['author'] ?? ''}',
        region: '',
      );

  /// The 2026-10-09 M7.7 mainshock (USGS solution), used for the demo.
  static final demo = Quake(
    id: 'demo-2026-10-09',
    time: DateTime.utc(2026, 10, 9, 17, 56, 6),
    lat: 7.5868,
    lon: -80.769,
    depthKm: 12.6,
    mag: 7.7,
    magType: 'Mww',
    author: 'USGS',
    region: 'Herrera, Panamá',
  );

  String get title {
    final r = region.trim();
    final pretty = r == r.toUpperCase()
        ? r.toLowerCase().split(' ').map((w) => w.isEmpty ? w : w[0].toUpperCase() + w.substring(1)).join(' ')
        : r;
    return 'M${mag.toStringAsFixed(1)}${pretty.isEmpty ? '' : ' · $pretty'}';
  }
}
