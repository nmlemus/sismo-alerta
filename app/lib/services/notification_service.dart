import 'dart:convert';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../models/quake.dart';
import '../screens/quake_screen.dart';

final GlobalKey<NavigatorState> navigatorKey = GlobalKey<NavigatorState>();

/// Shows pushes while the app is open and opens the quake when a notification is tapped.
class NotificationService {
  NotificationService._();
  static final NotificationService instance = NotificationService._();

  final _local = FlutterLocalNotificationsPlugin();

  // Must match the channel_id the backend sends (backend/app/store.py).
  static const _channel = AndroidNotificationChannel(
    'sismos',
    'Alertas de sismos',
    description: 'Sismos que probablemente sientas donde estás',
    importance: Importance.max,
  );

  Future<void> start() async {
    await _local.initialize(
      const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
        iOS: DarwinInitializationSettings(),
      ),
      onDidReceiveNotificationResponse: (r) {
        if (r.payload != null) _open(jsonDecode(r.payload!) as Map<String, dynamic>);
      },
    );
    await _local
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(_channel);

    FirebaseMessaging.onMessage.listen(_showForeground);
    FirebaseMessaging.onMessageOpenedApp.listen((m) => _open(m.data));
    final initial = await FirebaseMessaging.instance.getInitialMessage();
    if (initial != null) {
      // Wait for the first frame so the navigator exists.
      WidgetsBinding.instance.addPostFrameCallback((_) => _open(initial.data));
    }
  }

  void _showForeground(RemoteMessage m) {
    final n = m.notification;
    if (n == null) return;
    _local.show(
      m.data['eventId'].hashCode,
      n.title,
      n.body,
      NotificationDetails(
        android: AndroidNotificationDetails(
          _channel.id,
          _channel.name,
          channelDescription: _channel.description,
          importance: Importance.max,
          priority: Priority.high,
          styleInformation: BigTextStyleInformation(n.body ?? ''),
        ),
        iOS: const DarwinNotificationDetails(presentAlert: true, presentSound: true),
      ),
      payload: jsonEncode(m.data),
    );
  }

  Future<void> _open(Map<String, dynamic> data) async {
    final id = data['eventId'];
    if (id == null) return;
    Quake quake = Quake.fromPush(data);
    try {
      final doc = await FirebaseFirestore.instance.collection('events').doc('$id').get();
      if (doc.exists) quake = Quake.fromDoc(doc);
    } catch (_) {
      // Offline: the push payload has enough to draw the simulation.
    }
    navigatorKey.currentState?.push(MaterialPageRoute(builder: (_) => QuakeScreen(quake: quake)));
  }
}
