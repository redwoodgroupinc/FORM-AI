#!/usr/bin/env bash
# Sign an unsigned ShapeCoach release bundle with the upload key for Google Play.
#   scripts/sign-android.sh shapecoach-unsigned.aab shapecoach-upload.jks shapecoach-1.0.0.aab
# You will be asked for the keystore password. Needs a JDK (jarsigner).
set -euo pipefail
in=${1:?unsigned .aab}; keystore=${2:?upload keystore (.jks)}; out=${3:?signed .aab to write}
jarsigner -sigalg SHA256withRSA -digestalg SHA-256 -keystore "$keystore" -signedjar "$out" "$in" upload
jarsigner -verify "$out" > /dev/null && echo "Signed and verified: $out"
