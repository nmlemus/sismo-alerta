import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'firebase_options.dart';
import 'screens/home_screen.dart';
import 'services/device_service.dart';
import 'services/notification_service.dart';

/// Pushes that arrive while the app is closed are shown by the OS; nothing to do here,
/// but the handler must exist for Android to deliver data while in the background.
@pragma('vm:entry-point')
Future<void> _onBackgroundMessage(RemoteMessage message) async {
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await initializeDateFormatting('es');
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  FirebaseMessaging.onBackgroundMessage(_onBackgroundMessage);
  runApp(const SismoApp());
  // Registration runs after the first frame so the map shows immediately.
  await NotificationService.instance.start();
  await DeviceService.instance.start();
}

class SismoApp extends StatefulWidget {
  const SismoApp({super.key});

  @override
  State<SismoApp> createState() => _SismoAppState();
}

class _SismoAppState extends State<SismoApp> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      DeviceService.instance.refreshLocation();
    } else if (state == AppLifecycleState.paused) {
      DeviceService.instance.pauseTracking();
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Sismo Alerta',
      navigatorKey: navigatorKey,
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFFE8440A)),
        useMaterial3: true,
      ),
      darkTheme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFFE8440A), brightness: Brightness.dark),
        useMaterial3: true,
      ),
      home: const HomeScreen(),
    );
  }
}
