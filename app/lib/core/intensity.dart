// Ground-motion helpers. Mirror of backend/app/intensity.py — keep them in sync.
//
// Intensity: Atkinson, Worden & Wald (2014) intensity prediction equation,
// hypocentral form. Calibrated against USGS "Did You Feel It?" for the
// 2026-10-09 M7.7 Panama earthquake: Panama City reported 5.2 vs 4.6
// predicted, hence the default site adjustment of +0.6.

import 'dart:math' as math;

const double earthRadiusKm = 6371.0;
const double vpKmS = 6.0; // average crustal P-wave speed
const double vsKmS = 3.5; // average crustal S-wave speed

const List<String> roman = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const Map<int, String> labelEs = {
  1: 'no sentido',
  2: 'débil',
  3: 'débil',
  4: 'leve',
  5: 'moderado',
  6: 'fuerte',
  7: 'muy fuerte',
  8: 'severo',
  9: 'violento',
  10: 'extremo',
};

double _rad(double d) => d * math.pi / 180.0;
double _log10(double x) => math.log(x) / math.ln10;

double epicentralKm(double lat1, double lon1, double lat2, double lon2) {
  final p1 = _rad(lat1), p2 = _rad(lat2);
  final dp = p2 - p1, dl = _rad(lon2 - lon1);
  final a = math.pow(math.sin(dp / 2), 2) + math.cos(p1) * math.cos(p2) * math.pow(math.sin(dl / 2), 2);
  return 2 * earthRadiusKm * math.asin(math.min(1.0, math.sqrt(a)));
}

double hypocentralKm(double epiKm, double depthKm) =>
    math.sqrt(epiKm * epiKm + math.max(0.0, depthKm) * math.max(0.0, depthKm));

/// Predicted MMI (unclipped).
double mmiAww2014(double mag, double rhypKm) {
  final r = math.sqrt(rhypKm * rhypKm + 14.0 * 14.0);
  final lr = _log10(r);
  final b = math.max(0.0, _log10(r / 50.0));
  return 0.309 + 1.864 * mag - 1.672 * lr - 0.00219 * r + 1.77 * b - 0.383 * mag * lr;
}

/// Intensity at an epicentral distance, clipped to [1, 10].
double mmiAtEpicentral(double mag, double depthKm, double epiKm, {double siteAdjust = 0}) =>
    math.min(10.0, math.max(1.0, mmiAww2014(mag, hypocentralKm(epiKm, depthKm)) + siteAdjust));

int mmiLevel(double mmi) {
  final v = (mmi + 0.5).floor();
  return v < 1 ? 1 : (v > 10 ? 10 : v);
}

String describeMmi(double mmi) {
  final lv = mmiLevel(mmi);
  return '${roman[lv]} (${labelEs[lv]})';
}

/// Seconds after origin time at which the P and S waves reach this hypocentral distance.
({double p, double s}) arrivals(double rhypKm) => (p: rhypKm / vpKmS, s: rhypKm / vsKmS);

/// Radius on the surface (km) a wave travelling at [speed] has reached after [t] seconds.
double frontRadiusKm(double t, double speed, double depthKm) {
  final travelled = t * speed;
  if (travelled <= depthKm) return 0;
  return math.sqrt(travelled * travelled - depthKm * depthKm);
}

/// Epicentral distance (km) beyond which the intensity rounds below [level].
/// Returns 0 if even the epicenter doesn't reach it.
double radiusForLevel(double mag, double depthKm, int level, {double siteAdjust = 0}) {
  final target = level - 0.5;
  double f(double d) => mmiAww2014(mag, hypocentralKm(d, depthKm)) + siteAdjust - target;
  if (f(0) < 0) return 0;
  double lo = 0, hi = 3000;
  if (f(hi) > 0) return hi;
  for (var i = 0; i < 60; i++) {
    final mid = (lo + hi) / 2;
    if (f(mid) > 0) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}
