import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';
import 'package:shared_preferences/shared_preferences.dart';

enum LocationMode { gps, fixed }

/// What this phone wants to be alerted about. Mirrored to Firestore `devices/{uid}`.
class AlertSettings {
  const AlertSettings({
    this.enabled = true,
    this.thresholdLevel = 4,
    this.minMag = 0,
    this.alwaysMag = 6.0,
    this.siteAdjust = 0.6,
    this.mode = LocationMode.gps,
    this.fixed,
  });

  final bool enabled;
  final int thresholdLevel; // notify when the intensity here rounds to this MMI level or more
  final double minMag;
  final double alwaysMag; // ...or always, for events at least this big in the watch area
  final double siteAdjust; // local amplification added to the model
  final LocationMode mode;
  final LatLng? fixed;

  AlertSettings copyWith({
    bool? enabled,
    int? thresholdLevel,
    double? minMag,
    double? alwaysMag,
    double? siteAdjust,
    LocationMode? mode,
    LatLng? fixed,
  }) =>
      AlertSettings(
        enabled: enabled ?? this.enabled,
        thresholdLevel: thresholdLevel ?? this.thresholdLevel,
        minMag: minMag ?? this.minMag,
        alwaysMag: alwaysMag ?? this.alwaysMag,
        siteAdjust: siteAdjust ?? this.siteAdjust,
        mode: mode ?? this.mode,
        fixed: fixed ?? this.fixed,
      );
}

/// Registers this phone (anonymous Firebase user + FCM token + location + settings).
class DeviceService extends ChangeNotifier {
  DeviceService._();
  static final DeviceService instance = DeviceService._();

  AlertSettings settings = const AlertSettings();
  LatLng? location; // location used for alerts (GPS or fixed)
  String? status; // last problem worth showing, in Spanish
  String? _token;
  StreamSubscription<Position>? _positionSub;
  Timer? _pushDebounce;

  User? get user => FirebaseAuth.instance.currentUser;

  Future<void> start() async {
    await _loadPrefs();
    if (FirebaseAuth.instance.currentUser == null) {
      await FirebaseAuth.instance.signInAnonymously();
    }
    await _setupMessaging();
    await refreshLocation();
  }

  // ------------------------------------------------------------------ settings

  Future<void> _loadPrefs() async {
    final p = await SharedPreferences.getInstance();
    final fLat = p.getDouble('fixedLat'), fLon = p.getDouble('fixedLon');
    settings = AlertSettings(
      enabled: p.getBool('enabled') ?? true,
      thresholdLevel: p.getInt('thresholdLevel') ?? 4,
      minMag: p.getDouble('minMag') ?? 0,
      alwaysMag: p.getDouble('alwaysMag') ?? 6.0,
      siteAdjust: p.getDouble('siteAdjust') ?? 0.6,
      mode: (p.getString('mode') ?? 'gps') == 'fixed' ? LocationMode.fixed : LocationMode.gps,
      fixed: fLat != null && fLon != null ? LatLng(fLat, fLon) : null,
    );
    if (settings.mode == LocationMode.fixed && settings.fixed != null) location = settings.fixed;
    notifyListeners();
  }

  Future<void> update(AlertSettings next) async {
    final whereChanged = next.mode != settings.mode || next.fixed != settings.fixed;
    settings = next;
    notifyListeners();
    final p = await SharedPreferences.getInstance();
    await p.setBool('enabled', next.enabled);
    await p.setInt('thresholdLevel', next.thresholdLevel);
    await p.setDouble('minMag', next.minMag);
    await p.setDouble('alwaysMag', next.alwaysMag);
    await p.setDouble('siteAdjust', next.siteAdjust);
    await p.setString('mode', next.mode.name);
    if (next.fixed != null) {
      await p.setDouble('fixedLat', next.fixed!.latitude);
      await p.setDouble('fixedLon', next.fixed!.longitude);
    }
    if (whereChanged) {
      if (next.mode == LocationMode.fixed && next.fixed != null) {
        location = next.fixed;
        await _stopTracking();
      } else {
        await refreshLocation();
      }
      notifyListeners();
    }
    // Sliders call this on every tick; write to Firestore once they settle.
    _pushDebounce?.cancel();
    _pushDebounce = Timer(const Duration(milliseconds: 800), _push);
  }

  // ------------------------------------------------------------------ messaging

  Future<void> _setupMessaging() async {
    final fm = FirebaseMessaging.instance;
    final perm = await fm.requestPermission(alert: true, sound: true, badge: true);
    if (perm.authorizationStatus == AuthorizationStatus.denied) {
      status = 'Las notificaciones están desactivadas para esta app en el sistema.';
    }
    await fm.setForegroundNotificationPresentationOptions(alert: true, sound: true, badge: true);
    _token = await fm.getToken();
    fm.onTokenRefresh.listen((t) {
      _token = t;
      _push();
    });
  }

  // ------------------------------------------------------------------ location

  /// Re-reads the GPS (when in GPS mode) and keeps following it while the app is open.
  Future<void> refreshLocation() async {
    if (settings.mode == LocationMode.fixed && settings.fixed != null) {
      location = settings.fixed;
      notifyListeners();
      await _push();
      return;
    }
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        status = 'La ubicación del teléfono está apagada.';
        notifyListeners();
        return;
      }
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
      if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
        status = 'Sin permiso de ubicación: usa una ubicación fija en Ajustes.';
        notifyListeners();
        return;
      }
      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.medium),
      );
      _setLocation(LatLng(pos.latitude, pos.longitude));
      _positionSub ??= Geolocator.getPositionStream(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.medium, distanceFilter: 2000),
      ).listen((p) => _setLocation(LatLng(p.latitude, p.longitude)));
      status = null;
    } catch (e) {
      status = 'No se pudo leer la ubicación ($e).';
      notifyListeners();
    }
  }

  void _setLocation(LatLng l) {
    location = l;
    notifyListeners();
    _push();
  }

  Future<void> _stopTracking() async {
    await _positionSub?.cancel();
    _positionSub = null;
  }

  Future<void> pauseTracking() => _stopTracking();

  // ------------------------------------------------------------------ firestore

  Future<void> _push() async {
    final uid = user?.uid;
    final loc = location;
    if (uid == null || loc == null) return;
    // ~1 km precision is plenty for intensity and keeps the exact address off the server.
    double r2(double v) => (v * 100).roundToDouble() / 100;
    try {
      await FirebaseFirestore.instance.collection('devices').doc(uid).set({
        'fcmToken': _token,
        'lat': r2(loc.latitude),
        'lon': r2(loc.longitude),
        'enabled': settings.enabled,
        'thresholdLevel': settings.thresholdLevel,
        'minMag': settings.minMag,
        'alwaysMag': settings.alwaysMag,
        'siteAdjust': settings.siteAdjust,
        'locationMode': settings.mode.name,
        'platform': defaultTargetPlatform.name,
        'updatedAt': FieldValue.serverTimestamp(),
      }, SetOptions(merge: true));
    } catch (e) {
      debugPrint('device registration failed: $e');
    }
  }
}
