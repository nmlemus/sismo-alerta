#!/usr/bin/env python3
"""Generate the android/ and ios/ folders with `flutter create` and apply the
permissions and build settings this app needs. Safe to run more than once.

    cd app && python3 tool/setup_platforms.py
"""

import re
import subprocess
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1]


def run(*cmd):
    print("+", " ".join(cmd))
    subprocess.run(cmd, cwd=APP, check=True)


def patch_android():
    manifest = APP / "android/app/src/main/AndroidManifest.xml"
    m = manifest.read_text()
    perms = [
        "android.permission.INTERNET",
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.POST_NOTIFICATIONS",
    ]
    for p in perms:
        if p not in m:
            m = m.replace("<application", f'<uses-permission android:name="{p}"/>\n    <application', 1)
    meta = 'com.google.firebase.messaging.default_notification_channel_id'
    if meta not in m:
        m = re.sub(r"(<application[^>]*>)",
                   r'\1\n        <meta-data android:name="' + meta + r'" android:value="sismos"/>', m, count=1)
    manifest.write_text(m)

    kts = APP / "android/app/build.gradle.kts"
    groovy = APP / "android/app/build.gradle"
    if kts.exists():
        g = kts.read_text()
        g = re.sub(r"minSdk\s*=\s*[^\n]+", "minSdk = 23", g)
        if "isCoreLibraryDesugaringEnabled" not in g:
            g = re.sub(r"compileOptions\s*\{", "compileOptions {\n        isCoreLibraryDesugaringEnabled = true", g, count=1)
        if "desugar_jdk_libs" not in g:
            g += '\ndependencies {\n    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")\n}\n'
        kts.write_text(g)
    elif groovy.exists():
        g = groovy.read_text()
        g = re.sub(r"minSdk(Version)?\s*=?\s*flutter\.minSdkVersion", "minSdkVersion 23", g)
        if "coreLibraryDesugaringEnabled" not in g:
            g = re.sub(r"compileOptions\s*\{", "compileOptions {\n        coreLibraryDesugaringEnabled true", g, count=1)
        if "desugar_jdk_libs" not in g:
            g += "\ndependencies {\n    coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.4'\n}\n"
        groovy.write_text(g)
    else:
        sys.exit("android/app/build.gradle(.kts) not found")


def patch_ios():
    plist = APP / "ios/Runner/Info.plist"
    p = plist.read_text()
    adds = {
        "NSLocationWhenInUseUsageDescription":
            "<string>Para estimar con qué intensidad te llegaría cada sismo donde estás.</string>",
        "UIBackgroundModes": "<array>\n\t\t<string>remote-notification</string>\n\t</array>",
    }
    for key, value in adds.items():
        if f"<key>{key}</key>" not in p:
            p = p.replace("<dict>", f"<dict>\n\t<key>{key}</key>\n\t{value}", 1)
    plist.write_text(p)

    podfile = APP / "ios/Podfile"
    if podfile.exists():
        pf = podfile.read_text()
        pf = re.sub(r"#?\s*platform :ios, '[\d.]+'", "platform :ios, '13.0'", pf, count=1)
        podfile.write_text(pf)


if __name__ == "__main__":
    if not (APP / "android").exists() or not (APP / "ios").exists():
        run("flutter", "create", "--org", "pa.aiudalabs", "--project-name", "sismo_alerta",
            "--platforms", "android,ios", ".")
        # flutter create adds a counter-app test that doesn't apply here.
        (APP / "test/widget_test.dart").unlink(missing_ok=True)
    patch_android()
    patch_ios()
    print("Platforms ready. Next: flutterfire configure (see README).")
