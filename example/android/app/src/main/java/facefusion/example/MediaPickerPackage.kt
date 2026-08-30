package facefusion.example

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/** Registers [MediaPickerModule] — see its class doc. Old-architecture bridge module, on
 *  purpose: this is example-app testing scaffolding, not a library API, so it does not need
 *  a TurboModule spec or codegen. */
@Suppress("DEPRECATION") // ReactPackage's plain (non-Turbo) methods are deprecated in RN 0.85
// but still the required overrides for a bridge module registered by hand rather than
// autolinked, which is what this is (see the class doc above).
class MediaPickerPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(MediaPickerModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
