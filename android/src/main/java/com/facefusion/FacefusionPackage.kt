package com.facefusion

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.uimanager.ViewManager
import java.util.HashMap

class FacefusionPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    return if (name == FacefusionModule.NAME) {
      FacefusionModule(reactContext)
    } else {
      null
    }
  }

  // The live-preview surface -- see FacefusionPreviewViewManager's class doc for why this is
  // a plain ViewManager rather than a codegen'd Fabric component.
  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    listOf(FacefusionPreviewViewManager())

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(
      FacefusionModule.NAME to ReactModuleInfo(
        name = FacefusionModule.NAME,
        className = FacefusionModule.NAME,
        canOverrideExistingModule = false,
        needsEagerInit = false,
        isCxxModule = false,
        isTurboModule = true
      )
    )
  }
}
