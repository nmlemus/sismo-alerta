import 'package:flutter/material.dart';

/// Colors for intensity levels, following the USGS ShakeMap scale.
const List<Color> _mmi = [
  Color(0xFFFFFFFF), // 0 (unused)
  Color(0xFFDFE6FE), // I
  Color(0xFFBFCCFF), // II
  Color(0xFFA0E6FF), // III
  Color(0xFF80FFFF), // IV
  Color(0xFF7AFF93), // V
  Color(0xFFFFFF00), // VI
  Color(0xFFFFC800), // VII
  Color(0xFFFF9100), // VIII
  Color(0xFFFF0000), // IX
  Color(0xFFC80000), // X
];

Color mmiColor(int level) => _mmi[level < 1 ? 1 : (level > 10 ? 10 : level)];

/// Readable text color on top of [mmiColor].
Color mmiOnColor(int level) => level >= 9 ? Colors.white : Colors.black87;

const Color pWaveColor = Color(0xFF2F80ED);
const Color sWaveColor = Color(0xFFE53935);
