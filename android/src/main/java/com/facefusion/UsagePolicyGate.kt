package com.facefusion

import android.content.Context

/**
 * Requires an explicit, one-time acknowledgement before any swap runs — on the same public
 * API path [ContentGate] uses, where a JS caller cannot skip it: no `skipCheck` option
 * exists above [PhotoSwap]/[VideoSwap] for this any more than it does for that.
 *
 * This exists because of what this project sits downstream of, not because it seemed like
 * good practice in the abstract. `facefusion-mobile` — the C++ engine [PhotoSwap]/
 * [VideoSwap] wrap — is itself a port of FaceFusion by Henry Ruhs, licensed OpenRAIL-AS.
 * That licence prohibits, among other things, "impersonat[ing] ... human beings for
 * purposes of deception", and requires redistributors to pass its restrictions down to
 * their own users as "an enforceable provision" — see
 * `third_party/facefusion-mobile/NOTICE` for the full chain and the exact restriction text.
 *
 * A persisted boolean cannot *prove* informed consent — a bad-faith integrator could call
 * [acknowledge] without ever showing [USAGE_POLICY_TEXT_HINT] to anyone, the same way
 * [ContentGate] can be removed outright (CLAUDE.md rule 5, upstream's own switch). What this
 * does guarantee: no consumer of this library ships a working swap feature *by accident*
 * without deliberately calling [acknowledge] first, and the example app models what that
 * call should look like in front of a real user — see [USAGE_POLICY_TEXT_HINT]'s twin,
 * `USAGE_POLICY_TEXT` in `src/usagePolicyText.tsx`, which is the actual text shown there.
 */
object UsagePolicyGate {

  class NotAcknowledged(message: String) : Exception(message)

  private const val PREFS = "com.facefusion.usage_policy"
  // Versioned so a future wording change can force re-acknowledgement by bumping this key
  // rather than needing a migration.
  private const val KEY_ACK = "acknowledged_v1"

  /** Not the exact wording shown to an end user — that lives in `src/usagePolicyText.tsx`
   *  so it ships as one string a consuming app can actually render, not duplicated into
   *  this exception's message. This is only what shows up if a caller sees the rejection
   *  without ever having read that. */
  const val USAGE_POLICY_TEXT_HINT =
    "Call acknowledgeUsagePolicy() once, after showing the user what it means to agree to " +
      "it, before the first swapPhoto()/swapVideo()."

  fun isAcknowledged(context: Context): Boolean = prefs(context).getBoolean(KEY_ACK, false)

  fun acknowledge(context: Context) {
    prefs(context).edit().putBoolean(KEY_ACK, true).apply()
  }

  /** Called at the very top of [PhotoSwap.run] / [VideoSwap.run] — before any decode, any
   *  model check, any native call — so a caller who skipped [acknowledge] never gets far
   *  enough to touch the pipeline at all. */
  fun check(context: Context) {
    if (!isAcknowledged(context)) {
      throw NotAcknowledged("Usage policy not acknowledged. $USAGE_POLICY_TEXT_HINT")
    }
  }

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
