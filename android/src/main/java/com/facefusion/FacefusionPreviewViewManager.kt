package com.facefusion

import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext

/**
 * Registers `<FacefusionPreview />` (`src/FacefusionPreview.tsx`) as `"FacefusionPreviewView"`.
 *
 * A plain [SimpleViewManager], not a codegen'd Fabric component -- there are no props to
 * bridge (the view has none; all it does is exist and own a Surface), so codegen would add a
 * `codegenConfig` project-wide setting and a generated interface for zero benefit. RN's
 * Fabric interop layer renders a legacy `ViewManager` like this one under the New
 * Architecture without changes here, the same way `example/`'s (currently unwired)
 * `NativeVideoView` was scaffolded to.
 */
class FacefusionPreviewViewManager : SimpleViewManager<FacefusionPreviewView>() {
  override fun getName() = NAME

  override fun createViewInstance(reactContext: ThemedReactContext): FacefusionPreviewView =
    FacefusionPreviewView(reactContext)

  companion object {
    const val NAME = "FacefusionPreviewView"
  }
}
