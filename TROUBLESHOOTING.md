# Troubleshooting

Real errors hit while building this package, kept here because the QNN/Hexagon
error codes below are genuinely misleading on their own — the number rarely names
the actual cause. If you hit one of these while integrating the library into your
own app, start here before assuming it's your code.

For "a face detects on one phone and not another", see [Known issues](README.md#known-issues)
in the README — that one isn't an error at all, it's documented behaviour.

## `Fail to get context blob with err 5000` / `Using newer context binary on old SDK`

Your QAIRT SDK (step 2 of [Install](README.md#install)) is older than the one the
model `.bin` files were compiled against. These files are QNN **context
binaries** — a graph already compiled and scheduled for one Hexagon architecture,
not portable weights — and the format they're serialized in
(`QNN_HTP_CONTEXT_BLOB_VERSION`, a constant in Qualcomm's own `QnnHtpCommon.h`)
has changed between SDK releases.

**Fix:** get a newer QAIRT SDK. This project currently develops against
**2.49.40.260810** (`QNN_HTP_CONTEXT_BLOB_VERSION 4.0.4`) — treat that as a floor,
not a ceiling; if a future model update needs a newer blob version than whatever
SDK you have, you'll see this exact error again.

## `err 4000` (`QNN_BACKEND_ERROR_CANNOT_INITIALIZE`)

This number on its own tells you almost nothing — it's shown up in this project's
own history for at least two unrelated root causes (a missing vendor library, and,
early on, a linking choice that was fixed before this ever became a public API).
**Don't diagnose from the code. Read `adb logcat` for the actual line immediately
around it** — in particular, any `dlopen failed:` line naming a specific missing
library. That line, not the QNN error number, is the real error.

## `14001` (`QNN_DEVICE_ERROR_INVALID_CONFIG`)

Same advice as `err 4000`, and just as misleading: in this project's own history,
this exact code showed up from a missing vendor library, and nothing about
configuration was actually wrong. Read the log line above it.

## `dlopen failed: library "libcdsprpc.so" not found: needed by .../libQnnHtpV*Stub.so`

The real line behind both codes above, in this project's own case. `libcdsprpc.so`
is Qualcomm's fastrpc client — the only transport to the Hexagon DSP at all — and
from `targetSdk` 31+, an app's linker namespace can't see a vendor library unless
the app's manifest explicitly names it with `<uses-native-library>`.

This library's own `AndroidManifest.xml` already declares `libcdsprpc.so` and
`libadsprpc.so` this way (`required="false"`, so it doesn't make your app
uninstallable on non-Qualcomm phones), and that merges into your app's manifest
automatically. **If you see this error anyway,** check your app's *merged*
manifest — not the one you wrote by hand — for both entries:

```sh
./gradlew :app:processDebugManifest
# then read app/build/intermediates/merged_manifests/debug/AndroidManifest.xml
```

Something in your own manifest, a manifest-merger `tools:` rule, or another
dependency can suppress a merged-in entry; if it's missing there, that's the bug
to chase, not this package.

## `deviceCreate failed` / "the DSP is not reachable from this process" from `probeDevice()`

Your own copy of the QAIRT runtime (step 2 of Install) is missing the Stub/Skel
pair for *this specific phone's* Hexagon architecture. `libQnnHtp.so` picks that
pair based on the chip's Hexagon generation, completely independent of which model
tier got downloaded — so this can happen even with the right models fully
downloaded and verified. Re-check the copy step: **every** architecture's
Stub+Skel pair needs to be present (`libQnnHtpV*Stub.so` **and**
`libQnnHtpV*Skel.so` for each), not a chosen few.

## `Could not decode image` for a file `adb shell ls` plainly shows exists

Scoped storage, not a bad path. From `targetSdk` 29+, an app with no storage
permission can't read a file it doesn't own in shared storage (`/sdcard/Download/`
and similar), even though the file is right there when you look from `adb shell`
as `shell`, not as your app. Confirm with `run-as <your.app.id> ls <path>` — if
that comes back empty while a plain `adb shell ls` shows the file, this is it.

**Fix:** pass paths your app actually owns —
`context.getExternalFilesDir(null)` and similar — rather than a raw shared-storage
path or an unresolved `content://` URI. `swapPhoto`/`swapVideo`/`detectSourceFaces`/
`detectTargetFaces` all take real filesystem paths, not URIs.

## `INSTALL_FAILED_INSUFFICIENT_STORAGE` on a debug install

`useLegacyPackaging = true` (required — see [Install](README.md#install)) stores
the QNN runtime **uncompressed** inside the APK *and* extracts a second real copy
on disk at install time, so budget for roughly double the runtime's size in actual
device storage, not just APK size. `adb uninstall` the previous build and
`pm trim-caches 4G` (or similar) before reinstalling on a tight test device.

## Manifest merge fails with `MergeFailureException: Error parsing …` and no line number

If you're editing your own `AndroidManifest.xml` near this library's
`<uses-native-library>` entries and hit this with no useful location: check for a
literal `--` inside an XML comment. It's illegal in XML, the manifest merger's
error gives no line number for it, and it's an easy thing to type by accident in a
comment describing what a permission is *for*.
