import 'package:flutter_test/flutter_test.dart';
import 'package:sismo_alerta/core/intensity.dart';

// Same checks as backend/tests/test_intensity.py, so the app and the server agree.
void main() {
  const lat = 7.5868, lon = -80.769, depth = 12.6, mag = 7.7; // 2026-10-09 mainshock

  double model(double la, double lo) =>
      mmiAww2014(mag, hypocentralKm(epicentralKm(lat, lon, la, lo), depth));

  test('distance to Panama City', () {
    expect(epicentralKm(lat, lon, 8.983, -79.517), closeTo(207.6, 1));
  });

  test('matches Did You Feel It? near the epicenter', () {
    expect(model(7.97, -80.42), closeTo(6.5, 0.4)); // Chitré
    expect(model(8.10, -80.97), closeTo(6.2, 0.4)); // Santiago
  });

  test('Panama City with the +0.6 site adjustment', () {
    final epi = epicentralKm(lat, lon, 8.983, -79.517);
    expect(model(8.983, -79.517), closeTo(4.6, 0.1));
    expect(mmiAtEpicentral(mag, depth, epi, siteAdjust: 0.6), closeTo(5.2, 0.1));
    expect(describeMmi(5.2), 'V (moderado)');
  });

  test('wave fronts and arrivals', () {
    final a = arrivals(210);
    expect(a.p, closeTo(35, 0.01));
    expect(a.s, closeTo(60, 0.01));
    expect(frontRadiusKm(1, vsKmS, depth), 0); // still underground
    expect(frontRadiusKm(60, vsKmS, depth), closeTo(209.6, 0.5));
  });

  test('intensity zones shrink with level', () {
    final r4 = radiusForLevel(mag, depth, 4), r5 = radiusForLevel(mag, depth, 5);
    expect(r4, greaterThan(r5));
    expect(mmiAtEpicentral(mag, depth, r5 - 1), greaterThanOrEqualTo(4.5));
    expect(mmiAtEpicentral(mag, depth, r5 + 1), lessThan(4.5));
    expect(radiusForLevel(3.0, 10, 8), 0); // a small quake never reaches VIII
  });

  test('levels clip to I..X', () {
    expect(mmiLevel(0.2), 1);
    expect(mmiLevel(3.49), 3);
    expect(mmiLevel(3.5), 4);
    expect(mmiLevel(14), 10);
  });
}
