import 'package:flutter/material.dart';

import '../core/intensity.dart';
import '../core/mmi_colors.dart';
import '../services/device_service.dart';

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final dev = DeviceService.instance;
    return Scaffold(
      appBar: AppBar(title: const Text('Ajustes de alertas')),
      body: ListenableBuilder(
        listenable: dev,
        builder: (context, _) {
          final s = dev.settings;
          final t = Theme.of(context).textTheme;
          final loc = dev.location;
          return ListView(padding: const EdgeInsets.symmetric(vertical: 8), children: [
            SwitchListTile(
              title: const Text('Recibir alertas'),
              value: s.enabled,
              onChanged: (v) => dev.update(s.copyWith(enabled: v)),
            ),
            const Divider(),
            _Section('Avisarme cuando aquí se sienta al menos'),
            ListTile(
              leading: _MmiBadge(s.thresholdLevel),
              title: Text('${roman[s.thresholdLevel]} · ${labelEs[s.thresholdLevel]}'),
              subtitle: Slider(
                value: s.thresholdLevel.toDouble(),
                min: 2,
                max: 7,
                divisions: 5,
                label: roman[s.thresholdLevel],
                onChanged: (v) => dev.update(s.copyWith(thresholdLevel: v.round())),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Text(_thresholdHelp(s.thresholdLevel), style: t.bodySmall),
            ),
            const SizedBox(height: 8),
            ListTile(
              title: Text('Siempre avisar si la magnitud es ${s.alwaysMag.toStringAsFixed(1)} o más'),
              subtitle: Slider(
                value: s.alwaysMag,
                min: 5,
                max: 8,
                divisions: 30,
                label: s.alwaysMag.toStringAsFixed(1),
                onChanged: (v) => dev.update(s.copyWith(alwaysMag: v)),
              ),
            ),
            ListTile(
              title: Text(s.minMag <= 0
                  ? 'Sin magnitud mínima'
                  : 'Ignorar sismos menores de M${s.minMag.toStringAsFixed(1)}'),
              subtitle: Slider(
                value: s.minMag,
                max: 6,
                divisions: 12,
                label: s.minMag.toStringAsFixed(1),
                onChanged: (v) => dev.update(s.copyWith(minMag: v)),
              ),
            ),
            const Divider(),
            _Section('Ubicación'),
            RadioListTile<LocationMode>(
              title: const Text('Mi ubicación actual'),
              subtitle: const Text('Se actualiza al abrir la app y mientras está abierta'),
              value: LocationMode.gps,
              groupValue: s.mode,
              onChanged: (m) => dev.update(s.copyWith(mode: m)),
            ),
            RadioListTile<LocationMode>(
              title: const Text('Ubicación fija'),
              subtitle: Text(s.fixed == null
                  ? 'Primero fíjala con el botón de abajo'
                  : '${s.fixed!.latitude.toStringAsFixed(3)}, ${s.fixed!.longitude.toStringAsFixed(3)}'),
              value: LocationMode.fixed,
              groupValue: s.mode,
              onChanged: s.fixed == null ? null : (m) => dev.update(s.copyWith(mode: m)),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: OutlinedButton.icon(
                icon: const Icon(Icons.push_pin_outlined),
                label: const Text('Fijar donde estoy ahora (casa, oficina…)'),
                onPressed: loc == null ? null : () => dev.update(s.copyWith(fixed: loc, mode: LocationMode.fixed)),
              ),
            ),
            const Divider(),
            _Section('Ajuste local de intensidad: ${s.siteAdjust >= 0 ? '+' : ''}${s.siteAdjust.toStringAsFixed(1)}'),
            Slider(
              value: s.siteAdjust,
              min: -1,
              max: 1.5,
              divisions: 25,
              label: s.siteAdjust.toStringAsFixed(1),
              onChanged: (v) => dev.update(s.copyWith(siteAdjust: v)),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Text(
                'Suelos blandos y edificios altos sienten más que lo que predice el modelo. '
                '+0.6 iguala lo que reportó Ciudad de Panamá en el sismo del 9 de octubre. '
                'Si vives sobre roca, bájalo.',
                style: t.bodySmall,
              ),
            ),
            const SizedBox(height: 16),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Text(
                'Esto no es una alerta temprana: los sismos se publican minutos después de ocurrir, '
                'y la sacudida de un sismo cercano llega antes. Sigue las indicaciones de SINAPROC.',
                style: t.bodySmall?.copyWith(fontStyle: FontStyle.italic),
              ),
            ),
            const SizedBox(height: 24),
          ]);
        },
      ),
    );
  }

  static String _thresholdHelp(int lv) => switch (lv) {
        2 => 'II: solo lo notan algunas personas en reposo, sobre todo en pisos altos.',
        3 => 'III: se siente dentro de casa; se parece al paso de un camión.',
        4 => 'IV: lo siente casi todo el mundo adentro; vibran ventanas y platos.',
        5 => 'V: lo siente todo el mundo; caen objetos, algunos se despiertan.',
        6 => 'VI: asusta; muebles se mueven, daños leves en construcciones débiles.',
        _ => 'VII o más: daños en construcciones; difícil mantenerse en pie.',
      };
}

class _Section extends StatelessWidget {
  const _Section(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
        child: Text(text, style: Theme.of(context).textTheme.titleSmall),
      );
}

class _MmiBadge extends StatelessWidget {
  const _MmiBadge(this.level);
  final int level;

  @override
  Widget build(BuildContext context) => CircleAvatar(
        backgroundColor: mmiColor(level),
        foregroundColor: mmiOnColor(level),
        child: Text(roman[level], style: const TextStyle(fontWeight: FontWeight.w800)),
      );
}
