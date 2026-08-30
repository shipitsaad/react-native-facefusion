package com.facefusion

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import java.util.concurrent.Executors

class FacefusionModule(reactContext: ReactApplicationContext) :
  NativeFacefusionSpec(reactContext) {

  // One thread, not a pool. The native pipeline is a single C++ global (`g_pipe`) and is
  // not reentrant, so serialising every native call through one thread is the behaviour
  // we want anyway -- and it keeps the QNN backend's dlopen off the UI thread.
  private val worker = Executors.newSingleThreadExecutor { r ->
    Thread(r, "facefusion-native").apply { isDaemon = true }
  }

  override fun multiply(a: Double, b: Double): Double {
    return a * b
  }

  override fun probeDevice(promise: Promise) {
    worker.execute {
      try {
        promise.resolve(toMap(DeviceProbe.probe(reactApplicationContext)))
      } catch (e: Throwable) {
        // Includes UnsatisfiedLinkError: a JNI symbol that did not bind is an Error, not
        // an Exception, so `catch (e: Exception)` would let it kill the worker thread
        // and leave the promise pending forever.
        promise.reject("E_PROBE", e.message ?: e.toString(), e)
      }
    }
  }

  override fun invalidate() {
    worker.shutdown()
    super.invalidate()
  }

  private fun toMap(probe: DeviceProbe): WritableMap = Arguments.createMap().apply {
    putBoolean("ok", probe.ok)
    putString("tier", probe.tier)
    putArray("tierChain", Arguments.createArray().apply {
      probe.tierChain.forEach { pushString(it) }
    })
    putInt("arch", probe.arch)
    putInt("vtcmMb", probe.vtcmMb)
    putInt("socModel", probe.socModel)
    putBoolean("signedPd", probe.signedPd)
    putBoolean("dlbc", probe.dlbc)
    putString("error", probe.error)
  }

  companion object {
    const val NAME = NativeFacefusionSpec.NAME
  }
}
