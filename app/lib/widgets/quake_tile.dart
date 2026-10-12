import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:latlong2/latlong.dart';

import '../core/intensity.dart';
import '../core/mmi_colors.dart';
import '../models/quake.dart';

String ago(DateTime t) {
  final d = DateTime.now().difference(t);
  if (d.inMinutes < 1) return 'hace segundos';
  if (d.inMinutes < 60) return 'hace ${d.inMinutes} min';
  if (d.inHours < 24) return 'hace ${d.inHours} h';
  return DateFormat('d MMM, h:mm a', 'es').format(t.toLocal());
}

class QuakeTile extends StatelessWidget {
  const QuakeTile({
    super.key,
    required this.quake,
    required this.here,
    required this.siteAdjust,
    required this.onTap,
    this.onLongPress,
  });

  final Quake quake;
  final LatLng? here;
  final double siteAdjust;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final me = here;
    double? epi, mmi;
    if (me != null) {
      epi = epicentralKm(quake.lat, quake.lon, me.latitude, me.longitude);
      mmi = mmiAtEpicentral(quake.mag, quake.depthKm, epi, siteAdjust: siteAdjust);
    }
    final lv = mmi == null ? null : mmiLevel(mmi);
    return ListTile(
      onTap: onTap,
      onLongPress: onLongPress,
      leading: CircleAvatar(
        backgroundColor: lv == null ? Colors.orange : mmiColor(lv),
        foregroundColor: lv == null ? Colors.black : mmiOnColor(lv),
        child: Text(quake.mag.toStringAsFixed(1), style: const TextStyle(fontWeight: FontWeight.w700)),
      ),
      title: Text(quake.title.replaceFirst(RegExp(r'^M[\d.]+ · '), ''), maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text([
        ago(quake.time),
        if (epi != null) '${epi.round()} km',
        if (quake.author.isNotEmpty) quake.author,
      ].join(' · ')),
      trailing: lv == null
          ? null
          : Column(mainAxisAlignment: MainAxisAlignment.center, children: [
              Text(roman[lv], style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
              Text(labelEs[lv]!, style: Theme.of(context).textTheme.labelSmall),
            ]),
    );
  }
}
