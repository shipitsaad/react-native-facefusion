package com.facefusion

import android.graphics.Bitmap
import android.graphics.BitmapFactory

/**
 * Decoding a photo without letting a big one kill the process.
 *
 * Every image path in this library used to call `BitmapFactory.decodeFile` with no size
 * limit, which crashes on photos that modern phones actually take. The arithmetic is the
 * whole reason this file exists, so it is written down rather than left to be rediscovered:
 *
 * [PhotoSwap] holds, simultaneously, for a `w x h` target — the decoded `Bitmap`
 * (`w*h*4`), the `IntArray` of pixels handed to `argbToBgr` (`w*h*4`), the packed BGR
 * buffer (`w*h*3`), the `IntArray` coming back from `bgrToArgb` (`w*h*4`) and the output
 * `Bitmap` (`w*h*4`). That is **~19 bytes per pixel**, against a heap this project has
 * measured topping out near 220 MB on a Snapdragon 8 Elite.
 *
 * | Photo | Pixels | Peak at ~19 B/px |
 * |---|---|---|
 * | 2560x1920 | 4.9 MP | ~93 MB — fine |
 * | 4096x3072 | 12.6 MP | ~239 MB — **crashes** |
 * | 8160x6120 (a 50 MP phone) | 50 MP | ~950 MB — **crashes immediately** |
 *
 * So this is not an exotic-input problem: a 50 MP main camera is standard on the exact
 * phones this library requires, and a user picking a photo their own phone took was
 * enough to kill it.
 *
 * **The downscale has to happen during decode, not after.** `inSampleSize` tells
 * `BitmapFactory` to subsample as it reads, so the full-size bitmap is never allocated.
 * Decoding first and calling `createScaledBitmap` afterwards would OOM on the decode
 * itself, which is exactly where the original crash was.
 */
object BitmapDecode {

  /**
   * Cap for an image that only contributes an **identity**, never pixels to the output.
   *
   * The source face is warped down to 112x112 for the recogniser (`ffpipe.cpp`, the
   * `arcface` stage), so resolution beyond a point contributes literally nothing — this
   * is free, not a tradeoff.
   */
  const val SOURCE_MAX = 1920

  /**
   * Cap for an image that **becomes** the output, where resolution is real quality.
   *
   * Deliberately higher than [SOURCE_MAX] for that reason, and still comfortably inside
   * the budget above. A swap output at 2560 on the long edge is past what any phone screen
   * or social upload will show; the alternative on a 50 MP input is not "sharper", it is
   * "crash".
   */
  const val TARGET_MAX = 2560

  /**
   * Decodes the image at [path], subsampled during decode so its long edge does not
   * greatly exceed [maxDimension].
   *
   * `inSampleSize` only takes powers of two, so the result can be up to ~2x under the cap
   * rather than landing exactly on it. That is the right trade: powers of two are the case
   * `BitmapFactory` decodes without an extra resample step, and being under the cap is
   * never the failure.
   *
   * ARGB_8888 is forced explicitly — `decodeFile` already defaults to it, but leaving it
   * implicit invites a HARDWARE bitmap the moment someone switches this to `ImageDecoder`,
   * and `getPixels()` throws on those.
   */
  fun decode(path: String, maxDimension: Int): Bitmap =
    decodeOrNull(path, maxDimension)
      ?: throw IllegalArgumentException("Could not decode image: $path")

  /**
   * As [decode], but answers `null` instead of throwing when [path] is not a decodable
   * image.
   *
   * [TargetFaces] needs this distinction: a target may legitimately be a *video*, and it
   * tells the two apart by trying a still decode first and falling through on failure. A
   * throwing decode would abort before the video path was ever reached.
   */
  fun decodeOrNull(path: String, maxDimension: Int): Bitmap? {
    // Pass one: read the header only. `inJustDecodeBounds` allocates no pixels, so this is
    // safe on an image far too big to actually decode -- which is the entire point.
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

    val options = BitmapFactory.Options().apply {
      inPreferredConfig = Bitmap.Config.ARGB_8888
      inSampleSize = sampleSizeFor(bounds.outWidth, bounds.outHeight, maxDimension)
    }
    return BitmapFactory.decodeFile(path, options)
  }

  /**
   * The smallest power of two that brings `max(w, h)` to [maxDimension] **or below**.
   *
   * Note the "or below", and that it is not the idiom most Android samples use. The common
   * one is `while (longest / 2 >= requested) sample *= 2`, which deliberately stops at the
   * last size still *larger* than the request, so the caller can scale down afterwards
   * with a good-quality resample. That leaves a result up to 2x the request — and here
   * that is the difference between working and not: a 50 MP photo against a 2560 cap comes
   * out 4080 wide under that idiom, which is ~237 MB peak and the exact crash this class
   * exists to prevent. We want a memory ceiling, not a quality floor.
   */
  fun sampleSizeFor(width: Int, height: Int, maxDimension: Int): Int {
    require(maxDimension > 0) { "maxDimension must be positive" }
    var sample = 1
    val longest = maxOf(width, height)
    while (longest / sample > maxDimension) sample *= 2
    return sample
  }
}
