/**
 * What {@link acknowledgeUsagePolicy} records that the user has agreed to.
 *
 * This exists because of what this library sits downstream of. `facefusion-mobile` — the
 * C++ engine this package wraps — is itself a port of FaceFusion by Henry Ruhs, licensed
 * OpenRAIL-AS. That licence prohibits, among other things, impersonating people for
 * deception and requires disclosing machine-generated content, and it requires those
 * restrictions passed down to anyone this is redistributed to — see
 * `third_party/facefusion-mobile/NOTICE` in the source repository for the full chain and
 * the exact restriction text.
 *
 * Show this (or your own text that says the same thing) before the first swap runs, get
 * the user's agreement, then call {@link acknowledgeUsagePolicy} — `swapPhoto`/`swapVideo`
 * both reject `E_POLICY` until that has happened once on the device.
 */
export const USAGE_POLICY_TEXT =
  'Only swap faces of people who consented to it. Never use a result to impersonate ' +
  'someone or pass it off as a real, unedited photo or video. Every swap this app ' +
  'produces has a small "AI-GENERATED" mark burned into it for that reason.';
